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

> ℹ️ Claude Console 账户在 5 分钟内累计 3 次 5xx/504 错误时会被标记为 `temp_error`，调度器会在粘性会话阶段自动跳过这些账户，确保后续重试真正切换到新的账号。

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

## 🔄 响应聚合器机制

### 核心功能 (`src/utils/responseAggregator.js`)

为了支持流式请求的错误处理和非流式降级，实现了完整的响应聚合器：

#### 1. 数据聚合
```javascript
class ResponseAggregator {
  constructor() {
    this.chunks = []           // 存储所有数据块
    this.completeText = ''     // 聚合的完整文本
    this.stopReason = null     // 停止原因
    this.usage = null          // Usage数据
    this.finalResponse = null  // 完整响应对象
  }
}
```

#### 2. 支持的功能

**流式数据捕获**
- 自动解析SSE事件流
- 聚合所有 `content_block_delta` 事件中的文本
- 捕获 `message_delta` 中的 usage 数据
- 记录 stop_reason（end_turn, max_tokens等）

**响应重建**
- 将聚合的文本和元数据重建为完整的Claude响应对象
- 保持与原始API响应格式完全一致
- 支持转换为SSE流格式输出

**错误处理**
- 在流式连接中断时保留已接收的部分数据
- 支持继续聚合或降级处理

#### 3. 使用场景

**场景1：流式请求成功**
```javascript
const aggregator = new ResponseAggregator()

// 在流式响应中逐块处理
for await (const chunk of stream) {
  aggregator.addChunk(chunk)  // 聚合数据
  res.write(chunk)            // 同时发送给客户端
}

// 最终获取完整响应
const completeResponse = aggregator.getCompleteResponse()
logger.info(`✅ Captured complete text: ${aggregator.completeText.length} chars`)
```

**场景2：流式失败后降级**
```javascript
try {
  // 尝试流式请求
  const aggregator = new ResponseAggregator()
  // ... 流式处理失败
} catch (error) {
  // 降级为非流式请求
  const nonStreamResponse = await executeNonStreamRequest(...)

  // 转换为SSE流（复用聚合器的逻辑）
  await convertJsonToSSEStream(nonStreamResponse, res)
}
```

### 聚合器API

#### `addChunk(chunk)`
添加流式数据块到聚合器

```javascript
aggregator.addChunk(Buffer.from('data: {"type":"content_block_delta",...}\n\n'))
```

#### `getCompleteResponse()`
获取重建的完整响应对象

```javascript
const response = aggregator.getCompleteResponse()
// 返回格式：
// {
//   id: "msg_xxx",
//   type: "message",
//   role: "assistant",
//   content: [{ type: "text", text: "完整的回复文本" }],
//   model: "claude-sonnet-4",
//   stop_reason: "end_turn",
//   usage: { input_tokens: 100, output_tokens: 200 }
// }
```

#### 内部属性
- `chunks` - 原始数据块数组
- `completeText` - 聚合的文本内容
- `stopReason` - 停止原因
- `usage` - Token使用统计
- `finalResponse` - 完整响应对象

### 与重试机制的集成

```javascript
// 在流式重试循环中
let responseAggregator = new ResponseAggregator()

while (streamRetryCount < MAX_STREAM_RETRIES) {
  try {
    // 流式请求
    for await (const chunk of upstreamResponse.body) {
      responseAggregator.addChunk(chunk)  // 聚合数据
      res.write(chunk)                     // 发送给客户端
    }

    // 成功：记录完整响应
    const completeResponse = responseAggregator.getCompleteResponse()
    logger.info(`✅ Stream completed, total text: ${completeText.length} chars`)
    break

  } catch (error) {
    // 失败：聚合器保留部分数据，继续重试
    excludedAccounts.push(accountId)
    streamRetryCount++
  }
}
```

### 日志输出示例

```
🌊 Starting stream with response aggregator
📊 Aggregator: Captured content_block_delta, total text: 234 chars
📊 Aggregator: Captured content_block_delta, total text: 567 chars
📊 Aggregator: Captured message_delta with usage data
📊 Aggregator: stop_reason=end_turn, usage={"input_tokens":100,"output_tokens":234}
✅ Stream completed, aggregated 567 chars, usage: 334 tokens
```

## ⏱️ 超时监控机制

### 核心功能 (`src/utils/streamHelpers.js`)

为了防止流式请求长时间无响应导致资源浪费，实现了智能超时监控：

#### 1. 超时监控器
```javascript
class TimeoutMonitor {
  constructor(timeoutMs, onTimeout, logger) {
    this.timeoutMs = timeoutMs      // 超时时间（毫秒）
    this.onTimeout = onTimeout      // 超时回调函数
    this.logger = logger            // 日志记录器
    this.timer = null               // 定时器
    this.lastActivityTime = Date.now()
    this.isActive = true
  }
}
```

#### 2. 监控机制

**活动检测**
- 每次接收到数据时自动重置超时计时器
- 只要流有数据传输，就不会触发超时
- 适用于长时间生成但持续产生输出的请求

