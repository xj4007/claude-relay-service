/**
 * Claude Code Tools 管理器
 * 负责管理和提供完整的 Claude Code 工具定义
 */

const fs = require('fs')
const path = require('path')
const logger = require('../utils/logger')

class ClaudeCodeToolsManager {
  constructor() {
    this.toolsCache = null
    this.configPath = path.join(__dirname, '../../config/claude-code-tools.json')
  }

  /**
   * 获取完整的 Claude Code tools 定义
   * @returns {Array} 完整的工具定义数组
   */
  getRequiredTools() {
    if (this.toolsCache) {
      return this.toolsCache
    }

    try {
      // 确保配置文件存在
      this.ensureConfigFileExists()

      // 从配置文件加载
      const toolsData = fs.readFileSync(this.configPath, 'utf8')
      this.toolsCache = JSON.parse(toolsData)
      logger.debug('✅ Loaded Claude Code tools from config file')
      return this.toolsCache
    } catch (error) {
      logger.error(`❌ Failed to load tools from config file: ${error.message}`)
      throw new Error(`Cannot load Claude Code tools: ${error.message}`)
    }
  }

  /**
   * 确保配置文件存在，不存在则抛出错误提示用户
   */
  ensureConfigFileExists() {
    if (!fs.existsSync(this.configPath)) {
      const configDir = path.dirname(this.configPath)
      logger.error(`❌ Config file not found: ${this.configPath}`)
      logger.error(`❌ Please ensure the config file exists in: ${configDir}`)
      throw new Error(`Claude Code tools config file not found: ${this.configPath}`)
    }
  }

  /**
   * 校验并增强用户提供的 tools
   * @param {Array} userTools - 用户提供的工具数组
   * @param {string} modelType - 模型类型
   * @returns {Array|null|undefined} 增强后的工具数组，Haiku保留用户工具，Sonnet/Opus确保完整工具集
   */
  validateAndEnhanceTools(userTools, modelType) {
    // Haiku 模型：保留用户提供的tools，不强制添加Claude Code工具
    if (modelType === 'haiku') {
      if (userTools && Array.isArray(userTools) && userTools.length > 0) {
        logger.debug(`✅ Haiku model retaining ${userTools.length} user-provided tools`)
        return userTools
      } else {
        logger.debug('✅ Haiku model with no user tools, keeping empty')
        return undefined // 返回undefined表示不修改tools字段
      }
    }

    // Sonnet/Opus 模型：确保有完整的Claude Code工具集
    const requiredTools = this.getRequiredTools()

    // 如果用户没有提供 tools，返回完整的工具集
    if (!userTools || !Array.isArray(userTools) || userTools.length === 0) {
      logger.debug('✅ No user tools provided, using complete Claude Code toolset')
      return requiredTools
    }

    // 校验并合并用户工具与必需工具
    const mergedTools = this.mergeUserAndRequiredTools(userTools, requiredTools)
    logger.debug(`✅ Merged user tools with Claude Code tools, total: ${mergedTools.length}`)

    return mergedTools
  }

  /**
   * 合并用户工具和必需工具
   * @param {Array} userTools - 用户工具
   * @param {Array} requiredTools - 必需工具
   * @returns {Array} 合并后的工具数组
   */
  mergeUserAndRequiredTools(userTools, requiredTools) {
    // 创建用户工具名称映射
    const userToolNames = new Set(userTools.map((tool) => tool.name))

    // 找出缺失的必需工具
    const missingTools = requiredTools.filter((tool) => !userToolNames.has(tool.name))

    if (missingTools.length > 0) {
      logger.debug(
        `🔧 Adding ${missingTools.length} missing Claude Code tools: ${missingTools.map((t) => t.name).join(', ')}`
      )
    }

    // 合并工具：用户工具 + 缺失的必需工具
    return [...userTools, ...missingTools]
  }

  /**
   * 保存工具定义到配置文件
   * @param {Array} tools - 工具定义数组
   */
  saveToolsToConfig(tools) {
    try {
      const configDir = path.dirname(this.configPath)
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true })
      }

      fs.writeFileSync(this.configPath, JSON.stringify(tools, null, 2))
      this.toolsCache = tools
      logger.info(`✅ Saved Claude Code tools to config file: ${this.configPath}`)
    } catch (error) {
      logger.error(`❌ Failed to save tools to config file: ${error.message}`)
    }
  }

  /**
   * 清除缓存，强制重新加载
   */
  clearCache() {
    this.toolsCache = null
    logger.debug('🗑️ Cleared tools cache')
  }
}

module.exports = new ClaudeCodeToolsManager()
