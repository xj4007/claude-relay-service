/**
 * 测试 anyrouter-heibai 账户的实际 SSE 响应格式
 * 用于诊断缓存 token 分配问题
 */

const axios = require('axios')
const logger = require('../src/utils/logger')

async function testAnyrouterHeibaiResponse() {
  try {
    // 🔧 配置：请根据实际情况修改
    const ACCOUNT_API_URL = 'https://your-anyrouter-heibai-url.com/v1/messages' // 替换为实际URL
    const ACCOUNT_API_KEY = 'your-api-key' // 替换为实际API Key
    const TEST_MODEL = 'claude-haiku-4-5-20251001'

    logger.info('🧪 Starting anyrouter-heibai SSE response test...')
    logger.info(`📍 API URL: ${ACCOUNT_API_URL}`)
    logger.info(`🎯 Model: ${TEST_MODEL}`)

    // 🎯 构造测试请求（首次请求，应该创建缓存）
    const requestBody = {
      model: TEST_MODEL,
      max_tokens: 100,
      stream: true,
      messages: [
        {
          role: 'user',
          content: 'Hello, this is a test message for cache analysis.'
        }
      ],
      // 🔑 启用提示缓存
      system: [
        {
          type: 'text',
          text: 'You are a helpful assistant. This is a cached system prompt for testing.',
          cache_control: { type: 'ephemeral' }
        }
      ]
    }

    logger.info('📤 Sending test request with cache_control...')

    // 发送流式请求
    const response = await axios({
      method: 'POST',
      url: ACCOUNT_API_URL,
      data: requestBody,
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': ACCOUNT_API_KEY,
        'anthropic-beta': 'prompt-caching-2024-07-31,output-token-statistics-2024-11-04'
      },
      responseType: 'stream',
      validateStatus: () => true
    })

    if (response.status !== 200) {
      logger.error(`❌ Request failed with status ${response.status}`)
      return
    }

    logger.info('✅ Request successful, parsing SSE stream...')

    let messageStartUsage = null
    let messageDeltaUsage = null
    let buffer = ''

    // 处理流数据
    response.data.on('data', (chunk) => {
      const chunkStr = chunk.toString()
      buffer += chunkStr

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        // 解析 SSE 数据
        let dataLine = null
        if (line.startsWith('data: ') && line.length > 6) {
          dataLine = line.slice(6)
        } else if (line.startsWith('data:') && line.length > 5) {
          dataLine = line.slice(5)
        }

        if (dataLine) {
          try {
            const data = JSON.parse(dataLine)

            // 🔍 捕获 message_start 事件
            if (data.type === 'message_start' && data.message && data.message.usage) {
              messageStartUsage = data.message.usage
              logger.info('📊 [message_start] Usage data:')
              logger.info(JSON.stringify(messageStartUsage, null, 2))
            }

            // 🔍 捕获 message_delta 事件
            if (data.type === 'message_delta' && data.usage) {
              messageDeltaUsage = data.usage
              logger.info('📊 [message_delta] Usage data:')
              logger.info(JSON.stringify(messageDeltaUsage, null, 2))
            }
          } catch (e) {
            // 忽略非 JSON 行
          }
        }
      }
    })

    response.data.on('end', () => {
      logger.info('\n✅ Stream completed')

      // 🎯 分析结果
      logger.info('\n📋 === Final Analysis ===')

      if (messageStartUsage) {
        logger.info('\n🔹 message_start usage:')
        logger.info(`  input_tokens: ${messageStartUsage.input_tokens || 0}`)
        logger.info(
          `  cache_creation_input_tokens: ${messageStartUsage.cache_creation_input_tokens || 0}`
        )
        logger.info(`  cache_read_input_tokens: ${messageStartUsage.cache_read_input_tokens || 0}`)
      } else {
        logger.warn('⚠️ No message_start usage data found')
      }

      if (messageDeltaUsage) {
        logger.info('\n🔹 message_delta usage:')
        logger.info(`  input_tokens: ${messageDeltaUsage.input_tokens || 0}`)
        logger.info(`  output_tokens: ${messageDeltaUsage.output_tokens || 0}`)
        logger.info(
          `  cache_creation_input_tokens: ${messageDeltaUsage.cache_creation_input_tokens || 0}`
        )
        logger.info(`  cache_read_input_tokens: ${messageDeltaUsage.cache_read_input_tokens || 0}`)
      } else {
        logger.warn('⚠️ No message_delta usage data found')
      }

      // 🎯 诊断问题
      logger.info('\n🔍 === Problem Diagnosis ===')

      if (messageStartUsage) {
        const hasCacheCreation = (messageStartUsage.cache_creation_input_tokens || 0) > 0
        const hasCacheRead = (messageStartUsage.cache_read_input_tokens || 0) > 0

        if (hasCacheCreation && hasCacheRead) {
          logger.error('❌ PROBLEM DETECTED: First request has BOTH cache_creation AND cache_read!')
          logger.error(
            '   This is incorrect - first request should only have cache_creation, not cache_read.'
          )
        } else if (hasCacheCreation && !hasCacheRead) {
          logger.info('✅ CORRECT: First request has cache_creation but no cache_read')
        } else if (!hasCacheCreation && hasCacheRead) {
          logger.warn(
            '⚠️ UNEXPECTED: First request has cache_read but no cache_creation (should be a cache hit, not first request)'
          )
        } else {
          logger.info('ℹ️ No cache tokens found (caching may not be enabled)')
        }
      }

      logger.info('\n✅ Test completed')
      process.exit(0)
    })

    response.data.on('error', (error) => {
      logger.error(`❌ Stream error: ${error.message}`)
      process.exit(1)
    })
  } catch (error) {
    logger.error('❌ Test failed:', error.message)
    if (error.response) {
      logger.error(`Status: ${error.response.status}`)
      logger.error(`Data: ${JSON.stringify(error.response.data)}`)
    }
    process.exit(1)
  }
}

// 运行测试
testAnyrouterHeibaiResponse()
