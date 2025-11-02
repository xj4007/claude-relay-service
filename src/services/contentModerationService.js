const axios = require('axios')
const logger = require('../utils/logger')
const config = require('../../config/config')

class ContentModerationService {
  constructor() {
    this.enabled = config.contentModeration?.enabled || false
    this.apiBaseUrl = config.contentModeration?.apiBaseUrl

    // 🔑 多API Key支持：优先使用apiKeys数组，向后兼容单个apiKey
    this.apiKeys = config.contentModeration?.apiKeys || []
    if (this.apiKeys.length === 0 && config.contentModeration?.apiKey) {
      // 向后兼容：如果没有apiKeys但有apiKey，使用单个key
      this.apiKeys = [config.contentModeration.apiKey]
    }

    // 当前使用的Key索引（用于轮询）
    this.currentKeyIndex = 0

    this.model = config.contentModeration?.model
    this.advancedModel =
      config.contentModeration?.advancedModel || 'deepseek-ai/DeepSeek-V3.1-Terminus'
    // 🚀 Pro模型配置（TPM更大，用于重试时的备选模型）
    this.proModel = config.contentModeration?.proModel || 'Pro/deepseek-ai/DeepSeek-V3.2-Exp'
    this.enableSecondCheck = config.contentModeration?.enableSecondCheck !== false
    this.maxTokens = config.contentModeration?.maxTokens || 100
    this.timeout = config.contentModeration?.timeout || 10000

    // 🔄 重试配置
    this.maxRetries = config.contentModeration?.maxRetries || 3
    this.retryDelay = config.contentModeration?.retryDelay || 1000
    this.failStrategy = config.contentModeration?.failStrategy || 'fail-close'

    // ✂️ 智能提取配置：每个消息片段截取的最大字符数（减少token消耗）
    this.maxContentLength = config.contentModeration?.maxContentLength || 1000

    // 🔥 熔断机制配置：检测到故障后自动停用审核一段时间
    this.circuitBreakerEnabled = config.contentModeration?.circuitBreakerEnabled !== false
    this.circuitBreakerDuration = config.contentModeration?.circuitBreakerDuration || 5 * 60 * 1000 // 默认5分钟
    this.circuitBreakerTripped = false // 熔断器是否触发
    this.circuitBreakerTrippedAt = null // 熔断触发时间

    // 🚨 性能监控配置：监控硅基流动API性能，自动降级
    this.performanceMonitoringEnabled =
      config.contentModeration?.performanceMonitoringEnabled !== false
    this.slowResponseThreshold = config.contentModeration?.slowResponseThreshold || 10000 // 慢响应阈值（毫秒，默认10秒）
    this.maxConsecutiveFailures = config.contentModeration?.maxConsecutiveFailures || 3 // 连续失败次数阈值
    this.degradationDuration = config.contentModeration?.degradationDuration || 5 * 60 * 1000 // 降级持续时间（默认5分钟）
    this.consecutiveFailures = 0 // 当前连续失败次数
    this.lastSuccessTime = Date.now() // 最后成功时间
    this.isDegraded = false // 是否处于降级状态
    this.degradedAt = null // 降级开始时间

    // 📊 记录每个Key的使用情况
    this.keyStats = this.apiKeys.map((key, index) => ({
      index,
      keyPrefix: this._maskKey(key),
      successCount: 0,
      failureCount: 0,
      lastUsed: null
    }))

    // 日志输出配置信息
    if (this.enabled) {
      logger.info(`🛡️ Content Moderation Enabled with ${this.apiKeys.length} API Key(s)`)
      this.keyStats.forEach((stat) => {
        logger.info(`   - Key ${stat.index + 1}: ${stat.keyPrefix}`)
      })
      logger.info(`✂️ Content truncation enabled: max ${this.maxContentLength} characters`)
      if (this.circuitBreakerEnabled) {
        logger.info(
          `🔥 Circuit breaker enabled: will disable moderation for ${this.circuitBreakerDuration / 1000}s on failure`
        )
      }
      if (this.performanceMonitoringEnabled) {
        logger.info(
          `🚨 Performance monitoring enabled: slow threshold=${this.slowResponseThreshold}ms, max failures=${this.maxConsecutiveFailures}, degradation=${this.degradationDuration / 1000}s`
        )
      }
    }

    // 🛡️ 审核系统提示词（优化版：宽松对待情绪发泄，严格禁止纯NSFW）
    this.systemPrompt = `You are a content moderator. Return JSON only.

⚠️ IMPORTANT: The input is TRUNCATED (first ~${this.maxContentLength} chars each), not complete content.

FORMAT:
{"status":"true","words":["word1"]} = BLOCK (pure NSFW detected)
{"status":"false","words":[]} = ALLOW (safe or acceptable)

RULES:
1. **ALLOW emotional venting** (frustration, complaints, mild profanity) - users need to express emotions
2. **ALLOW violent metaphors in casual context** (e.g., "this bug is killing me", "I'll destroy this code")
3. **BLOCK pure sexual/pornographic content** (explicit NSFW requests with NO technical context)
4. **ALLOW if ANY technical context exists** (code/API/debug/algorithm/function/implement/检测/算法/实现)

EXAMPLES:
✅ "这代码真他妈难写" → ALLOW (frustration, technical context)
✅ "我要杀了这个bug" → ALLOW (violent metaphor, debugging context)
✅ "帮我实现nsfw检测" → ALLOW (technical: implement + detection)
✅ "操，又报错了" → ALLOW (frustration + error context)
✅ "给我暴力破解这个算法" → ALLOW (technical: algorithm)
❌ "我要看色情内容" → BLOCK (pure NSFW, NO technical context)
❌ "给我黄色视频" → BLOCK (pure NSFW request)
❌ "nsfw" (isolated) → BLOCK (no context at all)

When in doubt → ALLOW (better false negative than false positive).`
  }

