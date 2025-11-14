#!/usr/bin/env node

/**
 * 诊断工具：检查 API Key 的总费用限制和消费日志的一致性
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const redis = require('../src/models/redis')
const logger = require('../src/utils/logger')

async function diagnoseQuota(keyId) {
  try {
    await redis.initialize()
    logger.info('🔗 Connected to Redis')

    // 1. 获取 API Key 信息
    const keyData = await redis.getApiKey(keyId)
    if (!keyData) {
      logger.error(`❌ API Key not found: ${keyId}`)
      process.exit(1)
    }

    console.log('\n' + '='.repeat(60))
    console.log(`📊 API Key: ${keyData.name} (${keyId})`)
    console.log('='.repeat(60))

    // 2. 获取总费用限制
    const totalCostLimit = parseFloat(keyData.totalCostLimit || 0)
    console.log(`💰 Total Cost Limit: $${totalCostLimit.toFixed(2)}`)

    // 3. 获取当前总费用
    const costStats = await redis.getCostStats(keyId, true) // 强制刷新
    const currentTotalCost = costStats.total || 0
    console.log(`📈 Current Total Cost: $${currentTotalCost.toFixed(4)}`)

    // 4. 计算正确的剩余额度
    const correctRemainingQuota = totalCostLimit - currentTotalCost
    console.log(`✅ Correct Remaining Quota: $${correctRemainingQuota.toFixed(4)}`)

    // 5. 获取最近的消费日志
    const client = redis.getClientSafe()
    const logKey = `transaction_log:${keyId}`
    const recentLogs = await client.zrevrange(logKey, 0, 4, 'WITHSCORES')

    if (recentLogs.length === 0) {
      console.log('\n📝 No transaction logs found')
      await redis.disconnect()
      return
    }

    console.log('\n📝 Recent Transaction Logs (last 5):')
    console.log('-'.repeat(60))

    for (let i = 0; i < recentLogs.length; i += 2) {
      const logData = recentLogs[i]
      const timestamp = recentLogs[i + 1]
      const log = JSON.parse(logData)

      const logDate = new Date(parseInt(timestamp))
      const logRemainingQuota = log.remainingQuota

      console.log(`\n🕐 ${logDate.toISOString()}`)
      console.log(`   Model: ${log.model}`)
      console.log(`   Cost: $${(log.cost || 0).toFixed(4)}`)
      console.log(`   Remaining Quota (logged): $${logRemainingQuota !== null && logRemainingQuota !== undefined ? logRemainingQuota.toFixed(4) : 'N/A'}`)

      // 检查是否一致
      if (i === 0) {
        // 最新的日志
        const diff = Math.abs((logRemainingQuota || 0) - correctRemainingQuota)
        if (diff > 0.01) {
          console.log(`   ⚠️  MISMATCH! Difference: $${diff.toFixed(4)}`)
          console.log(`   ✅ Should be: $${correctRemainingQuota.toFixed(4)}`)
        } else {
          console.log(`   ✅ Correct!`)
        }
      }
    }

    console.log('\n' + '='.repeat(60))
    console.log('📊 Summary:')
    console.log('='.repeat(60))
    console.log(`Total Cost Limit: $${totalCostLimit.toFixed(2)}`)
    console.log(`Current Total Cost: $${currentTotalCost.toFixed(4)}`)
    console.log(`Correct Remaining: $${correctRemainingQuota.toFixed(4)}`)

    await redis.disconnect()
    logger.info('👋 Redis disconnected')
  } catch (error) {
    logger.error(`❌ Error: ${error.message}`)
    logger.error(error.stack)
    process.exit(1)
  }
}

// Parse command line arguments
const args = process.argv.slice(2)
const keyIdIndex = args.indexOf('--key-id')
const keyId = keyIdIndex !== -1 ? args[keyIdIndex + 1] : null

if (!keyId) {
  console.error('❌ Usage: node scripts/diagnose-quota.js --key-id <API_KEY_ID>')
  console.error('   Example: node scripts/diagnose-quota.js --key-id 425a5307-9bc8-4b25-b4b1-39ebaed2c9b8')
  process.exit(1)
}

diagnoseQuota(keyId)
