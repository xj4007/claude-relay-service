/**
 * Claude Code Headers 管理服务
 * 负责存储和管理不同账号使用的 Claude Code headers
 */

const redis = require('../models/redis')
const logger = require('../utils/logger')

class ClaudeCodeHeadersService {
  constructor() {
    this.defaultHeaders = {
      'x-stainless-retry-count': '0',
      'x-stainless-timeout': '60',
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '0.55.1',
      'x-stainless-os': 'Windows',
      'x-stainless-arch': 'x64',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v20.19.2',
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-app': 'cli',
      'user-agent': 'claude-cli/1.0.119 (external, cli)',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
      'anthropic-beta': 'claude-code-20250219,fine-grained-tool-streaming-2025-05-14',
      'x-stainless-helper-method': 'stream'
    }

    // 特殊供应商配置 - 在这里统一配置所有需要特殊处理的供应商
    this.specialVendors = {
      instcopilot: {
        needsSpecialHeaders: true,
        needsBetaParam: true,
        needsSpecialRequestBody: true
      },
      anyrouter: {
        needsSpecialHeaders: true,
        needsBetaParam: true,
        needsSpecialRequestBody: true
      },
      gaccode: {
        needsSpecialHeaders: true,
        needsBetaParam: true,
        needsSpecialRequestBody: true
      }
      // 未来新增供应商只需要在这里添加配置即可
    }

    // 需要捕获的 Claude Code 特定 headers
    this.claudeCodeHeaderKeys = [
      'x-stainless-retry-count',
      'x-stainless-timeout',
      'x-stainless-lang',
      'x-stainless-package-version',
      'x-stainless-os',
      'x-stainless-arch',
      'x-stainless-runtime',
      'x-stainless-runtime-version',
      'anthropic-dangerous-direct-browser-access',
      'x-app',
      'user-agent',
      'accept-language',
      'sec-fetch-mode',
      'accept-encoding',
      'anthropic-beta',
      'x-stainless-helper-method'
    ]
  }

  /**
   * 检测账户是否是特殊供应商
   */
  detectSpecialVendor(account) {
    if (!account || !account.name) {
      return null
    }

    const accountName = account.name.toLowerCase()
    for (const [vendorName, config] of Object.entries(this.specialVendors)) {
      if (accountName.includes(vendorName)) {
        return { vendorName, config }
      }
    }
    return null
  }

  /**
   * 检查账户是否需要特殊请求头
   */
  needsSpecialHeaders(account) {
    const specialVendor = this.detectSpecialVendor(account)
    return specialVendor?.config.needsSpecialHeaders || false
  }

  /**
   * 检查账户是否需要beta参数
   */
  needsBetaParam(account) {
    const specialVendor = this.detectSpecialVendor(account)
    return specialVendor?.config.needsBetaParam || false
  }

  /**
   * 检查账户是否需要特殊请求体处理
   */
  needsSpecialRequestBody(account) {
    const specialVendor = this.detectSpecialVendor(account)
    return specialVendor?.config.needsSpecialRequestBody || false
  }

  /**
   * 从 user-agent 中提取版本号
   */
  extractVersionFromUserAgent(userAgent) {
    if (!userAgent) {
      return null
    }
    const match = userAgent.match(/claude-cli\/([\d.]+(?:[a-zA-Z0-9-]*)?)/i)
    return match ? match[1] : null
  }

  /**
   * 比较版本号
   * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if equal
   */
  compareVersions(v1, v2) {
    if (!v1 || !v2) {
      return 0
    }

    const parts1 = v1.split('.').map(Number)
    const parts2 = v2.split('.').map(Number)

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0
      const p2 = parts2[i] || 0

      if (p1 > p2) {
        return 1
      }
      if (p1 < p2) {
        return -1
      }
    }

