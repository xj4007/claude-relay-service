const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const ProxyHelper = require('../utils/proxyHelper')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const config = require('../../config/config')
const LRUCache = require('../utils/lruCache')

class ClaudeConsoleAccountService {
  constructor() {
    // 加密相关常量
    this.ENCRYPTION_ALGORITHM = 'aes-256-cbc'
    this.ENCRYPTION_SALT = 'claude-console-salt'

    // Redis键前缀
    this.ACCOUNT_KEY_PREFIX = 'claude_console_account:'
    this.SHARED_ACCOUNTS_KEY = 'shared_claude_console_accounts'
    this.ACCOUNT_CONCURRENCY_PREFIX = 'account_concurrency:console:'

    // 🚀 性能优化：缓存派生的加密密钥，避免每次重复计算
    // scryptSync 是 CPU 密集型操作，缓存可以减少 95%+ 的 CPU 密集型操作
    this._encryptionKeyCache = null

    // 🔄 解密结果缓存，提高解密性能
    this._decryptCache = new LRUCache(500)

    // 🧹 定期清理缓存（每10分钟）
    setInterval(
      () => {
        this._decryptCache.cleanup()
        logger.info(
          '🧹 Claude Console decrypt cache cleanup completed',
          this._decryptCache.getStats()
        )
      },
      10 * 60 * 1000
    )
  }

  // 🏢 创建Claude Console账户
  async createAccount(options = {}) {
    const {
      name = 'Claude Console Account',
      description = '',
      apiUrl = '',
      apiKey = '',
      priority = 50, // 默认优先级50（1-100）
      supportedModels = [], // 支持的模型列表或映射表，空数组/对象表示支持所有
      userAgent = 'claude-cli/1.0.119 (external, cli)',
      rateLimitDuration = 60, // 限流时间（分钟）
      proxy = null,
      isActive = true,
      accountType = 'shared', // 'dedicated' or 'shared'
      schedulable = true, // 是否可被调度
      dailyQuota = 0, // 每日额度限制（美元），0表示不限制
      quotaResetTime = '00:00', // 额度重置时间（HH:mm格式）
      accountConcurrencyLimit = 0 // 账户并发限制，0表示不限制
    } = options

    // 验证必填字段
    if (!apiUrl || !apiKey) {
      throw new Error('API URL and API Key are required for Claude Console account')
    }

    const accountId = uuidv4()

    // 处理 supportedModels，确保向后兼容
    const processedModels = this._processModelMapping(supportedModels)

    const accountData = {
      id: accountId,
      platform: 'claude-console',
      name,
      description,
      apiUrl,
      apiKey: this._encryptSensitiveData(apiKey),
      priority: priority.toString(),
      supportedModels: JSON.stringify(processedModels),
      userAgent,
      rateLimitDuration: rateLimitDuration.toString(),
      proxy: proxy ? JSON.stringify(proxy) : '',
      isActive: isActive.toString(),
      accountType,
      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      status: 'active',
      errorMessage: '',
      // 限流相关
      rateLimitedAt: '',
      rateLimitStatus: '',
      // 调度控制
      schedulable: schedulable.toString(),
      // 额度管理相关
      dailyQuota: dailyQuota.toString(), // 每日额度限制（美元）
      dailyUsage: '0', // 当日使用金额（美元）
      // 使用与统计一致的时区日期，避免边界问题
      lastResetDate: redis.getDateStringInTimezone(), // 最后重置日期（按配置时区）
      quotaResetTime, // 额度重置时间
      quotaStoppedAt: '', // 因额度停用的时间
      // 并发控制相关
      accountConcurrencyLimit: accountConcurrencyLimit.toString() // 账户并发限制
    }

    const client = redis.getClientSafe()
    logger.debug(
      `[DEBUG] Saving account data to Redis with key: ${this.ACCOUNT_KEY_PREFIX}${accountId}`
    )
    logger.debug(`[DEBUG] Account data to save: ${JSON.stringify(accountData, null, 2)}`)

    await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, accountData)

    // 如果是共享账户，添加到共享账户集合
    if (accountType === 'shared') {
      await client.sadd(this.SHARED_ACCOUNTS_KEY, accountId)
    }

    logger.success(`🏢 Created Claude Console account: ${name} (${accountId})`)