  /**
   * 主审核方法（三级审核：最后一次输入 → 倒数两次合并 → 高级模型验证）
   * @param {Object} requestBody - Claude API 请求体
   * @param {Object} apiKeyInfo - API Key 信息 {keyName, keyId, userId}
   * @returns {Promise<{passed: boolean, message?: string}>}
   */
  async moderateContent(requestBody, apiKeyInfo = {}) {
    // 功能未启用，直接通过
    if (!this.enabled) {
      return { passed: true }
    }

    // 🔥 熔断器检查：如果熔断器已触发，直接放行所有请求
    if (this.circuitBreakerEnabled && this._isCircuitBreakerTripped()) {
      const remainingTime = this._getCircuitBreakerRemainingTime()
      logger.warn(
        `🔥 Circuit breaker is ACTIVE, bypassing moderation (${Math.ceil(remainingTime / 1000)}s remaining)`
      )
      return { passed: true }
    }

    // 🚨 降级检查：如果处于降级状态，直接放行所有请求
    if (this.performanceMonitoringEnabled && this._isDegraded()) {
      const remainingTime = this._getDegradationRemainingTime()
      logger.warn(
        `🚨 Performance degradation ACTIVE, bypassing moderation (${Math.ceil(remainingTime / 1000)}s remaining, failures: ${this.consecutiveFailures})`
      )
      return { passed: true }
    }

    try {
      // 智能提取审核内容（最后user 50字 + 前一次assistant 50字 + 倒数第二user 50字）
      const contentToModerate = this._extractSmartContent(requestBody)

      // 如果提取内容为空，直接通过
      if (!contentToModerate || contentToModerate.trim().length === 0) {
        logger.warn('⚠️ No content found for moderation')
        return { passed: true }
      }

      logger.info(`🔍 Phase 1: Moderating content with default model ${this.model}`)

      // ========== 第一阶段：默认模型初次审核 ==========
      const firstResult = await this._callModerationAPIWithRetry(contentToModerate, null)

      // 情况1：API调用失败
      if (!firstResult.success) {
        // 🔥 触发熔断器（已在_callModerationAPI中处理）
        if (this.failStrategy === 'fail-open') {
          logger.warn(
            '⚠️ Phase 1 moderation API failed, but using FAIL-OPEN strategy, ALLOWING request'
          )
          return { passed: true }
        } else {
          logger.error(
            '❌ Phase 1 moderation API failed, using FAIL-CLOSE strategy, BLOCKING request'
          )
          return {
            passed: false,
            message:
              '小红帽AI内容审核服务暂不可用，请稍后重试。如问题持续，请联系管理员。\n提示：在 Claude Code 中按 ESC+ESC 可返回上次输入。'
          }
        }
      }

      // 情况2：第一次通过 - 直接放行
      if (firstResult.data.status === 'false') {
        logger.info('✅ Phase 1: Content passed moderation, allowing request')
        return { passed: true }
      }

      // 情况3：第一次判定违规 → 使用高级模型复核
      if (firstResult.data.status === 'true') {
        logger.warn(
          `⚠️ Phase 1: Content flagged by default model, using advanced model ${this.advancedModel} for verification...`
        )
        logger.warn(`   Flagged words: [${firstResult.data.sensitiveWords.join(', ')}]`)

        if (!this.enableSecondCheck) {
          // 如果禁用二次审核，直接拒绝
          logger.error('❌ Second check disabled, BLOCKING request directly')
          this._logNSFWViolation(requestBody, firstResult.data.sensitiveWords, apiKeyInfo)
          return {
            passed: false,
            message: this._formatErrorMessage(firstResult.data.sensitiveWords)
          }
        }

        // ========== 第二阶段：高级模型复核 ==========
        logger.info(`🔍 Phase 2: Verification with advanced model ${this.advancedModel}`)

        const secondResult = await this._callModerationAPIWithRetry(
          contentToModerate,
          this.advancedModel
        )

        // 第二次API调用失败
        if (!secondResult.success) {
          if (this.failStrategy === 'fail-open') {
            logger.warn(
              '⚠️ Phase 2 (advanced model) failed, but using FAIL-OPEN strategy, ALLOWING request'
            )
            return { passed: true }
          } else {
            // fail-close 策略：使用第一次审核结果拒绝请求
            logger.error(
              '❌ Phase 2 (advanced model) failed, applying FAIL-CLOSE policy, BLOCKING request'
            )
            this._logNSFWViolation(requestBody, firstResult.data.sensitiveWords, apiKeyInfo)
            return {
              passed: false,
              message: this._formatErrorMessage(firstResult.data.sensitiveWords)
            }
          }
        }

        // 高级模型通过 → 误判纠正，放行
        if (secondResult.data.status === 'false') {
          logger.info(
            `✅ Phase 2: Advanced model ${this.advancedModel} passed (false positive corrected), allowing request`
          )
          return { passed: true }
        }

        // 高级模型仍然违规 → 确认违规，拒绝请求
        logger.error(
          `🚫 Phase 2: CONFIRMED violation by advanced model ${this.advancedModel}, words: [${secondResult.data.sensitiveWords.join(', ')}]`
        )
        this._logNSFWViolation(requestBody, secondResult.data.sensitiveWords, apiKeyInfo)
        return {
          passed: false,
          message: this._formatErrorMessage(secondResult.data.sensitiveWords)
        }
      }

      // 所有审核通过
      logger.info('✅ All content moderation passed')
      return { passed: true }
    } catch (error) {
      logger.error('❌ Content moderation error:', error)
      // 🔥 触发熔断器：异常情况也算作故障
      this._tripCircuitBreaker()

      // 🔴 异常情况 - 根据failStrategy决定策略
      if (this.failStrategy === 'fail-open') {
        logger.warn('⚠️ Exception in moderation, but using FAIL-OPEN strategy, ALLOWING request')
        logger.warn(
          '   Reason: Unexpected error in moderation service, allowing request to proceed'
        )
        return { passed: true }
      } else {
        // fail-close 策略（默认）
        logger.error('❌ Exception in moderation, using FAIL-CLOSE strategy, BLOCKING request')
        return {
          passed: false,
          message: '小红帽AI内容审核服务异常，请稍后重试。如问题持续，请联系管理员。'
        }
      }
    }
  }

