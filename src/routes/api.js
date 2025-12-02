const express = require('express')
const claudeRelayService = require('../services/claudeRelayService')
const claudeConsoleRelayService = require('../services/claudeConsoleRelayService')
const bedrockRelayService = require('../services/bedrockRelayService')
const ccrRelayService = require('../services/ccrRelayService')
const bedrockAccountService = require('../services/bedrockAccountService')
const unifiedClaudeScheduler = require('../services/unifiedClaudeScheduler')
const apiKeyService = require('../services/apiKeyService')
const contentModerationService = require('../services/contentModerationService')
const IntelligentErrorFilter = require('../utils/intelligentErrorFilter')
const config = require('../../config/config')
const { authenticateApiKey } = require('../middleware/auth')
const logger = require('../utils/logger')
const { getEffectiveModel, parseVendorPrefixedModel } = require('../utils/modelHelper')
const sessionHelper = require('../utils/sessionHelper')
const { updateRateLimitCounters } = require('../utils/rateLimitHelper')
const retryManager = require('../utils/retryManager')
const responseCacheService = require('../services/responseCacheService')
const {
  convertJsonToSSEStream,
  sendSSEError,
  isStreamRetryableError
} = require('../utils/sseConverter')

const { sanitizeUpstreamError } = require('../utils/errorSanitizer')
const router = express.Router()

function queueRateLimitUpdate(rateLimitInfo, usageSummary, model, context = '') {
  if (!rateLimitInfo) {
    return Promise.resolve({ totalTokens: 0, totalCost: 0 })
  }

  const label = context ? ` (${context})` : ''

  return updateRateLimitCounters(rateLimitInfo, usageSummary, model)
    .then(({ totalTokens, totalCost }) => {
      if (totalTokens > 0) {
        logger.api(`📊 Updated rate limit token count${label}: +${totalTokens} tokens`)
      }
      if (typeof totalCost === 'number' && totalCost > 0) {
        logger.api(`💰 Updated rate limit cost count${label}: +$${totalCost.toFixed(6)}`)
      }
      return { totalTokens, totalCost }
    })
    .catch((error) => {
      logger.error(`❌ Failed to update rate limit counters${label}:`, error)
      return { totalTokens: 0, totalCost: 0 }
    })
}

