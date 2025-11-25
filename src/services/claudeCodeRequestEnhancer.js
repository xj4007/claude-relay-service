/**
 * Claude Code 请求增强器
 * 负责提供请求头相关的动态配置（如 anthropic-beta header）
 * 注意：提示词补充功能已移除，只保留请求头增强
 */

const logger = require('../utils/logger')

class ClaudeCodeRequestEnhancer {
  constructor() {
    logger.info('🔧 ClaudeCodeRequestEnhancer initialized (headers-only mode)')
  }

  /**
   * 检测模型基础类型（支持版本号）
   * @param {string} model - 模型名称
   * @returns {string} 'haiku' | 'sonnet' | 'opus' | 'unknown'
   */
  detectModelType(model) {
    if (!model || typeof model !== 'string') {
      return 'unknown'
    }

    const modelLower = model.toLowerCase()

    // 检测Haiku模型
    if (modelLower.includes('haiku')) {
      return 'haiku'
    }

    // 检测Sonnet模型
    if (modelLower.includes('sonnet')) {
      return 'sonnet'
    }

    // 检测Opus模型
    if (modelLower.includes('opus')) {
      return 'opus'
    }

    return 'unknown'
  }

  /**
   * 根据模型类型获取正确的anthropic-beta header值
   * haiku: interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14
   * sonnet/opus: claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14
   * @param {string} model - 模型名称
   * @returns {string} beta header值
   */
  getBetaHeader(model) {
    const modelType = this.detectModelType(model)

    switch (modelType) {
      case 'haiku':
        return 'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14'
      case 'sonnet':
      case 'opus':
        return 'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14'
      default:
        return 'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14'
    }
  }
}

module.exports = new ClaudeCodeRequestEnhancer()
