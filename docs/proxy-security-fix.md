# 代理安全修复文档

## 修复日期

2025-11-03

## 问题描述

### 严重安全隐患：代理失败时暴露真实IP

**问题等级**: 🚨 **严重**

当代理配置存在但创建失败时（如代理服务器不可用、配置错误、网络不稳定等），原有代码会返回 `null`，导致 `https.request()` 使用默认agent进行**直接连接**，从而**暴露服务器的真实IP地址**。

### 受影响的场景

1. **代理服务器不稳定或宕机**
2. **代理配置错误**（端口错误、认证失败等）
3. **网络问题导致代理连接失败**
4. **代理类型配置错误**（如配置了不支持的代理类型）

### 原有代码问题示例

```javascript
// ❌ 不安全的代码（修复前）
const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
// 如果代理创建失败，proxyAgent 为 null

const options = {
  hostname: 'api.anthropic.com',
  agent: proxyAgent // null会导致使用默认agent，暴露真实IP！
}

https.request(options, callback)
```

### 影响范围

以下服务在修复前都存在此安全隐患：

- Claude 官方API转发服务 (`claudeRelayService.js`)
- Claude账户管理 (`claudeAccountService.js`)
- Claude Console账户管理 (`claudeConsoleAccountService.js`)
- Gemini账户管理 (`geminiAccountService.js`)
- Droid转发和账户服务 (`droidRelayService.js`, `droidAccountService.js`)
- OAuth认证流程 (`oauthHelper.js`)

## 修复方案

### 核心思想

**强制代理模式（Strict Proxy Mode）**: 当账户配置了代理时，代理失败必须抛出错误，绝不允许fallback到直接连接。

### 技术实现

#### 1. ProxyHelper 增强 ([src/utils/proxyHelper.js](src/utils/proxyHelper.js))

新增 `createProxyAgentStrict()` 方法：

```javascript
/**
 * 安全地创建代理 Agent（强制代理模式）
 * 当账户配置了代理但创建失败时，会抛出错误而不是返回null
 * 这可以防止在代理不可用时fallback到直接连接而暴露真实IP
 */
static createProxyAgentStrict(proxyConfig, options = {}) {
  // 如果没有配置代理，返回null（允许直接连接）
  if (!proxyConfig) {
    return null
  }

  // 有代理配置时，强制严格模式
  return ProxyHelper.createProxyAgent(proxyConfig, { ...options, strict: true })
}
```

#### 2. 修改所有服务的代理创建逻辑

**修复模式**：

```javascript
// ✅ 安全的代码（修复后）
if (!proxyConfig) {
  logger.debug('No proxy configured')
  return null
}

try {
  // 使用严格模式创建代理，失败时会抛出错误而不是返回null
  const proxyAgent = ProxyHelper.createProxyAgentStrict(proxyConfig)
  logger.info(`Using proxy: ${ProxyHelper.getProxyDescription(proxyConfig)}`)
  return proxyAgent
} catch (error) {
  logger.error('Proxy creation failed (strict mode):', error.message)
  // 严格模式下，代理失败必须抛出错误，防止fallback到直接连接
  throw new Error(`Proxy required but unavailable: ${error.message}`)
}
```

## 修改清单

### 1. 核心工具类

- ✅ [src/utils/proxyHelper.js](src/utils/proxyHelper.js)
  - 新增 `createProxyAgentStrict()` 方法
  - 为 `createProxyAgent()` 添加 `strict` 选项
  - 更新文档注释

### 2. Claude 服务

- ✅ [src/services/claudeRelayService.js](src/services/claudeRelayService.js)
  - 修改 `_getProxyAgent()` 方法使用严格模式
  - 影响3处请求：非流式、流式、count_tokens API

- ✅ [src/services/claudeAccountService.js](src/services/claudeAccountService.js)
  - 修改 `_createProxyAgent()` 方法使用严格模式
  - 影响OAuth token刷新流程