// 🔧 共享的消息处理函数
async function handleMessagesRequest(req, res) {
  try {
    const startTime = Date.now()

    // Claude 服务权限校验，阻止未授权的 Key
    if (
      req.apiKey.permissions &&
      req.apiKey.permissions !== 'all' &&
      req.apiKey.permissions !== 'claude'
    ) {
      return res.status(403).json({
        error: {
          type: 'permission_error',
          message: '此 API Key 无权访问 Claude 服务'
        }
      })
    }

    // 🔄 并发满额重试标志：最多重试一次（使用req对象存储状态）
    if (req._concurrencyRetryAttempted === undefined) {
      req._concurrencyRetryAttempted = false
    }

    // 严格的输入验证
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Request body must be a valid JSON object'
      })
    }

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Missing or invalid field: messages (must be an array)'
      })
    }

    if (req.body.messages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Messages array cannot be empty'
      })
    }

    // 模型限制（黑名单）校验：统一在此处处理（去除供应商前缀）
    if (
      req.apiKey.enableModelRestriction &&
      Array.isArray(req.apiKey.restrictedModels) &&
      req.apiKey.restrictedModels.length > 0
    ) {
      const effectiveModel = getEffectiveModel(req.body.model || '')
      if (req.apiKey.restrictedModels.includes(effectiveModel)) {
        return res.status(403).json({
          error: {
            type: 'forbidden',
            message: '暂无该模型访问权限'
          }
        })
      }
    }

    // 🛡️ 内容审核：在发送到 Claude 之前检查所有输入内容
    if (config.contentModeration && config.contentModeration.enabled) {
      try {
        const moderationResult = await contentModerationService.moderateContent(req.body, {
          keyName: req.apiKey.name,
          keyId: req.apiKey.id,
          userId: req.apiKey.userId
        })
        if (!moderationResult.passed) {
          logger.warn(`🚫 Content moderation blocked request for key: ${req.apiKey.name}`)
          return res.status(400).json({
            error: {
              type: 'content_moderation_error',
              message: moderationResult.message
            }
          })
        }
        logger.info(`✅ Content moderation passed for key: ${req.apiKey.name}`)
      } catch (moderationError) {
        // 审核服务出错时记录日志但不阻止请求（优雅降级）
        logger.error('❌ Content moderation service error:', moderationError)
      }
    }

    // // 设置 max_tokens 默认值（如果用户未传递）
    // if (!req.body.max_tokens) {
    //   req.body.max_tokens = 32000 //32000
    //   logger.api(`🔢 Added default max_tokens: 32000 for key: ${req.apiKey.name}`)
    // }

    // 检查是否为流式请求
    const isStream = req.body.stream === true

    // 临时修复新版本客户端，删除context_management字段，避免报错
    if (req.body.context_management) {
      delete req.body.context_management
    }

    // 遍历tools数组，删除input_examples字段
    if (req.body.tools && Array.isArray(req.body.tools)) {
      req.body.tools.forEach((tool) => {
        if (tool && typeof tool === 'object' && tool.input_examples) {
          delete tool.input_examples
        }
      })
    }

    logger.api(
      `🚀 Processing ${isStream ? 'stream' : 'non-stream'} request for key: ${req.apiKey.name}`
    )

    if (isStream) {
      // 🌊 流式响应 - 带连接级重试和非流式降级
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('X-Accel-Buffering', 'no') // 禁用 Nginx 缓冲

      // 禁用 Nagle 算法，确保数据立即发送
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true)
      }

      // 生成会话哈希（用于流式请求） - 必须包含 apiKeyId 确保用户隔离
      const sessionHash = sessionHelper.generateSessionHash(req.body, req.apiKey.id)
      const requestedModel = req.body.model

      // 🔄 流式重试配置
      const MAX_STREAM_RETRIES = 3 // 最多尝试3个账户
      const excludedAccounts = []
      let streamRetryCount = 0
      let lastStreamError = null
      let usageDataCaptured = false

      logger.info(
        `🌊 Starting stream request with retry support (max ${MAX_STREAM_RETRIES} accounts)`
      )

      // 🔄 连接级重试循环
      while (streamRetryCount < MAX_STREAM_RETRIES) {
        let accountId
        let accountType

        try {
          // 选择账户（排除已失败的）
          const selection = await unifiedClaudeScheduler.selectAccountForApiKey(
            req.apiKey,
            sessionHash,
            requestedModel,
            { excludedAccounts, requestBody: req.body }
          )
          ;({ accountId, accountType } = selection)

          logger.info(
            `🎯 Stream attempt ${streamRetryCount + 1}/${MAX_STREAM_RETRIES} using account: ${accountId} (${accountType})`
          )
        } catch (error) {
          if (error.code === 'CLAUDE_DEDICATED_RATE_LIMITED') {
            const limitMessage = claudeRelayService._buildStandardRateLimitMessage(
              error.rateLimitEndAt
            )
            if (!res.headersSent) {
              res.status(403)
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  error: 'upstream_rate_limited',
                  message: limitMessage
                })
              )
            } else {
              sendSSEError(res, { message: limitMessage, type: 'rate_limit_error' })
            }
            return
          }

          logger.error(`❌ Failed to select account: ${error.message}`)
          lastStreamError = error
          break // 无可用账户，跳出循环
        }

        try {
          // 根据账号类型选择对应的转发服务并调用
          if (accountType === 'claude-official') {
            // 官方Claude账号使用原有的转发服务（会自己选择账号）
            await claudeRelayService.relayStreamRequestWithUsageCapture(
              req.body,
              req.apiKey,
              res,
              req.headers,
              (usageData) => {
                // 🔒 防重复扣费检查
                if (usageDataCaptured) {
                  logger.warn(
                    '⚠️ Usage already captured, skipping duplicate record to prevent double charging'
                  )
                  return
                }

                // 回调函数：当检测到完整usage数据时记录真实token使用量
                logger.info(
                  '🎯 Usage callback triggered with complete data:',
                  JSON.stringify(usageData, null, 2)
                )

                if (
                  usageData &&
                  usageData.input_tokens !== undefined &&
                  usageData.output_tokens !== undefined
                ) {
                  const inputTokens = usageData.input_tokens || 0
                  const outputTokens = usageData.output_tokens || 0
                  // 兼容处理：如果有详细的 cache_creation 对象，使用它；否则使用总的 cache_creation_input_tokens
                  let cacheCreateTokens = usageData.cache_creation_input_tokens || 0
                  let ephemeral5mTokens = 0
                  let ephemeral1hTokens = 0

                  if (usageData.cache_creation && typeof usageData.cache_creation === 'object') {
                    ephemeral5mTokens = usageData.cache_creation.ephemeral_5m_input_tokens || 0
                    ephemeral1hTokens = usageData.cache_creation.ephemeral_1h_input_tokens || 0
                    // 总的缓存创建 tokens 是两者之和
                    cacheCreateTokens = ephemeral5mTokens + ephemeral1hTokens
                  }

                  const cacheReadTokens = usageData.cache_read_input_tokens || 0
                  const model = usageData.model || 'unknown'

                  // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
                  const { accountId: usageAccountId } = usageData

                  // 构建 usage 对象以传递给 recordUsage
                  const usageObject = {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    cache_creation_input_tokens: cacheCreateTokens,
                    cache_read_input_tokens: cacheReadTokens
                  }

                  // 如果有详细的缓存创建数据，添加到 usage 对象中
                  if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
                    usageObject.cache_creation = {
                      ephemeral_5m_input_tokens: ephemeral5mTokens,
                      ephemeral_1h_input_tokens: ephemeral1hTokens
                    }
                  }

                  apiKeyService
                    .recordUsageWithDetails(
                      req.apiKey.id,
                      usageObject,
                      model,
                      usageAccountId,
                      'claude'
                    )
                    .catch((error) => {
                      logger.error('❌ Failed to record stream usage:', error)
                    })

                  queueRateLimitUpdate(
                    req.rateLimitInfo,
                    {
                      inputTokens,
                      outputTokens,
                      cacheCreateTokens,
                      cacheReadTokens
                    },
                    model,
                    'claude-stream'
                  )

                  usageDataCaptured = true
                  logger.api(
                    `📊 Stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`
                  )
                } else {
                  logger.warn(
                    '⚠️ Usage callback triggered but data is incomplete:',
                    JSON.stringify(usageData)
                  )
                }
              }
            )
          } else if (accountType === 'claude-console') {
            // Claude Console账号使用Console转发服务（需要传递accountId）
            await claudeConsoleRelayService.relayStreamRequestWithUsageCapture(
              req.body,
              req.apiKey,
              res,
              req.headers,
              (usageData) => {
                // 🔒 防重复扣费检查
                if (usageDataCaptured) {
                  logger.warn(
                    '⚠️ Usage already captured, skipping duplicate record to prevent double charging'
                  )
                  return
                }

                // 回调函数：当检测到完整usage数据时记录真实token使用量
                logger.info(
                  '🎯 Usage callback triggered with complete data:',
                  JSON.stringify(usageData, null, 2)
                )

                if (
                  usageData &&
                  usageData.input_tokens !== undefined &&
                  usageData.output_tokens !== undefined
                ) {
                  const inputTokens = usageData.input_tokens || 0
                  const outputTokens = usageData.output_tokens || 0
                  // 兼容处理：如果有详细的 cache_creation 对象，使用它；否则使用总的 cache_creation_input_tokens
                  let cacheCreateTokens = usageData.cache_creation_input_tokens || 0
                  let ephemeral5mTokens = 0
                  let ephemeral1hTokens = 0

                  if (usageData.cache_creation && typeof usageData.cache_creation === 'object') {
                    ephemeral5mTokens = usageData.cache_creation.ephemeral_5m_input_tokens || 0
                    ephemeral1hTokens = usageData.cache_creation.ephemeral_1h_input_tokens || 0
                    // 总的缓存创建 tokens 是两者之和
                    cacheCreateTokens = ephemeral5mTokens + ephemeral1hTokens
                  }

                  const cacheReadTokens = usageData.cache_read_input_tokens || 0
                  const model = usageData.model || 'unknown'

                  // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
                  const usageAccountId = usageData.accountId

                  // 构建 usage 对象以传递给 recordUsage
                  const usageObject = {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    cache_creation_input_tokens: cacheCreateTokens,
                    cache_read_input_tokens: cacheReadTokens
                  }

                  // 如果有详细的缓存创建数据，添加到 usage 对象中
                  if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
                    usageObject.cache_creation = {
                      ephemeral_5m_input_tokens: ephemeral5mTokens,
                      ephemeral_1h_input_tokens: ephemeral1hTokens
                    }
                  }

                  apiKeyService
                    .recordUsageWithDetails(
                      req.apiKey.id,
                      usageObject,
                      model,
                      usageAccountId,
                      'claude-console'
                    )
                    .catch((error) => {
                      logger.error('❌ Failed to record stream usage:', error)
                    })

                  queueRateLimitUpdate(
                    req.rateLimitInfo,
                    {
                      inputTokens,
                      outputTokens,
                      cacheCreateTokens,
                      cacheReadTokens
                    },
                    model,
                    'claude-console-stream'
                  )

                  usageDataCaptured = true
                  logger.api(
                    `📊 Stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`
                  )
                } else {
                  logger.warn(
                    '⚠️ Usage callback triggered but data is incomplete:',
                    JSON.stringify(usageData)
                  )
                }
              },
              accountId
            )
          } else if (accountType === 'bedrock') {
            // Bedrock账号使用Bedrock转发服务
            try {
              const bedrockAccountResult = await bedrockAccountService.getAccount(accountId)
              if (!bedrockAccountResult.success) {
                throw new Error('Failed to get Bedrock account details')
              }

              const result = await bedrockRelayService.handleStreamRequest(
                req.body,
                bedrockAccountResult.data,
                res
              )

              // 记录Bedrock使用统计
              if (result.usage) {
                const inputTokens = result.usage.input_tokens || 0
                const outputTokens = result.usage.output_tokens || 0

                apiKeyService
                  .recordUsage(
                    req.apiKey.id,
                    inputTokens,
                    outputTokens,
                    0,
                    0,
                    result.model,
                    accountId,
                    accountType
                  )
                  .catch((error) => {
                    logger.error('❌ Failed to record Bedrock stream usage:', error)
                  })

                queueRateLimitUpdate(
                  req.rateLimitInfo,
                  {
                    inputTokens,
                    outputTokens,
                    cacheCreateTokens: 0,
                    cacheReadTokens: 0
                  },
                  result.model,
                  'bedrock-stream'
                )

                usageDataCaptured = true
                logger.api(
                  `📊 Bedrock stream usage recorded - Model: ${result.model}, Input: ${inputTokens}, Output: ${outputTokens}, Total: ${inputTokens + outputTokens} tokens`
                )
              }
            } catch (error) {
              logger.error('❌ Bedrock stream request failed:', error)
              if (!res.headersSent) {
                return res
                  .status(500)
                  .json({ error: 'Bedrock service error', message: error.message })
              }
              return undefined
            }
          } else if (accountType === 'ccr') {
            // CCR账号使用CCR转发服务（需要传递accountId）
            await ccrRelayService.relayStreamRequestWithUsageCapture(
              req.body,
              req.apiKey,
              res,
              req.headers,
              (usageData) => {
                // 🔒 防重复扣费检查
                if (usageDataCaptured) {
                  logger.warn(
                    '⚠️ Usage already captured, skipping duplicate record to prevent double charging'
                  )
                  return
                }

                // 回调函数：当检测到完整usage数据时记录真实token使用量
                logger.info(
                  '🎯 CCR usage callback triggered with complete data:',
                  JSON.stringify(usageData, null, 2)
                )

                if (
                  usageData &&
                  usageData.input_tokens !== undefined &&
                  usageData.output_tokens !== undefined
                ) {
                  const inputTokens = usageData.input_tokens || 0
                  const outputTokens = usageData.output_tokens || 0
                  // 兼容处理：如果有详细的 cache_creation 对象，使用它；否则使用总的 cache_creation_input_tokens
                  let cacheCreateTokens = usageData.cache_creation_input_tokens || 0
                  let ephemeral5mTokens = 0
                  let ephemeral1hTokens = 0

                  if (usageData.cache_creation && typeof usageData.cache_creation === 'object') {
                    ephemeral5mTokens = usageData.cache_creation.ephemeral_5m_input_tokens || 0
                    ephemeral1hTokens = usageData.cache_creation.ephemeral_1h_input_tokens || 0
                    // 总的缓存创建 tokens 是两者之和
                    cacheCreateTokens = ephemeral5mTokens + ephemeral1hTokens
                  }

                  const cacheReadTokens = usageData.cache_read_input_tokens || 0
                  const model = usageData.model || 'unknown'

                  // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
                  const usageAccountId = usageData.accountId

                  // 构建 usage 对象以传递给 recordUsage
                  const usageObject = {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    cache_creation_input_tokens: cacheCreateTokens,
                    cache_read_input_tokens: cacheReadTokens
                  }

                  // 如果有详细的缓存创建数据，添加到 usage 对象中
                  if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
                    usageObject.cache_creation = {
                      ephemeral_5m_input_tokens: ephemeral5mTokens,
                      ephemeral_1h_input_tokens: ephemeral1hTokens
                    }
                  }

                  apiKeyService
                    .recordUsageWithDetails(
                      req.apiKey.id,
                      usageObject,
                      model,
                      usageAccountId,
                      'ccr'
                    )
                    .catch((error) => {
                      logger.error('❌ Failed to record CCR stream usage:', error)
                    })

                  queueRateLimitUpdate(
                    req.rateLimitInfo,
                    {
                      inputTokens,
                      outputTokens,
                      cacheCreateTokens,
                      cacheReadTokens
                    },
                    model,
                    'ccr-stream'
                  )

                  usageDataCaptured = true
                  logger.api(
                    `📊 CCR stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`
                  )
                } else {
                  logger.warn(
                    '⚠️ CCR usage callback triggered but data is incomplete:',
                    JSON.stringify(usageData)
                  )
                }
              },
              accountId
            )
          }

          // ✅ 流式请求成功完成，退出重试循环
          logger.info(`✅ Stream request succeeded using account: ${accountId} (${accountType})`)
          break
        } catch (error) {
          // ❌ 流式请求失败，判断是否需要重试
          logger.error(`❌ Stream attempt ${streamRetryCount + 1} failed: ${error.message}`, error)

          lastStreamError = error

          // 检查错误是否可以重试
          const isRetryable = isStreamRetryableError(error)

          if (!isRetryable) {
            logger.warn(`⚠️ Non-retryable stream error, stopping: ${error.message}`)
            break
          }

          // 排除失败的账户
          excludedAccounts.push(accountId)
          logger.info(`🔄 Excluded account ${accountId}, will try another account`)

          // 增加重试计数
          streamRetryCount++

          // 如果还有重试机会，继续循环
          if (streamRetryCount < MAX_STREAM_RETRIES) {
            logger.info(
              `🔄 Retrying stream request (attempt ${streamRetryCount + 1}/${MAX_STREAM_RETRIES})...`
            )
            continue
          } else {
            logger.warn(`⚠️ Reached max stream retry attempts (${MAX_STREAM_RETRIES})`)
            break
          }
        }
      }

      // 🔄 如果所有流式重试都失败，尝试降级为非流式请求
      if (streamRetryCount >= MAX_STREAM_RETRIES && lastStreamError) {
        logger.warn(
          `⚠️ All ${MAX_STREAM_RETRIES} stream attempts failed, attempting non-stream fallback...`
        )

        try {
          // 使用非流式请求作为降级方案（使用retryManager，支持3次重试）
          const fallbackSessionHash = sessionHelper.generateSessionHash(req.body, req.apiKey.id)
          const fallbackRequestedModel = req.body.model

          const result = await retryManager.executeWithRetry(
            // 请求函数
            async (selectedAccountId, selectedAccountType) => {
              logger.info(
                `🔄 Non-stream fallback attempt using account: ${selectedAccountId} (${selectedAccountType})`
              )

              let fallbackResponse

              if (selectedAccountType === 'claude-official') {
                fallbackResponse = await claudeRelayService.relayRequest(
                  req.body,
                  req.apiKey,
                  req,
                  res,
                  req.headers
                )
                // 添加 accountType 到响应中
                if (fallbackResponse && typeof fallbackResponse === 'object') {
                  fallbackResponse.accountType = selectedAccountType
                }
              } else if (selectedAccountType === 'claude-console') {
                fallbackResponse = await claudeConsoleRelayService.relayRequest(
                  req.body,
                  req.apiKey,
                  req,
                  res,
                  req.headers,
                  selectedAccountId
                )
                // 添加 accountType 到响应中
                if (fallbackResponse && typeof fallbackResponse === 'object') {
                  fallbackResponse.accountType = selectedAccountType
                }
              } else if (selectedAccountType === 'bedrock') {
                const bedrockAccountResult =
                  await bedrockAccountService.getAccount(selectedAccountId)
                if (!bedrockAccountResult.success) {
                  throw new Error('Failed to get Bedrock account details')
                }

                const bedrockFallbackResult = await bedrockRelayService.handleNonStreamRequest(
                  req.body,
                  bedrockAccountResult.data,
                  req.headers
                )

                fallbackResponse = {
                  statusCode: bedrockFallbackResult.success ? 200 : 500,
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(
                    bedrockFallbackResult.success
                      ? bedrockFallbackResult.data
                      : { error: bedrockFallbackResult.error }
                  ),
                  accountId: selectedAccountId,
                  accountType: selectedAccountType
                }
              } else if (selectedAccountType === 'ccr') {
                fallbackResponse = await ccrRelayService.relayRequest(
                  req.body,
                  req.apiKey,
                  req,
                  res,
                  req.headers,
                  selectedAccountId
                )
                // 添加 accountType 到响应中
                if (fallbackResponse && typeof fallbackResponse === 'object') {
                  fallbackResponse.accountType = selectedAccountType
                }
              }

              return fallbackResponse
            },
            // 账户选择函数（排除已失败的流式账户）
            async (additionalExcludedAccounts) => {
              const allExcluded = [...excludedAccounts, ...additionalExcludedAccounts]
              logger.debug(
                `🔍 Selecting account for non-stream fallback (excluding ${allExcluded.length} accounts)`
              )

              const selection = await unifiedClaudeScheduler.selectAccountForApiKey(
                req.apiKey,
                fallbackSessionHash,
                fallbackRequestedModel,
                { excludedAccounts: allExcluded, requestBody: req.body }
              )
              return selection
            },
            {
              maxRetries: 3,
              initialExcludedAccounts: []
            }
          )

          // 检查非流式降级结果
          if (result.success && result.response) {
            logger.info(`✅ Non-stream fallback succeeded, converting to SSE format`)

            // 🌊 将JSON响应转换为SSE流
            await convertJsonToSSEStream(result.response, res)

            // 记录usage数据
            try {
              const jsonData = JSON.parse(result.response.body)
              if (
                jsonData.usage &&
                jsonData.usage.input_tokens !== undefined &&
                jsonData.usage.output_tokens !== undefined
              ) {
                const inputTokens = jsonData.usage.input_tokens || 0
                const outputTokens = jsonData.usage.output_tokens || 0
                const cacheCreateTokens = jsonData.usage.cache_creation_input_tokens || 0
                const cacheReadTokens = jsonData.usage.cache_read_input_tokens || 0
                const { baseModel } = parseVendorPrefixedModel(
                  jsonData.model || req.body.model || 'unknown'
                )
                const model = baseModel || jsonData.model || req.body.model || 'unknown'

                await apiKeyService.recordUsage(
                  req.apiKey.id,
                  inputTokens,
                  outputTokens,
                  cacheCreateTokens,
                  cacheReadTokens,
                  model,
                  result.accountId,
                  result.response.accountType
                )

                await queueRateLimitUpdate(
                  req.rateLimitInfo,
                  { inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens },
                  model,
                  'stream-fallback-to-non-stream'
                )

                usageDataCaptured = true
                logger.info(
                  `📊 Stream fallback usage recorded - Model: ${model}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`
                )
              }
            } catch (usageError) {
              logger.error(`❌ Failed to record fallback usage: ${usageError.message}`)
            }

            return // 成功返回
          } else {
            // 非流式降级也失败了
            logger.error(`❌ Non-stream fallback also failed after ${result.attempts} attempts`)
            lastStreamError = result.error || new Error('All fallback attempts failed')
          }
        } catch (fallbackError) {
          logger.error(`❌ Exception during non-stream fallback: ${fallbackError.message}`)
          lastStreamError = fallbackError
        }
      }

      // 🚨 所有重试都失败了，发送错误响应
      if (lastStreamError && !res.headersSent) {
        logger.error(`❌ All stream and fallback attempts exhausted, sending error`)
        sendSSEError(res, lastStreamError)
        return
      }

      // 流式请求完成后 - 如果没有捕获到usage数据，记录警告但不进行估算
      setTimeout(() => {
        if (!usageDataCaptured) {
          logger.warn(
            '⚠️ No usage data captured from SSE stream - no statistics recorded (official data only)'
          )
        }
      }, 1000) // 1秒后检查
    } else {
      // 🔄 非流式响应 - 带重试和缓存
      logger.info('📄 Starting non-streaming request with retry & cache', {
        apiKeyId: req.apiKey.id,
        apiKeyName: req.apiKey.name
      })

      // 生成会话哈希用于sticky会话 - 必须包含 apiKeyId 确保用户隔离
      const sessionHash = sessionHelper.generateSessionHash(req.body, req.apiKey.id)
      const requestedModel = req.body.model

      // 生成缓存键（使用 sessionHash 确保会话隔离）
      const cacheKey = responseCacheService.generateCacheKey(req.body, requestedModel, sessionHash)
      logger.debug(
        `📋 Generated cache key: ${cacheKey ? `${cacheKey.substring(0, 16)}...` : 'none'} | Session: ${sessionHash ? sessionHash.substring(0, 8) : 'none'}... | ApiKey: ${req.apiKey.name}`
      )

      // 🎯 使用缓存或执行新请求（自动处理请求去重）
      const response = await responseCacheService.getOrFetchResponse(
        cacheKey,
        async () => {
          // 🔄 使用 retryManager 执行带重试的请求
          const result = await retryManager.executeWithRetry(
            // 请求函数
            async (selectedAccountId, selectedAccountType) => {
              logger.debug(
                `🎯 Executing request with account: ${selectedAccountId} (${selectedAccountType})`
              )

              let accountResponse

              if (selectedAccountType === 'claude-official') {
                // 官方Claude账号
                accountResponse = await claudeRelayService.relayRequest(
                  req.body,
                  req.apiKey,
                  req,
                  res,
                  req.headers
                )
              } else if (selectedAccountType === 'claude-console') {
                // Claude Console账号
                accountResponse = await claudeConsoleRelayService.relayRequest(
                  req.body,
                  req.apiKey,
                  req,
                  res,
                  req.headers,
                  selectedAccountId
                )
              } else if (selectedAccountType === 'bedrock') {
                // Bedrock账号
                try {
                  const bedrockAccountResult =
                    await bedrockAccountService.getAccount(selectedAccountId)
                  if (!bedrockAccountResult.success) {
                    throw new Error('Failed to get Bedrock account details')
                  }

                  const bedrockResult = await bedrockRelayService.handleNonStreamRequest(
                    req.body,
                    bedrockAccountResult.data,
                    req.headers
                  )

                  // 构建标准响应格式
                  accountResponse = {
                    statusCode: bedrockResult.success ? 200 : 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(
                      bedrockResult.success ? bedrockResult.data : { error: bedrockResult.error }
                    ),
                    accountId: selectedAccountId
                  }

                  // 如果成功，添加使用统计到响应数据中
                  if (bedrockResult.success && bedrockResult.usage) {
                    const responseData = JSON.parse(accountResponse.body)
                    responseData.usage = bedrockResult.usage
                    accountResponse.body = JSON.stringify(responseData)
                  }
                } catch (error) {
                  logger.error('❌ Bedrock non-stream request failed:', error)
                  accountResponse = {
                    statusCode: 500,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      error: 'Bedrock service error',
                      message: error.message
                    }),
                    accountId: selectedAccountId
                  }
                }
              } else if (selectedAccountType === 'ccr') {
                // CCR账号
                accountResponse = await ccrRelayService.relayRequest(
                  req.body,
                  req.apiKey,
                  req,
                  res,
                  req.headers,
                  selectedAccountId
                )
              }

              logger.info('📡 Upstream response received', {
                statusCode: accountResponse.statusCode,
                accountId: selectedAccountId,
                accountType: selectedAccountType,
                bodyLength: accountResponse.body ? accountResponse.body.length : 0
              })

              return accountResponse
            },
            // 账户选择函数（排除失败的账户）
            async (excludedAccounts) => {
              logger.debug(
                `🔍 Selecting account (excluding ${excludedAccounts.length} failed accounts)`
              )

              try {
                const selection = await unifiedClaudeScheduler.selectAccountForApiKey(
                  req.apiKey,
                  sessionHash,
                  requestedModel,
                  { excludedAccounts, requestBody: req.body }
                )
                return selection
              } catch (error) {
                if (error.code === 'CLAUDE_DEDICATED_RATE_LIMITED') {
                  const limitMessage = claudeRelayService._buildStandardRateLimitMessage(
                    error.rateLimitEndAt
                  )
                  const rateLimitError = new Error(limitMessage)
                  rateLimitError.statusCode = 403
                  rateLimitError.isRateLimitError = true
                  throw rateLimitError
                }
                throw error
              }
            },
            {
              maxRetries: 3,
              initialExcludedAccounts: []
            }
          )

          // 检查重试结果
          if (!result.success) {
            logger.error(
              `❌ All retry attempts failed after ${result.attempts} attempts`,
              result.error
            )

            // 如果是限流错误，返回特殊响应
            if (result.error.isRateLimitError) {
              return {
                statusCode: 403,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  error: 'upstream_rate_limited',
                  message: result.error.message
                })
              }
            }

            // 其他错误返回500
            return {
              statusCode: 500,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                error: 'all_retry_attempts_failed',
                message: result.error?.message || 'All upstream requests failed',
                attempts: result.attempts,
                excludedAccounts: result.excludedAccounts || []
              })
            }
          }

          logger.info(
            `✅ Request succeeded after ${result.attempts} attempt(s) using account ${result.accountId}`
          )
          return result.response
        },
        300 // 5分钟TTL
      )

      // 检查是否是错误响应，需要进行智能过滤
      if (response.statusCode < 200 || response.statusCode >= 300) {
        // 使用智能过滤器处理错误
        const filteredError = IntelligentErrorFilter.filterError(response.statusCode, response.body)

        // 记录原始错误（仅在日志中）
        logger.error('Upstream error response:', {
          statusCode: response.statusCode,
          accountId: response.accountId,
          originalError: response.body?.substring ? response.body.substring(0, 500) : response.body
        })

        // 返回过滤后的错误
        return res.status(response.statusCode).json(filteredError)
      }

      // 设置响应状态码
      res.status(response.statusCode)

      // 设置响应头，避免 Content-Length 和 Transfer-Encoding 冲突
      const skipHeaders = ['content-encoding', 'transfer-encoding', 'content-length']
      Object.keys(response.headers || {}).forEach((key) => {
        if (!skipHeaders.includes(key.toLowerCase())) {
          res.setHeader(key, response.headers[key])
        }
      })

      let usageRecorded = false

      // 尝试解析JSON响应并提取usage信息
      try {
        const jsonData = JSON.parse(response.body)

        logger.info('📊 Parsed upstream response:', JSON.stringify(jsonData, null, 2))

        // 🔒 检查是否应该跳过usage记录（防止重复扣费）
        const isCachedResponse = response.cachedAt && response.cachedAt > 0
        const isSharedResponse = response.isSharedResponse === true

        if (isCachedResponse) {
          logger.info(
            '💾 Response from cache, skipping usage recording to prevent duplicate charging'
          )
        }

        if (isSharedResponse) {
          logger.info(
            '🔄 Response from request deduplication, skipping usage recording (already recorded by first request)'
          )
        }

        // 从响应中提取usage信息（完整的token分类体系）
        if (
          !isCachedResponse &&
          !isSharedResponse &&
          jsonData.usage &&
          jsonData.usage.input_tokens !== undefined &&
          jsonData.usage.output_tokens !== undefined
        ) {
          const inputTokens = jsonData.usage.input_tokens || 0
          const outputTokens = jsonData.usage.output_tokens || 0
          const cacheCreateTokens = jsonData.usage.cache_creation_input_tokens || 0
          const cacheReadTokens = jsonData.usage.cache_read_input_tokens || 0
          // Parse the model to remove vendor prefix if present
          const rawModel = jsonData.model || req.body.model || 'unknown'
          const { baseModel } = parseVendorPrefixedModel(rawModel)
          const model = baseModel || rawModel

          // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
          const responseAccountId = response.accountId
          const responseAccountType = response.accountType
          await apiKeyService.recordUsage(
            req.apiKey.id,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            model,
            responseAccountId,
            responseAccountType
          )

          await queueRateLimitUpdate(
            req.rateLimitInfo,
            {
              inputTokens,
              outputTokens,
              cacheCreateTokens,
              cacheReadTokens
            },
            model,
            'claude-non-stream-retry'
          )

          usageRecorded = true
          logger.api(
            `📊 Non-stream usage recorded - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`
          )
        } else if (!isCachedResponse && !isSharedResponse) {
          logger.warn('⚠️ No usage data found in response')
        }

        return res.json(jsonData)
      } catch (parseError) {
        logger.warn('⚠️ Failed to parse response as JSON:', parseError.message)
        logger.debug('📄 Raw response body:', response.body)
        return res.send(response.body)
      } finally {
        // 如果没有记录usage，只记录警告
        if (!usageRecorded) {
          logger.warn('⚠️ No usage data recorded for non-stream request')
        }
      }
    }

    const duration = Date.now() - startTime
    logger.api(`✅ Request completed in ${duration}ms for key: ${req.apiKey.name}`)
    return undefined
  } catch (error) {
    // 增强错误日志：记录更多详细信息
    logger.error('❌ Claude relay error:', {
      message: error.message,
      code: error.code,
      name: error.name,
      statusCode: error.response?.status,
      statusText: error.response?.statusText,
      upstreamError: error.response?.data
        ? typeof error.response.data === 'string'
          ? error.response.data.substring(0, 1000)
          : JSON.stringify(error.response.data).substring(0, 1000)
        : undefined,
      stack: error.stack
    })
    let handledError = error

    // 🔄 并发满额降级处理：捕获CONSOLE_ACCOUNT_CONCURRENCY_FULL错误
    if (
      handledError.code === 'CONSOLE_ACCOUNT_CONCURRENCY_FULL' &&
      !req._concurrencyRetryAttempted
    ) {
      req._concurrencyRetryAttempted = true
      logger.warn(
        `⚠️ Console account ${handledError.accountId} concurrency full, attempting fallback to other accounts...`
      )

      // 只有在响应头未发送时才能重试
      if (!res.headersSent) {
        try {
          // 清理粘性会话映射（如果存在）
          const sessionHash = sessionHelper.generateSessionHash(req.body)
          await unifiedClaudeScheduler.clearSessionMapping(sessionHash)

          logger.info('🔄 Session mapping cleared, retrying handleMessagesRequest...')

          // 递归重试整个请求处理（会选择新账户）
          return await handleMessagesRequest(req, res)
        } catch (retryError) {
          // 重试失败
          if (retryError.code === 'CONSOLE_ACCOUNT_CONCURRENCY_FULL') {
            logger.error('❌ All Console accounts reached concurrency limit after retry')
            return res.status(503).json({
              error: 'service_unavailable',
              message:
                'All available Claude Console accounts have reached their concurrency limit. Please try again later.'
            })
          }
          // 其他错误继续向下处理
          handledError = retryError
        }
      } else {
        // 响应头已发送，无法重试
        logger.error('❌ Cannot retry concurrency full error - response headers already sent')
        if (!res.destroyed && !res.finished) {
          res.end()
        }
        return undefined
      }
    }

    // 🚫 第二次并发满额错误：已经重试过，直接返回503
    if (
      handledError.code === 'CONSOLE_ACCOUNT_CONCURRENCY_FULL' &&
      req._concurrencyRetryAttempted
    ) {
      logger.error('❌ All Console accounts reached concurrency limit (retry already attempted)')
      if (!res.headersSent) {
        return res.status(503).json({
          error: 'service_unavailable',
          message:
            'All available Claude Console accounts have reached their concurrency limit. Please try again later.'
        })
      } else {
        if (!res.destroyed && !res.finished) {
          res.end()
        }
        return undefined
      }
    }

    logger.error('❌ Claude relay error:', handledError.message, {
      code: handledError.code,
      stack: handledError.stack
    })

    // 确保在任何情况下都能返回有效的JSON响应
    if (!res.headersSent) {
      // 根据错误类型设置适当的状态码
      let statusCode = 500
      let errorType = 'Relay service error'

      if (
        handledError.message.includes('Connection reset') ||
        handledError.message.includes('socket hang up')
      ) {
        statusCode = 502
        errorType = 'Upstream connection error'
      } else if (handledError.message.includes('Connection refused')) {
        statusCode = 502
        errorType = 'Upstream service unavailable'
      } else if (handledError.message.includes('timeout')) {
        statusCode = 504
        errorType = 'Upstream timeout'
      } else if (
        handledError.message.includes('resolve') ||
        handledError.message.includes('ENOTFOUND')
      ) {
        statusCode = 502
        errorType = 'Upstream hostname resolution failed'
      }

      return res.status(statusCode).json({
        error: errorType,
        message: handledError.message || 'An unexpected error occurred',
        timestamp: new Date().toISOString()
      })
    } else {
      // 如果响应头已经发送，尝试结束响应
      if (!res.destroyed && !res.finished) {
        res.end()
      }
      return undefined
    }
  }
}

