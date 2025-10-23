const logger = require('./logger')

/**
 * 🌊 将JSON响应转换为SSE流格式
 * 用于在流式请求失败后，将非流式重试的结果转换为SSE流返回给客户端
 *
 * @param {Object} response - 非流式响应对象 { statusCode, body, headers }
 * @param {Object} res - Express响应对象
 */
async function convertJsonToSSEStream(response, res) {
  try {
    // 解析响应体
    const jsonData = typeof response.body === 'string' ? JSON.parse(response.body) : response.body

    logger.info('🔄 Converting JSON response to SSE stream format')

    // 确保响应头已设置
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
    }

    // 1️⃣ message_start event
    res.write('event: message_start\n')
    res.write(
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: jsonData.id || `msg_${Date.now()}`,
          type: 'message',
          role: 'assistant',
          model: jsonData.model || 'claude-sonnet-4-20250514',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: jsonData.usage || { input_tokens: 0, output_tokens: 0 }
        }
      })}\n\n`
    )

    // 2️⃣ content_block_start event
    res.write('event: content_block_start\n')
    res.write(
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })}\n\n`
    )

    // 3️⃣ content_block_delta event (分块发送文本)
    const text = jsonData.content && jsonData.content[0] ? jsonData.content[0].text : ''
    const chunkSize = 50 // 每50字符一个chunk，模拟流式传输

    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.substring(i, Math.min(i + chunkSize, text.length))
      res.write('event: content_block_delta\n')
      res.write(
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: chunk }
        })}\n\n`
      )

      // 可选：添加小延迟以模拟真实流式传输
      // await new Promise(resolve => setTimeout(resolve, 10))
    }

    // 4️⃣ content_block_stop event
    res.write('event: content_block_stop\n')
    res.write(
      `data: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0
      })}\n\n`
    )

    // 5️⃣ message_delta event (包含最终usage和stop_reason)
    res.write('event: message_delta\n')
    res.write(
      `data: ${JSON.stringify({
        type: 'message_delta',
        delta: {
          stop_reason: jsonData.stop_reason || 'end_turn',
          stop_sequence: jsonData.stop_sequence || null
        },
        usage: jsonData.usage || { output_tokens: 0 }
      })}\n\n`
    )

    // 6️⃣ message_stop event
    res.write('event: message_stop\n')
    res.write(
      `data: ${JSON.stringify({
        type: 'message_stop'
      })}\n\n`
    )

    // 结束响应
    res.end()

    logger.info(
      `✅ Successfully converted JSON to SSE stream (${text.length} chars, ${Math.ceil(text.length / chunkSize)} chunks)`
    )
  } catch (error) {
    logger.error(`❌ Failed to convert JSON to SSE stream: ${error.message}`)
    sendSSEError(res, error)
  }
}

/**
 * 🚨 发送SSE格式的错误响应
 *
 * @param {Object} res - Express响应对象
 * @param {Error|Object} error - 错误对象
 * @param {number} statusCode - HTTP状态码（可选）
 */
function sendSSEError(res, error, statusCode = null) {
  try {
    // 如果还没有发送响应头，设置SSE相关的头
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
    }

    // 构建错误对象
    const errorData = {
      type: 'error',
      error: {
        type: error.type || 'api_error',
        message: error.message || 'An error occurred during streaming'
      }
    }

    // 发送错误事件
    res.write('event: error\n')
    res.write(`data: ${JSON.stringify(errorData)}\n\n`)

    // 结束响应
    res.end()

    logger.warn(
      `⚠️ Sent SSE error: ${errorData.error.type} - ${errorData.error.message}${statusCode ? ` (HTTP ${statusCode})` : ''}`
    )
  } catch (e) {
    logger.error(`❌ Failed to send SSE error: ${e.message}`)
    // 最后的尝试：直接结束响应
    if (!res.finished) {
      res.end()
    }
  }
}

/**
 * 🔍 检查错误是否可以重试
 * 用于判断流式请求失败后是否应该切换账户重试
 *
 * @param {Error} error - 错误对象
 * @returns {boolean} - 是否可以重试
 */
function isStreamRetryableError(error) {
  // 🆕 账户并发限制超限错误 - 应该切换到其他账户重试
  // 这是设计上的可重试错误，粘性会话机制会先等待30秒（STICKY_CONCURRENCY_MAX_WAIT_MS）
  // 如果等待后仍然超限，则应该切换账号
  if (error.accountConcurrencyExceeded === true) {
    return true
  }

  // 网络错误可重试
  if (
    error.code === 'ECONNRESET' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNABORTED' ||
    error.code === 'ENOTFOUND' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'EAI_AGAIN'
  ) {
    return true
  }

  // 🆕 检查是否是特殊错误响应（空响应体、JSON解析失败等）
  if (error.shouldRetryDueToSpecialError) {
    return true
  }

  // 🚫 明确判断：prompt is too long 是客户端错误（用户输入过长），不可重试
  const errorMessage = error.message ? error.message.toLowerCase() : ''
  if (errorMessage.includes('prompt is too long')) {
    return false // 明确返回 false，立即停止重试
  }

  const responseData = error.response?.data
  if (responseData) {
    let responseText = ''
    if (typeof responseData === 'string') {
      responseText = responseData.toLowerCase()
    } else {
      try {
        responseText = JSON.stringify(responseData).toLowerCase()
      } catch (stringifyError) {
        responseText = String(responseData).toLowerCase()
      }
    }

    if (responseText.includes('prompt is too long')) {
      return false // 明确返回 false，立即停止重试
    }
  }
  if (
    errorMessage.includes('socket hang up') ||
    errorMessage.includes('connection reset') ||
    errorMessage.includes('timeout') ||
    errorMessage.includes('econnreset') ||
    errorMessage.includes('503') ||
    errorMessage.includes('502') ||
    errorMessage.includes('504') ||
    errorMessage.includes('500') ||
    errorMessage.includes('overloaded') ||
    errorMessage.includes('unexpected end of json input') || // JSON解析错误
    errorMessage.includes('empty response body') ||
    errorMessage.includes('malformed json') ||
    errorMessage.includes('invalid claude api response') ||
    errorMessage.includes('too many active sessions') || // 🆕 会话过多错误（应切换账户）
    errorMessage.includes('permission_error') || // 🆕 权限错误（可能是账户限制）
    errorMessage.includes('account concurrency limit exceeded') // 🆕 账户并发超限（应切换账户）
  ) {
    return true
  }

  // HTTP状态码检查
  if (error.statusCode) {
    // 🔧 403 也应该重试（会话过多、权限问题可能在其他账户上不存在）
    const retryableStatusCodes = [403, 500, 502, 503, 504, 524, 529]
    return retryableStatusCodes.includes(error.statusCode)
  }

  // 默认不重试
  return false
}

module.exports = {
  convertJsonToSSEStream,
  sendSSEError,
  isStreamRetryableError
}
