const logger = require('./logger')

/**
 * 🔄 服务器端重试管理器
 * 处理5xx错误的自动重试和账户切换
 *
 * 功能：
 * 1. 5xx错误：立即重试3次
 * 2. 超时错误：等待180秒再切换账户
 * 3. 自动排除失败的账户
 * 4. 重试之间无延迟（立即重试）
 */
class RetryManager {
  constructor() {
    // 配置参数
    this.MAX_RETRIES = 2 // 🎯 优化: 5xx错误最大重试次数从3减少到2 (总共尝试3次)
    this.RETRY_DELAY = 0 // 重试延迟（毫秒），0表示立即重试
    this.SLOW_RESPONSE_TIMEOUT = 180000 // 慢响应超时（180秒）
    this.RETRYABLE_STATUS_CODES = [500, 502, 503, 504] // 可重试的状态码
  }

  /**
   * 检查错误是否可以重试
   * @param {number} statusCode - HTTP状态码
   * @param {Error} error - 错误对象
   * @returns {boolean}
   */
  isRetryableError(statusCode, error) {
    // 5xx错误可重试
    if (this.RETRYABLE_STATUS_CODES.includes(statusCode)) {
      return true
    }

    // 网络错误可重试
    if (
      error &&
      (error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNABORTED' ||
        error.message.includes('socket hang up') ||
        error.message.includes('Connection reset'))
    ) {
      return true
    }

    return false
  }

  /**
   * 检查是否应该立即重试（vs 等待后重试）
   * @param {number} statusCode - HTTP状态码
   * @returns {boolean}
   */
  shouldRetryImmediately(statusCode) {
    // 5xx错误立即重试
    return this.RETRYABLE_STATUS_CODES.includes(statusCode)
  }

  /**
   * 检测是否为需要强制切换账号的特殊错误（如 Cloudflare 524、官方 400）
   * @param {Object} response - 上游响应
   * @returns {string|null} - 需要切换账号时返回原因描述，否则返回 null
   */
  _shouldSwitchAccountForSpecialError(response) {
    if (!response || !response.statusCode) {
      return null
    }

    const { statusCode } = response
    let bodyText = ''

    if (typeof response.body === 'string') {
      bodyText = response.body
    } else if (response.body !== undefined && response.body !== null) {
      try {
        bodyText = JSON.stringify(response.body)
      } catch (error) {
        bodyText = String(response.body)
      }
    }

    const normalizedText = bodyText.toLowerCase()

    if (statusCode === 400) {
      const thinkingMismatch =
        normalizedText.includes('expected `thinking`') &&
        normalizedText.includes('found `tool_use`')

      if (thinkingMismatch) {
        return 'thinking/tool_use format mismatch'
      }

      const officialInternalError =
        normalizedText.includes('"type":"internal_error"') ||
        normalizedText.includes('\'type\':\'internal_error\'') ||
        normalizedText.includes('server internal error, please contact admin')

      if (officialInternalError) {
        return 'official internal error 400'
      }

      // 🆕 检测 thinking.budget_tokens 相关错误
      const thinkingBudgetError =
        normalizedText.includes('max_tokens') &&
        normalizedText.includes('thinking.budget_tokens')

      if (thinkingBudgetError) {
        return 'thinking budget tokens validation error'
      }
    }

    if (statusCode === 524) {
      return 'cloudflare timeout 524'
    }

    // 🆕 检测 403 权限错误（会话过多、账户限制等）
    if (statusCode === 403) {
      const tooManySessions =
        normalizedText.includes('too many active sessions') ||
        normalizedText.includes('permission_error')

      if (tooManySessions) {
        return 'too many active sessions (403)'
      }

      // 其他 403 权限错误也应该切换账户
      if (normalizedText.includes('permission') || normalizedText.includes('forbidden')) {
        return 'permission denied (403)'
      }
    }

    return null
  }