// 🚀 Claude API messages 端点 - /api/v1/messages
router.post('/v1/messages', authenticateApiKey, handleMessagesRequest)

// 🚀 Claude API messages 端点 - /claude/v1/messages (别名)
router.post('/claude/v1/messages', authenticateApiKey, handleMessagesRequest)

// 📋 模型列表端点 - 支持 Claude, OpenAI, Gemini
router.get('/v1/models', authenticateApiKey, async (req, res) => {
  try {
    const modelService = require('../services/modelService')

    // 从 modelService 获取所有支持的模型
    const models = modelService.getAllModels()

    // 可选：根据 API Key 的模型限制过滤
    let filteredModels = models
    if (req.apiKey.enableModelRestriction && req.apiKey.restrictedModels?.length > 0) {
      filteredModels = models.filter((model) => req.apiKey.restrictedModels.includes(model.id))
    }

    res.json({
      object: 'list',
      data: filteredModels
    })
  } catch (error) {
    logger.error('❌ Models list error:', error)
    res.status(500).json({
      error: 'Failed to get models list',
      message: error.message
    })
  }
})

// 🏥 健康检查端点
router.get('/health', async (req, res) => {
  try {
    const healthStatus = await claudeRelayService.healthCheck()

    res.status(healthStatus.healthy ? 200 : 503).json({
      status: healthStatus.healthy ? 'healthy' : 'unhealthy',
      service: 'claude-relay-service',
      version: '1.0.0',
      ...healthStatus
    })
  } catch (error) {
    logger.error('❌ Health check error:', error)
    res.status(503).json({
      status: 'unhealthy',
      service: 'claude-relay-service',
      error: error.message,
      timestamp: new Date().toISOString()
    })
  }
})

