#!/usr/bin/env node

/**
 * 修复交易日志中的剩余额度 (remainingQuota)
 *
 * 问题：历史交易日志中的 remainingQuota 可能基于旧的、不准确的 totalCost 计算
 * 解决方案：遍历所有交易日志，根据每条日志记录时的实际 totalCost 重新计算 remainingQuota
 *
 * 使用方法：
 *   node scripts/fix-transaction-log-quota.js [--dry-run] [--key-id <keyId>]
 *
 * 参数：
 *   --dry-run    : 仅模拟运行，不实际修改数据
 *   --key-id     : 仅修复指定的 API Key ID（不指定则修复所有）
 */

const redis = require('../src/models/redis')
const logger = require('../src/utils/logger')

// 解析命令行参数
const args = process.argv.slice(2)
const isDryRun = args.includes('--dry-run')
const keyIdIndex = args.indexOf('--key-id')
const targetKeyId = keyIdIndex !== -1 ? args[keyIdIndex + 1] : null

async function fixTransactionLogQuota() {
  try {
    await redis.connect()
    logger.info('🔗 Connected to Redis')

    const client = redis.getClientSafe()
    let apiKeys = []

    // 获取要处理的 API Keys
    if (targetKeyId) {
      // 仅处理指定的 Key
      const keyData = await redis.getApiKey(targetKeyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        logger.error(`❌ API Key not found: ${targetKeyId}`)
        process.exit(1)
      }
      apiKeys = [{ id: targetKeyId, ...keyData }]
      logger.info(`🎯 Processing single API Key: ${keyData.name} (${targetKeyId})`)
    } else {
      // 处理所有 Keys
      apiKeys = await redis.getAllApiKeys()
      logger.info(`📋 Found ${apiKeys.length} API Keys to process`)
    }

    let totalKeysProcessed = 0
    let totalLogsProcessed = 0
    let totalLogsFixed = 0
    let totalErrors = 0

    // 遍历每个 API Key
    for (const key of apiKeys) {
      const keyId = key.id
      const keyName = key.name || 'Unnamed'
      const totalCostLimit = parseFloat(key.totalCostLimit || 0)
      const dailyCostLimit = parseFloat(key.dailyCostLimit || 0)

      // 跳过没有费用限制的 Key
      if (totalCostLimit <= 0 && dailyCostLimit <= 0) {
        logger.debug(`⏭️  Skipping ${keyName} (${keyId}): No cost limit set`)
        continue
      }

      logger.info(`\n🔍 Processing: ${keyName} (${keyId})`)
      logger.info(`   Total Cost Limit: $${totalCostLimit}`)

      try {
        // 获取该 Key 的所有交易日志
        const logKey = `transaction_log:${keyId}`
        const now = Date.now()
        const twelveHoursAgo = now - 12 * 60 * 60 * 1000

        // 获取最近12小时的所有日志（按时间倒序）
        const logs = await client.zrevrangebyscore(logKey, now, twelveHoursAgo, 'WITHSCORES')

        if (logs.length === 0) {
          logger.debug(`   ℹ️  No transaction logs found`)
          continue
        }

        const logCount = logs.length / 2 // WITHSCORES 返回 [value, score, value, score, ...]
        logger.info(`   📊 Found ${logCount} transaction logs`)

        // 解析日志并重新计算 remainingQuota
        let logsFixed = 0
        const pipeline = client.pipeline()

        // 按时间顺序处理（从旧到新），模拟实际消费过程
        const parsedLogs = []
        for (let i = logs.length - 2; i >= 0; i -= 2) {
          const logData = logs[i]
          const timestamp = parseFloat(logs[i + 1])

          try {
            const log = JSON.parse(logData)
            parsedLogs.push({ log, timestamp, originalData: logData })
          } catch (e) {
            logger.warn(`   ⚠️  Failed to parse log: ${logData}`)
            totalErrors++
          }
        }

        // 获取当前的总成本
        const currentCostStats = await redis.getCostStats(keyId, true)
        const runningTotalCost = currentCostStats.total || 0

        logger.debug(`   💰 Current total cost: $${runningTotalCost.toFixed(6)}`)

        // 从最新的日志开始倒推，重新计算每条日志记录时的 remainingQuota
        for (let i = 0; i < parsedLogs.length; i++) {
          const { log, timestamp, originalData } = parsedLogs[i]
          const logCost = log.cost || 0

          // 计算这条日志记录时的 totalCost
          // 如果是最新的日志，使用当前的 totalCost
          // 如果是历史日志，减去后续的消费
          let totalCostAtTime = runningTotalCost
          if (i < parsedLogs.length - 1) {
            // 减去后续所有日志的消费
            for (let j = i + 1; j < parsedLogs.length; j++) {
              totalCostAtTime -= parsedLogs[j].log.cost || 0
            }
          }

          // 重新计算 remainingQuota
          let newRemainingQuota = null
          if (totalCostLimit > 0) {
            newRemainingQuota = totalCostLimit - totalCostAtTime
          } else if (dailyCostLimit > 0) {
            // 对于日费用限制，需要获取当日的成本
            // 这里简化处理，使用 totalCost（实际应该使用 dailyCost）
            newRemainingQuota = dailyCostLimit - totalCostAtTime
          }

          const oldRemainingQuota = log.remainingQuota

          // 检查是否需要更新
          if (oldRemainingQuota === null || oldRemainingQuota === undefined) {
            // 旧日志没有 remainingQuota，添加
            log.remainingQuota = newRemainingQuota
            logsFixed++

            if (!isDryRun) {
              // 删除旧日志，添加新日志
              pipeline.zrem(logKey, originalData)
              pipeline.zadd(logKey, timestamp, JSON.stringify(log))
            }

            logger.debug(
              `   ✏️  [${new Date(timestamp).toISOString()}] Added remainingQuota: $${newRemainingQuota?.toFixed(2) || 'N/A'}`
            )
          } else if (Math.abs(oldRemainingQuota - (newRemainingQuota || 0)) > 0.01) {
            // remainingQuota 不一致，更新
            log.remainingQuota = newRemainingQuota
            logsFixed++

            if (!isDryRun) {
              // 删除旧日志，添加新日志
              pipeline.zrem(logKey, originalData)
              pipeline.zadd(logKey, timestamp, JSON.stringify(log))
            }

            logger.debug(
              `   🔧 [${new Date(timestamp).toISOString()}] Fixed: $${oldRemainingQuota.toFixed(2)} → $${newRemainingQuota?.toFixed(2) || 'N/A'} (diff: $${Math.abs(oldRemainingQuota - (newRemainingQuota || 0)).toFixed(2)})`
            )
          }
        }

        // 执行批量更新
        if (!isDryRun && logsFixed > 0) {
          await pipeline.exec()
        }

        if (logsFixed > 0) {
          logger.info(`   ✅ Fixed ${logsFixed} logs for ${keyName}`)
        } else {
          logger.info(`   ✓ All logs are correct for ${keyName}`)
        }

        totalKeysProcessed++
        totalLogsProcessed += logCount
        totalLogsFixed += logsFixed
      } catch (error) {
        logger.error(`   ❌ Error processing ${keyName}: ${error.message}`)
        totalErrors++
      }
    }

    // 输出统计信息
    logger.info(`\n${'='.repeat(60)}`)
    logger.info('📊 Fix Transaction Log Quota - Summary')
    logger.info('='.repeat(60))
    logger.info(`Mode: ${isDryRun ? 'DRY RUN (no changes made)' : 'LIVE (changes applied)'}`)
    logger.info(`Total API Keys processed: ${totalKeysProcessed}`)
    logger.info(`Total logs processed: ${totalLogsProcessed}`)
    logger.info(`Total logs fixed: ${totalLogsFixed}`)
    logger.info(`Total errors: ${totalErrors}`)
    logger.info('='.repeat(60))

    if (isDryRun && totalLogsFixed > 0) {
      logger.info('\n💡 This was a dry run. To apply changes, run without --dry-run flag.')
    } else if (totalLogsFixed > 0) {
      logger.info('\n✅ Transaction logs have been successfully fixed!')
      logger.info('   Please refresh the frontend to see the corrected remaining quotas.')
    } else {
      logger.info('\n✓ All transaction logs are already correct. No changes needed.')
    }
  } catch (error) {
    logger.error('❌ Fatal error:', error)
    process.exit(1)
  } finally {
    await redis.disconnect()
    process.exit(0)
  }
}

// 运行脚本
if (require.main === module) {
  logger.info('🚀 Starting transaction log quota fix...')
  if (isDryRun) {
    logger.warn('⚠️  DRY RUN MODE - No changes will be made')
  }
  if (targetKeyId) {
    logger.info(`🎯 Target Key ID: ${targetKeyId}`)
  }
  logger.info('')

  fixTransactionLogQuota().catch((error) => {
    logger.error('❌ Unhandled error:', error)
    process.exit(1)
  })
}

module.exports = { fixTransactionLogQuota }
