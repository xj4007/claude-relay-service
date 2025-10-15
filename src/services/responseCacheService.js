const crypto = require('crypto')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const requestQueue = require('../utils/requestQueue')

/**
 * 响应缓存服务
 * 用于缓存客户端断开但上游成功返回的响应
 * 避免客户端重试时重复请求上游
 *
 * 新功能：
 * - 请求去重和等待共享（多个相同请求共享一个上游调用）
 * - 增加TTL到5分钟
 */
class ResponseCacheService {
  constructor() {
    this.CACHE_PREFIX = 'response_cache:'
    this.STREAM_CACHE_PREFIX = 'stream_cache:'
    this.DEFAULT_TTL = 300 // 5分钟（从180秒改为300秒）
    this.MAX_CACHE_SIZE = 5 * 1024 * 1024 // 5MB
  }

  /**
   * 生成缓存键（基于请求内容的唯一哈希）
   * @param {Object} requestBody - 请求体
   * @param {string} model - 模型名称
   * @returns {string} - 缓存键
   */
  generateCacheKey(requestBody, model) {
    try {
      // 构建缓存键的内容（包含所有影响输出的参数）
      // ⚠️ 必须按固定顺序构建，确保相同内容生成相同哈希
      const cacheContent = {
        model: model,
        messages: requestBody.messages || [],
        system: requestBody.system || '',
        max_tokens: requestBody.max_tokens,
        temperature: requestBody.temperature,
        top_p: requestBody.top_p,
        top_k: requestBody.top_k,
        stop_sequences: requestBody.stop_sequences
        // 不包含 metadata 和 stream，因为这些不影响输出内容
      }

      // 🔧 使用稳定的序列化方式（按键排序）
      const stableJson = JSON.stringify(cacheContent, Object.keys(cacheContent).sort())

      // 生成 SHA256 哈希
      const hash = crypto.createHash('sha256').update(stableJson).digest('hex').substring(0, 32)

      logger.debug(`📋 Cache key generated: ${hash}`)
      return hash
    } catch (error) {
      logger.error(`❌ Failed to generate cache key: ${error.message}`)
      return null
    }
  }

  /**
   * 检查缓存是否存在（非流式）
   * @param {string} cacheKey - 缓存键
   * @returns {Object|null} - 缓存的响应，如果不存在则返回 null
   */
  async getCachedResponse(cacheKey) {
    if (!cacheKey) return null

    try {
      const client = redis.getClientSafe()
      const redisKey = `${this.CACHE_PREFIX}${cacheKey}`
      const cached = await client.hgetall(redisKey)

      if (!cached || !cached.body) {
        logger.debug(`📋 Cache miss: ${cacheKey}`)
        return null
      }

      // 解析缓存的响应
      const response = {
        statusCode: parseInt(cached.statusCode) || 200,
        headers: JSON.parse(cached.headers || '{}'),
        body: JSON.parse(cached.body),
        usage: cached.usage ? JSON.parse(cached.usage) : null,
        cachedAt: parseInt(cached.cachedAt) || Date.now()
      }

      logger.info(
        `🎯 Cache hit: ${cacheKey} | Cached ${Math.floor((Date.now() - response.cachedAt) / 1000)}s ago`
      )
      return response
    } catch (error) {
      logger.error(`❌ Failed to get cached response: ${error.message}`)
      return null
    }
  }

