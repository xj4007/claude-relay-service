const redis = require('../models/redis')
const logger = require('../utils/logger')
const config = require('../../config/config')

/**
 * 🎯 智能缓存优化服务
 *
 * 功能：
 * 1. 检测短时间内的相似请求
 * 2. 自动应用"缓存折扣"，降低用户成本
 * 3. 透明记录优化过程，便于审计
 *
 * 应用场景：
 * - 连续对话中的相似请求（例如用户持续提问）
 * - 代码编辑过程中的增量请求
 * - 重试或微调请求
 *
 * 优化原理：
 * - 将部分 cache_create tokens 转换为 cache_read tokens
 * - cache_read 比 cache_create 便宜 10 倍
 * - 节省成本 60-80%
 */
class SmartCacheOptimizer {
  constructor() {
    this.config = config.smartCacheOptimization
    this.RECENT_REQUESTS_KEY_PREFIX = 'recent_requests:'
    this.RECENT_REQUESTS_TTL = this.config.timeWindowMinutes * 60 // 转换为秒
  }

  /**
   * 🔍 检查是否应该应用智能缓存优化
   *
   * @param {string} keyId - API Key ID
   * @param {Object} currentRequest - 当前请求的token信息
   * @param {string} accountId - 账户ID (可选)
   * @param {string} accountType - 账户类型 (可选)
   * @returns {Promise<Object|null>} - 优化结果或null（不优化）
   */
  async checkAndOptimize(keyId, currentRequest, accountId = null, accountType = null) {
    // 检查是否启用
    if (!this.config.enabled) {
      return null
    }

    try {
      const { inputTokens, cacheCreateTokens, cacheReadTokens, model } = currentRequest

      // 🔍 验证必要参数
      if (!inputTokens || !cacheCreateTokens || typeof cacheReadTokens === 'undefined' || !model) {
        logger.debug('⚠️ Smart cache: Missing required parameters, skipping optimization')
        return null
      }

      // 🎯 检查是否为 anyrouter 账户（只对 anyrouter 账户应用智能缓存优化）
      if (accountId && accountType) {
        let isAnyRouterAccount = false
        try {
          let account = null
          if (accountType === 'claude-console') {
            const claudeConsoleAccountService = require('./claudeConsoleAccountService')
            account = await claudeConsoleAccountService.getAccount(accountId)
          } else if (accountType === 'claude-official') {
            const claudeAccountService = require('./claudeAccountService')
            account = await claudeAccountService.getAccount(accountId)
          }

          if (account?.name?.includes('anyrouter-anyrouter')) {
            isAnyRouterAccount = true
            logger.debug(
              `✅ Smart cache: Detected anyrouter account "${account.name}", eligible for optimization`
            )
          } else {
            logger.debug(
              `⏭️ Smart cache: Account "${account?.name || 'unknown'}" is not anyrouter, skipping optimization`
            )
            return null
          }
        } catch (err) {
          logger.warn(`⚠️ Smart cache: Failed to check account type: ${err.message}`)
          return null
        }

        if (!isAnyRouterAccount) {
          return null
        }
      } else {
        // 如果没有传递账户信息，不应用优化（默认策略：只对明确的 anyrouter 账户优化）
        logger.debug('⏭️ Smart cache: No account info provided, skipping optimization')
        return null
      }

      // ⚠️ 如果已经有缓存读取，说明已经命中缓存，不需要优化
      if (cacheReadTokens > 0) {
        logger.debug(
          `✅ Smart cache: Already has cache_read (${cacheReadTokens}), no optimization needed`
        )
        return null
      }

      // ⚠️ 如果缓存创建tokens太少，优化收益不明显
      if (cacheCreateTokens < this.config.minCacheTokens) {
        logger.debug(
          `⚠️ Smart cache: cache_create (${cacheCreateTokens}) below minimum threshold (${this.config.minCacheTokens}), skipping`
        )
        return null
      }

      // 📋 查询最近的相似请求
      const recentRequest = await this._findSimilarRecentRequest(
        keyId,
        inputTokens,
        cacheCreateTokens,
        model
      )

      if (!recentRequest) {
        // 没有找到相似请求，记录当前请求
        await this._recordRecentRequest(keyId, currentRequest)
        logger.debug('📝 Smart cache: No similar request found, recorded current request')
        return null
      }

      // 🎯 应用缓存优化
      const optimized = this._applyCacheOptimization(currentRequest, recentRequest)

      logger.info(
        `🎯 Smart cache optimization applied | Key: ${keyId.substring(0, 8)}... | ` +
          `Original: cache_create=${cacheCreateTokens}, cache_read=${cacheReadTokens} | ` +
          `Optimized: cache_create=${optimized.cacheCreateTokens}, cache_read=${optimized.cacheReadTokens} | ` +
          `Savings: ${optimized.savingsPercent}%`
      )

      // 记录当前请求
      await this._recordRecentRequest(keyId, currentRequest)

      return optimized
    } catch (error) {
      logger.error(`❌ Smart cache optimization error: ${error.message}`)
      // 出错时不影响主流程，返回null
      return null
    }
  }

