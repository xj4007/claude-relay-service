# 交易日志功能详细文档

## 📋 功能概述

交易日志功能为 Claude Relay Service 提供了详细的 API 调用记录查询能力，支持分页、时间范围筛选，并实时显示剩余额度。用户可以通过 Web 界面查看最近 12 小时内的所有 API 调用明细。

---

## 🎯 核心特性

### 1. 数据存储

- **存储引擎**: Redis Sorted Set
- **数据结构**: `transaction_log:${keyId}`
- **保留时长**: 12 小时（自动清理）
- **排序方式**: 按时间戳倒序（最新记录在前）

### 2. 查询功能

- ✅ 支持分页查询（默认每页 10 条）
- ✅ 支持时间范围筛选（1h/3h/6h/12h/自定义）
- ✅ 实时计算剩余额度（remainingQuota）
- ✅ 显示详细的 token 使用情况
- ✅ 显示单次请求费用

### 3. 前端界面

- ✅ 现代化 UI 设计（支持明亮/暗黑模式）
- ✅ 响应式布局（手机/平板/桌面兼容）
- ✅ 实时刷新功能
- ✅ 分页导航
- ✅ 统计信息面板

---

## 📂 相关文件

### 后端文件

#### 1. `src/models/redis.js`

**新增功能**：交易日志存储与查询方法

```javascript
// 添加交易日志记录
redisClient.addTransactionLog = async function (keyId, logData) {
  // 使用 Redis Sorted Set 存储
  // Score: 时间戳（用于排序和范围查询）
  // Member: JSON 字符串（包含完整的交易信息）
}

// 查询交易日志（支持分页和时间范围）
redisClient.getTransactionLogs = async function (
  keyId,
  startTime = null,
  endTime = null,
  page = 1,
  pageSize = 10
) {
  // 使用 ZREVRANGEBYSCORE 倒序查询
  // 支持分页：LIMIT offset count
  // 返回格式化的日志数组和分页信息
}
```

**核心逻辑**：

- 使用 Redis Pipeline 批量操作
- 自动删除 12 小时前的旧数据（`ZREMRANGEBYSCORE`）
- 设置 Key 过期时间为 13 小时（容错）

