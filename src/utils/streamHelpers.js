const logger = require('./logger')

/**
 * 🔍 检测模型是否需要强制流式
 * @param {string} modelName - 模型名称
 * @returns {boolean} 是否需要强制流式
 */
function shouldForceStreamForModel(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return false
  }

  const lowerModel = modelName.toLowerCase()

  // 强制流式的模型：sonnet 和 opus（大模型，响应较慢）
  const forceStreamModels = ['sonnet', 'opus']

  const shouldForce = forceStreamModels.some((pattern) => lowerModel.includes(pattern))

  if (shouldForce) {
    logger.debug(`🔄 Model "${modelName}" should use forced streaming`)
  }

  return shouldForce
}

/**
 * ⏱️ 流式超时监控器
 * 监控流式请求的两种超时：
 * 1. 绝对超时：从请求开始计算的总时间（默认3分钟）
 * 2. 空闲超时：多久没收到数据（默认30秒）
 */
class StreamTimeoutMonitor {
  /**
   * @param {number} totalTimeoutMs - 绝对超时时间（毫秒），默认180000（3分钟）
   * @param {number} idleTimeoutMs - 空闲超时时间（毫秒），默认30000（30秒）
   */
  constructor(totalTimeoutMs = 180000, idleTimeoutMs = 30000) {
    this.totalTimeoutMs = totalTimeoutMs
    this.idleTimeoutMs = idleTimeoutMs
    this.lastDataTime = Date.now()
    this.startTime = Date.now()
    this.totalTimeout = null
    this.idleCheckInterval = null
    this.stopped = false
    this.onTimeoutCallback = null
  }

  /**
   * 启动监控
   * @param {Function} onTimeout - 超时回调函数 (timeoutType: string, duration: number) => void
   */
  start(onTimeout) {
    if (this.stopped) {
      logger.warn('⚠️ Cannot start already stopped monitor')
      return
    }

    this.onTimeoutCallback = onTimeout

    logger.debug(
      `⏱️ StreamTimeoutMonitor started: total=${this.totalTimeoutMs}ms, idle=${this.idleTimeoutMs}ms`
    )

    // 绝对超时：从请求开始计算
    this.totalTimeout = setTimeout(() => {
      if (this.stopped) return

      const elapsed = Date.now() - this.startTime
      logger.warn(`⏰ Stream total timeout triggered: ${elapsed}ms`)

      if (this.onTimeoutCallback) {
        this.onTimeoutCallback('TOTAL_TIMEOUT', elapsed)
      }

      this.stop()
    }, this.totalTimeoutMs)

    // 空闲超时：定期检查是否长时间无数据
    this.idleCheckInterval = setInterval(() => {
      if (this.stopped) return

      const idleTime = Date.now() - this.lastDataTime

      if (idleTime > this.idleTimeoutMs) {
        logger.warn(`⏰ Stream idle timeout triggered: ${idleTime}ms since last data`)

        if (this.onTimeoutCallback) {
          this.onTimeoutCallback('IDLE_TIMEOUT', idleTime)
        }

        this.stop()
      }
    }, 5000) // 每5秒检查一次
  }

  /**
   * 标记收到数据（重置空闲计时器）
   */
  markDataReceived() {
    this.lastDataTime = Date.now()
  }

  /**
   * 停止监控（清理所有定时器）
   */
  stop() {
    if (this.stopped) return

    this.stopped = true

    if (this.totalTimeout) {
      clearTimeout(this.totalTimeout)
      this.totalTimeout = null
    }

    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval)
      this.idleCheckInterval = null
    }

    logger.debug('⏱️ StreamTimeoutMonitor stopped')
  }

  /**
   * 获取运行状态
   * @returns {object} 状态信息
   */
  getStatus() {
    const now = Date.now()
    return {
      stopped: this.stopped,
      totalElapsed: now - this.startTime,
      idleTime: now - this.lastDataTime,
      totalTimeoutMs: this.totalTimeoutMs,
      idleTimeoutMs: this.idleTimeoutMs
    }
  }
}

