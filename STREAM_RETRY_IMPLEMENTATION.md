# 流式请求重试实现完成 ✅

## 实现概览

流式请求重试机制已经完全实现，包含以下核心功能：

### ✅ 已完成功能

1. **SSE转换工具** (`src/utils/sseConverter.js`)
   - `convertJsonToSSEStream()` - 将JSON响应转换为SSE流
   - `sendSSEError()` - 发送SSE格式的错误
   - `isStreamRetryableError()` - 判断错误是否可重试

2. **流式请求重试循环** (`src/routes/api.js` 第169-587行)
   - 连接级重试：最多尝试3个不同的账户
   - 自动排除失败的账户：`excludedAccounts` 数组
   - 错误类型判断：可重试 vs 不可重试错误
   - 支持多种账户类型：Claude官方、Claude Console、Bedrock、CCR

3. **非流式降级机制** (`src/routes/api.js` 第589-743行)
   - 当所有流式账户失败后，自动降级为非流式请求
   - 使用 `retryManager` 执行带重试的非流式请求（最多3次）
   - 自动将JSON响应转换为SSE流格式
   - 完整的usage数据记录和限流更新

4. **错误处理和资源清理** (`src/routes/api.js` 第745-750行)
   - 所有重试都失败后，发送SSE错误响应
   - 防止响应头已发送的情况下重复响应
   - 自动清理资源和记录日志

## 📊 重试流程图

```
流式请求开始
    ↓
┌─────────────────────────────────────┐
│ 🔄 流式重试循环 (最多3个账户)        │
│                                     │
│ 1. 选择可用账户 (排除失败账户)       │
│ 2. 尝试建立流式连接                 │
│ 3. 检测错误是否可重试               │
│ 4. 失败→排除账户→继续循环           │
│ 5. 成功→退出循环→返回响应           │
└─────────────────────────────────────┘
    ↓ (所有流式尝试都失败)
┌─────────────────────────────────────┐
│ 🔄 非流式降级 (使用retryManager)    │
│                                     │
│ 1. 使用retryManager执行3次重试      │
│ 2. 排除所有已失败的流式账户         │
│ 3. 获取非流式JSON响应               │
│ 4. 转换JSON→SSE流格式               │
│ 5. 记录usage数据                   │
└─────────────────────────────────────┘
    ↓ (成功/失败)
┌─────────────────────────────────────┐
│ ✅ 成功：返回SSE流                  │
│ ❌ 失败：发送SSE错误                │
└─────────────────────────────────────┘
```

## 🔧 关键实现细节

### 1. 流式重试配置
```javascript
const MAX_STREAM_RETRIES = 3  // 最多尝试3个账户
const excludedAccounts = []    // 记录失败账户
let streamRetryCount = 0       // 当前重试次数
let lastStreamError = null     // 记录最后的错误
let usageDataCaptured = false  // 是否捕获了usage数据
```

### 2. 账户选择和排除
```javascript
const selection = await unifiedClaudeScheduler.selectAccountForApiKey(
  req.apiKey,
  sessionHash,
  requestedModel,
  { excludedAccounts }  // 🔑 排除已失败的账户
)
```

### 3. 错误判断和重试决策
```javascript
catch (error) {
  // 检查错误是否可以重试
  const isRetryable = isStreamRetryableError(error)

  if (!isRetryable) {
    logger.warn(`⚠️ Non-retryable stream error, stopping: ${error.message}`)
    break  // 不可重试，立即停止
  }

  // 排除失败的账户
  excludedAccounts.push(accountId)
  streamRetryCount++

  // 继续重试
  if (streamRetryCount < MAX_STREAM_RETRIES) {
    continue
  }
}
```

### 4. 非流式降级
```javascript
const result = await retryManager.executeWithRetry(
  async (selectedAccountId, selectedAccountType) => {
    // 执行非流式请求
    let fallbackResponse = await executeNonStreamRequest(...)
    return fallbackResponse
  },
  async (additionalExcludedAccounts) => {
    // 排除所有已失败的流式账户 + 额外失败账户
    const allExcluded = [...excludedAccounts, ...additionalExcludedAccounts]
    return await selectAccount(..., { excludedAccounts: allExcluded })
  },
  { maxRetries: 3 }  // 非流式也支持3次重试
)

// 转换JSON响应为SSE流
await convertJsonToSSEStream(result.response, res)
```

## 🎯 测试场景

### 场景1：流式账户立即成功
- **流程**：第1次尝试 → 成功 → 退出循环 → 返回SSE流
- **重试次数**：0次
- **降级**：无

### 场景2：第1个账户失败，第2个成功
- **流程**：第1次尝试 → 失败 → 排除账户1 → 第2次尝试 → 成功
- **重试次数**：1次
- **降级**：无

### 场景3：3个流式账户全部失败
- **流程**：3次流式尝试全部失败 → 降级为非流式 → 成功 → 转换为SSE流
- **重试次数**：3次流式 + 最多3次非流式 = 最多6次
- **降级**：是

### 场景4：所有尝试都失败
- **流程**：3次流式失败 → 3次非流式失败 → 发送SSE错误
- **重试次数**：6次
- **结果**：返回错误

## 📈 性能和容错

### 优势
1. **高可用性**：最多6次重试机会（3次流式 + 3次非流式）
2. **智能切换**：自动识别可重试错误，避免无效重试
3. **账户隔离**：失败账户被排除，不会重复使用
4. **无缝降级**：流式失败后自动转为非流式，对客户端透明

### 日志跟踪
```
🌊 Starting stream request with retry support (max 3 accounts)
🎯 Stream attempt 1/3 using account: xxx (claude-official)
❌ Stream attempt 1 failed: Connection timeout
🔄 Excluded account xxx, will try another account
🎯 Stream attempt 2/3 using account: yyy (claude-console)
❌ Stream attempt 2 failed: 503 Service Unavailable
⚠️ All 3 stream attempts failed, attempting non-stream fallback...
🔄 Non-stream fallback attempt using account: zzz (bedrock)
✅ Non-stream fallback succeeded, converting to SSE format
📊 Stream fallback usage recorded - Model: claude-sonnet-4, Total: 5234 tokens
```

## 🚀 部署和使用

### 无需额外配置
流式重试机制已经集成到现有的 `/api/v1/messages` 和 `/claude/v1/messages` 端点中，自动生效。

### 兼容性
- ✅ 支持所有账户类型：Claude官方、Claude Console、Bedrock、CCR
- ✅ 向后兼容：不影响现有的非流式请求逻辑
- ✅ 客户端透明：客户端无需修改任何代码

## 📝 相关文件

- `src/routes/api.js` - 主要实现（第139-759行）
- `src/utils/sseConverter.js` - SSE转换工具
- `src/utils/retryManager.js` - 重试管理器
- `src/utils/requestQueue.js` - 请求队列管理

## ✅ 实现完成确认

- [x] 流式重试循环
- [x] 账户选择和排除
- [x] 错误类型判断
- [x] 非流式降级
- [x] JSON到SSE转换
- [x] Usage数据记录
- [x] 错误处理和资源清理
- [x] ESLint检查通过
- [x] 文档更新

**实现状态：✅ 完成**

**实现日期：** 2025-01-11
**实现人员：** Claude Code AI Assistant