  /**
   * 🆕 获取缓存或执行请求（带请求去重和等待共享）
   * 如果缓存存在，直接返回缓存
   * 如果正在请求中，等待并共享结果
   * 如果都没有，执行新请求并缓存
   *
   * @param {string} cacheKey - 缓存键
   * @param {Function} fetchFn - 请求函数 async () => response
   * @param {number} ttl - 缓存TTL（秒）
   * @returns {Promise<Object>} - 响应对象
   */
  async getOrFetchResponse(cacheKey, fetchFn, ttl = this.DEFAULT_TTL) {
    if (!cacheKey) {
      // 没有缓存键，直接执行请求
      return await fetchFn()
    }

    // 1. 先检查缓存
    const cached = await this.getCachedResponse(cacheKey)
    if (cached) {
      logger.info(`✅ Returning cached response | CacheKey: ${cacheKey.substring(0, 16)}...`)
      return cached
    }

    // 2. 检查是否有相同请求正在进行，如果有则等待
    // 如果没有，则执行新请求
    const result = await requestQueue.executeOrWait(cacheKey, async () => {
      logger.info(`🚀 Executing new upstream request | CacheKey: ${cacheKey.substring(0, 16)}...`)

      // 执行实际请求
      const response = await fetchFn()

      // 🔍 检测特殊错误响应（空响应体、JSON解析失败等）
      const shouldRetryDueToSpecialError = this._shouldRetryForSpecialError(response)
      if (shouldRetryDueToSpecialError) {
        logger.warn(
          `🔄 Detected special error response: ${shouldRetryDueToSpecialError} | CacheKey: ${cacheKey.substring(0, 16)}...`
        )
        // 标记为失败，让等待的请求重新尝试而不是共享这个有问题的响应
        return { success: false, response }
      }

      // 缓存成功的响应（只缓存2xx响应）
      if (response.statusCode >= 200 && response.statusCode < 300) {
        await this.cacheResponse(cacheKey, response, ttl)
        // 标记为成功，让等待的请求共享此结果
        return { success: true, response }
      } else {
        logger.debug(
          `⚠️ Not caching non-2xx response: ${response.statusCode} | CacheKey: ${cacheKey.substring(0, 16)}...`
        )
        // 标记为失败，让等待的请求重新尝试
        return { success: false, response }
      }
    })

    // 3. 如果是失败响应，等待的请求应该重新尝试而不是共享失败结果
    if (!result.success) {
      logger.warn(
        `⚠️ Shared request failed (${result.response.statusCode}), waiting request will retry independently | CacheKey: ${cacheKey.substring(0, 16)}...`
      )
      // 🔄 重新执行请求（带重试逻辑），不共享失败结果
      return await fetchFn()
    }

    return result.response
  }

  /**
   * 缓存响应（非流式）
   * @param {string} cacheKey - 缓存键
   * @param {Object} response - 响应对象
   * @param {number} ttl - 过期时间（秒）
   */
  async cacheResponse(cacheKey, response, ttl = this.DEFAULT_TTL) {
    if (!cacheKey) return

    try {
      const client = redis.getClientSafe()
      const redisKey = `${this.CACHE_PREFIX}${cacheKey}`

      // 检查响应大小
      const bodySize = JSON.stringify(response.body).length
      if (bodySize > this.MAX_CACHE_SIZE) {
        logger.warn(
          `⚠️ Response too large to cache: ${(bodySize / 1024 / 1024).toFixed(2)}MB > ${this.MAX_CACHE_SIZE / 1024 / 1024}MB`
        )
        return
      }

      // 存储到 Redis Hash
      const cacheData = {
        statusCode: response.statusCode.toString(),
        headers: JSON.stringify(response.headers),
        body: JSON.stringify(response.body),
        usage: response.usage ? JSON.stringify(response.usage) : '',
        cachedAt: Date.now().toString()
      }

      await client.hset(redisKey, cacheData)
      await client.expire(redisKey, ttl)

      logger.info(
        `💾 Cached response: ${cacheKey} | Size: ${(bodySize / 1024).toFixed(2)}KB | TTL: ${ttl}s`
      )
    } catch (error) {
      logger.error(`❌ Failed to cache response: ${error.message}`)
    }
  }