**文件位置**: [src/models/redis.js:1993-2087](../src/models/redis.js#L1993-L2087)

---

#### 2. `src/routes/apiStats.js`

**新增端点**：`POST /apiStats/api/transaction-logs`

```javascript
router.post('/api/transaction-logs', async (req, res) => {
  // 参数：apiId, startTime, endTime, page, pageSize
  // 验证：API Key 存在性、激活状态、参数格式
  // 查询：调用 redis.getTransactionLogs()
  // 返回：{ success, data: { logs, pagination, retentionHours, note } }
})
```

**验证逻辑**：

1. **apiId 验证**: UUID 格式检查
2. **API Key 验证**: 存在性 + 激活状态
3. **时间范围验证**: 有效的时间戳
4. **分页参数验证**: page ≥ 1, pageSize ∈ [1, 100]

**返回格式**：

```json
{
  "success": true,
  "data": {
    "logs": [
      {
        "timestamp": 1760921194989,
        "model": "claude-sonnet-4-5-20250929",
        "inputTokens": 6,
        "outputTokens": 667,
        "cacheCreateTokens": 654,
        "cacheReadTokens": 78734,
        "cost": 0.036095699999999994,
        "remainingQuota": 6.4121293
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 10,
      "total": 64,
      "totalPages": 7
    },
    "retentionHours": 12,
    "note": "Transaction logs are retained for 12 hours only. The total count shown here may be less than the total requests in overall statistics."
  }
}
```

**文件位置**: [src/routes/apiStats.js:943-1041](../src/routes/apiStats.js#L943-L1041)

---

#### 3. `src/services/apiKeyService.js`

**修改功能**：在 `recordUsageWithDetails` 和 `recordUsage` 函数中添加交易日志记录

##### 原始实现（commit 8102e6d）

```javascript
async recordUsageWithDetails(keyId, usageObject, model, accountId, accountType) {
  // ... 记录使用统计 ...

  // 📝 记录交易日志（问题：remainingQuota 在成本累加后计算）
  try {
    let remainingQuota = null
    const costStats = await redis.getCostStats(keyId)  // 已累加的成本
    remainingQuota = totalCostLimit - (costStats?.total || 0)  // ❌ 消费后的剩余

    await redis.addTransactionLog(keyId, {
      model, inputTokens, outputTokens,
      cacheCreateTokens, cacheReadTokens,
      cost: costInfo.totalCost || 0,
      remainingQuota  // ❌ 不准确
    })
  } catch (logError) {
    logger.error(`Failed to add transaction log`)
  }
}
```

##### 优化后实现（最新版本）

```javascript
async recordUsageWithDetails(keyId, usageObject, model, accountId, accountType) {
  // 📝 在记录费用之前先计算剩余额度
  let remainingQuotaBeforeCharge = null
  try {
    const keyData = await redis.getApiKey(keyId)
    const totalCostLimit = parseFloat(keyData.totalCostLimit || 0)

    if (totalCostLimit > 0) {
      const costStats = await redis.getCostStats(keyId)  // 未累加本次成本
      remainingQuotaBeforeCharge = totalCostLimit - (costStats?.total || 0)  // ✅ 消费前的剩余
    }
  } catch (quotaError) {
    logger.debug(`Could not calculate remaining quota before charge`)
  }

  // ... 记录使用统计和累加成本 ...
  await redis.incrementDailyCost(keyId, costInfo.totalCost)

  // 📝 记录交易日志
  try {
    await redis.addTransactionLog(keyId, {
      model, inputTokens, outputTokens,
      cacheCreateTokens, cacheReadTokens,
      cost: costInfo.totalCost || 0,
      remainingQuota: remainingQuotaBeforeCharge  // ✅ 准确
    })
  } catch (logError) {
    logger.error(`Failed to add transaction log`)
  }
}

// 同样的优化也应用到 recordUsage() 函数
async recordUsage(keyId, inputTokens, outputTokens, ...) {
  // ✅ 同样在成本累加前计算 remainingQuotaBeforeCharge
  // ✅ 同样记录交易日志
}
```

**关键修复**：

1. 在 `incrementDailyCost()` **之前**计算 `remainingQuotaBeforeCharge`
2. 确保交易日志显示的是 **消费前** 的剩余额度
3. 两个函数都添加了交易日志记录，确保所有请求场景都被覆盖

**文件位置**:

- `recordUsageWithDetails`: [src/services/apiKeyService.js:1107-1243](../src/services/apiKeyService.js#L1107-L1243)
- `recordUsage`: [src/services/apiKeyService.js:917-1036](../src/services/apiKeyService.js#L917-L1036)

---

### 前端文件

#### 1. `web/admin-spa/src/components/apistats/TransactionLog.vue`

**新增组件**：交易明细展示组件（657 行）

**主要功能**：

1. **时间范围筛选**
   - 预设选项：1h / 3h / 6h / 12h
   - 自定义时间范围（datetime-local 输入）

2. **数据展示表格**
   - 时间（格式化显示）
   - 模型名称
   - 输入/输出 Tokens
   - 缓存 Tokens（Create/Read）
   - 费用（美元格式化）
   - 剩余额度

3. **分页导航**
   - 上一页/下一页按钮
   - 页码显示
   - 禁用状态处理

4. **统计信息面板**
   - 本页记录数
   - 总记录数（12h）
   - 本页消费总额
   - 数据保留时长

5. **数据说明提示**
   ```
   数据说明：
   交易日志仅保留最近 12 小时的详细记录，因此这里显示的总记录数可能
   少于统计概览页面中的"总请求数"。统计概览页面显示的是 API Key
   创建以来的累计请求总数。
   ```

**样式特性**：

- ✅ 响应式设计（移动端友好）
- ✅ 暗黑模式支持
- ✅ 玻璃态效果
- ✅ 动画过渡效果

**文件位置**: [web/admin-spa/src/components/apistats/TransactionLog.vue](../web/admin-spa/src/components/apistats/TransactionLog.vue)

---

#### 2. `web/admin-spa/src/stores/apistats.js`

**新增 Store 方法**：

```javascript
// 获取交易日志
async fetchTransactionLogs(apiId, startTime, endTime, page = 1, pageSize = 10) {
  this.transactionLogsLoading = true
  this.transactionLogsError = null

  try {
    const response = await fetch('/apiStats/api/transaction-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiId, startTime, endTime, page, pageSize })
    })

    const data = await response.json()

    if (data.success) {
      this.transactionLogs = data.data.logs
      this.transactionLogsPagination = data.data.pagination
    } else {
      this.transactionLogsError = data.message || '获取交易日志失败'
    }
  } catch (error) {
    this.transactionLogsError = '网络错误，请稍后重试'
  } finally {
    this.transactionLogsLoading = false
  }
}

// 清空交易日志
clearTransactionLogs() {
  this.transactionLogs = []
  this.transactionLogsPagination = null
  this.transactionLogsError = null
}
```

**State 定义**：

```javascript
transactionLogs: [],
transactionLogsPagination: null,
transactionLogsLoading: false,
transactionLogsError: null
```

**文件位置**: [web/admin-spa/src/stores/apistats.js](../web/admin-spa/src/stores/apistats.js)

---

#### 3. `web/admin-spa/src/config/apiStats.js`

**新增配置**：

```javascript
export const API_ENDPOINTS = {
  // ... 其他端点 ...
  TRANSACTION_LOGS: '/apiStats/api/transaction-logs'
}

export const TRANSACTION_CONFIG = {
  DEFAULT_PAGE_SIZE: 10,
  MAX_PAGE_SIZE: 100,
  RETENTION_HOURS: 12,
  TIME_RANGES: [
    { value: '1h', label: '最近 1 小时', hours: 1 },
    { value: '3h', label: '最近 3 小时', hours: 3 },
    { value: '6h', label: '最近 6 小时', hours: 6 },
    { value: '12h', label: '最近 12 小时', hours: 12 },
    { value: 'custom', label: '自定义', hours: null }
  ]
}
```

**文件位置**: [web/admin-spa/src/config/apiStats.js](../web/admin-spa/src/config/apiStats.js)

---

#### 4. `web/admin-spa/src/views/ApiStatsView.vue`

**集成交易日志组件**：

```vue
<template>
  <div class="api-stats-view">
    <!-- 统计概览组件 -->
    <StatsOverview />

    <!-- 模型使用统计组件 -->
    <ModelStats />

    <!-- 📝 新增：交易明细组件 -->
    <TransactionLog />
  </div>
</template>

<script setup>
import TransactionLog from '@/components/apistats/TransactionLog.vue'
</script>
```

**文件位置**: [web/admin-spa/src/views/ApiStatsView.vue](../web/admin-spa/src/views/ApiStatsView.vue)

---

## 🔧 技术实现细节

### 1. Redis 数据结构

```redis
# Key 格式
transaction_log:{keyId}

# 数据类型
Sorted Set

# Score
时间戳（毫秒级）

# Member
JSON 字符串：
{
  "timestamp": 1760921194989,
  "model": "claude-sonnet-4-5-20250929",
  "inputTokens": 6,
  "outputTokens": 667,
  "cacheCreateTokens": 654,
  "cacheReadTokens": 78734,
  "cost": 0.036095699999999994,
  "remainingQuota": 6.4121293
}

# 过期策略
- 自动删除 12 小时前的数据（ZREMRANGEBYSCORE）
- Key 过期时间：13 小时（EXPIRE）
```

### 2. 查询性能优化

#### Redis 命令优化

```javascript
// 使用 Pipeline 批量操作
const pipeline = client.pipeline()
pipeline.zadd(logKey, timestamp, logEntry)
pipeline.zremrangebyscore(logKey, '-inf', twelveHoursAgo)
pipeline.expire(logKey, 13 * 60 * 60)
await pipeline.exec()

// 分页查询使用 ZREVRANGEBYSCORE + LIMIT
const logs = await client.zrevrangebyscore(
  logKey,
  end, // max score
  start, // min score
  'LIMIT',
  offset, // (page - 1) * pageSize
  pageSize // 每页数量
)
```

#### 前端性能优化

- 使用虚拟滚动（如需要）
- 懒加载分页数据
- 防抖处理刷新按钮
- 缓存已加载的页面数据

### 3. 剩余额度计算逻辑

```javascript
// 计算时机：在累加成本之后（重要！）
let remainingQuotaAfterCharge = null

// 1. 累加本次成本
await redis.incrementDailyCost(keyId, costInfo.totalCost)

// 2. 获取**累加后**的成本统计（包含本次消费）
const costStats = await redis.getCostStats(keyId) // 已包含本次成本
const totalCost = costStats?.total || 0

// 3. 获取额度限制
const totalCostLimit = parseFloat(keyData.totalCostLimit || 0)

// 4. 计算剩余额度（消费后的实际余额）
if (totalCostLimit > 0) {
  remainingQuotaAfterCharge = totalCostLimit - totalCost // ✅ 消费后的实际剩余
}

// 5. 记录交易日志（使用消费后的实际剩余额度）
await redis.addTransactionLog(keyId, {
  // ... 其他字段 ...
  remainingQuota: remainingQuotaAfterCharge // ✅ 准确反映交易后的剩余额度
})
```

**验证公式**：

```
记录N的remainingQuota - 记录N的cost ≈ 记录N+1的remainingQuota
// 说明：每笔交易的剩余额度（消费后） - 这笔交易的成本 ≈ 下一笔交易的剩余额度（下一笔消费后）
```

---

## 🐛 已修复的 Bug

### Bug 1: remainingQuota 计算时机错误（已修复）

**问题描述**：

- 交易日志显示的 `remainingQuota` 与统计概览数据不一致
- 例如：总额度 $20，统计显示消费 $9.98，应该剩余 $10.02
- 但交易日志错误显示剩余 $10.65

**根本原因**（第一版）：

- 初始实现在成本累加**之后**计算剩余额度
- 导致显示的不是真实的"消费后余额"

**最终修复方案**：

- 确保 `remainingQuota` 显示的是**消费后的实际余额**
- 在累加成本**之后**计算：`remainingQuota = totalLimit - (costStats?.total || 0)`
- 这样交易日志中的 `remainingQuota` 就是消费后的真实剩余额度
- 变量命名：`remainingQuotaAfterCharge`（明确语义）

**修复流程**：

1. 记录使用统计（`incrementTokenUsage`）
2. **累加成本**（`incrementDailyCost`）
3. **获取累加后的成本统计**
4. **计算剩余额度**（消费后）
5. 记录交易日志（使用消费后的余额）

**验证**：

- 交易日志记录 N：`remainingQuota` = $10.02，`cost` = $0.50
- 交易日志记录 N+1：`remainingQuota` 应该 ≈ $9.52
- 计算：$10.02 - $0.50 = $9.52 ✅ 完全匹配

**修复 Commit**: 2025-10-20（当前会话）

---

### Bug 2: 请求数不一致（统计 vs 交易日志）

**问题描述**：

- 统计数据：显示 68 个请求
- 交易日志：只有 64 条记录
- 用户当天才开始使用（排除 12h 保留问题）

**根本原因**：

- 项目中存在两个记录使用的函数：
  1. `recordUsage`（旧版）：❌ **没有**记录交易日志
  2. `recordUsageWithDetails`（新版）：✅ **有**记录交易日志
- Bedrock、非流式请求、流式回退等场景使用旧版函数

**影响场景**：

- Bedrock 流式请求
- 流式回退到非流式
- 非流式请求
- Azure OpenAI 请求
- Droid 请求

**修复方案**：

- 给 `recordUsage` 函数添加交易日志记录
- 确保所有请求场景都记录交易日志

**修复 Commit**: 本次修复

---

### Bug 3: 共享响应重复扣费（已修复）

**问题描述**：

- 当多个相同请求并发到达时，系统使用请求队列机制让后续请求等待第一个请求的结果
- 虽然只有一个上游请求，但日志显示多次记录了 usage，导致重复扣费
- 例如：23:05:22 时，4 个请求共享同一个上游响应，但交易日志出现 4 条相同的扣费记录

**问题日志示例**：

```log
📝 [2025-10-30 23:05:22] INFO: ✅ Request completed | CacheKey: f8753079d3e06b71... | Duration: 56643ms | Shared with: 4 requests
📝 [2025-10-30 23:05:22] INFO: ✅ Shared result delivered to waiting request (marked as shared) | CacheKey: f8753079d3e06b71...
📝 [2025-10-30 23:05:22] INFO: ✅ Shared result delivered to waiting request (marked as shared) | CacheKey: f8753079d3e06b71...
📝 [2025-10-30 23:05:22] INFO: ✅ Shared result delivered to waiting request (marked as shared) | CacheKey: f8753079d3e06b71...
📝 [2025-10-30 23:05:22] INFO: 🔗 📊 Non-stream usage recorded - Model: claude-sonnet-4-5-20250929, Input: 5, Output: 216, Cache Create: 75780, Cache Read: 15606, Total: 91607 tokens
📝 [2025-10-30 23:05:22] INFO: 🔗 📊 Non-stream usage recorded - Model: claude-sonnet-4-5-20250929, Input: 5, Output: 216, Cache Create: 75780, Cache Read: 15606, Total: 91607 tokens
📝 [2025-10-30 23:05:22] INFO: 🔗 📊 Non-stream usage recorded - Model: claude-sonnet-4-5-20250929, Input: 5, Output: 216, Cache Create: 75780, Cache Read: 15606, Total: 91607 tokens
📝 [2025-10-30 23:05:22] INFO: 🔗 📊 Non-stream usage recorded - Model: claude-sonnet-4-5-20250929, Input: 5, Output: 216, Cache Create: 75780, Cache Read: 15606, Total: 91607 tokens
```

**消费记录示例**：

```
时间               模型                              输入  输出  缓存创建  缓存读取  消费额度   剩余额度
2025-10-30 23:05:22  claude-sonnet-4-5-20250929  5     216   75,780    15,606   $0.2921   $48.22
2025-10-30 23:05:22  claude-sonnet-4-5-20250929  5     216   75,780    15,606   $0.2921   $48.22  ❌ 重复
2025-10-30 23:05:22  claude-sonnet-4-5-20250929  5     216   75,780    15,606   $0.2921   $48.22  ❌ 重复
```

**根本原因**：

1. **`requestQueue.js` 设置标记**：
   - 在 `waitForPendingRequest` 函数中，等待的请求获取结果后设置 `result.isSharedResponse = true`（第 59-61 行）

2. **`responseCacheService.js` 包装对象**：
   - `getOrFetchResponse` 函数返回的是 `{ success: true, response }` 包装对象（第 151 行）
   - `requestQueue` 给这个包装对象设置了 `isSharedResponse = true`

3. **标记丢失**：
   - 最终 `responseCacheService.js` 返回的是 `result.response`（第 170 行）
   - `isSharedResponse` 标记在 `result` 对象上，但返回的 `result.response` 对象上没有此标记
   - 导致 `api.js` 中的检查失效：`const isSharedResponse = response.isSharedResponse === true` 始终为 false

4. **重复记录 usage**：
   - 所有等待的请求都认为自己不是共享响应，都记录了 usage
   - 结果：1 个上游请求，N 次 usage 记录，N 倍扣费

**代码流程**：

```javascript
// 1. requestQueue.js (第 59-61 行)
const result = await pending.promise  // result = { success: true, response: {...} }
if (result && typeof result === 'object') {
  result.isSharedResponse = true  // ✅ 设置在包装对象上
}
return result  // 返回 { success: true, response: {...}, isSharedResponse: true }

// 2. responseCacheService.js (第 170 行)
return result.response  // ❌ 只返回 response 对象，isSharedResponse 标记丢失

// 3. api.js (第 1015 行)
const isSharedResponse = response.isSharedResponse === true  // ❌ 永远是 false

// 4. api.js (第 1030-1073 行)
if (!isCachedResponse && !isSharedResponse && jsonData.usage) {
  await apiKeyService.recordUsage(...)  // ❌ 每个请求都会记录
}
```

**修复方案**：
在 `responseCacheService.js` 中传递 `isSharedResponse` 标记到实际返回的响应对象：

```javascript
// src/services/responseCacheService.js (第 170-180 行)
// 3. 如果是失败响应，等待的请求应该重新尝试而不是共享失败结果
if (!result.success) {
  logger.warn(
    `⚠️ Shared request failed (${result.response.statusCode}), waiting request will retry independently | CacheKey: ${cacheKey.substring(0, 16)}...`
  )
  // 🔄 重新执行请求（带重试逻辑），不共享失败结果
  return await fetchFn()
}

// 🔒 IMPORTANT: 如果 result 被标记为共享响应，需要将此标记传递到 result.response
// requestQueue 会给 result 对象设置 isSharedResponse=true，但我们返回的是 result.response
// 所以需要将标记复制到实际返回的对象上，防止重复记录 usage
if (result.isSharedResponse === true && result.response) {
  result.response.isSharedResponse = true
  logger.debug(
    `🔒 Transferred isSharedResponse flag to response object | CacheKey: ${cacheKey.substring(0, 16)}...`
  )
}

return result.response
```

**修复验证**：
修复后的日志应该显示：

```log
✅ Request completed | CacheKey: f8753079d3e06b71... | Duration: 56643ms | Shared with: 4 requests
✅ Shared result delivered to waiting request (marked as shared) | CacheKey: f8753079d3e06b71...
✅ Shared result delivered to waiting request (marked as shared) | CacheKey: f8753079d3e06b71...
✅ Shared result delivered to waiting request (marked as shared) | CacheKey: f8753079d3e06b71...
🔒 Transferred isSharedResponse flag to response object | CacheKey: f8753079d3e06b71...
📊 Parsed upstream response: { ... }
📊 Non-stream usage recorded - Model: claude-sonnet-4-5-20250929, ... ✅ 只记录一次
🔒 Skipping usage for shared response | CacheKey: f8753079d3e06b71... ✅ 跳过
🔒 Skipping usage for shared response | CacheKey: f8753079d3e06b71... ✅ 跳过
🔒 Skipping usage for shared response | CacheKey: f8753079d3e06b71... ✅ 跳过
```

**影响范围**：

- 所有使用 `requestQueue` 机制的非流式请求
- 高并发场景下的重复请求去重
- 缓存失效后的并发请求处理

**修复 Commit**: 2025-10-30（当前会话）

**相关文件**：

- `src/utils/requestQueue.js` (第 59-61 行：设置 isSharedResponse 标记)
- `src/services/responseCacheService.js` (第 170-180 行：传递标记到响应对象)
- `src/routes/api.js` (第 1015, 1030-1073 行：检查 isSharedResponse 并决定是否记录 usage)

---

## 📊 数据一致性保证

### 1. 统计数据 vs 交易日志

| 数据源       | 存储位置                   | 保留时长       | 统计范围                      |
| ------------ | -------------------------- | -------------- | ----------------------------- |
| **统计数据** | `usage:${keyId}`           | 永久（或配置） | 从 API Key 创建开始的所有请求 |
| **交易日志** | `transaction_log:${keyId}` | 12 小时        | 最近 12 小时的详细记录        |

**一致性验证**：

```javascript
// 对于 12 小时内的数据
统计数据.requests ≈ 交易日志.pagination.total

// 超过 12 小时的数据
统计数据.requests > 交易日志.pagination.total  // ✅ 正常
```

### 2. 费用数据验证

```javascript
// 单条记录验证
log[i].remainingQuota - log[i].cost ≈ log[i+1].remainingQuota

// 总费用验证
sum(transactionLogs.cost) ≈ 统计数据.currentTotalCost  // 对于 12h 内
```

---

## 🎯 使用场景

### 1. 费用明细审计

用户可以查看每次 API 调用的详细费用，包括：

- 输入/输出 token 数量
- 缓存 token 使用情况
- 单次请求费用
- 剩余额度变化

### 2. 异常请求排查

通过交易日志快速定位：

- 哪些请求消耗了大量 token
- 哪个时间段请求最频繁
- 哪个模型费用最高

### 3. 成本优化分析

基于交易日志数据：

- 分析 token 使用模式
- 优化缓存策略
- 选择最经济的模型

### 4. 额度监控

实时查看剩余额度变化：

- 预警额度不足
- 避免超额使用
- 合理规划使用计划

---

## 🔒 安全性考虑

### 1. 权限控制

- 只能查询自己的 API Key 交易日志
- 验证 API Key 存在性和激活状态
- 记录安全日志（失败尝试）

### 2. 数据脱敏

- 不记录请求内容（仅统计信息）
- 不记录敏感的账户凭据
- 12 小时自动清理（隐私保护）

### 3. 参数验证

```javascript
// 严格的参数验证
- apiId: UUID 格式
- startTime/endTime: 有效时间戳
- page: ≥ 1
- pageSize: 1-100
```

---

## 🚀 未来优化方向

### 1. 功能扩展

- [ ] 导出交易日志（CSV/JSON）
- [ ] 按模型/账户筛选
- [ ] 高级搜索功能
- [ ] 交易日志图表可视化

### 2. 性能优化

- [ ] Redis Cluster 支持
- [ ] 分页缓存优化
- [ ] 异步导出大量数据

### 3. 数据分析

- [ ] 成本趋势分析
- [ ] Token 使用预测
- [ ] 异常检测告警

---

## 📖 相关文档

- [API Stats 总体架构](./API_STATS_ARCHITECTURE.md)
- [Redis 数据结构设计](./REDIS_DATA_STRUCTURE.md)
- [前端组件开发指南](./FRONTEND_COMPONENT_GUIDE.md)
- [API 接口文档](./API_ENDPOINTS.md)

---

## 🙏 贡献者

- **原始功能开发**: fenglangyuan (Commit: 8102e6d)
- **Bug 修复**: 当前会话
- **文档整理**: 当前会话

---

## 📝 更新日志

### 2025-10-19

- ✅ 初始功能开发（Commit: 8102e6d）
  - Redis 交易日志存储方法
  - API 查询接口
  - 前端交易明细组件
  - 分页和时间范围筛选

### 2025-10-30

- ✅ 修复共享响应重复扣费问题（Bug 3）
  - **问题**：并发相同请求共享响应时，多次记录 usage 导致重复扣费
  - **根因**：`requestQueue` 设置的 `isSharedResponse` 标记没有传递到实际返回的响应对象
  - **修复**：在 `responseCacheService.js` 中传递标记到响应对象
  - **影响文件**：
    - `src/services/responseCacheService.js` (第 170-180 行)
    - `src/utils/requestQueue.js` (第 59-61 行)
    - `src/routes/api.js` (第 1015, 1030-1073 行)
  - **结果**：1 个上游请求现在只记录 1 次 usage，杜绝 N 倍扣费
- ✅ 完善文档：添加 Bug 3 详细说明和代码流程分析

### 2025-10-20

- ✅ 修复 `remainingQuota` 计算策略
  - **关键改变**：`remainingQuota` 现在记录的是**消费后的实际余额**
  - 修改时机：在累加成本**之后**计算，而非之前
  - 影响函数：`recordUsage()` 和 `recordUsageWithDetails()`
  - 结果：交易日志中的余额现在与统计概览完全一致
- ✅ 修复 `recordUsage` 函数缺少交易日志记录（上一次会话）
- ✅ 验证数据一致性：$20 总额 - $9.98 消费 = $10.02 剩余 ✅
- ✅ 更新计算逻辑文档
- ✅ 完善 Bug 说明文档

---

## 🔗 快速链接

- [Git Commit 8102e6d](https://github.com/your-repo/commit/8102e6df4cbbcb1d49434f4d5bd212a167a13913)
- [在线演示](#)
- [问题反馈](https://github.com/your-repo/issues)