  /**
   * 🔥 触发熔断器（检测到审核服务故障）
   */
  _tripCircuitBreaker() {
    if (!this.circuitBreakerEnabled) {
      return
    }

    if (!this.circuitBreakerTripped) {
      this.circuitBreakerTripped = true
      this.circuitBreakerTrippedAt = Date.now()
      logger.error(
        `🔥 CIRCUIT BREAKER TRIPPED! Moderation service disabled for ${this.circuitBreakerDuration / 1000}s`
      )
      logger.error('   All subsequent requests will BYPASS moderation until circuit breaker resets')
    }
  }

  /**
   * 🔥 检查熔断器是否已触发
   * @returns {boolean}
   */
  _isCircuitBreakerTripped() {
    if (!this.circuitBreakerTripped) {
      return false
    }

    const elapsed = Date.now() - this.circuitBreakerTrippedAt
    if (elapsed >= this.circuitBreakerDuration) {
      // 熔断器超时，自动重置
      this._resetCircuitBreaker()
      return false
    }

    return true
  }

  /**
   * 🔥 重置熔断器
   */
  _resetCircuitBreaker() {
    if (this.circuitBreakerTripped) {
      logger.info('🔥 Circuit breaker RESET, moderation service re-enabled')
      this.circuitBreakerTripped = false
      this.circuitBreakerTrippedAt = null
    }
  }

  /**
   * 🔥 获取熔断器剩余时间（毫秒）
   * @returns {number}
   */
  _getCircuitBreakerRemainingTime() {
    if (!this.circuitBreakerTripped) {
      return 0
    }

    const elapsed = Date.now() - this.circuitBreakerTrippedAt
    const remaining = this.circuitBreakerDuration - elapsed
    return Math.max(0, remaining)
  }

