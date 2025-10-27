# 🚨 安全修复总结 - 用户数据隔离问题

**修复日期**: 2025-01-27
**严重级别**: 🔴 **严重 (Critical)** - 可能导致不同用户之间的数据泄露

---

## 问题概述

发现系统中存在**两个严重的用户数据隔离漏洞**，可能导致不同 API Key 的用户共享缓存和会话状态。

### 影响范围
- **响应缓存系统** (`responseCacheService`)
- **粘性会话系统** (`sessionHelper`)

### 漏洞后果
- 用户A和用户B发送相同请求内容时，可能：
  1. **共享缓存响应** - 用户B看到用户A的响应内容
  2. **共享粘性会话** - 用户B的请求被路由到为用户A选择的账户

---

## 修复详情

### ✅ 修复1：响应缓存隔离

#### 问题文件
- `src/services/responseCacheService.js`
- `src/services/claudeConsoleRelayService.js`
- `src/routes/api.js`

#### 问题原因
`generateCacheKey()` 方法只基于请求内容生成缓存键，**没有包含 API Key ID**：

```javascript
// ❌ 修复前 - 缺少用户标识
const cacheKey = responseCacheService.generateCacheKey(modifiedRequestBody, mappedModel)
```

#### 修复方案
在缓存键生成中**强制包含 API Key ID**：

```javascript
// ✅ 修复后 - 包含 apiKeyId 确保隔离
const cacheKey = responseCacheService.generateCacheKey(modifiedRequestBody, mappedModel, apiKeyData.id)
```

#### 修改的代码

**`responseCacheService.js:32-65`**:
```javascript
generateCacheKey(requestBody, model, apiKeyId) {
  if (!apiKeyId) {
    logger.warn(`⚠️ Cache key generation without apiKeyId - this may cause cache sharing between users!`)
    return null
  }

  const cacheContent = {
    apiKeyId: apiKeyId, // 🔒 首先包含API Key ID确保用户隔离
    model: model,
    messages: requestBody.messages || [],
    // ... 其他参数
  }

  // 生成 SHA256 哈希
  const hash = crypto.createHash('sha256').update(stableJson).digest('hex').substring(0, 32)
  return hash
}
```

**`claudeConsoleRelayService.js:272`**:
```javascript
const cacheKey = responseCacheService.generateCacheKey(modifiedRequestBody, mappedModel, apiKeyData.id)
```

**`api.js:775`**:
```javascript
const cacheKey = responseCacheService.generateCacheKey(req.body, requestedModel, req.apiKey.id)
```

---

### ⚠️ 修复2：粘性会话隔离 (部分完成)

#### 问题文件
- `src/utils/sessionHelper.js`
- `src/routes/api.js` (✅ 已修复)
- `src/routes/geminiRoutes.js` (⚠️ 待修复)
- `src/routes/standardGeminiRoutes.js` (⚠️ 待修复)
- `src/routes/droidRoutes.js` (⚠️ 待修复)
- `src/routes/openaiClaudeRoutes.js` (⚠️ 待修复)
- `src/services/claudeRelayService.js` (⚠️ 待修复)

#### 问题原因
`generateSessionHash()` 方法只基于请求内容生成会话哈希，**没有包含 API Key ID**：

```javascript
// ❌ 修复前 - 缺少用户标识
const sessionHash = sessionHelper.generateSessionHash(req.body)
```

导致 Redis 键 `unified_claude_session_mapping:{sessionHash}` 在不同用户间共享。

#### 修复方案
在会话哈希生成中**包含 API Key ID**：

```javascript
// ✅ 修复后 - 包含 apiKeyId 确保隔离
const sessionHash = sessionHelper.generateSessionHash(req.body, req.apiKey.id)
```

#### 修改的代码

**`sessionHelper.js:14-44`**:
```javascript
generateSessionHash(requestBody, apiKeyId = null) {
  if (!apiKeyId) {
    logger.warn(`⚠️ Session hash generation without apiKeyId - this may cause session sharing between users!`)
  }

  // 1. 使用metadata中的session ID（加上 apiKeyId 前缀）
  if (requestBody.metadata && requestBody.metadata.user_id) {
    const sessionId = sessionMatch[1]
    const isolatedSessionId = apiKeyId ? `${apiKeyId}_${sessionId}` : sessionId
    if (isolatedSessionId.length > 32) {
      return crypto.createHash('sha256').update(isolatedSessionId).digest('hex').substring(0, 32)
    }
    return isolatedSessionId
  }

  // 2. 从 cacheableContent 开始就包含 apiKeyId
  let cacheableContent = apiKeyId || ''
  // ... 继续添加其他内容
}
```

**`api.js`** (✅ 已完成):
- Line 160: `const sessionHash = sessionHelper.generateSessionHash(req.body, req.apiKey.id)`
- Line 600: `const fallbackSessionHash = sessionHelper.generateSessionHash(req.body, req.apiKey.id)`
- Line 771: `const sessionHash = sessionHelper.generateSessionHash(req.body, req.apiKey.id)`

