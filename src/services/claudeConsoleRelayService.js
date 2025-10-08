const axios = require('axios')
const claudeConsoleAccountService = require('./claudeConsoleAccountService')
const claudeCodeHeadersService = require('./claudeCodeHeadersService')
const claudeCodeRequestEnhancer = require('./claudeCodeRequestEnhancer')
const logger = require('../utils/logger')
const config = require('../../config/config')

class ClaudeConsoleRelayService {
  constructor() {
    this.defaultUserAgent = 'claude-cli/1.0.119 (external, cli)'
  }

  // 🛡️ 错误信息智能脱敏处理 - 供应商错误（含中文）脱敏，官方错误（纯英文）透传
  _sanitizeErrorMessage(statusCode, originalError = '', accountId = '') {
    const timestamp = new Date().toISOString()

    // 记录原始错误到日志（用于调试）
    logger.error(`🔍 Original error (Account: ${accountId}, Status: ${statusCode}):`)
    logger.error(`📋 Error type: ${typeof originalError}`)
    logger.error(`📋 Error length: ${originalError?.length || 'N/A'}`)

    // 根据类型打印详细信息
    if (typeof originalError === 'string') {
      logger.error(`📋 Error string (first 2000 chars):`)
      logger.error(originalError.substring(0, 2000))
    } else if (typeof originalError === 'object' && originalError !== null) {
      try {
        const jsonStr = JSON.stringify(originalError, null, 2)
        logger.error(`📋 Error object JSON (first 2000 chars):`)
        logger.error(jsonStr.substring(0, 2000))
      } catch (e) {
        logger.error('📋 Error stringify failed:', e.message)
        logger.error('📋 Error toString:', String(originalError).substring(0, 2000))
      }
    } else {
      logger.error('📋 Error value:', originalError)
    }

    // 解析错误内容为字符串
    let errorText = ''
    if (typeof originalError === 'string') {
      errorText = originalError
    } else if (originalError && typeof originalError === 'object') {
      try {
        errorText = JSON.stringify(originalError)
      } catch (e) {
        errorText = String(originalError)
      }
    } else {
      errorText = String(originalError)
    }

    // 🔍 检查是否包含中文字符 - 中文 = 供应商错误，英文 = Claude官方错误
    const containsChinese = /[\u4e00-\u9fff]/.test(errorText)

    // 💥 精简错误日志 - 一行关键信息
    logger.error(
      `❌ [${statusCode}] Account: ${accountId} | Type: ${containsChinese ? 'Vendor' : 'Official'} | Error: ${errorText.substring(0, 200)}`
    )

    if (containsChinese) {
      // 🛡️ 供应商错误 - 脱敏处理
      switch (statusCode) {
        case 401:
          return {
            error: {
              type: 'authentication_error',
              message: '服务认证失败，请稍后重试'
            },
            timestamp
          }

        case 403:
          return {
            error: {
              type: 'permission_error',
              message: '访问权限不足，请稍后重试'
            },
            timestamp
          }

        case 429:
          return {
            error: {
              type: 'rate_limit_error',
              message: '请求频率过高，请稍后重试'
            },
            timestamp
          }

        case 529:
          return {
            error: {
              type: 'overloaded_error',
              message: '服务负载过高，系统正在切换账号，请稍后重试'
            },
            timestamp
          }

        case 500:
        case 502:
        case 503:
        case 504:
          return {
            error: {
              type: 'server_error',
              message: '服务暂时不可用，系统正在切换账号，请稍后重试'
            },
            timestamp
          }

        default:
          return {
            error: {
              type: 'service_error',
              message: '服务出现异常，请稍后重试'
            },
            timestamp
          }
      }
    } else {
      // 🔍 Claude官方错误 - 直接透传

      // 尝试解析并返回原始错误结构
      try {
        const parsedError =
          typeof originalError === 'string' ? JSON.parse(originalError) : originalError

        // 如果解析成功且有正确的错误结构，直接返回并添加时间戳
        if (parsedError && typeof parsedError === 'object') {
          return {
            ...parsedError,
            timestamp
          }
        }
      } catch (e) {
        // JSON解析失败，构造标准格式
      }

      // 构造标准错误格式返回原始英文错误
      return {
        error: {
          type: 'api_error',
          message: errorText || 'Unknown error occurred'
        },
        timestamp
      }
    }
  }

