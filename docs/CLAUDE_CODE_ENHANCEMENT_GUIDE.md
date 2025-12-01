# Claude Code 增强器指南

> 本文档说明 Claude Code 相关的客户端验证和请求头增强功能

---

## 📚 核心文件

本系统涉及以下关键文件：

- **`src/utils/contents.js`** - Claude Code 官方提示词模板（用于验证）
- **`src/validators/clients/claudeCodeValidator.js`** - 客户端验证器
- **`src/services/claudeCodeRequestEnhancer.js`** - 请求头增强器（仅负责请求头，不修改请求体）
- **`src/services/claudeCodeHeadersService.js`** - 统一请求头管理服务
- **`src/services/claudeRelayService.js`** - Claude 官方 API 转发服务
- **`src/services/claudeConsoleRelayService.js`** - Claude Console API 转发服务

---

## 🛡️ 客户端验证功能

### claudeCodeValidator - 请求验证器

**作用**：验证请求是否来自真实的 Claude Code 客户端

**调用 contents.js 的方式**：

```javascript
const { bestSimilarityByTemplates, SYSTEM_PROMPT_THRESHOLD } = require('../../utils/contents')

let hasValidPrompt = false
const ignoredEntries = []

for (const entry of systemEntries) {
  const rawText = typeof entry?.text === 'string' ? entry.text : ''
  const { bestScore } = bestSimilarityByTemplates(rawText)

  if (bestScore >= SYSTEM_PROMPT_THRESHOLD) {
    hasValidPrompt = true
  } else if (rawText.trim()) {
    ignoredEntries.push({ score: bestScore })
  }
}

if (!hasValidPrompt) {
  return false // 至少要匹配到一条官方 Claude Code 模板
}

// 其余未达标的 system prompt 只记调试日志，不会阻断
return true
```

**验证逻辑**：

1. User-Agent 匹配 `claude-cli/x.x.x`
2. System prompt 列表中至少有一条与官方模板相似度 ≥ 0.5（其余条目可低于阈值，仅记录调试日志）
3. 必需 headers：`x-app`, `anthropic-beta`, `anthropic-version`
4. `metadata.user_id` 格式：`user_{64位}_account__session_{uuid}`

**注意**：

- `contents.js` 仅用于客户端验证，不再用于请求体补充
- 验证器帮助区分真实 Claude Code 客户端和其他客户端

---

## 🔐 Claude Code 统一请求头配置

### 背景说明

为了确保所有从 Claude Relay Service 转发到上游 API 的请求具有一致性，避免被上游检测为多账号异常行为，我们实现了**固定请求头**策略。

### 核心配置文件

**`src/services/claudeCodeHeadersService.js`**

统一管理所有 Claude Code 相关的请求头配置。

**`src/services/claudeCodeRequestEnhancer.js`**

提供动态 beta header 配置：

```javascript
class ClaudeCodeRequestEnhancer {
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

  detectModelType(model) {
    if (!model || typeof model !== 'string') return 'unknown'
    const modelLower = model.toLowerCase()
    if (modelLower.includes('haiku')) return 'haiku'
    if (modelLower.includes('sonnet')) return 'sonnet'
    if (modelLower.includes('opus')) return 'opus'
    return 'unknown'
  }
}
```

### 使用场景

**所有 Claude API 转发服务都应使用统一请求头管理**：

| 服务文件                       | 应用位置                | 使用方法                                       |
| ------------------------------ | ----------------------- | ---------------------------------------------- |
| `claudeRelayService.js`        | Claude 官方 API 转发    | `claudeCodeHeadersService` + `getBetaHeader()` |
| `claudeConsoleRelayService.js` | Claude Console API 转发 | `claudeCodeHeadersService` + `getBetaHeader()` |
| `bedrockRelayService.js`       | AWS Bedrock 转发        | 不适用（AWS 签名机制不同）                     |
| `ccrRelayService.js`           | CCR 转发                | `claudeCodeHeadersService` + `getBetaHeader()` |

### 代码实现示例

#### claudeRelayService.js

```javascript
const claudeCodeRequestEnhancer = require('./claudeCodeRequestEnhancer')
const claudeCodeHeadersService = require('./claudeCodeHeadersService')

async relayRequest(requestBody, account, clientHeaders) {
  // 1. 获取统一的固定请求头
  const baseHeaders = claudeCodeHeadersService.getUnifiedHeaders()

  // 2. 获取动态 beta header
  const betaHeader = claudeCodeRequestEnhancer.getBetaHeader(requestBody.model)

  // 3. 合并账户 token 和动态 beta header
  const requestHeaders = {
    ...baseHeaders, // 🔧 固定请求头（优先级最高）
    'anthropic-beta': betaHeader, // 动态 beta（根据模型决定）
    Authorization: `Bearer ${accessToken}`, // 账户凭据
  }

  // 4. 转发请求
  const response = await axios.post(API_URL, requestBody, {
    headers: requestHeaders,
    // ...
  })
}
```

#### claudeConsoleRelayService.js

```javascript
const claudeCodeRequestEnhancer = require('./claudeCodeRequestEnhancer')
const claudeCodeHeadersService = require('./claudeCodeHeadersService')

async relayRequest(requestBody, account, clientHeaders) {
  // 1. 获取统一的固定请求头
  const baseHeaders = claudeCodeHeadersService.getUnifiedHeaders()

  // 2. 获取动态 beta header
  const betaHeader = claudeCodeRequestEnhancer.getBetaHeader(requestBody.model)

  // 3. 合并账户 API Key 和动态 beta header
  const requestHeaders = {
    ...baseHeaders, // 🔧 固定请求头
    'anthropic-beta': betaHeader,
    'x-api-key': apiKey, // Console 账户使用 API Key
  }

  // 4. 转发请求
  const response = await axios.post(API_URL, requestBody, {
    headers: requestHeaders,
    // ...
  })
}
```

