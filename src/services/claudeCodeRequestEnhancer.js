/**
 * Claude Code 请求增强器
 * 负责根据模型类型自动补充必需参数，确保请求与真实Claude Code终端完全一致
 */

const logger = require('../utils/logger')
const claudeCodeToolsManager = require('./claudeCodeToolsManager')
const { promptMap } = require('../utils/contents')

class ClaudeCodeRequestEnhancer {
  constructor() {
    // Haiku模型的默认system参数（从 contents.js 获取）
    this.haikuDefaultSystem = [
      {
        type: 'text',
        text: promptMap.haikuSystemPrompt
      }
    ]

    // Sonnet/Opus的Claude Code system参数（从 contents.js 获取）
    this.claudeCodeSystemBase = {
      type: 'text',
      text: promptMap.claudeOtherSystemPrompt1
    }

    // 完整的Claude Code详细指令（从 contents.js 获取）
    this.claudeCodeDetailedInstructions = {
      type: 'text',
      text: promptMap.claudeOtherSystemPrompt2
    }

    // Agent SDK 相关提示词（未来可能需要）
    this.agentSdkPrompt = {
      type: 'text',
      text: promptMap.claudeOtherSystemPrompt3
    }

    this.agentSdkClaudeCodePrompt = {
      type: 'text',
      text: promptMap.claudeOtherSystemPrompt4
    }

    // system-reminder消息模板
    this.systemReminderMessages = [
      {
        type: 'text',
        text: '<system-reminder>\nThis is a reminder that your todo list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a todo list please use the TodoWrite tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.\n</system-reminder>'
      },
      {
        type: 'text',
        text: "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# important-instruction-reminders\nDo what has been asked; nothing more, nothing less.\nNEVER create files unless they're absolutely necessary for achieving your goal.\nALWAYS prefer editing an existing file to creating a new one.\nNEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n\n      \n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n"
      }
    ]
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
   * 增强请求体，补充必需参数
   * @param {object} requestBody - 原始请求体
   * @param {object} options - 可选配置
   * @returns {object} 增强后的请求体
   */
  enhanceRequest(requestBody, options = {}) {
    if (!requestBody) {
      return requestBody
    }

    // 深拷贝请求体，避免修改原始对象
    const enhancedBody = JSON.parse(JSON.stringify(requestBody))
    const modelType = this.detectModelType(enhancedBody.model)

    logger.info(`🔧 Enhancing request for model type: ${modelType} (${enhancedBody.model})`)

    switch (modelType) {
      case 'haiku':
        return this.enhanceHaikuRequest(enhancedBody, options)
      case 'sonnet':
      case 'opus':
        return this.enhanceSonnetOpusRequest(enhancedBody, options)
      default:
        logger.debug(`⚠️ Unknown model type, returning original request`)
        return enhancedBody
    }
  }

  /**
   * 增强Haiku模型请求
   */
  enhanceHaikuRequest(requestBody) {
    // 1. 补充max_tokens
    if (!requestBody.max_tokens) {
      requestBody.max_tokens = 512
      logger.debug('✅ Added max_tokens: 512 for Haiku')
    }

    // 2. 补充temperature
    if (requestBody.temperature === undefined) {
      requestBody.temperature = 0
      logger.debug('✅ Added temperature: 0 for Haiku')
    }

    // 3. 补充system参数
    if (!requestBody.system) {
      requestBody.system = this.haikuDefaultSystem
      logger.debug('✅ Added default system parameter for Haiku')
    } else if (Array.isArray(requestBody.system)) {
      // 检查是否包含必需的分析提示
      const hasAnalyzePrompt = requestBody.system.some(
        (item) => item.text && item.text.includes('Analyze if this message indicates')
      )
      if (!hasAnalyzePrompt) {
        requestBody.system.unshift(this.haikuDefaultSystem[0])
        logger.debug('✅ Added analyze prompt to system for Haiku')
      }
    }

    // 4. Haiku保留用户提供的tools，不强制移除
    if (requestBody.tools) {
      logger.debug('✅ Haiku model retaining user-provided tools')
    }

    // 5. 确保metadata格式正确
    this.ensureMetadata(requestBody)

    return requestBody
  }

  /**
   * 增强Sonnet/Opus模型请求
   */
  enhanceSonnetOpusRequest(requestBody, _options = {}) {
    const modelType = this.detectModelType(requestBody.model)

    // 1. 补充max_tokens
    if (!requestBody.max_tokens) {
      requestBody.max_tokens = 31000 //32000
      logger.debug('✅ Added max_tokens: 32000 for Sonnet/Opus')
    }

    // 2. 补充temperature
    if (requestBody.temperature === undefined) {
      requestBody.temperature = 1
      logger.debug('✅ Added temperature: 1 for Sonnet/Opus')
    }

    // 3. 处理messages中的system-reminder
    if (requestBody.messages && Array.isArray(requestBody.messages)) {
      this.injectSystemReminders(requestBody.messages)
    }

    // 4. 补充system参数
    this.ensureClaudeCodeSystem(requestBody)

    // // 5. 补充tools参数（使用claudeCodeToolsManager）
    // const enhancedTools = claudeCodeToolsManager.validateAndEnhanceTools(
    //   requestBody.tools,
    //   modelType
    // )
    // if (enhancedTools !== undefined) {
    //   requestBody.tools = enhancedTools
    //   logger.debug(
    //     `✅ Enhanced tools for ${modelType}: ${enhancedTools ? enhancedTools.length : 0} tools`
    //   )
    // }

    // 6. 为用户消息添加cache_control
    this.addCacheControl(requestBody.messages)

    // 7. 确保metadata格式正确
    this.ensureMetadata(requestBody)

    return requestBody
  }

  /**
   * 注入system-reminder消息
   */
  injectSystemReminders(messages) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return
    }