**超时触发**
- 当超过指定时间（默认30秒）没有任何数据时触发
- 自动调用 `onTimeout` 回调函数
- 支持优雅的资源清理

**灵活控制**
- 可以手动停止监控：`monitor.stop()`
- 可以重置计时器：`monitor.reset()`
- 支持动态调整超时时间

#### 3. 与流式请求的集成

```javascript
// 在流式请求开始时创建监控器
const timeoutMonitor = new TimeoutMonitor(
  30000,  // 30秒超时
  () => {
    logger.warn(`⏱️ Stream timeout: No data received for 30s`)
    abortController.abort()  // 中止请求
  },
  logger
)

// 在接收数据时重置超时
for await (const chunk of upstreamResponse.body) {
  timeoutMonitor.reset()     // 重置超时计时器
  aggregator.addChunk(chunk)
  res.write(chunk)
}

// 完成后停止监控
timeoutMonitor.stop()
```

#### 4. 配置选项

在 `config/config.js` 中可配置：

```javascript
module.exports = {
  stream: {
    timeoutMs: 30000,           // 默认30秒超时
    maxRetries: 3,              // 最大重试次数
    fallbackToNonStream: true   // 是否启用非流式降级
  }
}
```

### 超时场景处理

**场景1：正常流式响应**
```
🌊 Stream started with 30s timeout monitor
📊 Data received, timeout reset (0.5s elapsed)
📊 Data received, timeout reset (1.2s elapsed)
📊 Data received, timeout reset (2.8s elapsed)
✅ Stream completed, timeout monitor stopped
```

**场景2：超时后重试**
```
🌊 Stream started with 30s timeout monitor
📊 Data received, timeout reset (0.5s elapsed)
⏱️ Stream timeout: No data received for 30s
❌ Stream attempt 1 failed: Timeout
🔄 Excluded account xxx, will try another account
🎯 Stream attempt 2/3 using account: yyy
✅ Stream attempt 2 succeeded
```

**场景3：超时后降级**
```
🌊 Stream attempts all timed out
⚠️ All stream attempts failed, attempting non-stream fallback
🔄 Non-stream fallback succeeded
✅ Converted to SSE format and sent to client
```

### 超时监控优势

1. **防止资源浪费**：及时释放长时间无响应的连接
2. **提升用户体验**：避免客户端长时间等待
3. **智能重试**：超时后自动切换到其他账户
4. **灵活降级**：多次超时后自动降级为非流式请求

### API参考

#### `new TimeoutMonitor(timeoutMs, onTimeout, logger)`
创建超时监控器实例

**参数：**
- `timeoutMs` - 超时时间（毫秒）
- `onTimeout` - 超时时触发的回调函数
- `logger` - 日志记录器实例

#### `monitor.reset()`
重置超时计时器（表示有新的活动）

#### `monitor.stop()`
停止监控（清除定时器）

#### `monitor.getElapsedTime()`
获取自上次活动以来的经过时间（毫秒）

## 📝 相关文件

- `src/routes/api.js` - 主要实现（第139-759行）
- `src/utils/sseConverter.js` - SSE转换工具
- `src/utils/retryManager.js` - 重试管理器
- `src/utils/requestQueue.js` - 请求队列管理
- `src/utils/responseAggregator.js` - 响应聚合器
- `src/utils/streamHelpers.js` - 流式辅助工具（超时监控）

## ✅ 实现完成确认

### 核心功能
- [x] 流式重试循环（最多3个账户）
- [x] 账户选择和排除机制
- [x] 错误类型判断（可重试 vs 不可重试）
- [x] 非流式降级（retryManager集成）
- [x] JSON到SSE转换（sseConverter）

### 数据处理
- [x] 响应聚合器（ResponseAggregator）
  - [x] 流式数据实时聚合
  - [x] Usage数据自动捕获
  - [x] 完整响应对象重建
- [x] Usage数据记录和统计
- [x] 成本计算和追踪

### 可靠性保障
- [x] 超时监控机制（TimeoutMonitor）
  - [x] 智能超时检测（30秒默认）
  - [x] 自动重置计时器
  - [x] 优雅的资源清理
- [x] AbortController资源管理
- [x] 客户端断开检测
- [x] 错误处理和日志记录

### 兼容性和质量
- [x] 多账户类型支持（Claude官方、Console、Bedrock、CCR）
- [x] 向后兼容性保证
- [x] ESLint检查通过
- [x] 完整文档更新

### 新增工具文件
- [x] `src/utils/responseAggregator.js` - 响应聚合器
- [x] `src/utils/streamHelpers.js` - 超时监控器
- [x] `src/utils/sseConverter.js` - SSE转换工具
- [x] `src/utils/retryManager.js` - 重试管理器
- [x] `src/utils/requestQueue.js` - 请求队列管理

**实现状态：✅ 完成**

**实现日期：** 2025-01-11
**实现人员：** Claude Code AI Assistant
**最后更新：** 2025-01-11（补充响应聚合器和超时监控文档）