// 📊 API Key状态检查端点 - /api/v1/key-info
router.get('/v1/key-info', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id)

    res.json({
      keyInfo: {
        id: req.apiKey.id,
        name: req.apiKey.name,
        tokenLimit: req.apiKey.tokenLimit,
        usage
      },
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    logger.error('❌ Key info error:', error)
    res.status(500).json({
      error: 'Failed to get key info',
      message: error.message
    })
  }
})

// 📈 使用统计端点 - /api/v1/usage
router.get('/v1/usage', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id)

    res.json({
      usage,
      limits: {
        tokens: req.apiKey.tokenLimit,
        requests: 0 // 请求限制已移除
      },
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    logger.error('❌ Usage stats error:', error)
    res.status(500).json({
      error: 'Failed to get usage stats',
      message: error.message
    })
  }
})

// 👤 用户信息端点 - Claude Code 客户端需要
router.get('/v1/me', authenticateApiKey, async (req, res) => {
  try {
    // 返回基础用户信息
    res.json({
      id: `user_${req.apiKey.id}`,
      type: 'user',
      display_name: req.apiKey.name || 'API User',
      created_at: new Date().toISOString()
    })
  } catch (error) {
    logger.error('❌ User info error:', error)
    res.status(500).json({
      error: 'Failed to get user info',
      message: error.message
    })
  }
})