### 特殊供应商处理

对于 instcopilot、anyrouter、gaccode 等特殊供应商：

**只使用请求头增强，不修改请求体**

```javascript
// 在 claudeConsoleRelayService.js 中
_processSpecialVendorRequestBody(body) {
  if (!body) {
    return body
  }

  // 特殊供应商不需要请求体增强，直接返回原始body
  // 请求头增强由 claudeCodeHeadersService 统一处理
  logger.info(`🏷️ Special vendor request body processing (no modification needed)`)

  return body
}
```

### 更新指南

#### ⚠️ 当需要更新某些请求头参数时

**步骤 1: 修改 `claudeCodeHeadersService.js`**

打开文件：`src/services/claudeCodeHeadersService.js`

定位到统一请求头配置块：

```javascript
const unifiedHeaders = {
  'User-Agent': 'claude-cli/4.14.0', // 🔧 修改版本号
  'anthropic-version': '2023-06-01' // 🔧 更新 API 版本
  // ... 其他参数
}
```

**步骤 2: 运行格式化工具**

```bash
npx prettier --write src/services/claudeCodeHeadersService.js
```

**步骤 3: 重启服务**

```bash
npm run service:restart
```

**步骤 4: 验证更新**

查看日志确认新的请求头已生效：

```bash
npm run service:logs:follow
```

检查日志中是否包含：

```
✅ Using unified Claude Code headers (User-Agent: claude-cli/4.14.0)
```

#### 🔧 常见更新场景

| 更新内容          | 修改位置             | 示例                  |
| ----------------- | -------------------- | --------------------- |
| Claude CLI 版本号 | `User-Agent`         | `claude-cli/4.15.0`   |
| API 版本          | `anthropic-version`  | `2024-01-01`          |
| 浏览器版本        | `sec-ch-ua`          | `"Chromium";v="133"`  |
| 操作系统          | `sec-ch-ua-platform` | `"macOS"` / `"Linux"` |

#### 📋 完整的固定请求头参数说明

| 参数名               | 当前值              | 作用                   | 是否可修改                      |
| -------------------- | ------------------- | ---------------------- | ------------------------------- |
| `User-Agent`         | `claude-cli/4.14.0` | Claude Code 客户端标识 | ✅ 需同步官方版本               |
| `anthropic-version`  | `2023-06-01`        | Anthropic API 版本     | ✅ 跟随官方更新                 |
| `x-app`              | `claude-code`       | 应用标识               | ⚠️ 不建议修改                   |
| `priority`           | `u=1, i`            | HTTP/2 优先级          | ⚠️ 保持不变                     |
| `sec-ch-ua`          | Chromium 信息       | 浏览器标识             | ✅ 可更新版本号                 |
| `sec-ch-ua-mobile`   | `?0`                | 非移动设备             | ⚠️ 保持不变                     |
| `sec-ch-ua-platform` | `"Windows"`         | 操作系统               | ✅ 可改为 `"macOS"` / `"Linux"` |
| `sec-fetch-dest`     | `empty`             | Fetch 目标类型         | ⚠️ 保持不变                     |
| `sec-fetch-mode`     | `cors`              | Fetch 模式             | ⚠️ 保持不变                     |
| `sec-fetch-site`     | `none`              | Fetch 站点             | ⚠️ 保持不变                     |

#### 🔄 动态 Beta Header 更新

如需更新 `anthropic-beta` header 的值，修改 `claudeCodeRequestEnhancer.js` 中的 `getBetaHeader()` 方法：

```javascript
getBetaHeader(model) {
  const modelType = this.detectModelType(model)

  switch (modelType) {
    case 'haiku':
      return 'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14' // 🔧 更新 haiku 的 beta
    case 'sonnet':
    case 'opus':
      return 'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14' // 🔧 更新 sonnet/opus 的 beta
    default:
      return 'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14'
  }
}
```

#### ⚠️ 重要提醒

1. **不要在各个转发服务中单独设置这些固定请求头**
   - ❌ 错误做法：在 `claudeRelayService.js` 中直接写死 `User-Agent`
   - ✅ 正确做法：统一调用 `claudeCodeHeadersService.getUnifiedHeaders()`

2. **动态参数不应放在固定请求头中**
   - `anthropic-beta`: 根据模型动态生成（使用 `getBetaHeader(model)`）
   - `Authorization` / `x-api-key`: 根据账户类型动态添加

3. **格式化代码**
   - 修改后必须运行 `npx prettier --write` 确保代码风格一致

4. **测试验证**
   - 更新后务必查看日志，确认新的请求头已应用到实际请求中

---

## 📝 功能总结

### 已实现功能

- ✅ **客户端验证** - 使用 `contents.js` 验证真实 Claude Code 客户端
- ✅ **统一请求头管理** - `claudeCodeHeadersService` 统一管理所有固定请求头
- ✅ **动态 Beta Header** - 根据模型类型动态生成 `anthropic-beta` 值
- ✅ **特殊供应商支持** - 只使用请求头增强，不修改请求体

### 已移除功能

- ❌ **提示词补充** - 不再自动为非 Claude Code 请求补充提示词
- ❌ **请求体增强** - `enhanceRequest()` 方法已移除

---

**文档版本**: v2.0 (精简版 - 仅请求头和验证功能)

**最后更新**: 2025-11-21