    return 0
  }

  /**
   * 从客户端 headers 中提取 Claude Code 相关的 headers
   */
  extractClaudeCodeHeaders(clientHeaders) {
    const headers = {}

    // 转换所有 header keys 为小写进行比较
    const lowerCaseHeaders = {}
    Object.keys(clientHeaders || {}).forEach((key) => {
      lowerCaseHeaders[key.toLowerCase()] = clientHeaders[key]
    })

    // 提取需要的 headers
    this.claudeCodeHeaderKeys.forEach((key) => {
      const lowerKey = key.toLowerCase()
      if (lowerCaseHeaders[lowerKey]) {
        headers[key] = lowerCaseHeaders[lowerKey]
      }
    })

    return headers
  }

  /**
   * 存储账号的 Claude Code headers
   */
  async storeAccountHeaders(accountId, clientHeaders) {
    try {
      const extractedHeaders = this.extractClaudeCodeHeaders(clientHeaders)

      // 检查是否有 user-agent
      const userAgent = extractedHeaders['user-agent']
      if (!userAgent || !/^claude-cli\/[\d.]+\s+\(/i.test(userAgent)) {
        // 不是 Claude Code 的请求，不存储
        return
      }

      const version = this.extractVersionFromUserAgent(userAgent)
      if (!version) {
        logger.warn(`⚠️ Failed to extract version from user-agent: ${userAgent}`)
        return
      }

      // 获取当前存储的 headers
      const key = `claude_code_headers:${accountId}`
      const currentData = await redis.getClient().get(key)

      if (currentData) {
        const current = JSON.parse(currentData)
        const currentVersion = this.extractVersionFromUserAgent(current.headers['user-agent'])

        // 只有新版本更高时才更新
        if (this.compareVersions(version, currentVersion) <= 0) {
          return
        }
      }

      // 存储新的 headers
      const data = {
        headers: extractedHeaders,
        version,
        updatedAt: new Date().toISOString()
      }

      await redis.getClient().setex(key, 86400 * 7, JSON.stringify(data)) // 7天过期

      logger.info(`✅ Stored Claude Code headers for account ${accountId}, version: ${version}`)
    } catch (error) {
      logger.error(`❌ Failed to store Claude Code headers for account ${accountId}:`, error)
    }
  }

  /**
   * 获取特殊供应商专用请求头（通用方法）
   */
  getSpecialVendorHeaders(accessToken) {
    return {
      'x-api-key': accessToken,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'User-Agent': 'claude-cli/1.0.119 (external, cli)',
      'x-app': 'cli',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta':
        'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
      Accept: '*/*',
      Connection: 'keep-alive'
    }
  }

  /**
   * 获取账号的 Claude Code headers
   */
  async getAccountHeaders(accountId, account = null) {
    try {
      // 检测是否是特殊供应商
      const specialVendor = this.detectSpecialVendor(account)
      if (specialVendor) {
        logger.debug(`📋 Using ${specialVendor.vendorName} headers for account ${accountId}`)
        // 返回一个标识，让调用方知道这是特殊供应商账户
        return {
          isSpecialVendor: true,
          vendorName: specialVendor.vendorName,
          config: specialVendor.config
        }
      }

      const key = `claude_code_headers:${accountId}`
      const data = await redis.getClient().get(key)

      if (data) {
        const parsed = JSON.parse(data)
        logger.debug(
          `📋 Retrieved Claude Code headers for account ${accountId}, version: ${parsed.version}`
        )
        return parsed.headers
      }

      // 返回默认 headers
      logger.debug(`📋 Using default Claude Code headers for account ${accountId}`)
      return this.defaultHeaders
    } catch (error) {
      logger.error(`❌ Failed to get Claude Code headers for account ${accountId}:`, error)
      return this.defaultHeaders
    }
  }

  /**
   * 清除账号的 Claude Code headers
   */
  async clearAccountHeaders(accountId) {
    try {
      const key = `claude_code_headers:${accountId}`
      await redis.getClient().del(key)
      logger.info(`🗑️ Cleared Claude Code headers for account ${accountId}`)
    } catch (error) {
      logger.error(`❌ Failed to clear Claude Code headers for account ${accountId}:`, error)
    }
  }

  /**
   * 获取所有账号的 headers 信息
   */
  async getAllAccountHeaders() {
    try {
      const pattern = 'claude_code_headers:*'
      const keys = await redis.getClient().keys(pattern)

      const results = {}
      for (const key of keys) {
        const accountId = key.replace('claude_code_headers:', '')
        const data = await redis.getClient().get(key)
        if (data) {
          results[accountId] = JSON.parse(data)
        }
      }

      return results
    } catch (error) {
      logger.error('❌ Failed to get all account headers:', error)
      return {}
    }
  }
}

module.exports = new ClaudeCodeHeadersService()