- ✅ [src/services/claudeConsoleAccountService.js](src/services/claudeConsoleAccountService.js)
  - 修改 `_createProxyAgent()` 方法使用严格模式
  - 影响Console API请求

### 3. Gemini 服务

- ✅ [src/services/geminiAccountService.js](src/services/geminiAccountService.js)
  - 修改8处代理创建调用：
    1. `createOAuth2Client()` - OAuth客户端创建
    2. `loadCodeAssist()` - tokeninfo请求
    3. `loadCodeAssist()` - userinfo请求
    4. `loadCodeAssist()` - 主API调用
    5. `onboardUser()` - 用户注册
    6. `countTokens()` - Token计数
    7. `generateContent()` - 内容生成
    8. `generateContentStream()` - 流式内容生成

### 4. Droid (Factory.ai) 服务

- ✅ [src/services/droidAccountService.js](src/services/droidAccountService.js)
  - 修改 `_refreshTokensWithWorkOS()` 方法
  - 修改 `_fetchFactoryOrgIds()` 方法

- ✅ [src/services/droidRelayService.js](src/services/droidRelayService.js)
  - 修改 `relayRequest()` 方法中的代理创建

### 5. OAuth 认证

- ✅ [src/utils/oauthHelper.js](src/utils/oauthHelper.js)
  - 修改内部 `createProxyAgent()` 函数使用严格模式
  - 影响所有OAuth token交换和刷新流程

## 安全保障

### 行为变更

#### 修复前

```
账户配置代理 → 代理创建失败 → 返回null → 使用直连 ❌ IP泄露
```

#### 修复后（v1.0 - 初版）

```
账户配置代理 → 代理创建失败 → 抛出错误 → 请求失败 ✅ IP保护
```

#### 修复后（v2.0 - 故障转移）

```
账户A配置代理 → 代理失败 → 标记为可重试 → 切换到账户B → 成功 ✅ IP保护 + 高可用
```

### 错误处理

#### 单账户场景

当只有一个账户且代理失败时，用户会看到明确的错误信息：

```
🚫 Proxy creation failed (strict mode): <具体错误原因>
Proxy required but unavailable: <具体错误原因>
```

#### 多账户场景（自动故障转移）

当有多个可用账户时，系统会自动进行故障转移：

```
🔄 Proxy error detected, will retry with another account
🚫 Excluded account account-1, will try another account
🔄 Retrying stream request (attempt 2/3)...
🎯 Stream attempt 2/3 using account: account-2 (claude-official)
✅ Request successful with account-2
```

这样可以：

1. **立即发现问题**：不会静默失败
2. **保护IP安全**：绝不使用直连
3. **自动故障转移**：切换到其他可用账户，提高可用性
4. **便于排查**：错误信息明确指出代理问题和重试过程

### 兼容性

- ✅ **无代理账户**：不受影响，继续使用直连
- ✅ **正常代理**：行为不变，正常工作
- ✅ **单账户代理失败**：返回明确错误（保护IP）
- ✅ **多账户代理失败**：自动切换到其他账户（保护IP + 高可用）

## 测试建议

### 1. 正常代理测试

```bash
# 配置正常的SOCKS5代理
# 验证请求正常通过代理
```

**预期结果**: ✅ 请求成功，日志显示 `Using proxy: socks5://host:port`

### 2. 单账户代理失败测试

```bash
# 配置错误的代理端口
# 或关闭代理服务器
# 只配置一个账户
```

**预期结果**: ✅ 请求失败，错误日志显示 `Proxy required but unavailable`

### 3. 多账户代理故障转移测试

```bash
# 配置多个账户：
# - 账户A：配置错误的代理（端口错误或代理服务器关闭）
# - 账户B：配置正常的代理
# 发送请求
```

**预期结果**:

- ✅ 尝试账户A失败，日志显示 `Proxy error detected, will retry with another account`
- ✅ 自动切换到账户B
- ✅ 请求成功，使用账户B完成

