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

    // 审核系统提示词
    this.systemPrompt = `You are a content safety moderator. For technical inputs (code/project discussions), always return {"status":"false", "sensitiveWords":[]}.

For other inputs, check for:
1) Political sensitivity (negative comments on politicians/events/systems)
2) Pornography (explicit sexual content)
3) Extreme violence (detailed violence/terrorism/self-harm)
4) Racial discrimination
5) Illegal activities (crime/drugs/fraud)

Allow normal emotions and mild complaints. Return JSON with status (true=violation) and sensitiveWords array.`
  }

  /**
   * 主审核方法
   * @param {Object} requestBody - Claude API 请求体
   * @returns {Promise<{passed: boolean, message?: string}>}
   */
  async moderateContent(requestBody) {
    // 功能未启用，直接通过
    if (!this.enabled) {
      return { passed: true }
    }

    try {
      // 提取用户输入
      const userInput = this._extractUserInput(requestBody)

      if (!userInput || userInput.trim().length === 0) {
        logger.warn('⚠️ No user input found for moderation')
        return { passed: true }
      }

      logger.info(`🔍 Starting content moderation for input: ${userInput.substring(0, 100)}...`)

      // 调用审核 API
      const moderationResult = await this._callModerationAPI(userInput)

      if (moderationResult.success) {
        if (moderationResult.data.status === 'true') {
          // 检测到违规
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
        // API 调用失败，直接放行（避免误杀）
        logger.warn('⚠️ Moderation API failed, allowing request to pass (fail-open policy)')
        return { passed: true }
      }
    } catch (error) {
      logger.error('❌ Content moderation error:', error)
      // 出错时默认通过，避免影响正常服务（宁可放过，不可误杀）
      return { passed: true }
    }
  }

  /**
   * 提取用户输入的最后一条消息
   * @param {Object} requestBody - Claude API 请求体
   * @returns {string}
   */
  _extractUserInput(requestBody) {
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      return ''
    }

    // 获取最后一条用户消息
    for (let i = requestBody.messages.length - 1; i >= 0; i--) {
      const message = requestBody.messages[i]
      if (message.role === 'user') {
        // 处理不同类型的 content
        if (typeof message.content === 'string') {
          return message.content
        } else if (Array.isArray(message.content)) {
          // 提取文本内容
          const textContents = message.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
          return textContents.join('\n')
        }
      }
    }

    return ''
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

      logger.debug('📥 Moderation API response:', JSON.stringify(response.data, null, 2))

      // 解析响应
      if (response.data && response.data.choices && response.data.choices[0]) {
        const content = response.data.choices[0].message.content
        const result = JSON.parse(content)

        return {
          success: true,
          data: result
        }
      }

      return { success: false }
    } catch (error) {
      logger.error('❌ Moderation API call failed:', error.message)
      return { success: false }
    }
  }

  /**
   * 格式化错误信息
   * @param {Array<string>} sensitiveWords - 违规词汇列表
   * @returns {string}
   */
  _formatErrorMessage(sensitiveWords) {
    if (!sensitiveWords || sensitiveWords.length === 0) {
      return '检测到违规内容，请修改后重试。在Claude Code中按ESC+ESC可返回上次输入进行修改。'
    }

    const wordsDisplay = sensitiveWords.join('、')
    return `检测到违规词汇：[${wordsDisplay}]，请修改后重试。在Claude Code中按ESC+ESC可返回上次输入进行修改。`
  }
}

module.exports = new ContentModerationService()