/**
 * 📦 流式响应聚合器
 * 用于将 SSE 流式响应聚合成标准的 JSON 响应格式
 * 支持 Claude Messages API 的标准格式
 */
class StreamResponseAggregator {
  constructor() {
    this.textChunks = [] // 文本块数组
    this.usage = {} // 使用统计
    this.model = null // 模型名称
    this.messageId = null // 消息ID
    this.stopReason = 'end_turn' // 停止原因
    this.error = null // 错误信息
  }

  /**
   * 处理 SSE 行数据
   * @param {string} line - SSE 格式的一行数据
   * @returns {object|null} 解析后的数据对象，失败返回 null
   */
  processSSELine(line) {
    if (!line || typeof line !== 'string') return null

    // 只处理 data: 开头的行
    if (!line.startsWith('data: ')) return null

    try {
      const jsonStr = line.slice(6).trim()

      // 忽略空行或 [DONE] 标记
      if (!jsonStr || jsonStr === '[DONE]') return null

      const data = JSON.parse(jsonStr)

      // message_start: 获取初始 usage 和 model
      if (data.type === 'message_start' && data.message) {
        this.messageId = data.message.id
        this.model = data.message.model

        if (data.message.usage) {
          this.usage = { ...data.message.usage }
        }

        logger.debug(`📦 Aggregator: message_start - id=${this.messageId}, model=${this.model}`)
      }

      // content_block_start: 新的内容块开始
      if (data.type === 'content_block_start') {
        logger.debug('📦 Aggregator: content_block_start')
      }

      // content_block_delta: 收集文本块
      if (data.type === 'content_block_delta') {
        if (data.delta?.type === 'text_delta' && data.delta?.text) {
          this.textChunks.push(data.delta.text)
          logger.debug(`📦 Aggregator: added text chunk (${data.delta.text.length} chars)`)
        }
      }

      // content_block_stop: 内容块结束
      if (data.type === 'content_block_stop') {
        logger.debug('📦 Aggregator: content_block_stop')
      }

      // message_delta: 更新最终 usage 和 stop_reason
      if (data.type === 'message_delta') {
        if (data.usage) {
          this.usage = { ...this.usage, ...data.usage }
          logger.debug(`📦 Aggregator: updated usage - ${JSON.stringify(this.usage)}`)
        }

        if (data.delta?.stop_reason) {
          this.stopReason = data.delta.stop_reason
          logger.debug(`📦 Aggregator: stop_reason = ${this.stopReason}`)
        }
      }

      // error: 错误事件
      if (data.type === 'error' || data.error) {
        this.error = data.error || data
        logger.error(`📦 Aggregator: error received - ${JSON.stringify(this.error)}`)
      }

      return data
    } catch (e) {
      logger.debug(`Failed to parse SSE line: ${e.message}`)
      return null
    }
  }

  /**
   * 构建最终的 JSON 响应
   * @returns {object} 标准的 Claude Messages API 响应格式
   */
  buildFinalResponse() {
    // 如果有错误，返回错误响应
    if (this.error) {
      return {
        error: this.error,
        type: 'error'
      }
    }

    // 构建标准响应
    const response = {
      id: this.messageId || `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: this.model || 'unknown',
      content: [
        {
          type: 'text',
          text: this.textChunks.join('')
        }
      ],
      stop_reason: this.stopReason
    }

    // 只在有 usage 数据时添加
    if (Object.keys(this.usage).length > 0) {
      response.usage = this.usage
    }

    logger.info(
      `📦 Aggregator: built final response - ${response.content[0].text.length} chars, usage=${JSON.stringify(this.usage)}`
    )

    return response
  }

  /**
   * 获取当前收集的文本长度
   * @returns {number} 文本长度
   */
  getTextLength() {
    return this.textChunks.join('').length
  }

  /**
   * 检查是否有错误
   * @returns {boolean} 是否有错误
   */
  hasError() {
    return this.error !== null
  }
}

module.exports = {
  shouldForceStreamForModel,
  StreamTimeoutMonitor,
  StreamResponseAggregator
}