    return {
      id: accountId,
      name,
      description,
      apiUrl,
      priority,
      supportedModels,
      userAgent,
      rateLimitDuration,
      isActive,
      proxy,
      accountType,
      status: 'active',
      createdAt: accountData.createdAt,
      dailyQuota,
      dailyUsage: 0,
      lastResetDate: accountData.lastResetDate,
      quotaResetTime,
      quotaStoppedAt: null,
      accountConcurrencyLimit: parseInt(accountData.accountConcurrencyLimit) || 0
    }
  }

  // 📋 获取所有Claude Console账户
  async getAllAccounts() {
    try {
      const client = redis.getClientSafe()
      const keys = await client.keys(`${this.ACCOUNT_KEY_PREFIX}*`)
      const accounts = []

      for (const key of keys) {
        // 🔧 跳过非账户键（如 slow_responses、5xx_errors、stream_timeouts、main_model_success 等辅助数据）
        if (
          key.includes(':slow_responses') ||
          key.includes(':5xx_errors') ||
          key.includes(':temp_error') ||
          key.includes(':stream_timeouts') ||
          key.includes(':main_model_success')
        ) {
          continue
        }

        const accountData = await client.hgetall(key)
        if (accountData && Object.keys(accountData).length > 0) {
          // 获取限流状态信息
          const rateLimitInfo = this._getRateLimitInfo(accountData)

          accounts.push({
            id: accountData.id,
            platform: accountData.platform,
            name: accountData.name,
            description: accountData.description,
            apiUrl: accountData.apiUrl,
            priority: parseInt(accountData.priority) || 50,
            supportedModels: JSON.parse(accountData.supportedModels || '[]'),
            userAgent: accountData.userAgent,
            rateLimitDuration: Number.isNaN(parseInt(accountData.rateLimitDuration))
              ? 60
              : parseInt(accountData.rateLimitDuration),
            isActive: accountData.isActive === 'true',
            proxy: accountData.proxy ? JSON.parse(accountData.proxy) : null,
            accountType: accountData.accountType || 'shared',
            createdAt: accountData.createdAt,
            lastUsedAt: accountData.lastUsedAt,
            status: accountData.status || 'active',
            errorMessage: accountData.errorMessage,
            rateLimitInfo,
            schedulable: accountData.schedulable !== 'false', // 默认为true，只有明确设置为false才不可调度
            // 额度管理相关
            dailyQuota: parseFloat(accountData.dailyQuota || '0'),
            dailyUsage: parseFloat(accountData.dailyUsage || '0'),
            lastResetDate: accountData.lastResetDate || '',
            quotaResetTime: accountData.quotaResetTime || '00:00',
            quotaStoppedAt: accountData.quotaStoppedAt || null,
            // 并发控制
            accountConcurrencyLimit: parseInt(accountData.accountConcurrencyLimit) || 0
          })
        }
      }

      return accounts
    } catch (error) {
      logger.error('❌ Failed to get Claude Console accounts:', error)
      throw error
    }
  }

  // 🔍 获取单个账户（内部使用，包含敏感信息）
  async getAccount(accountId) {
    const client = redis.getClientSafe()
    logger.debug(`[DEBUG] Getting account data for ID: ${accountId}`)
    const accountData = await client.hgetall(`${this.ACCOUNT_KEY_PREFIX}${accountId}`)

    if (!accountData || Object.keys(accountData).length === 0) {
      logger.debug(`[DEBUG] No account data found for ID: ${accountId}`)
      return null
    }

    logger.debug(`[DEBUG] Raw account data keys: ${Object.keys(accountData).join(', ')}`)
    logger.debug(`[DEBUG] Raw supportedModels value: ${accountData.supportedModels}`)

    // 解密敏感字段（只解密apiKey，apiUrl不加密）
    const decryptedKey = this._decryptSensitiveData(accountData.apiKey)
    logger.debug(
      `[DEBUG] URL exists: ${!!accountData.apiUrl}, Decrypted key exists: ${!!decryptedKey}`
    )

    accountData.apiKey = decryptedKey

    // 解析JSON字段
    const parsedModels = JSON.parse(accountData.supportedModels || '[]')
    logger.debug(`[DEBUG] Parsed supportedModels: ${JSON.stringify(parsedModels)}`)

    accountData.supportedModels = parsedModels
    accountData.priority = parseInt(accountData.priority) || 50
    {
      const _parsedDuration = parseInt(accountData.rateLimitDuration)
      accountData.rateLimitDuration = Number.isNaN(_parsedDuration) ? 60 : _parsedDuration
    }
    accountData.isActive = accountData.isActive === 'true'
    accountData.schedulable = accountData.schedulable !== 'false' // 默认为true

    if (accountData.proxy) {
      accountData.proxy = JSON.parse(accountData.proxy)
    }

    logger.debug(
      `[DEBUG] Final account data - name: ${accountData.name}, hasApiUrl: ${!!accountData.apiUrl}, hasApiKey: ${!!accountData.apiKey}, supportedModels: ${JSON.stringify(accountData.supportedModels)}`
    )

    return accountData
  }

  // 📝 更新账户
  async updateAccount(accountId, updates) {
    try {
      const existingAccount = await this.getAccount(accountId)
      if (!existingAccount) {
        throw new Error('Account not found')
      }

      const client = redis.getClientSafe()
      const updatedData = {}

      // 处理各个字段的更新
      logger.debug(
        `[DEBUG] Update request received with fields: ${Object.keys(updates).join(', ')}`
      )
      logger.debug(`[DEBUG] Updates content: ${JSON.stringify(updates, null, 2)}`)

      if (updates.name !== undefined) {
        updatedData.name = updates.name
      }
      if (updates.description !== undefined) {
        updatedData.description = updates.description
      }
      if (updates.apiUrl !== undefined) {
        logger.debug(`[DEBUG] Updating apiUrl from frontend: ${updates.apiUrl}`)
        updatedData.apiUrl = updates.apiUrl
      }
      if (updates.apiKey !== undefined) {
        logger.debug(`[DEBUG] Updating apiKey (length: ${updates.apiKey?.length})`)
        updatedData.apiKey = this._encryptSensitiveData(updates.apiKey)
      }
      if (updates.priority !== undefined) {
        updatedData.priority = updates.priority.toString()
      }
      if (updates.supportedModels !== undefined) {
        logger.debug(`[DEBUG] Updating supportedModels: ${JSON.stringify(updates.supportedModels)}`)
        // 处理 supportedModels，确保向后兼容
        const processedModels = this._processModelMapping(updates.supportedModels)
        updatedData.supportedModels = JSON.stringify(processedModels)
      }
      if (updates.userAgent !== undefined) {
        updatedData.userAgent = updates.userAgent
      }
      if (updates.rateLimitDuration !== undefined) {
        updatedData.rateLimitDuration = updates.rateLimitDuration.toString()
      }
      if (updates.proxy !== undefined) {
        updatedData.proxy = updates.proxy ? JSON.stringify(updates.proxy) : ''
      }
      if (updates.isActive !== undefined) {
        updatedData.isActive = updates.isActive.toString()
      }
      if (updates.schedulable !== undefined) {
        updatedData.schedulable = updates.schedulable.toString()
        // 如果是手动修改调度状态，清除所有自动停止相关的字段
        // 防止自动恢复
        updatedData.rateLimitAutoStopped = ''
        updatedData.quotaAutoStopped = ''
        // 兼容旧的标记
        updatedData.autoStoppedAt = ''
        updatedData.stoppedReason = ''

        // 记录日志
        if (updates.schedulable === true || updates.schedulable === 'true') {
          logger.info(`✅ Manually enabled scheduling for Claude Console account ${accountId}`)
        } else {
          logger.info(`⛔ Manually disabled scheduling for Claude Console account ${accountId}`)
        }
      }

      // 额度管理相关字段
      if (updates.dailyQuota !== undefined) {
        updatedData.dailyQuota = updates.dailyQuota.toString()
      }
      if (updates.quotaResetTime !== undefined) {
        updatedData.quotaResetTime = updates.quotaResetTime
      }
      if (updates.dailyUsage !== undefined) {
        updatedData.dailyUsage = updates.dailyUsage.toString()
      }
      if (updates.lastResetDate !== undefined) {
        updatedData.lastResetDate = updates.lastResetDate
      }
      if (updates.quotaStoppedAt !== undefined) {
        updatedData.quotaStoppedAt = updates.quotaStoppedAt
      }

      // 并发控制相关字段
      if (updates.accountConcurrencyLimit !== undefined) {
        updatedData.accountConcurrencyLimit = updates.accountConcurrencyLimit.toString()
      }

      // 处理账户类型变更
      if (updates.accountType && updates.accountType !== existingAccount.accountType) {
        updatedData.accountType = updates.accountType

        if (updates.accountType === 'shared') {
          await client.sadd(this.SHARED_ACCOUNTS_KEY, accountId)
        } else {
          await client.srem(this.SHARED_ACCOUNTS_KEY, accountId)
        }
      }

      updatedData.updatedAt = new Date().toISOString()

      // 检查是否手动禁用了账号，如果是则发送webhook通知
      if (updates.isActive === false && existingAccount.isActive === true) {
        try {
          const webhookNotifier = require('../utils/webhookNotifier')
          await webhookNotifier.sendAccountAnomalyNotification({
            accountId,
            accountName: updatedData.name || existingAccount.name || 'Unknown Account',
            platform: 'claude-console',
            status: 'disabled',
            errorCode: 'CLAUDE_CONSOLE_MANUALLY_DISABLED',
            reason: 'Account manually disabled by administrator'
          })
        } catch (webhookError) {
          logger.error(
            'Failed to send webhook notification for manual account disable:',
            webhookError
          )
        }
      }

      logger.debug(`[DEBUG] Final updatedData to save: ${JSON.stringify(updatedData, null, 2)}`)
      logger.debug(`[DEBUG] Updating Redis key: ${this.ACCOUNT_KEY_PREFIX}${accountId}`)

      await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, updatedData)

      logger.success(`📝 Updated Claude Console account: ${accountId}`)

      return { success: true }
    } catch (error) {
      logger.error('❌ Failed to update Claude Console account:', error)
      throw error
    }
  }

  // 🗑️ 删除账户
  async deleteAccount(accountId) {
    try {
      const client = redis.getClientSafe()
      const account = await this.getAccount(accountId)

      if (!account) {
        throw new Error('Account not found')
      }

      // 从Redis删除
      await client.del(`${this.ACCOUNT_KEY_PREFIX}${accountId}`)

      // 从共享账户集合中移除
      if (account.accountType === 'shared') {
        await client.srem(this.SHARED_ACCOUNTS_KEY, accountId)
      }

      logger.success(`🗑️ Deleted Claude Console account: ${accountId}`)

      return { success: true }
    } catch (error) {
      logger.error('❌ Failed to delete Claude Console account:', error)
      throw error
    }
  }

  // 🚫 标记账号为限流状态
  async markAccountRateLimited(accountId) {
    try {
      const client = redis.getClientSafe()
      const account = await this.getAccount(accountId)

      if (!account) {
        throw new Error('Account not found')
      }

      // 如果限流时间设置为 0，表示不启用限流机制，直接返回
      if (account.rateLimitDuration === 0) {
        logger.info(
          `ℹ️ Claude Console account ${account.name} (${accountId}) has rate limiting disabled, skipping rate limit`
        )
        return { success: true, skipped: true }
      }

      const updates = {
        rateLimitedAt: new Date().toISOString(),
        rateLimitStatus: 'limited',
        isActive: 'false', // 禁用账户
        schedulable: 'false', // 停止调度，与其他平台保持一致
        errorMessage: `Rate limited at ${new Date().toISOString()}`,
        // 使用独立的限流自动停止标记
        rateLimitAutoStopped: 'true'
      }

      // 只有当前状态不是quota_exceeded时才设置为rate_limited
      // 避免覆盖更重要的配额超限状态
      const currentStatus = await client.hget(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, 'status')
      if (currentStatus !== 'quota_exceeded') {
        updates.status = 'rate_limited'
      }

      await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, updates)

      // 发送Webhook通知
      try {
        const webhookNotifier = require('../utils/webhookNotifier')
        const { getISOStringWithTimezone } = require('../utils/dateHelper')
        await webhookNotifier.sendAccountAnomalyNotification({
          accountId,
          accountName: account.name || 'Claude Console Account',
          platform: 'claude-console',
          status: 'error',
          errorCode: 'CLAUDE_CONSOLE_RATE_LIMITED',
          reason: `Account rate limited (429 error) and has been disabled. ${account.rateLimitDuration ? `Will be automatically re-enabled after ${account.rateLimitDuration} minutes` : 'Manual intervention required to re-enable'}`,
          timestamp: getISOStringWithTimezone(new Date())
        })
      } catch (webhookError) {
        logger.error('Failed to send rate limit webhook notification:', webhookError)
      }

      logger.warn(
        `🚫 Claude Console account marked as rate limited: ${account.name} (${accountId})`
      )
      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to mark Claude Console account as rate limited: ${accountId}`, error)
      throw error
    }
  }

  // ✅ 移除账号的限流状态
  async removeAccountRateLimit(accountId) {
    try {
      const client = redis.getClientSafe()
      const accountKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}`

      // 获取账户当前状态和额度信息
      const [currentStatus, quotaStoppedAt] = await client.hmget(
        accountKey,
        'status',
        'quotaStoppedAt'
      )

      // 删除限流相关字段
      await client.hdel(accountKey, 'rateLimitedAt', 'rateLimitStatus')

      // 根据不同情况决定是否恢复账户
      if (currentStatus === 'rate_limited') {
        if (quotaStoppedAt) {
          // 还有额度限制，改为quota_exceeded状态
          await client.hset(accountKey, {
            status: 'quota_exceeded'
            // isActive保持false
          })
          logger.info(`⚠️ Rate limit removed but quota exceeded remains for account: ${accountId}`)
        } else {
          // 没有额度限制，完全恢复
          const accountData = await client.hgetall(accountKey)
          const updateData = {
            isActive: 'true',
            status: 'active',
            errorMessage: ''
          }

          const hadAutoStop = accountData.rateLimitAutoStopped === 'true'

          // 只恢复因限流而自动停止的账户
          if (hadAutoStop && accountData.schedulable === 'false') {
            updateData.schedulable = 'true' // 恢复调度
            logger.info(
              `✅ Auto-resuming scheduling for Claude Console account ${accountId} after rate limit cleared`
            )
          }

          if (hadAutoStop) {
            await client.hdel(accountKey, 'rateLimitAutoStopped')
          }

          await client.hset(accountKey, updateData)
          logger.success(`✅ Rate limit removed and account re-enabled: ${accountId}`)
        }
      } else {
        if (await client.hdel(accountKey, 'rateLimitAutoStopped')) {
          logger.info(
            `ℹ️ Removed stale auto-stop flag for Claude Console account ${accountId} during rate limit recovery`
          )
        }
        logger.success(`✅ Rate limit removed for Claude Console account: ${accountId}`)
      }

      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to remove rate limit for Claude Console account: ${accountId}`, error)
      throw error
    }
  }

  // 🔍 检查账号是否处于限流状态
  async isAccountRateLimited(accountId) {
    try {
      const account = await this.getAccount(accountId)
      if (!account) {
        return false
      }

      // 如果限流时间设置为 0，表示不启用限流机制
      if (account.rateLimitDuration === 0) {
        return false
      }

      if (account.rateLimitStatus === 'limited' && account.rateLimitedAt) {
        const rateLimitedAt = new Date(account.rateLimitedAt)
        const now = new Date()
        const minutesSinceRateLimit = (now - rateLimitedAt) / (1000 * 60)

        // 使用账户配置的限流时间
        const rateLimitDuration =
          typeof account.rateLimitDuration === 'number' && !Number.isNaN(account.rateLimitDuration)
            ? account.rateLimitDuration
            : 60

        if (minutesSinceRateLimit >= rateLimitDuration) {
          await this.removeAccountRateLimit(accountId)
          return false
        }

        return true
      }

      return false
    } catch (error) {
      logger.error(
        `❌ Failed to check rate limit status for Claude Console account: ${accountId}`,
        error
      )
      return false
    }
  }

  // 🔍 检查账号是否因额度超限而被停用（懒惰检查）
  async isAccountQuotaExceeded(accountId) {
    try {
      const account = await this.getAccount(accountId)
      if (!account) {
        return false
      }

      // 如果没有设置额度限制，不会超额
      const dailyQuota = parseFloat(account.dailyQuota || '0')
      if (isNaN(dailyQuota) || dailyQuota <= 0) {
        return false
      }

      // 如果账户没有被额度停用，检查当前使用情况
      if (!account.quotaStoppedAt) {
        return false
      }

      // 检查是否应该重置额度（到了新的重置时间点）
      if (this._shouldResetQuota(account)) {
        await this.resetDailyUsage(accountId)
        return false
      }

      // 仍在额度超限状态
      return true
    } catch (error) {
      logger.error(
        `❌ Failed to check quota exceeded status for Claude Console account: ${accountId}`,
        error
      )
      return false
    }
  }

  // 🔍 判断是否应该重置账户额度
  _shouldResetQuota(account) {
    // 与 Redis 统计一致：按配置时区判断“今天”与时间点
    const tzNow = redis.getDateInTimezone(new Date())
    const today = redis.getDateStringInTimezone(tzNow)

    // 如果已经是今天重置过的，不需要重置
    if (account.lastResetDate === today) {
      return false
    }

    // 检查是否到了重置时间点（按配置时区的小时/分钟）
    const resetTime = account.quotaResetTime || '00:00'
    const [resetHour, resetMinute] = resetTime.split(':').map((n) => parseInt(n))

    const currentHour = tzNow.getUTCHours()
    const currentMinute = tzNow.getUTCMinutes()

    // 如果当前时间已过重置时间且不是同一天重置的，应该重置
    return currentHour > resetHour || (currentHour === resetHour && currentMinute >= resetMinute)
  }

  // 🚫 标记账号为未授权状态（401错误）
  async markAccountUnauthorized(accountId) {
    try {
      const client = redis.getClientSafe()
      const account = await this.getAccount(accountId)

      if (!account) {
        throw new Error('Account not found')
      }

      const updates = {
        schedulable: 'false',
        status: 'unauthorized',
        errorMessage: 'API Key无效或已过期（401错误）',
        unauthorizedAt: new Date().toISOString(),
        unauthorizedCount: String((parseInt(account.unauthorizedCount || '0') || 0) + 1)
      }

      await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, updates)

      // 发送Webhook通知
      try {
        const webhookNotifier = require('../utils/webhookNotifier')
        await webhookNotifier.sendAccountAnomalyNotification({
          accountId,
          accountName: account.name || 'Claude Console Account',
          platform: 'claude-console',
          status: 'error',
          errorCode: 'CLAUDE_CONSOLE_UNAUTHORIZED',
          reason: 'API Key无效或已过期（401错误），账户已停止调度',
          timestamp: new Date().toISOString()
        })
      } catch (webhookError) {
        logger.error('Failed to send unauthorized webhook notification:', webhookError)
      }

      logger.warn(
        `🚫 Claude Console account marked as unauthorized: ${account.name} (${accountId})`
      )
      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to mark Claude Console account as unauthorized: ${accountId}`, error)
      throw error
    }
  }

  // 🚫 标记账号为过载状态（529错误）
  async markAccountOverloaded(accountId) {
    try {
      const client = redis.getClientSafe()
      const account = await this.getAccount(accountId)

      if (!account) {
        throw new Error('Account not found')
      }

      const updates = {
        overloadedAt: new Date().toISOString(),
        overloadStatus: 'overloaded',
        errorMessage: '服务过载（529错误）'
      }

      await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, updates)

      // 发送Webhook通知
      try {
        const webhookNotifier = require('../utils/webhookNotifier')
        await webhookNotifier.sendAccountAnomalyNotification({
          accountId,
          accountName: account.name || 'Claude Console Account',
          platform: 'claude-console',
          status: 'error',
          errorCode: 'CLAUDE_CONSOLE_OVERLOADED',
          reason: '服务过载（529错误）。账户将暂时停止调度',
          timestamp: new Date().toISOString()
        })
      } catch (webhookError) {
        logger.error('Failed to send overload webhook notification:', webhookError)
      }

      logger.warn(`🚫 Claude Console account marked as overloaded: ${account.name} (${accountId})`)
      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to mark Claude Console account as overloaded: ${accountId}`, error)
      throw error
    }
  }

  // ✅ 移除账号的过载状态
  async removeAccountOverload(accountId) {
    try {
      const client = redis.getClientSafe()

      await client.hdel(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, 'overloadedAt', 'overloadStatus')

      logger.info(`✅ Removed overload status for Claude Console account: ${accountId}`)
      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to remove overload status: ${accountId}`, error)
      throw error
    }
  }

  // 🐌 标记账户响应慢（降低优先级但不禁用）
  // ⚠️ 注意：此方法不再自动调用，仅供以下场景使用：
  //   1. 管理员通过 Web 界面手动标记
  //   2. CLI 工具手动调整优先级
  //   3. 特殊监控脚本调用
  // 设计原因：成功响应不应因慢而被自动惩罚（可能是正常的复杂请求：大上下文、Prompt Caching首次缓存、复杂推理等）
  async markAccountSlow(accountId, responseTime) {
    try {
      const client = redis.getClientSafe()
      const account = await this.getAccount(accountId)

      if (!account) {
        return { success: false, error: 'Account not found' }
      }

      // 记录慢响应事件
      const slowKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}:slow_responses`
      const now = Date.now()
      const oneHourAgo = now - 60 * 60 * 1000

      // 添加当前慢响应记录（带时间戳和响应时间）
      await client.zadd(slowKey, now, `${now}:${responseTime}`)

      // 清理1小时前的记录
      await client.zremrangebyscore(slowKey, '-inf', oneHourAgo)

      // 设置过期时间（2小时）
      await client.expire(slowKey, 7200)

      // 统计1小时内的慢响应次数
      const slowCount = await client.zcard(slowKey)

      logger.info(
        `🐌 Recorded slow response for account ${account.name}: ${responseTime}ms (${slowCount} slow responses in last hour)`
      )

      // 🎯 如果1小时内慢响应超过5次，降低优先级
      if (slowCount >= 5) {
        const currentPriority = parseInt(account.priority) || 50
        const newPriority = Math.min(currentPriority + 10, 90) // 优先级+10（数字越大优先级越低）

        await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, {
          priority: newPriority.toString(),
          slowResponseWarning: `降低优先级: ${slowCount}次慢响应/小时`,
          lastSlowResponseAt: new Date().toISOString()
        })

        logger.warn(
          `⚠️ Account ${account.name} priority lowered: ${currentPriority} → ${newPriority} (${slowCount} slow responses/hour)`
        )

        // 发送Webhook通知
        try {
          const webhookNotifier = require('../utils/webhookNotifier')
          await webhookNotifier.sendAccountAnomalyNotification({
            accountId,
            accountName: account.name,
            platform: 'claude-console',
            status: 'warning',
            errorCode: 'SLOW_RESPONSE',
            reason: `账户响应缓慢，1小时内${slowCount}次慢响应（>${responseTime}ms），已降低优先级 ${currentPriority}→${newPriority}`,
            timestamp: new Date().toISOString()
          })
        } catch (webhookError) {
          logger.error('Failed to send slow response webhook:', webhookError)
        }
      }

      return { success: true, slowCount }
    } catch (error) {
      logger.error(`Failed to mark account as slow: ${accountId}`, error)
      return { success: false, error: error.message }
    }
  }

  // 🔄 恢复账户正常优先级（当响应速度恢复时）
  // ⚠️ 注意：此方法不再自动调用，仅供手动恢复使用
  // 设计原因：与 markAccountSlow() 配套，保留供管理员手动操作
  async restoreAccountPriority(accountId) {
    try {
      const client = redis.getClientSafe()
      const account = await this.getAccount(accountId)

      if (!account) {
        return { success: false }
      }

      // 检查是否有慢响应记录
      const slowKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}:slow_responses`
      const slowCount = await client.zcard(slowKey)

      // 如果最近1小时内慢响应少于2次，恢复默认优先级
      if (slowCount < 2) {
        const currentPriority = parseInt(account.priority) || 50

        // 只恢复被降低过的优先级（>50）
        if (currentPriority > 50) {
          await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, {
            priority: '50',
            slowResponseWarning: ''
          })

          logger.info(
            `✅ Restored priority for account ${account.name}: ${currentPriority} → 50 (response time improved)`
          )
        }
      }

      return { success: true }
    } catch (error) {
      logger.error(`Failed to restore account priority: ${accountId}`, error)
      return { success: false }
    }
  }

  // 🔍 检查账号是否处于过载状态
  async isAccountOverloaded(accountId) {
    try {
      const account = await this.getAccount(accountId)
      if (!account) {
        return false
      }

      if (account.overloadStatus === 'overloaded' && account.overloadedAt) {
        const overloadedAt = new Date(account.overloadedAt)
        const now = new Date()
        const minutesSinceOverload = (now - overloadedAt) / (1000 * 60)

        // 过载状态持续10分钟后自动恢复
        if (minutesSinceOverload >= 10) {
          await this.removeAccountOverload(accountId)
          return false
        }

        return true
      }

      return false
    } catch (error) {
      logger.error(
        `❌ Failed to check overload status for Claude Console account: ${accountId}`,
        error
      )
      return false
    }
  }

  // 🚫 标记账号为封锁状态（模型不支持等原因）
  async blockAccount(accountId, reason) {
    try {
      const client = redis.getClientSafe()

      // 获取账户信息用于webhook通知
      const accountData = await client.hgetall(`${this.ACCOUNT_KEY_PREFIX}${accountId}`)

      const updates = {
        status: 'blocked',
        errorMessage: reason,
        blockedAt: new Date().toISOString()
      }

      await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, updates)

      logger.warn(`🚫 Claude Console account blocked: ${accountId} - ${reason}`)

      // 发送Webhook通知
      if (accountData && Object.keys(accountData).length > 0) {
        try {
          const webhookNotifier = require('../utils/webhookNotifier')
          await webhookNotifier.sendAccountAnomalyNotification({
            accountId,
            accountName: accountData.name || 'Unknown Account',
            platform: 'claude-console',
            status: 'blocked',
            errorCode: 'CLAUDE_CONSOLE_BLOCKED',
            reason
          })
        } catch (webhookError) {
          logger.error('Failed to send webhook notification:', webhookError)
        }
      }

      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to block Claude Console account: ${accountId}`, error)
      throw error
    }
  }

  // 🌐 创建代理agent（使用统一的代理工具）
  _createProxyAgent(proxyConfig) {
    const proxyAgent = ProxyHelper.createProxyAgent(proxyConfig)
    if (proxyAgent) {
      logger.info(
        `🌐 Using proxy for Claude Console request: ${ProxyHelper.getProxyDescription(proxyConfig)}`
      )
    } else if (proxyConfig) {
      logger.debug('🌐 Failed to create proxy agent for Claude Console')
    } else {
      logger.debug('🌐 No proxy configured for Claude Console request')
    }
    return proxyAgent
  }

  // 🔐 加密敏感数据
  _encryptSensitiveData(data) {
    if (!data) {
      return ''
    }

    try {
      const key = this._generateEncryptionKey()
      const iv = crypto.randomBytes(16)

      const cipher = crypto.createCipheriv(this.ENCRYPTION_ALGORITHM, key, iv)
      let encrypted = cipher.update(data, 'utf8', 'hex')
      encrypted += cipher.final('hex')

      return `${iv.toString('hex')}:${encrypted}`
    } catch (error) {
      logger.error('❌ Encryption error:', error)
      return data
    }
  }

  // 🔓 解密敏感数据
  _decryptSensitiveData(encryptedData) {
    if (!encryptedData) {
      return ''
    }

    // 🎯 检查缓存
    const cacheKey = crypto.createHash('sha256').update(encryptedData).digest('hex')
    const cached = this._decryptCache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    try {
      if (encryptedData.includes(':')) {
        const parts = encryptedData.split(':')
        if (parts.length === 2) {
          const key = this._generateEncryptionKey()
          const iv = Buffer.from(parts[0], 'hex')
          const encrypted = parts[1]

          const decipher = crypto.createDecipheriv(this.ENCRYPTION_ALGORITHM, key, iv)
          let decrypted = decipher.update(encrypted, 'hex', 'utf8')
          decrypted += decipher.final('utf8')

          // 💾 存入缓存（5分钟过期）
          this._decryptCache.set(cacheKey, decrypted, 5 * 60 * 1000)

          // 📊 定期打印缓存统计
          if ((this._decryptCache.hits + this._decryptCache.misses) % 1000 === 0) {
            this._decryptCache.printStats()
          }

          return decrypted
        }
      }

      return encryptedData
    } catch (error) {
      logger.error('❌ Decryption error:', error)
      return encryptedData
    }
  }

  // 🔑 生成加密密钥
  _generateEncryptionKey() {
    // 性能优化：缓存密钥派生结果，避免重复的 CPU 密集计算
    // scryptSync 是故意设计为慢速的密钥派生函数（防暴力破解）
    // 但在高并发场景下，每次都重新计算会导致 CPU 100% 占用
    if (!this._encryptionKeyCache) {
      // 只在第一次调用时计算，后续使用缓存
      // 由于输入参数固定，派生结果永远相同，不影响数据兼容性
      this._encryptionKeyCache = crypto.scryptSync(
        config.security.encryptionKey,
        this.ENCRYPTION_SALT,
        32
      )
      logger.info('🔑 Console encryption key derived and cached for performance optimization')
    }
    return this._encryptionKeyCache
  }

  // 🎭 掩码API URL
  _maskApiUrl(apiUrl) {
    if (!apiUrl) {
      return ''
    }

    try {
      const url = new URL(apiUrl)
      return `${url.protocol}//${url.hostname}/***`
    } catch {
      return '***'
    }
  }

  // 📊 获取限流信息
  _getRateLimitInfo(accountData) {
    if (accountData.rateLimitStatus === 'limited' && accountData.rateLimitedAt) {
      const rateLimitedAt = new Date(accountData.rateLimitedAt)
      const now = new Date()
      const minutesSinceRateLimit = Math.floor((now - rateLimitedAt) / (1000 * 60))
      const __parsedDuration = parseInt(accountData.rateLimitDuration)
      const rateLimitDuration = Number.isNaN(__parsedDuration) ? 60 : __parsedDuration
      const minutesRemaining = Math.max(0, rateLimitDuration - minutesSinceRateLimit)

      return {
        isRateLimited: minutesRemaining > 0,
        rateLimitedAt: accountData.rateLimitedAt,
        minutesSinceRateLimit,
        minutesRemaining
      }
    }

    return {
      isRateLimited: false,
      rateLimitedAt: null,
      minutesSinceRateLimit: 0,
      minutesRemaining: 0
    }
  }

  // 🔄 处理模型映射，确保向后兼容
  _processModelMapping(supportedModels) {
    // 如果是空值，返回空对象（支持所有模型）
    if (!supportedModels || (Array.isArray(supportedModels) && supportedModels.length === 0)) {
      return {}
    }

    // 如果已经是对象格式（新的映射表格式），直接返回
    if (typeof supportedModels === 'object' && !Array.isArray(supportedModels)) {
      return supportedModels
    }

    // 如果是数组格式（旧格式），转换为映射表
    if (Array.isArray(supportedModels)) {
      const mapping = {}
      supportedModels.forEach((model) => {
        if (model && typeof model === 'string') {
          mapping[model] = model // 映射到自身
        }
      })
      return mapping
    }

    // 其他情况返回空对象
    return {}
  }

  // 🔍 检查模型是否支持（用于调度）
  isModelSupported(modelMapping, requestedModel) {
    // 如果映射表为空，支持所有模型
    if (!modelMapping || Object.keys(modelMapping).length === 0) {
      return true
    }

    // 检查请求的模型是否在映射表的键中
    return Object.prototype.hasOwnProperty.call(modelMapping, requestedModel)
  }

  // 🔄 获取映射后的模型名称
  getMappedModel(modelMapping, requestedModel) {
    // 如果映射表为空，返回原模型
    if (!modelMapping || Object.keys(modelMapping).length === 0) {
      return requestedModel
    }

    // 返回映射后的模型，如果不存在则返回原模型
    return modelMapping[requestedModel] || requestedModel
  }

  // 💰 检查账户使用额度（基于实时统计数据）
  async checkQuotaUsage(accountId) {
    try {
      // 获取实时的使用统计（包含费用）
      const usageStats = await redis.getAccountUsageStats(accountId)
      const currentDailyCost = usageStats.daily.cost || 0

      // 获取账户配置
      const accountData = await this.getAccount(accountId)
      if (!accountData) {
        logger.warn(`Account not found: ${accountId}`)
        return
      }

      // 解析额度配置，确保数值有效
      const dailyQuota = parseFloat(accountData.dailyQuota || '0')
      if (isNaN(dailyQuota) || dailyQuota <= 0) {
        // 没有设置有效额度，无需检查
        return
      }

      // 检查是否已经因额度停用（避免重复操作）
      if (!accountData.isActive && accountData.quotaStoppedAt) {
        return
      }

      // 检查是否超过额度限制
      if (currentDailyCost >= dailyQuota) {
        // 使用原子操作避免竞态条件 - 再次检查是否已设置quotaStoppedAt
        const client = redis.getClientSafe()
        const accountKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}`

        // double-check locking pattern - 检查quotaStoppedAt而不是status
        const existingQuotaStop = await client.hget(accountKey, 'quotaStoppedAt')
        if (existingQuotaStop) {
          return // 已经被其他进程处理
        }

        // 超过额度，停用账户
        const updates = {
          isActive: false,
          quotaStoppedAt: new Date().toISOString(),
          errorMessage: `Daily quota exceeded: $${currentDailyCost.toFixed(2)} / $${dailyQuota.toFixed(2)}`,
          schedulable: false, // 停止调度
          // 使用独立的额度超限自动停止标记
          quotaAutoStopped: 'true'
        }

        // 只有当前状态是active时才改为quota_exceeded
        // 如果是rate_limited等其他状态，保持原状态不变
        const currentStatus = await client.hget(accountKey, 'status')
        if (currentStatus === 'active') {
          updates.status = 'quota_exceeded'
        }

        await this.updateAccount(accountId, updates)

        logger.warn(
          `💰 Account ${accountId} exceeded daily quota: $${currentDailyCost.toFixed(2)} / $${dailyQuota.toFixed(2)}`
        )

        // 发送webhook通知
        try {
          const webhookNotifier = require('../utils/webhookNotifier')
          await webhookNotifier.sendAccountAnomalyNotification({
            accountId,
            accountName: accountData.name || 'Unknown Account',
            platform: 'claude-console',
            status: 'quota_exceeded',
            errorCode: 'CLAUDE_CONSOLE_QUOTA_EXCEEDED',
            reason: `Daily quota exceeded: $${currentDailyCost.toFixed(2)} / $${dailyQuota.toFixed(2)}`
          })
        } catch (webhookError) {
          logger.error('Failed to send webhook notification for quota exceeded:', webhookError)
        }
      }

      logger.debug(
        `💰 Quota check for account ${accountId}: $${currentDailyCost.toFixed(4)} / $${dailyQuota.toFixed(2)}`
      )
    } catch (error) {
      logger.error('Failed to check quota usage:', error)
    }
  }

  // 🔄 重置账户每日使用量（恢复因额度停用的账户）
  async resetDailyUsage(accountId) {
    try {
      const accountData = await this.getAccount(accountId)
      if (!accountData) {
        return
      }

      const today = redis.getDateStringInTimezone()
      const updates = {
        lastResetDate: today
      }

      // 如果账户是因为超额被停用的，恢复账户
      // 注意：状态可能是 quota_exceeded 或 rate_limited（如果429错误时也超额了）
      if (
        accountData.quotaStoppedAt &&
        accountData.isActive === false &&
        (accountData.status === 'quota_exceeded' || accountData.status === 'rate_limited')
      ) {
        updates.isActive = true
        updates.status = 'active'
        updates.errorMessage = ''
        updates.quotaStoppedAt = ''

        // 只恢复因额度超限而自动停止的账户
        if (accountData.quotaAutoStopped === 'true') {
          updates.schedulable = true
          updates.quotaAutoStopped = ''
        }

        // 如果是rate_limited状态，也清除限流相关字段
        if (accountData.status === 'rate_limited') {
          const client = redis.getClientSafe()
          const accountKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
          await client.hdel(accountKey, 'rateLimitedAt', 'rateLimitStatus', 'rateLimitAutoStopped')
        }

        logger.info(
          `✅ Restored account ${accountId} after daily reset (was ${accountData.status})`
        )
      }

      await this.updateAccount(accountId, updates)

      logger.debug(`🔄 Reset daily usage for account ${accountId}`)
    } catch (error) {
      logger.error('Failed to reset daily usage:', error)
    }
  }

  // 🔄 重置所有账户的每日使用量
  async resetAllDailyUsage() {
    try {
      const accounts = await this.getAllAccounts()
      // 与统计一致使用配置时区日期
      const today = redis.getDateStringInTimezone()
      let resetCount = 0

      for (const account of accounts) {
        // 只重置需要重置的账户
        if (account.lastResetDate !== today) {
          await this.resetDailyUsage(account.id)
          resetCount += 1
        }
      }

      logger.success(`✅ Reset daily usage for ${resetCount} Claude Console accounts`)
    } catch (error) {
      logger.error('Failed to reset all daily usage:', error)
    }
  }

  // 📊 获取账户使用统计（基于实时数据）
  async getAccountUsageStats(accountId) {
    try {
      // 获取实时的使用统计（包含费用）
      const usageStats = await redis.getAccountUsageStats(accountId)
      const currentDailyCost = usageStats.daily.cost || 0

      // 获取账户配置
      const accountData = await this.getAccount(accountId)
      if (!accountData) {
        return null
      }

      const dailyQuota = parseFloat(accountData.dailyQuota || '0')

      return {
        dailyQuota,
        dailyUsage: currentDailyCost, // 使用实时计算的费用
        remainingQuota: dailyQuota > 0 ? Math.max(0, dailyQuota - currentDailyCost) : null,
        usagePercentage: dailyQuota > 0 ? (currentDailyCost / dailyQuota) * 100 : 0,
        lastResetDate: accountData.lastResetDate,
        quotaStoppedAt: accountData.quotaStoppedAt,
        isQuotaExceeded: dailyQuota > 0 && currentDailyCost >= dailyQuota,
        // 额外返回完整的使用统计
        fullUsageStats: usageStats
      }
    } catch (error) {
      logger.error('Failed to get account usage stats:', error)
      return null
    }
  }

  // 🔄 重置账户所有异常状态
  async resetAccountStatus(accountId) {
    try {
      const accountData = await this.getAccount(accountId)
      if (!accountData) {
        throw new Error('Account not found')
      }

      const client = redis.getClientSafe()
      const accountKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}`

      // 准备要更新的字段
      const updates = {
        status: 'active',
        errorMessage: '',
        schedulable: 'true',
        isActive: 'true' // 重要：必须恢复isActive状态
      }

      // 删除所有异常状态相关的字段
      const fieldsToDelete = [
        'rateLimitedAt',
        'rateLimitStatus',
        'unauthorizedAt',
        'unauthorizedCount',
        'overloadedAt',
        'overloadStatus',
        'blockedAt',
        'quotaStoppedAt'
      ]

      // 执行更新
      await client.hset(accountKey, updates)
      await client.hdel(accountKey, ...fieldsToDelete)

      logger.success(`✅ Reset all error status for Claude Console account ${accountId}`)

      // 发送 Webhook 通知
      try {
        const webhookNotifier = require('../utils/webhookNotifier')
        await webhookNotifier.sendAccountAnomalyNotification({
          accountId,
          accountName: accountData.name || accountId,
          platform: 'claude-console',
          status: 'recovered',
          errorCode: 'STATUS_RESET',
          reason: 'Account status manually reset',
          timestamp: new Date().toISOString()
        })
      } catch (webhookError) {
        logger.warn('Failed to send webhook notification:', webhookError)
      }

      return { success: true, accountId }
    } catch (error) {
      logger.error(`❌ Failed to reset Claude Console account status: ${accountId}`, error)
      throw error
    }
  }

  // 📝 记录5xx服务器错误（用于连续错误检测）
  // 🎯 优化后的错误计数机制：引入衰减，避免账户因临时波动被长期标记
  async recordServerError(accountId, statusCode) {
    try {
      const key = `claude_console_account:${accountId}:5xx_errors`
      const client = redis.getClientSafe()

      // 🔄 使用 sorted set 记录每次错误及时间戳，支持自动衰减
      const now = Date.now()
      const slidingWindowMs = 5 * 60 * 1000
      const windowStart = now - slidingWindowMs

      // 添加当前错误记录
      await client.zadd(key, now, `${now}:${statusCode}`)

      // 清理30分钟前的旧错误（自动衰减）
      await client.zremrangebyscore(key, '-inf', windowStart)

      // 设置1小时过期时间
      await client.expire(key, Math.ceil((slidingWindowMs * 2) / 1000))

      // 获取当前有效错误数
      const errorCount = await client.zcard(key)

      logger.info(
        `📝 Recorded ${statusCode} error for Claude Console account ${accountId} (${errorCount} errors in last 5min)`
      )
    } catch (error) {
      logger.error(`❌ Failed to record ${statusCode} error for account ${accountId}:`, error)
    }
  }

  // 📊 获取5xx错误计数
  async getServerErrorCount(accountId) {
    try {
      const key = `claude_console_account:${accountId}:5xx_errors`
      const client = redis.getClientSafe()

      // 🔄 从 sorted set 获取30分钟内的错误数
      const now = Date.now()
      const slidingWindowMs = 5 * 60 * 1000
      const windowStart = now - slidingWindowMs

      // 清理过期记录（可选，因为 recordServerError 已经清理）
      await client.zremrangebyscore(key, '-inf', windowStart)

      // 获取当前有效错误数
      const count = await client.zcard(key)
      return count || 0
    } catch (error) {
      logger.error(`❌ Failed to get 5xx error count for account ${accountId}:`, error)
      return 0
    }
  }

  // 🧹 清除5xx错误计数
  async clearServerErrors(accountId) {
    try {
      const key = `claude_console_account:${accountId}:5xx_errors`
      const client = redis.getClientSafe()

      await client.del(key)
      logger.info(`✅ Cleared 5xx error count for Claude Console account ${accountId}`)
    } catch (error) {
      logger.error(`❌ Failed to clear 5xx errors for account ${accountId}:`, error)
    }
  }

  // ⚠️ 标记账号为临时错误状态（连续5xx错误后）
  async markAccountTempError(accountId) {
    try {
      const client = redis.getClientSafe()
      const accountData = await this.getAccount(accountId)

      if (!accountData) {
        throw new Error('Account not found')
      }

      // 更新账户状态
      const updates = {
        status: 'temp_error',
        schedulable: 'false', // 停止调度
        errorMessage: 'Account temporarily disabled due to consecutive 5xx errors',
        tempErrorAt: new Date().toISOString(),
        tempErrorAutoStopped: 'true' // 标记为自动停止
      }

      await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, updates)

      logger.warn(
        `⚠️ Claude Console account ${accountData.name} (${accountId}) marked as temp_error and disabled for scheduling`
      )

      // 设置 5 分钟后自动恢复
      setTimeout(
        async () => {
          try {
            const account = await this.getAccount(accountId)
            if (account && account.status === 'temp_error' && account.tempErrorAt) {
              // 验证是否确实过了 5 分钟
              const tempErrorAt = new Date(account.tempErrorAt)
              const now = new Date()
              const minutesSince = (now - tempErrorAt) / (1000 * 60)

              if (minutesSince >= 5) {
                // 恢复账户
                const recoveryUpdates = {
                  status: 'active',
                  schedulable: 'true'
                }

                await client.hset(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, recoveryUpdates)

                // 删除临时错误相关字段
                await client.hdel(
                  `${this.ACCOUNT_KEY_PREFIX}${accountId}`,
                  'errorMessage',
                  'tempErrorAt',
                  'tempErrorAutoStopped'
                )

                // 清除 5xx 错误计数
                await this.clearServerErrors(accountId)

                logger.success(
                  `✅ Auto-recovered temp_error after 5 minutes: ${account.name} (${accountId})`
                )

                // 发送恢复通知
                try {
                  const webhookNotifier = require('../utils/webhookNotifier')
                  await webhookNotifier.sendAccountAnomalyNotification({
                    accountId,
                    accountName: account.name,
                    platform: 'claude-console',
                    status: 'recovered',
                    errorCode: 'TEMP_ERROR_RECOVERED',
                    reason: 'Account auto-recovered after 5 minutes from temp_error status',
                    timestamp: new Date().toISOString()
                  })
                } catch (webhookError) {
                  logger.error('Failed to send recovery webhook:', webhookError)
                }
              }
            }
          } catch (error) {
            logger.error(`❌ Failed to auto-recover temp_error account ${accountId}:`, error)
          }
        },
        6 * 60 * 1000
      ) // 6 分钟后执行，确保已过 5 分钟

      // 发送Webhook通知
      try {
        const webhookNotifier = require('../utils/webhookNotifier')
        await webhookNotifier.sendAccountAnomalyNotification({
          accountId,
          accountName: accountData.name,
          platform: 'claude-console',
          status: 'temp_error',
          errorCode: 'CONSECUTIVE_5XX_ERRORS',
          reason: 'Account temporarily disabled due to consecutive 5xx errors',
          timestamp: new Date().toISOString()
        })
      } catch (webhookError) {
        logger.error('Failed to send temp_error webhook:', webhookError)
      }

      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to mark account ${accountId} as temp_error:`, error)
      throw error
    }
  }

  // 🔢 账户并发控制方法

  // 增加账户并发计数
  async incrAccountConcurrency(accountId, requestId, leaseSeconds = 600) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_CONCURRENCY_PREFIX}${accountId}`
    const requestKey = `${key}:${requestId}`

    // 设置请求标记和过期时间
    await client.set(requestKey, '1', 'EX', leaseSeconds)

    // 获取当前并发数
    const keys = await client.keys(`${key}:*`)
    return keys.length
  }

  // 减少账户并发计数
  async decrAccountConcurrency(accountId, requestId) {
    const client = redis.getClientSafe()
    const requestKey = `${this.ACCOUNT_CONCURRENCY_PREFIX}${accountId}:${requestId}`
    await client.del(requestKey)
  }

  // 获取账户当前并发数
  async getAccountConcurrency(accountId) {
    const client = redis.getClientSafe()
    const pattern = `${this.ACCOUNT_CONCURRENCY_PREFIX}${accountId}:*`
    let cursor = '0'
    let count = 0

    // 使用 SCAN 命令避免阻塞 Redis（生产环境推荐）
    do {
      const reply = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = reply[0]
      count += reply[1].length
    } while (cursor !== '0')

    return count
  }

  // 刷新账户并发租期
  async refreshAccountConcurrencyLease(accountId, requestId, leaseSeconds = 600) {
    const client = redis.getClientSafe()
    const requestKey = `${this.ACCOUNT_CONCURRENCY_PREFIX}${accountId}:${requestId}`
    await client.expire(requestKey, leaseSeconds)
  }

  // 🔥 流式超时管理方法

  /**
   * 记录流式超时事件
   * @param {string} accountId - 账户ID
   * @param {string} timeoutType - 超时类型（TOTAL_TIMEOUT | IDLE_TIMEOUT）
   * @param {number} duration - 超时时长（毫秒）
   */
  async recordStreamTimeout(accountId, timeoutType, duration) {
    try {
      const client = redis.getClientSafe()
      const timeoutKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}:stream_timeouts`
      const now = Date.now()
      const oneHourAgo = now - 3600000

      // 添加超时记录：成员格式 {timestamp}:{timeoutType}:{duration}
      await client.zadd(timeoutKey, now, `${now}:${timeoutType}:${duration}`)

      // 清理1小时前的记录
      await client.zremrangebyscore(timeoutKey, '-inf', oneHourAgo)

      // 设置2小时TTL（超时记录会自动过期）
      await client.expire(timeoutKey, 7200)

      logger.info(
        `📝 Recorded stream timeout for account ${accountId}: ${timeoutType} (${duration}ms)`
      )
    } catch (error) {
      logger.error(`❌ Failed to record stream timeout for account ${accountId}:`, error)
    }
  }

  /**
   * 获取流式超时次数（1小时内）
   * @param {string} accountId - 账户ID
   * @returns {Promise<number>} 超时次数
   */
  async getStreamTimeoutCount(accountId) {
    try {
      const client = redis.getClientSafe()
      const timeoutKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}:stream_timeouts`
      const count = await client.zcard(timeoutKey)
      return count || 0
    } catch (error) {
      logger.error(`❌ Failed to get stream timeout count for account ${accountId}:`, error)
      return 0
    }
  }

  /**
   * 清除流式超时记录
   * @param {string} accountId - 账户ID
   */
  async clearStreamTimeouts(accountId) {
    try {
      const client = redis.getClientSafe()
      const timeoutKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}:stream_timeouts`
      await client.del(timeoutKey)
      logger.info(`✅ Cleared stream timeouts for account ${accountId}`)
    } catch (error) {
      logger.error(`❌ Failed to clear stream timeouts for account ${accountId}:`, error)
    }
  }

  /**
   * 获取流式超时详细记录（用于调试）
   * @param {string} accountId - 账户ID
   * @returns {Promise<Array>} 超时记录数组
   */
  async getStreamTimeoutDetails(accountId) {
    try {
      const client = redis.getClientSafe()
      const timeoutKey = `${this.ACCOUNT_KEY_PREFIX}${accountId}:stream_timeouts`

      // 获取所有记录（带分数）
      const records = await client.zrange(timeoutKey, 0, -1, 'WITHSCORES')

      // 解析记录
      const details = []
      for (let i = 0; i < records.length; i += 2) {
        const member = records[i]
        const score = parseFloat(records[i + 1])

        // 解析成员：{timestamp}:{timeoutType}:{duration}
        const parts = member.split(':')
        if (parts.length >= 3) {
          details.push({
            timestamp: new Date(score),
            timeoutType: parts[1],
            duration: parseInt(parts[2]),
            raw: member
          })
        }
      }

      return details
    } catch (error) {
      logger.error(`❌ Failed to get stream timeout details for account ${accountId}:`, error)
      return []
    }
  }
}

module.exports = new ClaudeConsoleAccountService()