  /**
   * 🔍 查找最近的相似请求
   *
   * @param {string} keyId - API Key ID
   * @param {number} inputTokens - 输入tokens
   * @param {number} cacheCreateTokens - 缓存创建tokens
   * @param {string} model - 模型名称
   * @returns {Promise<Object|null>} - 相似请求或null
   */
  async _findSimilarRecentRequest(keyId, inputTokens, cacheCreateTokens, model) {
    try {
      const client = redis.getClientSafe()
      const key = `${this.RECENT_REQUESTS_KEY_PREFIX}${keyId}`

      // 获取最近的请求（按时间倒序，最多10条）
      const recentLogs = await client.lrange(key, 0, 9)

      if (!recentLogs || recentLogs.length === 0) {
        return null
      }

      // 遍历查找相似请求
      for (const logStr of recentLogs) {
        try {
          const log = JSON.parse(logStr)

          // 模型必须相同
          if (log.model !== model) {
            continue
          }

          // 检查时间窗口（已经由Redis TTL保证，但双重检查更安全）
          const timeDiff = Date.now() - log.timestamp
          const timeWindowMs = this.config.timeWindowMinutes * 60 * 1000
          if (timeDiff > timeWindowMs) {
            continue
          }

          // 计算相似度
          const similarity = this._calculateSimilarity(
            inputTokens,
            cacheCreateTokens,
            log.inputTokens,
            log.cacheCreateTokens
          )

          if (similarity.isSimilar) {
            logger.debug(
              `🎯 Found similar request | Time diff: ${Math.floor(timeDiff / 1000)}s | ` +
                `Input diff: ${similarity.inputDiff.toFixed(2)}% | ` +
                `Cache diff: ${similarity.cacheDiff.toFixed(2)}%`
            )
            return log
          }
        } catch (parseError) {
          // 忽略解析错误的记录
          continue
        }
      }

      return null
    } catch (error) {
      logger.error(`❌ Error finding similar request: ${error.message}`)
      return null
    }
  }

  /**
   * 📊 计算两个请求的相似度
   *
   * @param {number} input1 - 请求1的输入tokens
   * @param {number} cache1 - 请求1的缓存创建tokens
   * @param {number} input2 - 请求2的输入tokens
   * @param {number} cache2 - 请求2的缓存创建tokens
   * @returns {Object} - 相似度信息
   */
  _calculateSimilarity(input1, cache1, input2, cache2) {
    // 计算输入tokens差异百分比
    const inputDiff = Math.abs(input1 - input2) / Math.max(input1, input2)

    // 计算缓存创建tokens差异百分比
    const cacheDiff = Math.abs(cache1 - cache2) / Math.max(cache1, cache2)

    // 判断是否相似
    const isSimilar =
      inputDiff <= this.config.inputTokenThreshold && cacheDiff <= this.config.cacheCreateThreshold

    return {
      isSimilar,
      inputDiff: inputDiff * 100, // 转为百分比
      cacheDiff: cacheDiff * 100 // 转为百分比
    }
  }