// 💰 余额/限制端点 - Claude Code 客户端需要
router.get('/v1/organizations/:org_id/usage', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id)

    res.json({
      object: 'usage',
      data: [
        {
          type: 'credit_balance',
          credit_balance: req.apiKey.tokenLimit - (usage.totalTokens || 0)
        }
      ]
    })
  } catch (error) {
    logger.error('❌ Organization usage error:', error)
    res.status(500).json({
      error: 'Failed to get usage info',
      message: error.message
    })
  }
})

// 🔢 Token计数端点 - count_tokens beta API
router.post('/v1/messages/count_tokens', authenticateApiKey, async (req, res) => {
  // 检查权限
  if (
    req.apiKey.permissions &&
    req.apiKey.permissions !== 'all' &&
    req.apiKey.permissions !== 'claude'
  ) {
    return res.status(403).json({
      error: {
        type: 'permission_error',
        message: 'This API key does not have permission to access Claude'
      }
    })
  }

  logger.info(`🔢 Processing token count request for key: ${req.apiKey.name}`)

  // 生成会话哈希用于sticky会话 - 必须包含 apiKeyId 确保用户隔离
  const sessionHash = sessionHelper.generateSessionHash(req.body)
  const requestedModel = req.body.model
  const maxAttempts = 2
  let attempt = 0

  const processRequest = async () => {
    const { accountId, accountType } = await unifiedClaudeScheduler.selectAccountForApiKey(
      req.apiKey,
      sessionHash,
      requestedModel,
      { requestBody: req.body }
    )

    if (accountType === 'ccr') {
      throw Object.assign(new Error('Token counting is not supported for CCR accounts'), {
        httpStatus: 501,
        errorPayload: {
          error: {
            type: 'not_supported',
            message: 'Token counting is not supported for CCR accounts'
          }
        }
      })
    }

    if (accountType === 'bedrock') {
      throw Object.assign(new Error('Token counting is not supported for Bedrock accounts'), {
        httpStatus: 501,
        errorPayload: {
          error: {
            type: 'not_supported',
            message: 'Token counting is not supported for Bedrock accounts'
          }
        }
      })
    }

    const relayOptions = {
      skipUsageRecord: true,
      customPath: '/v1/messages/count_tokens'
    }

    const response =
      accountType === 'claude-official'
        ? await claudeRelayService.relayRequest(
            req.body,
            req.apiKey,
            req,
            res,
            req.headers,
            relayOptions
          )
        : await claudeConsoleRelayService.relayRequest(
            req.body,
            req.apiKey,
            req,
            res,
            req.headers,
            accountId,
            relayOptions
          )

    res.status(response.statusCode)

    const skipHeaders = ['content-encoding', 'transfer-encoding', 'content-length']
    Object.keys(response.headers).forEach((key) => {
      if (!skipHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, response.headers[key])
      }
    })

    try {
      const jsonData = JSON.parse(response.body)
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const sanitizedData = sanitizeUpstreamError(jsonData)
        res.json(sanitizedData)
      } else {
        res.json(jsonData)
      }
    } catch (parseError) {
      res.send(response.body)
    }

    logger.info(`✅ Token count request completed for key: ${req.apiKey.name}`)
  }

  while (attempt < maxAttempts) {
    try {
      await processRequest()
      return
    } catch (error) {
      if (error.code === 'CONSOLE_ACCOUNT_CONCURRENCY_FULL') {
        logger.warn(
          `⚠️ Console account concurrency full during count_tokens (attempt ${attempt + 1}/${maxAttempts})`
        )
        if (attempt < maxAttempts - 1) {
          try {
            await unifiedClaudeScheduler.clearSessionMapping(sessionHash)
          } catch (clearError) {
            logger.error('❌ Failed to clear session mapping for count_tokens retry:', clearError)
            if (!res.headersSent) {
              return res.status(500).json({
                error: {
                  type: 'server_error',
                  message: 'Failed to count tokens'
                }
              })
            }
            if (!res.destroyed && !res.finished) {
              res.end()
            }
            return
          }
          attempt += 1
          continue
        }
        if (!res.headersSent) {
          return res.status(503).json({
            error: 'service_unavailable',
            message:
              'All available Claude Console accounts have reached their concurrency limit. Please try again later.'
          })
        }
        if (!res.destroyed && !res.finished) {
          res.end()
        }
        return
      }

      if (error.httpStatus) {
        return res.status(error.httpStatus).json(error.errorPayload)
      }

      // 客户端断开连接不是错误，使用 INFO 级别
      if (error.message === 'Client disconnected') {
        logger.info('🔌 Client disconnected during token count request')
        if (!res.headersSent) {
          return res.status(499).end() // 499 Client Closed Request
        }
        if (!res.destroyed && !res.finished) {
          res.end()
        }
        return
      }

      logger.error('❌ Token count error:', error)
      if (!res.headersSent) {
        return res.status(500).json({
          error: {
            type: 'server_error',
            message: 'Failed to count tokens'
          }
        })
      }

      if (!res.destroyed && !res.finished) {
        res.end()
      }
      return
    }
  }
})

module.exports = router
module.exports.handleMessagesRequest = handleMessagesRequest