### 4. 无代理测试

```bash
# 不配置代理
# 验证直连正常工作
```

**预期结果**: ✅ 请求成功，使用直连（仅限未配置代理的账户）

## 部署建议

### 1. 检查现有代理配置

```bash
# 检查Redis中所有账户的代理配置
npm run cli accounts list
npm run cli gemini list
```

### 2. 测试代理连接性

在部署前，确保所有配置的代理服务器都可用：

- SOCKS5代理服务器运行正常
- 代理认证信息正确
- 网络连接稳定

### 3. 监控日志

部署后重点关注以下日志：

```bash
# 成功使用代理
grep "Using proxy" logs/claude-relay-*.log

# 代理失败错误
grep "Proxy required but unavailable" logs/claude-relay-*.log
```

### 4. 处理代理失败

如果发现代理失败错误：

1. **检查代理服务器状态**
2. **验证代理配置正确性**（host、port、type、认证信息）
3. **测试代理连接**
4. **如不需要代理**，在Web界面删除账户的代理配置

## 回滚方案

如果需要回滚到旧版本（不推荐，会恢复安全隐患）：

```bash
git revert <commit-hash>
```

**注意**: 回滚会恢复IP泄露风险，仅在特殊情况下使用。

## 后续改进建议

### 1. 添加代理健康检查

在账户添加/编辑时，测试代理连接性：

```javascript
async function testProxyConnection(proxyConfig) {
  // 发送测试请求验证代理可用性
}
```

### 2. 代理故障转移

支持配置多个备用代理：

```json
{
  "proxies": [
    { "type": "socks5", "host": "proxy1.com", "port": 1080 },
    { "type": "socks5", "host": "proxy2.com", "port": 1080 }
  ]
}
```

### 3. 监控告警

集成监控系统，代理失败时发送告警：

```javascript
if (proxyError) {
  webhookService.notify('proxy_failure', {
    account: accountId,
    error: error.message
  })
}
```

## 相关文件

- 核心代码：[src/utils/proxyHelper.js](src/utils/proxyHelper.js)
- 重试逻辑：[src/utils/sseConverter.js](src/utils/sseConverter.js)
- 项目说明：[CLAUDE.md](../CLAUDE.md)
- 配置示例：[config/config.example.js](../config/config.example.js)

## 总结

此次修复彻底解决了**代理失败时IP泄露**的严重安全隐患。通过引入**强制代理模式**和**自动故障转移**，确保配置了代理的账户在代理不可用时既不会暴露IP，也能通过切换账户保持服务可用性。

### 核心特性

- ✅ **安全第一**：宁可请求失败，也不暴露IP
- ✅ **自动故障转移**：代理失败时自动切换到其他可用账户（最多重试3次）
- ✅ **明确错误**：清晰的错误信息便于排查
- ✅ **向后兼容**：不影响无代理账户的使用
- ✅ **高可用性**：多账户场景下自动容错

### 工作流程

1. **代理失败检测**：ProxyHelper 检测到代理创建失败
2. **错误标记**：错误对象标记 `isProxyError = true`
3. **重试判断**：sseConverter 识别为可重试错误
4. **账户排除**：将失败账户加入排除列表
5. **自动切换**：统一调度器选择其他可用账户
6. **重试执行**：使用新账户重新发起请求
7. **成功或失败**：
   - 成功：请求完成，日志记录切换过程
   - 失败：达到最大重试次数后返回错误

### 维护建议

- 定期检查代理服务器状态
- 监控代理失败日志（搜索 `Proxy error detected`）
- 配置多个账户以实现高可用
- 及时更新代理配置
- 关注账户切换频率，频繁切换可能表明某个账户的代理不稳定

---

**文档版本**: 2.0（新增故障转移功能）
**修复人员**: Claude Code
**最后更新**: 2025-11-03
