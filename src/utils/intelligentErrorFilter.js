/**
 * 智能错误过滤器
 * 根据内容智能判断是否应该返回原生错误信息
 */

const logger = require('./logger')

class IntelligentErrorFilter {
  /**
   * 检查文本是否包含中文字符
   * @param {string} text - 要检查的文本
   * @returns {boolean} 是否包含中文
   */
  static containsChinese(text) {
    if (!text || typeof text !== 'string') return false
    return /[\u4e00-\u9fa5]/.test(text)
  }

  /**
   * 检查文本是否包含允许的域名
   * @param {string} text - 要检查的文本
   * @returns {boolean} 是否包含允许的域名
   */
  static containsAllowedDomains(text) {
    if (!text || typeof text !== 'string') return false

    const allowedDomains = [
      'claude.ai',
      'anthropic.com',
      'console.anthropic.com',
      'api.anthropic.com'
    ]

    const loweredText = text.toLowerCase()
    return allowedDomains.some(domain => loweredText.includes(domain))
  }

  /**
   * 检查文本是否包含敏感URL或域名
   * @param {string} text - 要检查的文本
   * @returns {boolean} 是否包含敏感URL
   */
  static containsSensitiveUrls(text) {
    if (!text || typeof text !== 'string') return false

    // 匹配URL和域名的正则
    const urlPattern = /(?:https?:\/\/|www\.|[a-zA-Z0-9-]+\.)[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/gi
    const matches = text.match(urlPattern)

    if (!matches) return false

    // 检查是否有非允许的域名
    for (const match of matches) {
      const loweredMatch = match.toLowerCase()
      if (!this.containsAllowedDomains(loweredMatch)) {
        return true // 包含敏感URL
      }
    }

    return false
  }

  /**
   * 移除敏感URL，保留允许的域名
   * @param {string} text - 要处理的文本
   * @returns {string} 处理后的文本
   */
  static removeSensitiveUrls(text) {
    if (!text || typeof text !== 'string') return text

    // 匹配完整URL的正则
    const urlPattern = /(?:https?:\/\/|www\.)[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*[^\s]*/gi

    return text.replace(urlPattern, (match) => {
      if (this.containsAllowedDomains(match)) {
        return match // 保留允许的URL
      }
      return '[FILTERED_URL]' // 替换敏感URL
    })
  }

  /**
   * 检查是否包含其他敏感信息
   * @param {string} text - 要检查的文本
   * @returns {boolean} 是否包含敏感信息
   */
  static containsSensitiveInfo(text) {
    if (!text || typeof text !== 'string') return false

    const sensitivePatterns = [
      /\b[A-Za-z0-9]{40,}\b/,  // 长token/密钥
      /\bsk-[a-zA-Z0-9]{48}\b/,  // API密钥格式
      /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i,  // UUID
      /Bearer\s+[A-Za-z0-9-._~+\/]+=*/i,  // Bearer token
      /account_id["\s:]+["']?[a-zA-Z0-9-]+/i,  // 账户ID
      /user_id["\s:]+["']?[a-zA-Z0-9-]+/i,  // 用户ID
      /email["\s:]+["']?[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i  // 邮箱地址
    ]

    return sensitivePatterns.some(pattern => pattern.test(text))
  }

  /**
   * 智能过滤错误响应
   * @param {number} statusCode - HTTP状态码
   * @param {string|object} errorBody - 原始错误响应
   * @returns {object} 过滤后的错误对象
   */
  static filterError(statusCode, errorBody) {
    try {
      // 解析错误内容
      let errorContent = ''
      let parsedError = null

      if (typeof errorBody === 'string') {
        errorContent = errorBody
        try {
          parsedError = JSON.parse(errorBody)
        } catch (e) {
          parsedError = { error: { message: errorBody } }
        }
      } else if (errorBody && typeof errorBody === 'object') {
        parsedError = errorBody
        errorContent = JSON.stringify(errorBody)
      }

      // 获取错误消息
      let errorMessage = parsedError?.error?.message ||
                        parsedError?.message ||
                        errorContent ||
                        'Unknown error'

      // 日志记录原始错误（用于调试）
      logger.debug('Filtering error response:', {
        statusCode,
        originalMessage: errorMessage.substring(0, 200)
      })

      // 智能判断逻辑

      // 1. 如果包含中文，说明是我们自定义的错误，直接返回
      if (this.containsChinese(errorMessage)) {
        logger.debug('Error contains Chinese, returning original')
        return parsedError || { error: { message: errorMessage } }
      }

      // 2. 如果包含敏感URL（非claude.ai/anthropic.com），需要过滤
      if (this.containsSensitiveUrls(errorMessage)) {
        logger.debug('Error contains sensitive URLs, filtering')
        errorMessage = this.removeSensitiveUrls(errorMessage)
      }

      // 3. 如果包含其他敏感信息，返回通用错误
      if (this.containsSensitiveInfo(errorMessage)) {
        logger.debug('Error contains sensitive info, using generic message')
        return this.getGenericError(statusCode)
      }

      // 4. 对于特定状态码，如果没有中文且没有敏感信息，可以返回
      if (statusCode === 400 || statusCode === 422) {
        // 请求错误通常包含有用的信息
        return {
          error: {
            type: parsedError?.error?.type || 'invalid_request',
            message: errorMessage
          }
        }
      }

      // 5. 对于429限流错误，保留有用信息
      if (statusCode === 429) {
        return {
          error: {
            type: 'rate_limit_error',
            message: errorMessage.includes('rate limit') ? errorMessage : '请求频率过高，请稍后重试'
          }
        }
      }

      // 6. 对于其他错误，返回通用消息
      return this.getGenericError(statusCode)

    } catch (error) {
      logger.error('Error in filterError:', error)
      return this.getGenericError(statusCode)
    }
  }

  /**
   * 获取通用错误消息
   * @param {number} statusCode - HTTP状态码
   * @returns {object} 通用错误对象
   */
  static getGenericError(statusCode) {
    const errorMap = {
      400: { type: 'invalid_request', message: '请求参数无效' },
      401: { type: 'authentication_error', message: '认证失败' },
      403: { type: 'permission_error', message: '权限不足' },
      404: { type: 'not_found', message: '资源不存在' },
      429: { type: 'rate_limit_error', message: '请求频率过高，请稍后重试' },
      500: { type: 'server_error', message: '服务器内部错误' },
      502: { type: 'upstream_error', message: '上游服务不可用' },
      503: { type: 'service_unavailable', message: '服务暂时不可用' },
      504: { type: 'timeout_error', message: '请求超时' },
      529: { type: 'overload_error', message: '服务负载过高' }
    }

    const error = errorMap[statusCode] || {
      type: statusCode >= 500 ? 'server_error' : 'client_error',
      message: statusCode >= 500 ? '服务器错误' : '请求错误'
    }

    return { error }
  }

  /**
   * 过滤流式响应错误
   * @param {number} statusCode - HTTP状态码
   * @param {string} errorData - 原始错误数据
   * @returns {object} 过滤后的SSE错误对象
   */
  static filterStreamError(statusCode, errorData) {
    const filteredError = this.filterError(statusCode, errorData)

    // 返回SSE格式的错误
    return {
      error: filteredError.error?.type || 'stream_error',
      message: filteredError.error?.message || '流处理出错',
      timestamp: new Date().toISOString()
    }
  }
}

module.exports = IntelligentErrorFilter