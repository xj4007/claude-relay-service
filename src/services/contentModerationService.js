const axios = require('axios')
const logger = require('../utils/logger')
const config = require('../../config/config')

class ContentModerationService {
  constructor() {
    this.enabled = config.contentModeration?.enabled || false
    this.apiBaseUrl = config.contentModeration?.apiBaseUrl
    this.apiKey = config.contentModeration?.apiKey
    this.model = config.contentModeration?.model
    this.maxTokens = config.contentModeration?.maxTokens || 100
    this.timeout = config.contentModeration?.timeout || 10000

    // 🔄 重试配置
    this.maxRetries = config.contentModeration?.maxRetries || 3
    this.retryDelay = config.contentModeration?.retryDelay || 1000
    this.failStrategy = config.contentModeration?.failStrategy || 'fail-close'

    // 🛡️ 审核系统提示词（简化版，更适配 Qwen 模型）
    this.systemPrompt = `You are a content safety moderator. Analyze the following content and respond ONLY with a JSON object.

RESPOND WITH ONLY THIS JSON FORMAT - NO OTHER TEXT:
{"status":"true","words":["word1","word2"]} if content violates policies
{"status":"false","words":[]} if content is safe

CHECK FOR VIOLATIONS:
- NSFW/Sexual content (including: 色色, 搞黄, 涩涩, NSFW, 裸体, 性爱)
- Violence/Gore (attacks, terrorism, self-harm)
- Illegal content (drugs, weapons, hacking)
- Hate speech
- Profanity (草泥马, 操, 傻逼)
- Political attacks

EXCEPTION: Allow technical discussions (code, programming, architecture, API).

CRITICAL: Return ONLY valid JSON, nothing else.`
  }

  /**
   * 主审核方法
   * @param {Object} requestBody - Claude API 请求体
   * @param {Object} apiKeyInfo - API Key 信息 {keyName, keyId, userId}
   * @returns {Promise<{passed: boolean, message?: string}>}
   */
  async moderateContent(requestBody, apiKeyInfo = {}) {
    // 功能未启用，直接通过
    if (!this.enabled) {
      return { passed: true }
    }

    try {
      // 提取所有内容（用户消息和系统消息）
      const allContent = this._extractAllContent(requestBody)

      if (!allContent || allContent.trim().length === 0) {
        logger.warn('⚠️ No content found for moderation')
        return { passed: true }
      }

      logger.info(`🔍 Starting content moderation for ${Object.keys(requestBody.messages).length} messages`)

      // 🔄 调用审核 API（带重试机制）
      const moderationResult = await this._callModerationAPIWithRetry(allContent)

      if (moderationResult.success) {
        if (moderationResult.data.status === 'true') {
          // 检测到违规 - 记录到专用日志
          this._logNSFWViolation(requestBody, moderationResult.data.sensitiveWords, apiKeyInfo)

          const message = this._formatErrorMessage(moderationResult.data.sensitiveWords)
          logger.warn(`🚫 Content moderation failed: ${message}`)
          return {
            passed: false,
            message
          }
        } else {
          // 通过审核
          logger.info('✅ Content moderation passed')
          return { passed: true }
        }
      } else {
        // 🔴 API 调用失败（重试全部失败）- Fail-Close 策略
        logger.error(
          '❌ Moderation API failed after all retries, BLOCKING request (fail-close policy)'
        )
        return {
          passed: false,
          message:
            '小红帽AI内容审核服务暂不可用，请稍后重试。如问题持续，请联系管理员。\n提示：在 Claude Code 中按 ESC+ESC 可返回上次输入。'
        }
      }
    } catch (error) {
      logger.error('❌ Content moderation error:', error)
      // 🔴 异常情况 - Fail-Close 策略
      logger.error('❌ Exception in moderation, BLOCKING request (fail-close policy)')
      return {
        passed: false,
        message: '小红帽AI内容审核服务异常，请稍后重试。如问题持续，请联系管理员。'
      }
    }
  }