**已修复的文件** (✅ 已完成):
- `geminiRoutes.js`: 5处调用 ✅
- `standardGeminiRoutes.js`: 2处调用 ✅
- `droidRoutes.js`: 1处调用 ✅
- `openaiClaudeRoutes.js`: 1处调用 ✅
- `claudeRelayService.js`: 2处调用 ✅
- `api.js`: 额外发现并修复1处 (token count端点) ✅

---

## 验证方法

### 1. 检查缓存键是否包含 API Key ID

```bash
# 查看所有响应缓存键
redis-cli KEYS "response_cache:*"

# 查看缓存详情
redis-cli HGETALL "response_cache:{cacheKey}"

# 验证：不同 API Key 发送相同请求，应该生成不同的缓存键
```

### 2. 检查会话映射是否包含 API Key ID

```bash
# 查看所有粘性会话映射
redis-cli KEYS "unified_claude_session_mapping:*"

# 查看会话内容
redis-cli GET "unified_claude_session_mapping:{sessionHash}"

# 验证：不同 API Key 发送相同请求，应该生成不同的 sessionHash
```

### 3. 功能测试

```javascript
// 测试脚本示例
// 1. 使用 API Key A 发送请求
// 2. 使用 API Key B 发送完全相同的请求
// 3. 验证两个请求生成的缓存键和会话哈希是否不同
```

---

## 回滚方案

如果修复后发现问题，可以临时回滚（**不推荐**，会恢复安全漏洞）：

### 缓存键回滚
```javascript
// responseCacheService.js
generateCacheKey(requestBody, model) {  // 移除 apiKeyId 参数
  const cacheContent = {
    // apiKeyId: apiKeyId,  // 注释掉这行
    model: model,
    // ...
  }
}
```

### 会话哈希回滚
```javascript
// sessionHelper.js
generateSessionHash(requestBody) {  // 移除 apiKeyId 参数
  // 移除所有 apiKeyId 相关逻辑
}
```

**⚠️ 警告**: 回滚会重新引入数据隔离漏洞！

---

## 后续建议

### 1. 清理旧缓存（可选）
旧的缓存会在 5 分钟 TTL 后自动过期，也可以手动清理：

```bash
# 清理所有响应缓存
redis-cli KEYS "response_cache:*" | xargs redis-cli DEL

# 清理所有粘性会话
redis-cli KEYS "unified_claude_session_mapping:*" | xargs redis-cli DEL
```

### 2. 添加监控告警
监控日志中的警告信息：
```log
⚠️ Cache key generation without apiKeyId - this may cause cache sharing between users!
⚠️ Session hash generation without apiKeyId - this may cause session sharing between users!
```

如果出现这些警告，说明有代码路径没有传递 `apiKeyId`。

### 3. 代码审计
搜索所有调用点，确保都传入了 `apiKeyId`：

```bash
# 搜索可能遗漏的调用
grep -rn "generateCacheKey" src/ | grep -v "apiKeyId"
grep -rn "generateSessionHash" src/ | grep -v "apiKeyId"
```

### 4. 单元测试
添加测试用例验证：
```javascript
describe('User Isolation', () => {
  it('should generate different cache keys for different API keys', () => {
    const sameRequest = { model: 'claude-3', messages: [...] }
    const key1 = generateCacheKey(sameRequest, 'claude-3', 'apikey1')
    const key2 = generateCacheKey(sameRequest, 'claude-3', 'apikey2')
    expect(key1).not.toBe(key2)
  })

  it('should generate different session hashes for different API keys', () => {
    const sameRequest = { system: 'test', messages: [...] }
    const hash1 = generateSessionHash(sameRequest, 'apikey1')
    const hash2 = generateSessionHash(sameRequest, 'apikey2')
    expect(hash1).not.toBe(hash2)
  })
})
```

---

## 相关文档

- [response-cache.md](./docs/response-cache.md) - 响应缓存机制说明 (已更新)
- [load-balancing-and-session-rules.md](./docs/load-balancing-and-session-rules.md) - 负载均衡和会话规则

---

## 修复状态

| 组件 | 状态 | 修复者 | 验证状态 |
|------|------|--------|----------|
| responseCacheService.js | ✅ 已修复 | - | ⏳ 待验证 |
| claudeConsoleRelayService.js | ✅ 已修复 | - | ⏳ 待验证 |
| api.js (缓存) | ✅ 已修复 | - | ⏳ 待验证 |
| sessionHelper.js | ✅ 已修复 | - | ⏳ 待验证 |
| api.js (会话) | ✅ 已修复 (4处) | - | ⏳ 待验证 |
| geminiRoutes.js | ✅ 已修复 (5处) | - | ⏳ 待验证 |
| standardGeminiRoutes.js | ✅ 已修复 (2处) | - | ⏳ 待验证 |
| droidRoutes.js | ✅ 已修复 (1处) | - | ⏳ 待验证 |
| openaiClaudeRoutes.js | ✅ 已修复 (1处) | - | ⏳ 待验证 |
| claudeRelayService.js | ✅ 已修复 (2处) | - | ⏳ 待验证 |

---

**最后更新**: 2025-01-27
**优先级**: 🔴 P0 (Critical)
**影响用户**: 所有使用非流式响应缓存和粘性会话的用户