  /**
   * 🚨 检查是否处于降级状态
   * @returns {boolean}
   */
  _isDegraded() {
    if (!this.isDegraded) {
      return false
    }

    const elapsed = Date.now() - this.degradedAt
    if (elapsed >= this.degradationDuration) {
      // 降级超时，自动重置
      this._resetDegradation()
      return false
    }

    return true
  }

  /**
   * 🚨 触发降级（检测到性能问题）
   * @param {string} reason - 降级原因
   */
  _triggerDegradation(reason) {
    if (!this.performanceMonitoringEnabled) {
      return
    }

    if (!this.isDegraded) {
      this.isDegraded = true
      this.degradedAt = Date.now()
      logger.error(
        `🚨 PERFORMANCE DEGRADATION TRIGGERED! Reason: ${reason}. Moderation service disabled for ${this.degradationDuration / 1000}s`
      )
      logger.error(
        `   All subsequent requests will BYPASS moderation until degradation period ends`
      )
      logger.error(`   Consecutive failures: ${this.consecutiveFailures}`)
    }
  }

  /**
   * 🚨 重置降级状态
   */
  _resetDegradation() {
    if (this.isDegraded) {
      logger.info('🚨 Performance degradation RESET, moderation service re-enabled')
      logger.info(`   Will monitor performance again. Last failures: ${this.consecutiveFailures}`)
      this.isDegraded = false
      this.degradedAt = null
      this.consecutiveFailures = 0 // 重置失败计数
    }
  }

  /**
   * 🚨 获取降级剩余时间（毫秒）
   * @returns {number}
   */
  _getDegradationRemainingTime() {
    if (!this.isDegraded) {
      return 0
    }

    const elapsed = Date.now() - this.degradedAt
    const remaining = this.degradationDuration - elapsed
    return Math.max(0, remaining)
  }

  /**
   * 🚨 记录API调用成功（重置性能计数器）
   */
  _recordPerformanceSuccess() {
    if (!this.performanceMonitoringEnabled) {
      return
    }

    // 成功调用，重置失败计数
    if (this.consecutiveFailures > 0) {
      logger.info(
        `✅ API call succeeded, resetting failure count (was: ${this.consecutiveFailures})`
      )
      this.consecutiveFailures = 0
    }
    this.lastSuccessTime = Date.now()
  }