  /**
   * 执行带重试的请求
   * @param {Function} requestFn - 请求函数 async (accountId, accountType) => response
   * @param {Function} accountSelectorFn - 账户选择函数 async (excludedAccounts) => { accountId, accountType }
   * @param {Object} options - 配置选项
   * @param {number} options.maxRetries - 最大重试次数（可选，默认使用MAX_RETRIES）
   * @param {Array<string>} options.initialExcludedAccounts - 初始排除的账户ID列表
   * @returns {Promise<Object>} - 响应对象 { success: boolean, response?: Object, error?: Error, attempts: number }
   */
  async executeWithRetry(requestFn, accountSelectorFn, options = {}) {
    const maxRetries = options.maxRetries || this.MAX_RETRIES
    const excludedAccounts = new Set(options.initialExcludedAccounts || [])

    let lastError = null
    let attempts = 0

    // 尝试主请求 + 重试
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts++

      try {
        // 选择账户（排除已失败的账户）
        const { accountId, accountType } = await accountSelectorFn(Array.from(excludedAccounts))

        if (!accountId) {
          logger.error('❌ No available accounts after excluding failed ones')
          break
        }

        logger.info(
          `🔄 Attempt ${attempts}/${maxRetries + 1} using account: ${accountId} (${accountType})`
        )

        // 执行请求
        const response = await requestFn(accountId, accountType)

        // 检查响应状态
        if (response.statusCode >= 200 && response.statusCode < 300) {
          // 成功响应
          logger.info(`✅ Request succeeded on attempt ${attempts}`)
          return {
            success: true,
            response,
            attempts,
            accountId,
            accountType
          }
        }

        const specialErrorReason = this._shouldSwitchAccountForSpecialError(response)
        if (specialErrorReason) {
          excludedAccounts.add(accountId)
          lastError = new Error(`HTTP ${response.statusCode}: ${response.body}`)
          const hasMoreAttempts = attempt < maxRetries
          logger.warn(
            hasMoreAttempts
              ? `⚠️ Detected non-retryable ${response.statusCode} (${specialErrorReason}) on account ${accountId}, switching to another account`
              : `⚠️ Detected non-retryable ${response.statusCode} (${specialErrorReason}) on account ${accountId}, but no alternative accounts available`
          )

          if (hasMoreAttempts) {
            continue
          }

          break
        }

        // 检查是否可重试
        const isRetryable = this.isRetryableError(response.statusCode, null)
        if (!isRetryable) {
          logger.warn(`⚠️ Non-retryable error: ${response.statusCode}, stopping retry`)
          return {
            success: false,
            error: new Error(`HTTP ${response.statusCode}: ${response.body}`),
            response,
            attempts,
            accountId,
            accountType
          }
        }

        // 记录失败的账户
        excludedAccounts.add(accountId)
        lastError = new Error(`HTTP ${response.statusCode}: ${response.body}`)

        logger.warn(
          `⚠️ Attempt ${attempts} failed with ${response.statusCode}, excluding account ${accountId}`
        )

        // 如果还有重试机会，等待一下
        if (attempt < maxRetries) {
          const shouldRetryNow = this.shouldRetryImmediately(response.statusCode)
          if (shouldRetryNow) {
            logger.info(`🔄 Retrying immediately...`)
            // 立即重试（无延迟）
            continue
          } else {
            logger.info(`⏱️ Waiting ${this.SLOW_RESPONSE_TIMEOUT / 1000}s before retry...`)
            await this._delay(this.SLOW_RESPONSE_TIMEOUT)
          }
        }
      } catch (error) {
        lastError = error

        // 记录当前账户失败（如果有）
        if (error.accountId) {
          excludedAccounts.add(error.accountId)
        }

        // 检查是否可重试
        const isRetryable = this.isRetryableError(null, error)
        if (!isRetryable) {
          logger.error(`❌ Non-retryable error: ${error.message}`)
          return {
            success: false,
            error,
            attempts
          }
        }

        logger.error(`❌ Attempt ${attempts} failed: ${error.message}`)

        // 如果还有重试机会，等待一下
        if (attempt < maxRetries) {
          logger.info(`🔄 Retrying after error...`)
          if (this.RETRY_DELAY > 0) {
            await this._delay(this.RETRY_DELAY)
          }
        }
      }
    }

    // 所有重试都失败了
    logger.error(`❌ All ${attempts} attempts failed`)
    return {
      success: false,
      error: lastError || new Error('All retry attempts failed'),
      attempts,
      excludedAccounts: Array.from(excludedAccounts)
    }
  }

  /**
   * 延迟工具函数
   * @param {number} ms - 延迟毫秒数
   * @returns {Promise<void>}
   */
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * 获取配置信息
   * @returns {Object}
   */
  getConfig() {
    return {
      maxRetries: this.MAX_RETRIES,
      retryDelay: this.RETRY_DELAY,
      slowResponseTimeout: this.SLOW_RESPONSE_TIMEOUT,
      retryableStatusCodes: this.RETRYABLE_STATUS_CODES
    }
  }

  /**
   * 更新配置
   * @param {Object} config - 配置对象
   */
  updateConfig(config) {
    if (config.maxRetries !== undefined) this.MAX_RETRIES = config.maxRetries
    if (config.retryDelay !== undefined) this.RETRY_DELAY = config.retryDelay
    if (config.slowResponseTimeout !== undefined)
      this.SLOW_RESPONSE_TIMEOUT = config.slowResponseTimeout
    if (config.retryableStatusCodes !== undefined)
      this.RETRYABLE_STATUS_CODES = config.retryableStatusCodes

    logger.info('✅ RetryManager config updated:', this.getConfig())
  }
}

module.exports = new RetryManager()