  /**
   * 检查流式缓存是否存在
   * @param {string} cacheKey - 缓存键
   * @returns {Array|null} - 缓存的 chunks 数组，如果不存在则返回 null
   */
  async getCachedStream(cacheKey) {
    if (!cacheKey) return null

    try {
      const client = redis.getClientSafe()
      const redisKey = `${this.STREAM_CACHE_PREFIX}${cacheKey}`

      // 检查是否存在且完整
      const metadata = await client.hgetall(`${redisKey}:meta`)
      if (!metadata || metadata.complete !== 'true') {
        logger.debug(`📋 Stream cache miss or incomplete: ${cacheKey}`)
        return null
      }

      // 获取所有 chunks
      const chunks = await client.lrange(redisKey, 0, -1)
      if (!chunks || chunks.length === 0) {
        return null
      }

      logger.info(
        `🎯 Stream cache hit: ${cacheKey} | ${chunks.length} chunks | Cached ${Math.floor((Date.now() - parseInt(metadata.cachedAt)) / 1000)}s ago`
      )
      return chunks.map((chunk) => JSON.parse(chunk))
    } catch (error) {
      logger.error(`❌ Failed to get cached stream: ${error.message}`)
      return null
    }
  }

  /**
   * 开始缓存流式响应
   * @param {string} cacheKey - 缓存键
   * @returns {Object} - 缓存收集器对象
   */
  createStreamCacheCollector(cacheKey) {
    if (!cacheKey) return null

    const chunks = []
    let totalSize = 0
    let isComplete = false

    return {
      /**
       * 添加一个 chunk
       * @param {Object} chunk - SSE chunk 对象
       */
      addChunk(chunk) {
        const chunkStr = JSON.stringify(chunk)
        const chunkSize = chunkStr.length

        // 检查大小限制
        if (totalSize + chunkSize > this.MAX_CACHE_SIZE) {
          logger.warn(`⚠️ Stream cache size limit reached, stopping collection`)
          return false
        }

        chunks.push(chunk)
        totalSize += chunkSize

        // 检查是否完成
        if (chunk.event === 'message_stop') {
          isComplete = true
        }

        return true
      },

      /**
       * 保存到 Redis（只有完整接收才保存）
       * @param {number} ttl - 过期时间（秒）
       */
      async save(ttl = this.DEFAULT_TTL) {
        if (!isComplete) {
          logger.debug(`📋 Stream incomplete, not caching: ${cacheKey}`)
          return
        }

        try {
          const client = redis.getClientSafe()
          const redisKey = `${this.STREAM_CACHE_PREFIX}${cacheKey}`

          // 清空旧数据（如果存在）
          await client.del(redisKey)
          await client.del(`${redisKey}:meta`)

          // 存储所有 chunks
          for (const chunk of chunks) {
            await client.rpush(redisKey, JSON.stringify(chunk))
          }

          // 存储元数据
          await client.hset(`${redisKey}:meta`, {
            complete: 'true',
            cachedAt: Date.now().toString(),
            chunkCount: chunks.length.toString()
          })

          // 设置过期时间
          await client.expire(redisKey, ttl)
          await client.expire(`${redisKey}:meta`, ttl)

          logger.info(
            `💾 Cached stream: ${cacheKey} | ${chunks.length} chunks | Size: ${(totalSize / 1024).toFixed(2)}KB | TTL: ${ttl}s`
          )
        } catch (error) {
          logger.error(`❌ Failed to save stream cache: ${error.message}`)
        }
      },

      /**
       * 获取收集状态
       */
      getStats() {
        return {
          chunkCount: chunks.length,
          totalSize,
          isComplete
        }
      }
    }
  }

  /**
   * 清除指定的缓存
   * @param {string} cacheKey - 缓存键
   */
  async clearCache(cacheKey) {
    if (!cacheKey) return

    try {
      const client = redis.getClientSafe()
      await client.del(`${this.CACHE_PREFIX}${cacheKey}`)
      await client.del(`${this.STREAM_CACHE_PREFIX}${cacheKey}`)
      await client.del(`${this.STREAM_CACHE_PREFIX}${cacheKey}:meta`)
      logger.debug(`🗑️ Cleared cache: ${cacheKey}`)
    } catch (error) {
      logger.error(`❌ Failed to clear cache: ${error.message}`)
    }
  }