  /**
   * 🚨 记录API调用失败或慢响应（累加失败计数，可能触发降级）
   * @param {string} reason - 失败原因
   */
  _recordPerformanceFailure(reason) {
    if (!this.performanceMonitoringEnabled) {
      return
    }

    this.consecutiveFailures++
    logger.warn(
      `⚠️ Performance issue detected: ${reason} (consecutive failures: ${this.consecutiveFailures}/${this.maxConsecutiveFailures})`
    )

    // 达到阈值，触发降级
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this._triggerDegradation(
        `Reached ${this.maxConsecutiveFailures} consecutive failures/slow responses`
      )
    }
  }

  /**
   * 🔑 脱敏Key（显示前6位和后4位）
   * @param {string} key - API Key
   * @returns {string}
   */
  _maskKey(key) {
    if (!key || key.length < 10) {
      return '***'
    }
    return `${key.substring(0, 6)}...${key.substring(key.length - 4)}`
  }

  /**
   * ✂️ 截断内容（如果超过最大长度）
   * @param {string} content - 原始内容
   * @returns {string} 截断后的内容
   */
  _truncateContent(content) {
    if (!content) {
      return ''
    }

    if (content.length <= this.maxContentLength) {
      return content
    }

    const truncated = content.substring(0, this.maxContentLength)
    logger.info(
      `✂️ Content truncated from ${content.length} to ${this.maxContentLength} characters`
    )
    return truncated
  }

  /**
   * 🔄 获取下一个可用的API Key（轮询策略）
   * @returns {string|null}
   */
  _getNextApiKey() {
    if (this.apiKeys.length === 0) {
      return null
    }

    // 从当前索引开始轮询
    const key = this.apiKeys[this.currentKeyIndex]
    const keyInfo = this.keyStats[this.currentKeyIndex]

    // 更新最后使用时间
    keyInfo.lastUsed = new Date().toISOString()

    logger.info(
      `🔑 Using API Key ${this.currentKeyIndex + 1}/${this.apiKeys.length}: ${keyInfo.keyPrefix}`
    )

    return key
  }

  /**
   * 🔄 切换到下一个API Key
   * @returns {boolean} 是否还有可用的Key
   */
  _switchToNextKey() {
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length

    // 如果已经轮询回到第一个Key，说明所有Key都试过了
    if (this.currentKeyIndex === 0) {
      return false // 没有更多Key了
    }

    return true // 还有其他Key可以尝试
  }

  /**
   * 📊 记录Key使用成功
   * @param {number} keyIndex - Key索引
   */
  _recordKeySuccess(keyIndex) {
    if (this.keyStats[keyIndex]) {
      this.keyStats[keyIndex].successCount++
      logger.info(`✅ Key ${keyIndex + 1} success: ${this.keyStats[keyIndex].successCount} times`)
    }
  }

  /**
   * 📊 记录Key使用失败
   * @param {number} keyIndex - Key索引
   */
  _recordKeyFailure(keyIndex) {
    if (this.keyStats[keyIndex]) {
      this.keyStats[keyIndex].failureCount++
      logger.warn(`❌ Key ${keyIndex + 1} failure: ${this.keyStats[keyIndex].failureCount} times`)
    }
  }

  /**
   * 智能提取审核内容（优化版：截取关键片段，减少token消耗）
   * 提取策略：
   * 1. 最后一次用户输入（截取前N字符，N由maxContentLength配置）
   * 2. 前一次assistant回复（如果存在，截取前N字符）
   * 3. 倒数第二次用户输入（如果存在，截取前N字符）
   *
   * @param {Object} requestBody - Claude API 请求体
   * @returns {string} 组合后的审核内���
   */
  _extractSmartContent(requestBody) {
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      return ''
    }

    const messages = requestBody.messages
    const parts = []
    let foundLastUser = false
    let foundAssistant = false
    let foundSecondUser = false

    // 倒序遍历消息
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      let content = ''

      // 提取文本内容
      if (typeof message.content === 'string') {
        content = message.content
      } else if (Array.isArray(message.content)) {
        const textContents = message.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
        content = textContents.join('\n')
      }

      if (!content.trim()) {
        continue
      }

      // 截取前N字符（由配置决定）
      const truncated = content.substring(0, this.maxContentLength)

      // 按顺序提取：最后user → 前一次assistant → 倒数第二user
      if (message.role === 'user' && !foundLastUser) {
        // 最后一次用户输入
        parts.unshift(`User: ${truncated}`)
        foundLastUser = true
      } else if (message.role === 'assistant' && foundLastUser && !foundAssistant) {
        // 前一次assistant回复
        parts.unshift(`Assistant: ${truncated}`)
        foundAssistant = true
      } else if (message.role === 'user' && foundLastUser && !foundSecondUser) {
        // 倒数第二次用户输入
        parts.unshift(`User(prev): ${truncated}`)
        foundSecondUser = true
        break // 已经收集够了，停止
      }
    }

    // 组合内容，用双换行分隔
    const combined = parts.join('\n\n')
    logger.info(
      `📝 Smart content extraction: ${parts.length} parts, total ${combined.length} chars`
    )
    return combined
  }

  /**
   * 提取最后一条用户消息（自动截断超长内容）
   * @param {Object} requestBody - Claude API 请求体
   * @returns {string}
   */
  _extractLastUserMessage(requestBody) {
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      return ''
    }

    // 倒序查找最后一条用户消息
    for (let i = requestBody.messages.length - 1; i >= 0; i--) {
      const message = requestBody.messages[i]
      if (message.role === 'user') {
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

        // ✂️ 截断超长内容
        return this._truncateContent(content)
      }
    }

    return ''
  }

  /**
   * 提取最后两条用户消息（倒数第二条 + 最后一条，合并，自动截断）
   * @param {Object} requestBody - Claude API 请求体
   * @returns {string}
   */
  _extractLastTwoUserMessages(requestBody) {
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      return ''
    }

    const userMessages = []

    // 倒序查找用户消息
    for (let i = requestBody.messages.length - 1; i >= 0; i--) {
      const message = requestBody.messages[i]
      if (message.role === 'user') {
        // 处理不同类型的 content
        let content = ''
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
          userMessages.push(content)
        }

        // 找到两条就停止
        if (userMessages.length === 2) {
          break
        }
      }
    }

    // 如果只有一条消息，截断后返回
    if (userMessages.length === 1) {
      return this._truncateContent(userMessages[0])
    }

    // 如果有两条消息，倒序合并（倒数第二条在前，最后一条在后），然后截断
    if (userMessages.length === 2) {
      const combined = `${userMessages[1]}\n\n${userMessages[0]}`
      return this._truncateContent(combined)
    }

    return ''
  }

  /**
   * 提取最后一条用户消息（不再包含 Assistant 回复，避免 token 过大导致 TPM 超限，自动截断）
   * @param {Object} requestBody - Claude API 请求体
   * @returns {string}
   */
  _extractLastUserMessageWithContext(requestBody) {
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      return ''
    }

    // 倒序查找最后一条用户消息
    for (let i = requestBody.messages.length - 1; i >= 0; i--) {
      const message = requestBody.messages[i]
      if (message.role === 'user') {
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

        // ✂️ 截断超长内容
        return this._truncateContent(content)
      }
    }

    return ''
  }

  /**
   * 提取所有用户消息（数组格式，用于违规日志）
   * @param {Object} requestBody - Claude API 请求体
   * @returns {Array<string>}
   */
  _extractUserMessages(requestBody) {
    if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
      return []
    }

    const userMessages = []

    // 遍历所有消息，提取 user 角色的内容
    for (const message of requestBody.messages) {
      if (message.role === 'user') {
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
          userMessages.push(content)
        }
      }
    }

    return userMessages
  }

  /**
   * 🔄 调用审核 API（带模型级联重试和多Key轮询）
   * 重试策略：
   * 1. 对当前Key，先用默认模型重试maxRetries次
   * 2. 如果失败，换成Pro模型重试maxRetries次
   * 3. 如果还失败，切换到下一个API Key
   * 4. 对新Key重复步骤1-2
   *
   * @param {string} userInput - 用户输入内容
   * @param {string} modelOverride - 可选的模型覆盖参数（如果提供，则跳过模型级联，直接使用该模型）
   * @returns {Promise<{success: boolean, data?: Object}>}
   */
  async _callModerationAPIWithRetry(userInput, modelOverride = null) {
    // 🔄 多Key轮询策略
    const totalKeys = this.apiKeys.length
    if (totalKeys === 0) {
      logger.error('❌ No API keys configured for content moderation')
      return { success: false }
    }

    // 重置到第一个Key开始
    this.currentKeyIndex = 0
    let keysAttempted = 0

    // 外层循环：遍历所有API Key
    while (keysAttempted < totalKeys) {
      const currentKey = this._getNextApiKey()
      const currentKeyIndex = this.currentKeyIndex
      let lastError = null

      logger.info(
        `🔑 Trying Key ${currentKeyIndex + 1}/${totalKeys}: ${this.keyStats[currentKeyIndex].keyPrefix}`
      )

      // 🚀 模型级联重试策略（如果有modelOverride则跳过级联）
      const modelsToTry = modelOverride ? [modelOverride] : [this.model, this.proModel] // 默认模型 → Pro模型

      let modelIndex = 0
      for (const currentModel of modelsToTry) {
        modelIndex++
        const isProModel = currentModel === this.proModel
        const modelLabel = isProModel ? 'Pro Model' : 'Default Model'

        logger.info(
          `📋 Key ${currentKeyIndex + 1} - Trying ${modelLabel} (${modelIndex}/${modelsToTry.length}): ${currentModel}`
        )

        // 内层循环：对当前模型重试maxRetries次
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
          try {
            logger.info(
              `🔄 Key ${currentKeyIndex + 1} - ${modelLabel} - Attempt ${attempt}/${this.maxRetries}`
            )

            const result = await this._callModerationAPI(userInput, currentModel, currentKey)

            if (result.success) {
              logger.info(
                `✅ Moderation succeeded! Key ${currentKeyIndex + 1}, ${modelLabel}, attempt ${attempt}`
              )
              this._recordKeySuccess(currentKeyIndex)
              return result
            }

            // 记录失败但不立即返回，继续重试
            lastError = new Error('API returned success=false')
            logger.warn(
              `⚠️ Key ${currentKeyIndex + 1} - ${modelLabel} - Attempt ${attempt} failed, will retry...`
            )
          } catch (error) {
            lastError = error
            logger.error(
              `❌ Key ${currentKeyIndex + 1} - ${modelLabel} - Attempt ${attempt} threw error:`,
              error.message
            )
          }

          // 如果不是最后一次尝试，等待后重试（指数退避）
          if (attempt < this.maxRetries) {
            const delay = this.retryDelay * attempt // 1s, 2s, 3s
            logger.info(`⏳ Waiting ${delay}ms before retry...`)
            await this._sleep(delay)
          }
        }

        // 当前模型的所有重试都失败了
        logger.error(
          `❌ All ${this.maxRetries} attempts failed for Key ${currentKeyIndex + 1} with ${modelLabel} (${currentModel})`
        )

        // 如果还有下一个模型（Pro模型），不等待直接尝试
        if (modelIndex < modelsToTry.length) {
          logger.warn(
            `🔄 Switching to ${modelsToTry[modelIndex] === this.proModel ? 'Pro Model (higher TPM)' : 'next model'}...`
          )
        }
      }

      // 当前Key的所有模型都失败了
      this._recordKeyFailure(currentKeyIndex)
      logger.error(
        `❌ All models exhausted for Key ${currentKeyIndex + 1}/${totalKeys}. Tried: ${modelsToTry.join(' → ')}. Last error:`,
        lastError?.message || 'unknown'
      )

      // 切换到下一个Key
      keysAttempted++
      if (keysAttempted < totalKeys) {
        logger.warn(`🔄 Switching to next API Key (${keysAttempted + 1}/${totalKeys})...`)
        this._switchToNextKey()
      }
    }

    // 所有Key都失败了
    const totalAttempts = modelOverride
      ? totalKeys * this.maxRetries
      : totalKeys * 2 * this.maxRetries // 2个模型
    logger.error(`❌ All ${totalKeys} API Key(s) exhausted. Total attempts: ${totalAttempts}`)
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
   * @param {string} model - 使用的模型
   * @param {string} apiKey - 使用的API Key
   * @returns {Promise<{success: boolean, data?: Object}>}
   */
  async _callModerationAPI(userInput, model, apiKey) {
    try {
      const requestData = {
        top_p: 0.7,
        model,
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
        // enable_thinking: false,
        max_tokens: this.maxTokens
      }

      const startTime = Date.now()
      const response = await axios({
        method: 'POST',
        url: `${this.apiBaseUrl}/v1/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        data: requestData,
        timeout: this.timeout
      })
      const duration = Date.now() - startTime

      logger.info(`📥 Moderation API (${model}) responded in ${duration}ms`)

      // 🚨 性能监控：检查响应时间
      if (this.performanceMonitoringEnabled) {
        if (duration > this.slowResponseThreshold) {
          this._recordPerformanceFailure(
            `Slow response: ${duration}ms > ${this.slowResponseThreshold}ms`
          )
        } else {
          this._recordPerformanceSuccess()
        }
      }

      // 解析响应
      if (response.data && response.data.choices && response.data.choices[0]) {
        const { content } = response.data.choices[0].message

        // 🔧 自适应 JSON 解析：尝试多种方式提取 JSON
        const result = this._parseJSON(content)

        if (!result) {
          logger.error('❌ Failed to parse JSON from API response')
          // 🚨 解析失败也算性能问题
          if (this.performanceMonitoringEnabled) {
            this._recordPerformanceFailure('JSON parse failure')
          }
          return { success: false }
        }

        // 验证响应格式
        if (typeof result.status !== 'string') {
          logger.error('❌ Invalid API response format: missing or invalid status field')
          // 🚨 格式错误也算性能问题
          if (this.performanceMonitoringEnabled) {
            this._recordPerformanceFailure('Invalid response format')
          }
          return { success: false }
        }

        // 标准化字段名（支持 words 或 sensitiveWords）
        const words = result.words || result.sensitiveWords || []

        logger.info(`📊 Moderation result: status=${result.status}, words=${JSON.stringify(words)}`)

        return {
          success: true,
          data: {
            status: result.status,
            sensitiveWords: words
          }
        }
      }

      logger.error('❌ Invalid API response structure')
      // 🚨 响应结构错误
      if (this.performanceMonitoringEnabled) {
        this._recordPerformanceFailure('Invalid response structure')
      }
      return { success: false }
    } catch (error) {
      // 🚨 异常情况都算性能问题
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        logger.error(`❌ Moderation API timeout (${this.timeout}ms):`, error.message)
        if (this.performanceMonitoringEnabled) {
          this._recordPerformanceFailure(`Timeout: ${this.timeout}ms`)
        }
      } else if (error.response) {
        logger.error(`❌ Moderation API HTTP error ${error.response.status}:`, error.response.data)
        if (this.performanceMonitoringEnabled) {
          this._recordPerformanceFailure(`HTTP ${error.response.status} error`)
        }
      } else if (error.request) {
        logger.error('❌ Moderation API no response received:', error.message)
        if (this.performanceMonitoringEnabled) {
          this._recordPerformanceFailure('No response received')
        }
      } else {
        logger.error('❌ Moderation API call failed:', error.message)
        if (this.performanceMonitoringEnabled) {
          this._recordPerformanceFailure(`Request failed: ${error.message}`)
        }
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
    if (!text) {
      return null
    }

    // 方法 1：直接解析（如果是纯 JSON）
    try {
      return JSON.parse(text)
    } catch (e) {
      // 忽略错误，尝试下一个方法
    }

    // 方法 2：提取 JSON 对象（{...}）
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
    } catch (e) {
      // 忽略错误，尝试下一个方法
    }

    // 方法 3：提取 JSON 数组（[...]）
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
    } catch (e) {
      // 忽略错误，尝试下一个方法
    }

    // 方法 4：清理文本后重试（移除 markdown 代码块）
    try {
      const cleaned = text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim()

      // 再次尝试提取 JSON
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
    } catch (e) {
      // 忽略错误，尝试下一个方法
    }

    // 方法 5：尝试修复常见的 JSON 错误
    try {
      const fixed = text
        .replace(/'/g, '"') // 单引号改双引号
        .replace(/,\s*}/g, '}') // 移除末尾逗号
        .replace(/,\s*]/g, ']')

      const jsonMatch = fixed.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0])
      }
    } catch (e) {
      // 忽略错误
    }

    logger.error('❌ All JSON parsing methods failed')
    return null
  }

  /**
   * 记录 NSFW 违规信息到专用日志（完整记录用户输入）
   * @param {Object} requestBody - Claude API 请求体
   * @param {Array<string>} sensitiveWords - 违规词汇列表
   * @param {Object} apiKeyInfo - API Key 信息 {keyName, keyId, userId}
   */
  _logNSFWViolation(requestBody, sensitiveWords, apiKeyInfo) {
    try {
      // 提取所有用户消息
      const userMessages = this._extractUserMessages(requestBody)

      const logEntry = {
        timestamp: new Date().toISOString(),
        apiKey: apiKeyInfo?.keyName || 'unknown',
        keyId: apiKeyInfo?.keyId || 'unknown',
        userId: apiKeyInfo?.userId || 'unknown',
        sensitiveWords: sensitiveWords || [],
        messageCount: requestBody.messages?.length || 0,

        // 📝 详细的违规内容记录
        violation: {
          userMessages, // 用户输入的所有消息（完整内容）
          model: requestBody.model || 'unknown', // 请求的模型
          maxTokens: requestBody.max_tokens || 'N/A' // 最大token数
        }
      }

      // 🚨 使用专用的 warn 级别日志记录（便于日志聚合和筛选）
      logger.warn('🚨 NSFW Violation Detected - Full Details:')
      logger.warn(JSON.stringify(logEntry, null, 2))

      // 📋 额外输出更易读的格式（方便快速核查）
      logger.warn('='.repeat(80))
      logger.warn('📋 NSFW Violation Summary:')
      logger.warn('='.repeat(80))
      logger.warn(`⏰ Timestamp: ${logEntry.timestamp}`)
      logger.warn(`🔑 API Key: ${logEntry.apiKey}`)
      logger.warn(`🆔 Key ID: ${logEntry.keyId}`)
      logger.warn(`👤 User ID: ${logEntry.userId}`)
      logger.warn(`⚠️  Sensitive Words: [${sensitiveWords.join(', ')}]`)
      logger.warn(`📊 Total Messages: ${logEntry.messageCount}`)
      logger.warn(`🤖 Model: ${logEntry.violation.model}`)
      logger.warn('-'.repeat(80))
      logger.warn('📝 User Messages (FULL CONTENT):')
      logger.warn('-'.repeat(80))

      // 完整输出每条用户消息（不截断）
      userMessages.forEach((msg, idx) => {
        logger.warn(`\n[Message ${idx + 1}/${userMessages.length}]:`)
        logger.warn(msg)
        logger.warn('-'.repeat(80))
      })

      logger.warn('='.repeat(80))
    } catch (error) {
      logger.error('❌ Failed to log NSFW violation:', error)
    }
  }

  /**
   * 格式化错误信息（优化后的提示词）
   * @param {Array<string>} sensitiveWords - 违规词汇列表
   * @returns {string}
   */
  _formatErrorMessage(sensitiveWords) {
    const baseMessage = `小红帽AI内容安全提示:本平台仅允许输入技术或编程相关的内容，禁止输入NSFW（色情、暴力、违法等不适当内容）。   
${sensitiveWords && sensitiveWords.length > 0 ? `检测到敏感词汇：[${sensitiveWords.join('、')}]   ` : ''} 如果您正在讨论技术问题（如实现内容过滤算法、安全审核系统等），请确保：
1.包含明确的编程关键词（代码、函数、API、实现、算法等）
2.提供清晰的技术上下文
3.使用专业的技术术语
提示：在Claude Code终端中按ESC+ESC， 返回上次输入进行修改。多次输入违规内容将导致账号被自动封禁。感谢您的理解与配合！`
    return baseMessage
  }
}

module.exports = new ContentModerationService()