    // 查找第一条用户消息
    const firstUserMsgIndex = messages.findIndex((msg) => msg.role === 'user')
    if (firstUserMsgIndex === -1) {
      return
    }

    const firstUserMsg = messages[firstUserMsgIndex]

    // 检查是否已经包含system-reminder
    let hasSystemReminder = false
    if (firstUserMsg.content && Array.isArray(firstUserMsg.content)) {
      hasSystemReminder = firstUserMsg.content.some(
        (item) => item.text && item.text.includes('<system-reminder>')
      )
    }

    // 如果没有system-reminder，则插入
    if (!hasSystemReminder) {
      if (!Array.isArray(firstUserMsg.content)) {
        // 将string content转换为array
        if (typeof firstUserMsg.content === 'string') {
          firstUserMsg.content = [{ type: 'text', text: firstUserMsg.content }]
        } else {
          firstUserMsg.content = []
        }
      }

      // 在开头插入system-reminder消息（不包含cache_control，因为这些是用户消息的一部分）
      const remindersWithoutCache = this.systemReminderMessages.map((msg) => ({
        type: msg.type,
        text: msg.text
      }))
      firstUserMsg.content.unshift(...remindersWithoutCache)
      logger.debug('✅ Injected system-reminder messages')
    }
  }

  /**
   * 确保包含Claude Code的system参数（使用 contents.js 的完整指令）
   */
  ensureClaudeCodeSystem(requestBody) {
    if (!requestBody.system) {
      // 创建完整的system数组（使用 contents.js 的完整 Claude Code 指令）
      requestBody.system = [this.claudeCodeSystemBase, this.claudeCodeDetailedInstructions]
      logger.debug('✅ Added complete Claude Code system parameters from contents.js')
    } else if (Array.isArray(requestBody.system)) {
      // 检查是否包含Claude Code标识
      const hasClaudeCode = requestBody.system.some(
        (item) => item.text && item.text.includes('You are Claude Code')
      )
      if (!hasClaudeCode) {
        requestBody.system.unshift(this.claudeCodeSystemBase)
        logger.debug('✅ Added Claude Code identifier to system from contents.js')
      }

      // 确保system项有cache_control
      requestBody.system.forEach((item) => {
        if (item.type === 'text' && !item.cache_control) {
          // item.cache_control = { type: 'ephemeral' }
        }
      })
    }
  }

  /**
   * 为最后的用户消息添加cache_control
   */
  addCacheControl(messages) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return
    }

    // // 找到最后一条用户消息
    // for (let i = messages.length - 1; i >= 0; i--) {
    //   if (messages[i].role === 'user') {
    //     const userMsg = messages[i]

    //     // 处理content数组
    //     if (Array.isArray(userMsg.content)) {
    //       const lastContent = userMsg.content[userMsg.content.length - 1]
    //       if (lastContent && lastContent.type === 'text' && !lastContent.cache_control) {
    //         lastContent.cache_control = { type: 'ephemeral' }
    //         logger.debug('✅ Added cache_control to last user message')
    //       }
    //     }
    //     break
    //   }
    // }
  }

  /**
   * 确保metadata格式正确
   */
  ensureMetadata(requestBody) {
    if (!requestBody.metadata) {
      requestBody.metadata = {}
    }

    // 确保有user_id
    if (!requestBody.metadata.user_id) {
      // 生成一个标准格式的user_id
      const userId = `user_${this.generateRandomHash()}_account__session_${this.generateUUID()}`
      requestBody.metadata.user_id = userId
      logger.debug(`✅ Generated metadata.user_id: ${userId}`)
    }
  }

  /**
   * 生成随机哈希
   */
  generateRandomHash() {
    const chars = 'abcdef0123456789'
    let hash = ''
    for (let i = 0; i < 64; i++) {
      hash += chars[Math.floor(Math.random() * chars.length)]
    }
    return hash
  }

  /**
   * 生成UUID
   */
  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      const v = c === 'x' ? r : (r & 0x3) | 0x8
      return v.toString(16)
    })
  }

  /**
   * 根据模型类型获取正确的anthropic-beta header值
   * haiku: interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14
   * sonnet/opus: claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14
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
