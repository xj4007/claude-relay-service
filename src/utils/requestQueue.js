const logger = require('./logger')

/**
 * 🎯 请求队列管理器
 * 处理相同请求的去重和结果共享
 *
 * 功能：
 * 1. 检测相同的并发请求（基于缓存键）
 * 2. 让后续请求等待第一个请求的结果
 * 3. 所有等待的请求共享同一个上游响应
 * 4. 自动清理完成的请求
 */
class RequestQueue {
  constructor() {
    // 请求队列：Map<cacheKey, { promise, resolvers[], rejecters[], startTime, requestCount }>
    this.pendingRequests = new Map()

    // 清理配置
    this.CLEANUP_INTERVAL = 60000 // 1分钟清理一次
    this.MAX_PENDING_TIME = 300000 // 5分钟最大等待时间

    // 启动定期清理
    this._startCleanupTimer()
  }

  /**
   * 检查是否有相同的请求正在进行
   * @param {string} cacheKey - 请求的缓存键
   * @returns {boolean}
   */
  hasPendingRequest(cacheKey) {
    return this.pendingRequests.has(cacheKey)
  }

  /**
   * 等待相同请求的结果
   * @param {string} cacheKey - 请求的缓存键
   * @returns {Promise<Object>} - 请求结果
   */
  async waitForPendingRequest(cacheKey) {
    const pending = this.pendingRequests.get(cacheKey)
    if (!pending) {
      throw new Error('No pending request found for this cache key')
    }

    // 增加等待计数
    pending.requestCount++

    logger.info(
      `⏳ Request waiting for existing upstream call | CacheKey: ${cacheKey.substring(0, 16)}... | Waiters: ${pending.requestCount}`
    )

    try {
      // 等待第一个请求完成
      const result = await pending.promise

      logger.info(
        `✅ Shared result delivered to waiting request | CacheKey: ${cacheKey.substring(0, 16)}...`
      )

      return result
    } catch (error) {
      logger.error(
        `❌ Shared request failed | CacheKey: ${cacheKey.substring(0, 16)}... | Error: ${error.message}`
      )
      throw error
    }
  }

  /**
   * 创建新的请求队列项
   * @param {string} cacheKey - 请求的缓存键
   * @param {Function} requestFn - 执行请求的函数 async () => result
   * @returns {Promise<Object>} - 请求结果
   */
  async executeOrWait(cacheKey, requestFn) {
    // 检查是否已有相同请求在进行
    if (this.hasPendingRequest(cacheKey)) {
      logger.info(
        `🔄 Duplicate request detected, waiting for existing call | CacheKey: ${cacheKey.substring(0, 16)}...`
      )
      return await this.waitForPendingRequest(cacheKey)
    }

    // 创建新的pending请求
    logger.info(`🚀 Starting new request | CacheKey: ${cacheKey.substring(0, 16)}...`)

    const pending = {
      startTime: Date.now(),
      requestCount: 1, // 初始请求
      promise: null
    }

    // 创建Promise并立即执行
    pending.promise = this._executeRequest(cacheKey, requestFn, pending)

    // 注册到队列
    this.pendingRequests.set(cacheKey, pending)

    try {
      const result = await pending.promise
      return result
    } finally {
      // 清理completed的请求（延迟一点以便其他等待的请求可以获取结果）
      setTimeout(() => {
        this.pendingRequests.delete(cacheKey)
        logger.debug(`🧹 Cleaned up completed request | CacheKey: ${cacheKey.substring(0, 16)}...`)
      }, 1000) // 1秒后清理
    }
  }

  /**
   * 执行请求的内部函数
   * @param {string} cacheKey - 缓存键
   * @param {Function} requestFn - 请求函数
   * @param {Object} pending - pending对象
   * @returns {Promise<Object>}
   */
  async _executeRequest(cacheKey, requestFn, pending) {
    try {
      const result = await requestFn()

      const duration = Date.now() - pending.startTime

      logger.info(
        `✅ Request completed | CacheKey: ${cacheKey.substring(0, 16)}... | Duration: ${duration}ms | Shared with: ${pending.requestCount} requests`
      )

      return result
    } catch (error) {
      const duration = Date.now() - pending.startTime

      logger.error(
        `❌ Request failed | CacheKey: ${cacheKey.substring(0, 16)}... | Duration: ${duration}ms | Error: ${error.message}`
      )

      throw error
    }
  }

  /**
   * 获取队列统计信息
   * @returns {Object}
   */
  getStats() {
    const pending = []
    const now = Date.now()

    for (const [cacheKey, request] of this.pendingRequests.entries()) {
      pending.push({
        cacheKey: `${cacheKey.substring(0, 16)}...`,
        elapsedMs: now - request.startTime,
        waitingRequests: request.requestCount - 1 // 减去初始请求
      })
    }

    return {
      pendingCount: this.pendingRequests.size,
      pending: pending.sort((a, b) => b.elapsedMs - a.elapsedMs) // 按等待时间排序
    }
  }

  /**
   * 清理超时的pending请求
   */
  _cleanupStaleRequests() {
    const now = Date.now()
    let cleaned = 0

    for (const [cacheKey, pending] of this.pendingRequests.entries()) {
      const elapsed = now - pending.startTime
      if (elapsed > this.MAX_PENDING_TIME) {
        logger.warn(
          `⚠️ Cleaning up stale request | CacheKey: ${cacheKey.substring(0, 16)}... | Elapsed: ${Math.floor(elapsed / 1000)}s`
        )
        this.pendingRequests.delete(cacheKey)
        cleaned++
      }
    }

    if (cleaned > 0) {
      logger.info(`🧹 Cleaned up ${cleaned} stale requests`)
    }
  }

  /**
   * 启动定期清理定时器
   */
  _startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      this._cleanupStaleRequests()
    }, this.CLEANUP_INTERVAL)

    // 防止定时器阻止Node.js退出
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }

    logger.debug('✅ Request queue cleanup timer started')
  }

  /**
   * 停止清理定时器（用于测试或关闭）
   */
  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
      logger.debug('🛑 Request queue cleanup timer stopped')
    }
  }

  /**
   * 清空所有pending请求（用于测试或重置）
   */
  clear() {
    const count = this.pendingRequests.size
    this.pendingRequests.clear()
    logger.info(`🧹 Cleared all pending requests (${count} items)`)
  }
}

module.exports = new RequestQueue()
