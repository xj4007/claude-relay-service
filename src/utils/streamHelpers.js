const logger = require('./logger')

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
      if (this.stopped) {
        return
      }

      const elapsed = Date.now() - this.startTime
      logger.warn(`⏰ Stream total timeout triggered: ${elapsed}ms`)

      if (this.onTimeoutCallback) {
        this.onTimeoutCallback('TOTAL_TIMEOUT', elapsed)
      }

      this.stop()
    }, this.totalTimeoutMs)

    // 空闲超时：定期检查是否长时间无数据
    this.idleCheckInterval = setInterval(() => {
      if (this.stopped) {
        return
      }

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
    if (this.stopped) {
      return
    }

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

module.exports = {
  StreamTimeoutMonitor
}