  /**
   * 提取所有消息内容（用户消息和系统消息）
   * @param {Object} requestBody - Claude API 请求体
   * @returns {string}
   */
  _extractAllContent(requestBody) {
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      return ''
    }

    const allContent = []

    // 遍历所有消息，提取 user 和 system 角色的内容
    for (const message of requestBody.messages) {
      if (message.role === 'user' || message.role === 'system') {
        let content = ''

        // 处理不同类型的 content
        if (typeof message.content === 'string') {
          content = message.content
        } else if (Array.isArray(message.content)) {
          // 提取文本内容（支持多模态）
          const textContents = message.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
          content = textContents.join('\n')
        }

        if (content.trim()) {
          allContent.push(content)
        }
      }
    }

    // 合并所有内容，用双换行符分隔以保持可读性
    return allContent.join('\n\n')
  }

  /**
   * 🔄 调用审核 API（带重试机制）
   * @param {string} userInput - 用户输入内容
   * @returns {Promise<{success: boolean, data?: Object}>}
   */
  async _callModerationAPIWithRetry(userInput) {
    let lastError = null

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        logger.info(`🔄 Moderation attempt ${attempt}/${this.maxRetries}`)

        const result = await this._callModerationAPI(userInput)

        if (result.success) {
          logger.info(`✅ Moderation succeeded on attempt ${attempt}`)
          return result
        }

        // 记录失败但不立即返回，继续重试
        lastError = new Error('API returned success=false')
        logger.warn(`⚠️ Moderation attempt ${attempt} failed, will retry...`)
      } catch (error) {
        lastError = error
        logger.error(`❌ Moderation attempt ${attempt} threw error:`, error.message)
      }

      // 如果不是最后一次尝试，等待后重试（指数退避）
      if (attempt < this.maxRetries) {
        const delay = this.retryDelay * attempt // 1s, 2s, 3s
        logger.info(`⏳ Waiting ${delay}ms before retry...`)
        await this._sleep(delay)
      }
    }

    // 所有重试都失败
    logger.error(
      `❌ All ${this.maxRetries} moderation attempts failed. Last error:`,
      lastError?.message || 'unknown'
    )
    return { success: false }
  }

  /**
   * Sleep 辅助函数
   * @param {number} ms - 等待时间（毫秒）
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * 调用审核 API
   * @param {string} userInput - 用户输入内容
   * @returns {Promise<{success: boolean, data?: Object}>}
   */
  async _callModerationAPI(userInput) {
    try {
      const requestData = {
        top_p: 0.7,
        model: this.model,
        messages: [
          {
            content: this.systemPrompt,
            role: 'system'
          },
          {
            content: userInput,
            role: 'user'
          }
        ],
        response_format: {
          type: 'json_object'
        },
        enable_thinking: false,
        max_tokens: this.maxTokens
      }

      logger.debug('📤 Sending moderation request:', JSON.stringify(requestData, null, 2))

      const startTime = Date.now()
      const response = await axios({
        method: 'POST',
        url: `${this.apiBaseUrl}/v1/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        data: requestData,
        timeout: this.timeout
      })
      const duration = Date.now() - startTime

      logger.info(`📥 Moderation API responded in ${duration}ms`)
      logger.debug('📥 Moderation API response:', JSON.stringify(response.data, null, 2))

      // 解析响应
      if (response.data && response.data.choices && response.data.choices[0]) {
        let content = response.data.choices[0].message.content
        logger.debug('📝 Raw API content:', content)

        // 🔧 自适应 JSON 解析：尝试多种方式提取 JSON
        let result = this._parseJSON(content)

        if (!result) {
          logger.error('❌ Failed to parse JSON from API response')
          return { success: false }
        }

        // 验证响应格式
        if (typeof result.status !== 'string') {
          logger.error('❌ Invalid API response format: missing or invalid status field')
          return { success: false }
        }

        // 标准化字段名（支持 words 或 sensitiveWords）
        const words = result.words || result.sensitiveWords || []

        logger.info(
          `📊 Moderation result: status=${result.status}, words=${JSON.stringify(words)}`
        )

        return {
          success: true,
          data: {
            status: result.status,
            sensitiveWords: words
          }
        }
      }

      logger.error('❌ Invalid API response structure')
      return { success: false }
    } catch (error) {
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        logger.error(`❌ Moderation API timeout (${this.timeout}ms):`, error.message)
      } else if (error.response) {
        logger.error(
          `❌ Moderation API HTTP error ${error.response.status}:`,
          error.response.data
        )
      } else if (error.request) {
        logger.error('❌ Moderation API no response received:', error.message)
      } else {
        logger.error('❌ Moderation API call failed:', error.message)
      }
      return { success: false }
    }
  }

  /**
   * 🔧 自适应 JSON 解析器
   * 尝试多种方式从文本中提取有效的 JSON
   * @param {string} text - 原始文本
   * @returns {Object|null} 解析后的 JSON 对象或 null
   */
  _parseJSON(text) {
    if (!text) return null

    // 方法 1：直接解析（如果是纯 JSON）
    try {
      return JSON.parse(text)
    } catch (e) {
      logger.debug('Method 1 failed: Direct JSON parse')
    }

    // 方法 2：提取 JSON 对象（{...}）
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
    } catch (e) {
      logger.debug('Method 2 failed: Extract JSON object')
    }

    // 方法 3：提取 JSON 数组（[...]）
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
    } catch (e) {
      logger.debug('Method 3 failed: Extract JSON array')
    }

    // 方法 4：清理文本后重试（移除 markdown 代码块）
    try {
      let cleaned = text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim()

      // 再次尝试提取 JSON
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
    } catch (e) {
      logger.debug('Method 4 failed: Clean and extract JSON')
    }

    // 方法 5：尝试修复常见的 JSON 错误
    try {
      let fixed = text
        .replace(/'/g, '"') // 单引号改双引号
        .replace(/,\s*}/g, '}') // 移除末尾逗号
        .replace(/,\s*]/g, ']')

      const jsonMatch = fixed.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
    } catch (e) {
      logger.debug('Method 5 failed: Fix common JSON errors')
    }

    logger.error('❌ All JSON parsing methods failed')
    return null
  }

  /**
   * 记录 NSFW 违规信息到专用日志
   * @param {Object} requestBody - Claude API 请求体
   * @param {Array<string>} sensitiveWords - 违规词汇列表
   * @param {Object} apiKeyInfo - API Key 信息 {keyName, keyId, userId}
   */
  _logNSFWViolation(requestBody, sensitiveWords, apiKeyInfo) {
    try {
      const allContent = this._extractAllContent(requestBody)

      const logEntry = {
        timestamp: new Date().toISOString(),
        apiKey: apiKeyInfo?.keyName || 'unknown',
        keyId: apiKeyInfo?.keyId || 'unknown',
        userId: apiKeyInfo?.userId || 'unknown',
        sensitiveWords: sensitiveWords || [],
        messageCount: requestBody.messages?.length || 0,
        fullContent: allContent
      }

      // 🚨 使用专用的 warn 级别日志记录（便于日志聚合和筛选）
      logger.warn('🚨 NSFW Violation Detected:', JSON.stringify(logEntry, null, 2))
    } catch (error) {
      logger.error('❌ Failed to log NSFW violation:', error)
    }
  }

  /**
   * 格式化错误信息
   * @param {Array<string>} sensitiveWords - 违规词汇列表
   * @returns {string}
   */
  _formatErrorMessage(sensitiveWords) {
    if (!sensitiveWords || sensitiveWords.length === 0) {
      return '小红帽AI检测到违规内容，禁止NSFW，多次输入违规内容将自动封禁。在终端可按ESC+ESC可返回上次输入进行修改。'
    }

    const wordsDisplay = sensitiveWords.join('、')
    return `小红帽AI检测到违规词汇：[${wordsDisplay}]，禁止NSFW，多次输入违规内容将自动封禁。在终端可按ESC+ESC可返回上次输入进行修改。`
  }
}

module.exports = new ContentModerationService()