  // 🛡️ 流式响应错误脱敏处理
  _sendSanitizedStreamError(responseStream, statusCode, originalError = '', accountId = '') {
    if (responseStream.destroyed) {
      return
    }

    const sanitizedError = this._sanitizeErrorMessage(statusCode, originalError, accountId)

    // 发送脱敏后的错误事件
    responseStream.write('event: error\n')
    responseStream.write(`data: ${JSON.stringify(sanitizedError)}\n\n`)
    responseStream.end()
  }

  // 🚀 转发请求到Claude Console API
  async relayRequest(
    requestBody,
    apiKeyData,
    clientRequest,
    clientResponse,
    clientHeaders,
    accountId,
    options = {}
  ) {
    let abortController = null
    let account = null

    try {
      // 获取账户信息
      account = await claudeConsoleAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Claude Console Claude account not found')
      }

      // 处理模型映射
      let mappedModel = requestBody.model
      if (
        account.supportedModels &&
        typeof account.supportedModels === 'object' &&
        !Array.isArray(account.supportedModels)
      ) {
        const newModel = claudeConsoleAccountService.getMappedModel(
          account.supportedModels,
          requestBody.model
        )
        if (newModel !== requestBody.model) {
          mappedModel = newModel
        }
      }

      // 📍 请求开始 - 精简到一行
      const vendor = claudeCodeHeadersService.detectSpecialVendor(account)
      logger.info(
        `📤 [REQ] Key: ${apiKeyData.name} | Acc: ${account.name} | Model: ${requestBody.model}${mappedModel !== requestBody.model ? '→' + mappedModel : ''} | Vendor: ${vendor?.vendorName || 'std'}`
      )

      // 创建修改后的请求体
      let modifiedRequestBody = {
        ...requestBody,
        model: mappedModel
      }

      // 检查是否需要特殊处理请求体
      if (claudeCodeHeadersService.needsSpecialRequestBody(account)) {
        modifiedRequestBody = this._processSpecialVendorRequestBody(modifiedRequestBody)
      }

      // 模型兼容性检查已经在调度器中完成，这里不需要再检查

      // 创建代理agent
      const proxyAgent = claudeConsoleAccountService._createProxyAgent(account.proxy)

      // 创建AbortController用于取消请求
      abortController = new AbortController()

      // 📊 记录请求开始时间（用于性能诊断）
      const requestStartTime = Date.now()
      let clientDisconnected = false
      let clientDisconnectTime = null

      // 🔧 智能延迟取消机制：客户端断开后等待上游响应
      const handleClientDisconnect = () => {
        clientDisconnected = true
        clientDisconnectTime = Date.now()
        const elapsedTime = clientDisconnectTime - requestStartTime

        // 检查是否启用延迟取消
        const waitConfig = config.upstreamWaitAfterClientDisconnect
        if (!waitConfig || !waitConfig.enabled) {
          // 禁用延迟取消，立即中止
          logger.info(
            `🔌 Client disconnected after ${elapsedTime}ms, aborting immediately (delay disabled) | Acc: ${account.name}`
          )
          if (abortController && !abortController.signal.aborted) {
            abortController.abort()
          }
          return
        }

        // 获取等待时间配置（非流式请求）
        const waitTime = waitConfig.nonStream || 60000

        logger.info(
          `🔌 Client disconnected after ${elapsedTime}ms, waiting ${waitTime}ms for upstream response | Acc: ${account.name}`
        )

        // ⏳ 延迟取消上游请求（给上游更多时间完成）
        setTimeout(() => {
          if (abortController && !abortController.signal.aborted) {
            const totalWaitTime = Date.now() - requestStartTime
            logger.warn(
              `⏰ Upstream timeout after ${totalWaitTime}ms (waited ${waitTime}ms after client disconnect), aborting request | Acc: ${account.name}`
            )

            // 🏷️ 标记账户响应慢（降低优先级，但不完全禁用）
            claudeConsoleAccountService.markAccountSlow(accountId, totalWaitTime).catch((err) => {
              logger.error(`Failed to mark account as slow: ${err.message}`)
            })

            abortController.abort()
          }
        }, waitTime)
      }

      // 监听客户端断开事件
      if (clientRequest) {
        clientRequest.once('close', handleClientDisconnect)
      }
      if (clientResponse) {
        clientResponse.once('close', handleClientDisconnect)
      }

      // 构建完整的API URL
      const cleanUrl = account.apiUrl.replace(/\/$/, '') // 移除末尾斜杠
      let apiEndpoint

      if (options.customPath) {
        // 如果指定了自定义路径（如 count_tokens），使用它
        const baseUrl = cleanUrl.replace(/\/v1\/messages$/, '') // 移除已有的 /v1/messages
        apiEndpoint = `${baseUrl}${options.customPath}`
      } else {
        // 默认使用 messages 端点
        apiEndpoint = cleanUrl.endsWith('/v1/messages') ? cleanUrl : `${cleanUrl}/v1/messages`
      }

      // 为特殊供应商添加 beta=true 查询参数
      if (claudeCodeHeadersService.needsBetaParam(account)) {
        const separator = apiEndpoint.includes('?') ? '&' : '?'
        apiEndpoint += `${separator}beta=true`
      }

      // 过滤客户端请求头
      const filteredHeaders = this._filterClientHeaders(clientHeaders)

      // 决定使用的 User-Agent：优先使用账户自定义的，否则根据模型动态生成
      const userAgent =
        account.userAgent ||
        claudeCodeHeadersService.getUserAgentForModel(modifiedRequestBody.model)

      // 构建请求头，对特殊供应商特殊处理
      let requestHeaders
      if (claudeCodeHeadersService.needsSpecialHeaders(account)) {
        // 特殊供应商使用专用请求头
        try {
          requestHeaders = claudeCodeHeadersService.getSpecialVendorHeaders(
            account.apiKey,
            modifiedRequestBody.model
          )
        } catch (error) {
          // 如果方法失败，使用手动构建的请求头
          const betaHeader = claudeCodeRequestEnhancer.getBetaHeader(modifiedRequestBody.model)

          requestHeaders = {
            Authorization: `Bearer ${account.apiKey}`,
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'User-Agent': userAgent,
            'x-app': 'cli',
            'anthropic-dangerous-direct-browser-access': 'true',
            'anthropic-beta': betaHeader,
            Accept: 'application/json',
            Connection: 'keep-alive'
          }
          logger.warn(`⚠️ Fallback to manual headers: ${error.message}`)
        }
      } else {
        // ✅ 使用 claudeCodeHeadersService 获取完整的 Claude Code headers
        const claudeCodeHeaders = await claudeCodeHeadersService.getAccountHeaders(
          accountId,
          account,
          modifiedRequestBody.model
        )

        // 标准请求头：合并 Claude Code headers
        requestHeaders = {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'User-Agent': userAgent,
          ...claudeCodeHeaders, // ✅ 添加完整的 Claude Code headers
          ...filteredHeaders // 保留客户端的其他 headers
        }

        // 根据 API Key 格式选择认证方式
        if (account.apiKey && account.apiKey.startsWith('sk-ant-')) {
          requestHeaders['x-api-key'] = account.apiKey
        } else {
          requestHeaders['Authorization'] = `Bearer ${account.apiKey}`
        }
      }

      // 准备请求配置
      const requestConfig = {
        method: 'POST',
        url: apiEndpoint,
        data: modifiedRequestBody,
        headers: requestHeaders,
        httpsAgent: proxyAgent,
        timeout: config.requestTimeout || 600000,
        signal: abortController.signal,
        validateStatus: () => true // 接受所有状态码
      }

      // 添加beta header如果需要
      if (options.betaHeader) {
        requestConfig.headers['anthropic-beta'] = options.betaHeader
      }

      // 发送请求
      const response = await axios(requestConfig)

      // 📊 计算上游响应时间
      const upstreamDuration = Date.now() - requestStartTime

      // 移除监听器
      if (clientRequest) {
        clientRequest.removeListener('close', handleClientDisconnect)
      }
      if (clientResponse) {
        clientResponse.removeListener('close', handleClientDisconnect)
      }

      // ✅ 请求成功 - 包含响应时间诊断
      if (clientDisconnected) {
        // 客户端已断开，但上游还是返回了结果
        logger.info(
          `✅ [RESP-DELAYED] Status: ${response.status} | Acc: ${account.name} | Upstream: ${upstreamDuration}ms | Client disconnected at ${clientDisconnectTime - requestStartTime}ms`
        )
        // 🎯 这种情况说明不是上游慢，而是客户端超时设置太短
        logger.warn(
          `⚠️ Client timeout too short! Upstream responded in ${upstreamDuration}ms but client already disconnected`
        )
      } else {
        // 正常响应
        const responseTimeEmoji =
          upstreamDuration > 10000 ? '🐌' : upstreamDuration > 5000 ? '⏱️' : '⚡'
        logger.info(
          `✅ [RESP] Status: ${response.status} | Acc: ${account.name} | ${responseTimeEmoji} ${upstreamDuration}ms`
        )

        // 🏷️ 如果响应慢（>20秒），记录账户性能
        if (upstreamDuration > 20000) {
          claudeConsoleAccountService.markAccountSlow(accountId, upstreamDuration).catch((err) => {
            logger.error(`Failed to mark account as slow: ${err.message}`)
          })
        } else if (upstreamDuration < 10000) {
          // ✅ 响应快（<10秒），尝试恢复优先级
          claudeConsoleAccountService.restoreAccountPriority(accountId).catch((err) => {
            logger.error(`Failed to restore account priority: ${err.message}`)
          })
        }
      }

      // 检查错误状态并相应处理
      if (response.status === 401) {
        await claudeConsoleAccountService.markAccountUnauthorized(accountId)
        // 返回脱敏后的错误信息
        const sanitizedError = this._sanitizeErrorMessage(response.status, response.data, accountId)
        return {
          statusCode: response.status,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sanitizedError),
          accountId
        }
      } else if (response.status === 429) {
        // 收到429先检查是否因为超过了手动配置的每日额度
        await claudeConsoleAccountService.checkQuotaUsage(accountId).catch((err) => {
          logger.error('❌ Failed to check quota after 429 error:', err)
        })

        await claudeConsoleAccountService.markAccountRateLimited(accountId)
        // 返回脱敏后的错误信息
        const sanitizedError = this._sanitizeErrorMessage(response.status, response.data, accountId)
        return {
          statusCode: response.status,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sanitizedError),
          accountId
        }
      } else if (response.status === 529) {
        await claudeConsoleAccountService.markAccountOverloaded(accountId)
        // 返回脱敏后的错误信息
        const sanitizedError = this._sanitizeErrorMessage(response.status, response.data, accountId)
        return {
          statusCode: response.status,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sanitizedError),
          accountId
        }
      } else if (response.status >= 400) {
        // 返回脱敏后的错误信息
        const sanitizedError = this._sanitizeErrorMessage(response.status, response.data, accountId)
        return {
          statusCode: response.status,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sanitizedError),
          accountId
        }
      } else if (response.status === 200 || response.status === 201) {
        // 如果请求成功，检查并移除错误状态
        const isRateLimited = await claudeConsoleAccountService.isAccountRateLimited(accountId)
        if (isRateLimited) {
          await claudeConsoleAccountService.removeAccountRateLimit(accountId)
        }
        const isOverloaded = await claudeConsoleAccountService.isAccountOverloaded(accountId)
        if (isOverloaded) {
          await claudeConsoleAccountService.removeAccountOverload(accountId)
        }
      }

      // 更新最后使用时间
      await this._updateLastUsedTime(accountId)

      const responseBody =
        typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      logger.debug(`[DEBUG] Final response body to return: ${responseBody}`)

      return {
        statusCode: response.status,
        headers: response.headers,
        body: responseBody,
        accountId
      }
    } catch (error) {
      // 处理特定错误
      if (error.name === 'AbortError' || error.code === 'ECONNABORTED') {
        logger.info('Request aborted due to client disconnect')
        throw new Error('Client disconnected')
      }

      // 精简错误日志 - 一行关键信息
      const errorMsg = error.response?.data
        ? typeof error.response.data === 'string'
          ? error.response.data.substring(0, 200)
          : JSON.stringify(error.response.data).substring(0, 200)
        : error.message
      logger.error(
        `❌ [REQ-ERR] Acc: ${account?.name} | Code: ${error.code || error.name} | Status: ${error.response?.status || 'N/A'} | ${errorMsg}`
      )

      throw error
    }
  }

  // 🌊 处理流式响应
  async relayStreamRequestWithUsageCapture(
    requestBody,
    apiKeyData,
    responseStream,
    clientHeaders,
    usageCallback,
    accountId,
    streamTransformer = null,
    options = {}
  ) {
    let account = null
    try {
      // 获取账户信息
      account = await claudeConsoleAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('Claude Console Claude account not found')
      }

      // 处理模型映射
      let mappedModel = requestBody.model
      if (
        account.supportedModels &&
        typeof account.supportedModels === 'object' &&
        !Array.isArray(account.supportedModels)
      ) {
        const newModel = claudeConsoleAccountService.getMappedModel(
          account.supportedModels,
          requestBody.model
        )
        if (newModel !== requestBody.model) {
          mappedModel = newModel
        }
      }

      logger.info(
        `📡 [STREAM] Key: ${apiKeyData.name} | Acc: ${account.name} | Model: ${requestBody.model}${mappedModel !== requestBody.model ? '→' + mappedModel : ''}`
      )

      // 创建修改后的请求体
      let modifiedRequestBody = {
        ...requestBody,
        model: mappedModel
      }

      // 检查是否需要特殊处理请求体
      if (claudeCodeHeadersService.needsSpecialRequestBody(account)) {
        modifiedRequestBody = this._processSpecialVendorRequestBody(modifiedRequestBody)
      }

      // 模型兼容性检查已经在调度器中完成，这里不需要再检查

      // 创建代理agent
      const proxyAgent = claudeConsoleAccountService._createProxyAgent(account.proxy)

      // 发送流式请求
      await this._makeClaudeConsoleStreamRequest(
        modifiedRequestBody,
        account,
        proxyAgent,
        clientHeaders,
        responseStream,
        accountId,
        usageCallback,
        streamTransformer,
        options
      )

      // 更新最后使用时间
      await this._updateLastUsedTime(accountId)
    } catch (error) {
      // 精简错误日志 - 一行关键信息
      const errorMsg = error.response?.data
        ? typeof error.response.data === 'string'
          ? error.response.data.substring(0, 200)
          : JSON.stringify(error.response.data).substring(0, 200)
        : error.message
      logger.error(
        `❌ [STREAM-ERR] Acc: ${account?.name} | Code: ${error.code || error.name} | Status: ${error.response?.status || 'N/A'} | ${errorMsg}`
      )
      throw error
    }
  }

  // 🌊 发送流式请求到Claude Console API
  async _makeClaudeConsoleStreamRequest(
    body,
    account,
    proxyAgent,
    clientHeaders,
    responseStream,
    accountId,
    usageCallback,
    streamTransformer = null,
    requestOptions = {}
  ) {
    // 构建完整的API URL
    const cleanUrl = account.apiUrl.replace(/\/$/, '') // 移除末尾斜杠
    let apiEndpoint = cleanUrl.endsWith('/v1/messages') ? cleanUrl : `${cleanUrl}/v1/messages`

    // 为特殊供应商添加 beta=true 查询参数
    if (claudeCodeHeadersService.needsBetaParam(account)) {
      const separator = apiEndpoint.includes('?') ? '&' : '?'
      apiEndpoint += `${separator}beta=true`
    }

    // 过滤客户端请求头
    const filteredHeaders = this._filterClientHeaders(clientHeaders)

    // 决定使用的 User-Agent
    const userAgent = account.userAgent || claudeCodeHeadersService.getUserAgentForModel(body.model)

    // 构建请求头，对特殊供应商特殊处理
    let requestHeaders
    if (claudeCodeHeadersService.needsSpecialHeaders(account)) {
      // 特殊供应商使用专用请求头
      try {
        requestHeaders = claudeCodeHeadersService.getSpecialVendorHeaders(
          account.apiKey,
          body.model
        )
      } catch (error) {
        // 如果方法失败，使用手动构建的请求头
        const betaHeader = claudeCodeRequestEnhancer.getBetaHeader(body.model)

        requestHeaders = {
          Authorization: `Bearer ${account.apiKey}`,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'User-Agent': userAgent,
          'x-app': 'cli',
          'anthropic-dangerous-direct-browser-access': 'true',
          'anthropic-beta': betaHeader,
          Accept: 'application/json',
          Connection: 'keep-alive'
        }
        logger.warn(`⚠️ Fallback to manual stream headers: ${error.message}`)
      }
    } else {
      // ✅ 使用 claudeCodeHeadersService 获取完整的 Claude Code headers
      const claudeCodeHeaders = await claudeCodeHeadersService.getAccountHeaders(
        accountId,
        account,
        body.model
      )

      // 标准请求头：合并 Claude Code headers
      requestHeaders = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'User-Agent': userAgent,
        ...claudeCodeHeaders, // ✅ 添加完整的 Claude Code headers
        ...filteredHeaders // 保留客户端的其他 headers
      }

      // 根据 API Key 格式选择认证方式
      if (account.apiKey && account.apiKey.startsWith('sk-ant-')) {
        requestHeaders['x-api-key'] = account.apiKey
      } else {
        requestHeaders['Authorization'] = `Bearer ${account.apiKey}`
      }
    }

    return new Promise((resolve, reject) => {
      let aborted = false

      // 准备请求配置
      const requestConfig = {
        method: 'POST',
        url: apiEndpoint,
        data: body,
        headers: requestHeaders,
        httpsAgent: proxyAgent,
        timeout: config.requestTimeout || 600000,
        responseType: 'stream',
        validateStatus: () => true // 接受所有状态码
      }

      // 添加beta header如果需要
      if (requestOptions.betaHeader) {
        requestConfig.headers['anthropic-beta'] = requestOptions.betaHeader
      }

      // 发送请求
      const request = axios(requestConfig)

      request
        .then((response) => {
          // 错误响应处理
          if (response.status !== 200) {
            logger.error(`❌ [STREAM-ERR] Status: ${response.status} | Acc: ${account?.name}`)

            if (response.status === 401) {
              claudeConsoleAccountService.markAccountUnauthorized(accountId)
            } else if (response.status === 429) {
              claudeConsoleAccountService.markAccountRateLimited(accountId)
              // 检查是否因为超过每日额度
              claudeConsoleAccountService.checkQuotaUsage(accountId).catch((err) => {
                logger.error('❌ Failed to check quota after 429 error:', err)
              })
            } else if (response.status === 529) {
              claudeConsoleAccountService.markAccountOverloaded(accountId)
            }

            // 🛡️ 发送脱敏后的错误信息而不是透传原始错误
            let errorData = ''
            response.data.on('data', (chunk) => {
              errorData += chunk.toString()
            })

            response.data.on('end', () => {
              // 使用脱敏处理发送错误
              this._sendSanitizedStreamError(responseStream, response.status, errorData, accountId)
              resolve()
            })
            return
          }

          // 成功响应，检查并移除错误状态
          claudeConsoleAccountService.isAccountRateLimited(accountId).then((isRateLimited) => {
            if (isRateLimited) {
              claudeConsoleAccountService.removeAccountRateLimit(accountId)
            }
          })
          claudeConsoleAccountService.isAccountOverloaded(accountId).then((isOverloaded) => {
            if (isOverloaded) {
              claudeConsoleAccountService.removeAccountOverload(accountId)
            }
          })

          // 设置响应头
          if (!responseStream.headersSent) {
            responseStream.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'X-Accel-Buffering': 'no'
            })
          }

          let buffer = ''
          let finalUsageReported = false
          const collectedUsageData = {}

          // 处理流数据
          response.data.on('data', (chunk) => {
            try {
              if (aborted) {
                return
              }

              const chunkStr = chunk.toString()
              buffer += chunkStr

              // 处理完整的SSE行
              const lines = buffer.split('\n')
              buffer = lines.pop() || ''

              // 转发数据并解析usage
              if (lines.length > 0 && !responseStream.destroyed) {
                const linesToForward = lines.join('\n') + (lines.length > 0 ? '\n' : '')

                // 应用流转换器如果有
                if (streamTransformer) {
                  const transformed = streamTransformer(linesToForward)
                  if (transformed) {
                    responseStream.write(transformed)
                  }
                } else {
                  responseStream.write(linesToForward)
                }

                // 解析SSE数据寻找usage信息
                for (const line of lines) {
                  if (line.startsWith('data: ') && line.length > 6) {
                    try {
                      const jsonStr = line.slice(6)
                      const data = JSON.parse(jsonStr)

                      // 收集usage数据
                      if (data.type === 'message_start' && data.message && data.message.usage) {
                        collectedUsageData.input_tokens = data.message.usage.input_tokens || 0
                        collectedUsageData.cache_creation_input_tokens =
                          data.message.usage.cache_creation_input_tokens || 0
                        collectedUsageData.cache_read_input_tokens =
                          data.message.usage.cache_read_input_tokens || 0
                        collectedUsageData.model = data.message.model

                        if (
                          data.message.usage.cache_creation &&
                          typeof data.message.usage.cache_creation === 'object'
                        ) {
                          collectedUsageData.cache_creation = {
                            ephemeral_5m_input_tokens:
                              data.message.usage.cache_creation.ephemeral_5m_input_tokens || 0,
                            ephemeral_1h_input_tokens:
                              data.message.usage.cache_creation.ephemeral_1h_input_tokens || 0
                          }
                        }
                      }

                      if (
                        data.type === 'message_delta' &&
                        data.usage &&
                        data.usage.output_tokens !== undefined
                      ) {
                        collectedUsageData.output_tokens = data.usage.output_tokens || 0

                        if (collectedUsageData.input_tokens !== undefined && !finalUsageReported) {
                          usageCallback({ ...collectedUsageData, accountId })
                          finalUsageReported = true
                        }
                      }

                      // 不再因为模型不支持而block账号
                    } catch (e) {
                      // 忽略解析错误
                    }
                  }
                }
              }
            } catch (error) {
              logger.error(`❌ Stream data error (Acc: ${account?.name}): ${error.message}`)
              if (!responseStream.destroyed) {
                // 🛡️ 使用脱敏错误处理而不是透传具体错误信息
                const sanitizedError = this._sanitizeErrorMessage(500, error.message, accountId)
                responseStream.write('event: error\n')
                responseStream.write(`data: ${JSON.stringify(sanitizedError)}\n\n`)
              }
            }
          })

          response.data.on('end', () => {
            try {
              // 处理缓冲区中剩余的数据
              if (buffer.trim() && !responseStream.destroyed) {
                if (streamTransformer) {
                  const transformed = streamTransformer(buffer)
                  if (transformed) {
                    responseStream.write(transformed)
                  }
                } else {
                  responseStream.write(buffer)
                }
              }

              // 确保流正确结束
              if (!responseStream.destroyed) {
                responseStream.end()
              }

              resolve()
            } catch (error) {
              logger.error('❌ Error processing stream end:', error)
              reject(error)
            }
          })

          response.data.on('error', (error) => {
            logger.error(`❌ Stream data error (Acc: ${account?.name}): ${error.message}`)
            if (!responseStream.destroyed) {
              // 🛡️ 使用脱敏错误处理
              this._sendSanitizedStreamError(responseStream, 500, error.message, accountId)
            }
            reject(error)
          })
        })
        .catch((error) => {
          if (aborted) {
            return
          }

          logger.error(`❌ Stream request error (Acc: ${account?.name}): ${error.message}`)

          // 检查错误状态
          if (error.response) {
            if (error.response.status === 401) {
              claudeConsoleAccountService.markAccountUnauthorized(accountId)
            } else if (error.response.status === 429) {
              claudeConsoleAccountService.markAccountRateLimited(accountId)
              // 检查是否因为超过每日额度
              claudeConsoleAccountService.checkQuotaUsage(accountId).catch((err) => {
                logger.error('❌ Failed to check quota after 429 error:', err)
              })
            } else if (error.response.status === 529) {
              claudeConsoleAccountService.markAccountOverloaded(accountId)
            }
          }

          // 🛡️ 发送脱敏后的错误响应
          const statusCode = error.response?.status || 500
          this._sendSanitizedStreamError(responseStream, statusCode, error.message, accountId)

          reject(error)
        })

      // 处理客户端断开连接
      responseStream.on('close', () => {
        aborted = true
      })
    })
  }

  // 🔧 过滤客户端请求头
  _filterClientHeaders(clientHeaders) {
    // 只移除真正敏感的 headers，保留 Claude Code 相关的 headers
    const sensitiveHeaders = [
      'authorization', // 移除客户端的，使用账户的
      'x-api-key', // 移除客户端的，使用账户的
      'host', // 由axios自动设置
      'content-length', // 由axios自动计算
      'proxy-authorization' // 代理相关
    ]

    const filteredHeaders = {}

    Object.keys(clientHeaders || {}).forEach((key) => {
      const lowerKey = key.toLowerCase()
      if (!sensitiveHeaders.includes(lowerKey)) {
        filteredHeaders[key] = clientHeaders[key]
      }
    })

    return filteredHeaders
  }

  // 🕐 更新最后使用时间
  async _updateLastUsedTime(accountId) {
    try {
      const client = require('../models/redis').getClientSafe()
      await client.hset(
        `claude_console_account:${accountId}`,
        'lastUsedAt',
        new Date().toISOString()
      )
    } catch (error) {
      logger.warn(
        `⚠️ Failed to update last used time for Claude Console account ${accountId}:`,
        error.message
      )
    }
  }

  // 🎯 健康检查
  async healthCheck() {
    try {
      const accounts = await claudeConsoleAccountService.getAllAccounts()
      const activeAccounts = accounts.filter((acc) => acc.isActive && acc.status === 'active')

      return {
        healthy: activeAccounts.length > 0,
        activeAccounts: activeAccounts.length,
        totalAccounts: accounts.length,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.error('❌ Claude Console Claude health check failed:', error)
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      }
    }
  }

  // 🏷️ 处理特殊供应商的特殊请求体格式（instcopilot、anyrouter等）
  _processSpecialVendorRequestBody(body) {
    if (!body) {
      return body
    }

    // 使用增强器处理请求体
    const enhancedBody = claudeCodeRequestEnhancer.enhanceRequest(body, {
      includeTools: false // 暂时不包含完整的tools定义
    })

    logger.info(`🏷️ Enhanced request body for special vendor using claudeCodeRequestEnhancer`)

    return enhancedBody
  }
}

module.exports = new ClaudeConsoleRelayService()