  /**
   * 🎯 应用缓存优化
   *
   * @param {Object} currentRequest - 当前请求
   * @param {Object} recentRequest - 相似的历史请求
   * @returns {Object} - 优化后的结果
   */
  _applyCacheOptimization(currentRequest, recentRequest) {
    const { inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model } = currentRequest

    // 计算应该转换为cache_read的tokens数量
    const tokensToConvert = Math.floor(cacheCreateTokens * this.config.discountRatio)

    // 优化后的tokens分配
    const optimizedCacheCreate = cacheCreateTokens - tokensToConvert
    const optimizedCacheRead = cacheReadTokens + tokensToConvert

    // 计算节省比例
    // cache_create 和 cache_read 的价格比例约为 10:1
    // 假设 cache_create 成本为 tokensToConvert * 1.0
    // 优化后成本为 tokensToConvert * 0.1
    // 节省比例 = (1.0 - 0.1) / 1.0 * 100% * discountRatio
    const savingsPercent = Math.floor((1 - 0.1) * this.config.discountRatio * 100)

    return {
      // 优化后的tokens
      inputTokens,
      outputTokens,
      cacheCreateTokens: optimizedCacheCreate,
      cacheReadTokens: optimizedCacheRead,

      // 原始tokens（用于日志）
      originalCacheCreate: cacheCreateTokens,
      originalCacheRead: cacheReadTokens,

      // 优化元数据
      optimized: true,
      tokensConverted: tokensToConvert,
      savingsPercent,
      similarRequestTimestamp: recentRequest.timestamp,
      optimizationReason: 'similar_request_detected',

      // 模型信息
      model
    }
  }

  /**
   * 📝 记录最近的请求
   *
   * @param {string} keyId - API Key ID
   * @param {Object} request - 请求信息
   */
  async _recordRecentRequest(keyId, request) {
    try {
      const client = redis.getClientSafe()
      const key = `${this.RECENT_REQUESTS_KEY_PREFIX}${keyId}`

      const requestLog = {
        timestamp: Date.now(),
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
        cacheCreateTokens: request.cacheCreateTokens,
        cacheReadTokens: request.cacheReadTokens,
        model: request.model
      }

      // 添加到列表头部
      await client.lpush(key, JSON.stringify(requestLog))

      // 只保留最近10条记录
      await client.ltrim(key, 0, 9)

      // 设置TTL
      await client.expire(key, this.RECENT_REQUESTS_TTL)

      logger.debug(`📝 Recorded recent request for key: ${keyId.substring(0, 8)}...`)
    } catch (error) {
      logger.error(`❌ Error recording recent request: ${error.message}`)
    }
  }

  /**
   * 📊 获取优化统计信息
   *
   * @param {string} keyId - API Key ID (可选)
   * @returns {Promise<Object>} - 统计信息
   */
  async getOptimizationStats(keyId = null) {
    try {
      const client = redis.getClientSafe()
      const pattern = keyId
        ? `${this.RECENT_REQUESTS_KEY_PREFIX}${keyId}`
        : `${this.RECENT_REQUESTS_KEY_PREFIX}*`

      const keys = await client.keys(pattern)

      return {
        enabled: this.config.enabled,
        timeWindowMinutes: this.config.timeWindowMinutes,
        discountRatio: this.config.discountRatio,
        trackedKeys: keys.length,
        minCacheTokens: this.config.minCacheTokens
      }
    } catch (error) {
      logger.error(`❌ Error getting optimization stats: ${error.message}`)
      return null
    }
  }
}

module.exports = new SmartCacheOptimizer()
