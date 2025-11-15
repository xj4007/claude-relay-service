const crypto = require('crypto')
const logger = require('./logger')

class SessionHelper {
  /**
   * 生成会话哈希，用于sticky会话保持
   * 基于Anthropic的prompt caching机制，优先使用metadata中的session ID
   * ⚠️ 重要：必须包含 API Key ID 确保不同用户的会话隔离
   *
   * @param {Object} requestBody - 请求体
   * @param {string} apiKeyId - API Key ID (必须传入以确保会话隔离)
   * @returns {string|null} - 32字符的会话哈希，如果无法生成则返回null
   */
  generateSessionHash(requestBody, apiKeyId = null) {
    if (!requestBody || typeof requestBody !== 'object') {
      return null
    }

    // 🔒 如果没有提供 apiKeyId，记录警告但继续（向后兼容，但不推荐）
    if (!apiKeyId) {
      logger.warn(`⚠️ Session hash generation without apiKeyId - this may cause session sharing between users!`)
    }

    // 1. 最高优先级：使用metadata中的session ID（加上 apiKeyId 前缀）
    if (requestBody.metadata && requestBody.metadata.user_id) {
      // 提取 session_xxx 部分
      const userIdString = requestBody.metadata.user_id
      const sessionMatch = userIdString.match(/session_([a-f0-9-]{36})/)
      if (sessionMatch && sessionMatch[1]) {
        const sessionId = sessionMatch[1]
        // 🔒 拼接 apiKeyId 确保用户隔离
        const isolatedSessionId = apiKeyId ? `${apiKeyId}_${sessionId}` : sessionId
        // 如果拼接后超过32字符，对整个字符串hash
        if (isolatedSessionId.length > 32) {
          const hash = crypto.createHash('sha256').update(isolatedSessionId).digest('hex').substring(0, 32)
          logger.debug(`📋 Session ID extracted from metadata.user_id (hashed with apiKeyId): ${hash}`)
          return hash
        }
        logger.debug(`📋 Session ID extracted from metadata.user_id: ${isolatedSessionId}`)
        return isolatedSessionId
      }
    }

    let cacheableContent = apiKeyId || ''
    const system = requestBody.system || ''
    const messages = requestBody.messages || []

    // 2. 提取带有cache_control: {"type": "ephemeral"}的内容
    // 检查system中的cacheable内容
    if (Array.isArray(system)) {
      for (const part of system) {
        if (part && part.cache_control && part.cache_control.type === 'ephemeral') {
          cacheableContent += part.text || ''
        }
      }
    }

    // 检查messages中的cacheable内容
    for (const msg of messages) {
      const content = msg.content || ''
      let hasCacheControl = false

      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && part.cache_control && part.cache_control.type === 'ephemeral') {
            hasCacheControl = true
            break
          }
        }
      } else if (
        typeof content === 'string' &&
        msg.cache_control &&
        msg.cache_control.type === 'ephemeral'
      ) {
        hasCacheControl = true
      }

      if (hasCacheControl) {
        for (const message of messages) {
          let messageText = ''
          if (typeof message.content === 'string') {
            messageText = message.content
          } else if (Array.isArray(message.content)) {
            messageText = message.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text || '')
              .join('')
          }

          if (messageText) {
            cacheableContent += messageText
            break
          }
        }
        break
      }
    }

    // 3. 如果有cacheable内容，直接使用
    if (cacheableContent) {
      const hash = crypto
        .createHash('sha256')
        .update(cacheableContent)
        .digest('hex')
        .substring(0, 32)
      logger.debug(`📋 Session hash generated from cacheable content: ${hash}`)
      return hash
    }

    // 4. Fallback: 使用system内容
    if (system) {
      let systemText = ''
      if (typeof system === 'string') {
        systemText = system
      } else if (Array.isArray(system)) {
        systemText = system.map((part) => part.text || '').join('')
      }

      if (systemText) {
        const hash = crypto.createHash('sha256').update(systemText).digest('hex').substring(0, 32)
        logger.debug(`📋 Session hash generated from system content: ${hash}`)
        return hash
      }
    }

    // 5. 最后fallback: 使用第一条消息内容
    if (messages.length > 0) {
      const firstMessage = messages[0]
      let firstMessageText = ''

      if (typeof firstMessage.content === 'string') {
        firstMessageText = firstMessage.content
      } else if (Array.isArray(firstMessage.content)) {
        if (!firstMessage.content) {
          logger.error('📋 Session hash generated from first message failed: ', firstMessage)
        }

        firstMessageText = firstMessage.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text || '')
          .join('')
      }

      if (firstMessageText) {
        const hash = crypto
          .createHash('sha256')
          .update(firstMessageText)
          .digest('hex')
          .substring(0, 32)
        logger.debug(`📋 Session hash generated from first message: ${hash}`)
        return hash
      }
    }

    // 无法生成会话哈希
    logger.debug('📋 Unable to generate session hash - no suitable content found')
    return null
  }

  /**
   * 获取会话的Redis键名
   * @param {string} sessionHash - 会话哈希
   * @returns {string} - Redis键名
   */
  getSessionRedisKey(sessionHash) {
    return `sticky_session:${sessionHash}`
  }

  /**
   * 验证会话哈希格式
   * @param {string} sessionHash - 会话哈希
   * @returns {boolean} - 是否有效
   */
  isValidSessionHash(sessionHash) {
    return (
      typeof sessionHash === 'string' &&
      sessionHash.length === 32 &&
      /^[a-f0-9]{32}$/.test(sessionHash)
    )
  }

  /**
   * 🆕 从请求体的 metadata.user_id 中提取会话UUID
   * Claude Code 会在请求中包含 user_id，格式为：user_{client_id}_account__session_{uuid}
   *
   * @param {Object} requestBody - 请求体对象
   * @returns {string|null} - 会话UUID，如果提取失败返回null
   */
  extractSessionUUID(requestBody) {
    try {
      // 检查是否有 metadata.user_id
      if (
        !requestBody ||
        !requestBody.metadata ||
        typeof requestBody.metadata.user_id !== 'string'
      ) {
        return null
      }

      const userId = requestBody.metadata.user_id

      // 尝试匹配格式：user_{64位十六进制}_account__session_{uuid}
      const match = userId.match(/_account__session_([a-f0-9-]{36})$/)

      if (match && match[1]) {
        const sessionUUID = match[1]
        logger.debug(`✅ Extracted session UUID: ${sessionUUID} from user_id: ${userId}`)
        return sessionUUID
      }

      // 没有匹配到会话UUID
      logger.debug(`⚠️ No session UUID found in user_id: ${userId}`)
      return null
    } catch (error) {
      logger.warn(`❌ Failed to extract session UUID: ${error.message}`)
      return null
    }
  }
}

module.exports = new SessionHelper()