  /**
   * 获取缓存统计信息
   */
  async getStats() {
    try {
      const client = redis.getClientSafe()

      // 统计非流式缓存
      const responseCacheKeys = await client.keys(`${this.CACHE_PREFIX}*`)
      let totalResponseSize = 0
      for (const key of responseCacheKeys) {
        const body = await client.hget(key, 'body')
        if (body) totalResponseSize += body.length
      }

      // 统计流式缓存
      const streamCacheKeys = await client.keys(`${this.STREAM_CACHE_PREFIX}*`)
      const streamCacheCount = streamCacheKeys.filter((k) => !k.endsWith(':meta')).length

      return {
        responseCacheCount: responseCacheKeys.length,
        responseCacheSizeMB: (totalResponseSize / 1024 / 1024).toFixed(2),
        streamCacheCount,
        ttlSeconds: this.DEFAULT_TTL,
        maxCacheSizeMB: this.MAX_CACHE_SIZE / 1024 / 1024
      }
    } catch (error) {
      logger.error(`❌ Failed to get cache stats: ${error.message}`)
      return null
    }
  }

  /**
   * 🔍 检测是否为需要重试的特殊错误响应
   * @param {Object} response - 响应对象
   * @returns {string|null} - 需要重试时返回原因描述，否则返回 null
   */
  _shouldRetryForSpecialError(response) {
    if (!response || !response.statusCode) {
      return 'missing response or status code'
    }

    const { statusCode } = response
    let bodyText = ''

    // 获取响应体文本
    if (typeof response.body === 'string') {
      bodyText = response.body
    } else if (response.body !== undefined && response.body !== null) {
      try {
        bodyText = JSON.stringify(response.body)
      } catch (error) {
        return 'failed to stringify response body'
      }
    }

    const normalizedText = bodyText.toLowerCase()

    // 🆕 检测空响应体或无效 JSON（状态码 200 但响应体异常）
    if (statusCode === 200 || statusCode === 201) {
      // 检测完全空的响应体
      if (!bodyText || bodyText.trim() === '') {
        return 'empty response body with 200 status'
      }

      // 检测响应体过短（可能是截断的响应）
      if (bodyText.length < 10 && !bodyText.includes('{')) {
        return 'suspiciously short response body'
      }

      // 尝试解析 JSON，如果失败说明格式有问题
      try {
        const parsed = JSON.parse(bodyText)
        // 检测缺少必要字段的响应（Claude API 应该包含这些字段）
        if (parsed && typeof parsed === 'object') {
          const hasValidStructure =
            parsed.content ||
            parsed.message ||
            parsed.error ||
            parsed.type ||
            (Array.isArray(parsed.content) && parsed.content.length > 0)

          if (!hasValidStructure) {
            return 'invalid claude api response structure'
          }
        }
      } catch (jsonError) {
        return 'malformed json response with 200 status'
      }
    }

    // 检测其他特殊错误
    if (statusCode === 400) {
      const thinkingMismatch =
        normalizedText.includes('expected `thinking`') &&
        normalizedText.includes('found `tool_use`')

      if (thinkingMismatch) {
        return 'thinking/tool_use format mismatch'
      }

      const officialInternalError =
        normalizedText.includes('"type":"internal_error"') ||
        normalizedText.includes("'type':'internal_error'") ||
        normalizedText.includes('server internal error, please contact admin')

      if (officialInternalError) {
        return 'official internal error 400'
      }

      // 🆕 检测 thinking.budget_tokens 相关错误
      const thinkingBudgetError =
        normalizedText.includes('max_tokens') && normalizedText.includes('thinking.budget_tokens')

      if (thinkingBudgetError) {
        return 'thinking budget tokens validation error'
      }
    }

    if (statusCode === 524) {
      return 'cloudflare timeout 524'
    }

    return null
  }
}

module.exports = new ResponseCacheService()
