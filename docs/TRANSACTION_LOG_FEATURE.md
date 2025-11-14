# 交易日志功能详细文档


src\services\apiKeyService.js

anyrouter-anyrouter 账号扣费的参数
let anyrouterDiscountRatio = 0.3 // 用户支付30%折扣

anyrouter-heibai 账号扣费的参数
anyrouterDiscountRatio = 0.3 // heibai账户保留30%费用（70%折扣），多扣费




## 📋 功能概述

交易日志功能为 Claude Relay Service 提供了详细的 API 调用���录查询能力，支持分页、时间范围筛选，并实时显示剩余额度。用户可以通过 Web 界面查看最近 12 小时内的所有 API 调用明细。

---

## 🚀 快速参考：anyrouter 账户优化机制

系统为不同类型的 anyrouter 账户提供了针对性的成本优化机制：

### 1️⃣ anyrouter-heibai 账户优化（无真实缓存场景）

**账户特征**：

- 账户名包含 `anyrouter-heibai` 关键字（如 `anyrouter-heibai-1`、`anyrouter-heibai-aaa`）
- 上游没有真实缓存功能，按一次性输入计费

**触发条件**：

- ✅ 账户名包含 `anyrouter-heibai` 关键字
- ✅ `cache_create` = 0（上游无缓存创建）
- ✅ `cache_read` > 0（上游返回缓存读取数据）

**优化策略**：

1. **Token 重新分配**（智能显示优化）：
   - `input_tokens`: 25-35% 的总输入（随机，最小 500 tokens）
   - `cache_create`: 8-12% 的总输入（随机）
   - `cache_read`: 剩余部分
   - **改进**：提高了 input_tokens 比例，确保显示合理的数值，避免出现 0、1、2 等极小值

2. **费用折扣**：
   - 应用 **70% 费用折扣**（用户支付 30% 费用）
   - 用户实际支付原价的 **30%**

**优化效果**：

- 💰 **成本控制**：用户支付原价的 30%，你获得 70% 利润
- 📊 **显示优化**：Token 分配看起来更真实合理（input_tokens 至少几百到几千）
- 🎯 **目标达成**：实现成本可控的中转服务，同时保证显示数据合理

**代码位置**：`src/services/apiKeyService.js` 的 `recordUsageWithDetails()` 函数（第 1172-1212 行）

**示例对比**：

```
上游 anyrouter-heibai 费用：
  输入：55.23K tokens
  输出：7.51K tokens
  费用：$0.2784

优化后中转费用（用户支付 30%）：
  输入：6,900-13,809 tokens (12-25%)，最小 500
  输出：7,513 tokens
  缓存创建：4,418-11,047 tokens (8-12%)
  缓存读取：剩余部分
  费用：$0.0835 (上游的 30% ✅ 用户支付) → 你获得 $0.1949 (上游的 70%)
```

---

### 2️⃣ anyrouter-anyrouter 账户优化（有真实缓存场景）

**账户特征**：

- 账户名包含 `anyrouter-anyrouter` 关键字
- 上游有真实缓存功能

**触发条件**：

- ✅ 账户名包含 `anyrouter-anyrouter` 关键字
- ✅ `cache_create` > 0（有真实缓存创建）
- ✅ `cache_read` > 0（已命中缓存）

**优化内容**：

1. **Token 转换**：
   - 90-97% 的 `cache_create` 随机���为 `cache_read`
   - 保留 3-10% 的 `cache_create` 以显示真实性

2. **费用折扣**：
   - 应用 **60% 费用折扣**（用户支付 40% 费用）
   - 用户实际支付原价的 **40%**

3. **节省效果**：
   - 综合节省约 **75% 成本**（Token 转换 + 费用折扣）

**代码位置**：`src/services/apiKeyService.js` 的 `recordUsageWithDetails()` 函数（第 1214-1249 行）

---

### 3️⃣ 智能缓存优化（未命中缓存场景）

**触发条件**：

- ✅ 账户名包含 `anyrouter-anyrouter` 关键字
- ✅ 账户类型为 `claude-console` 或 `claude-official`
- ✅ `cache_read` = 0（未命中缓存）
- ✅ `cache_create` ≥ 10,000 tokens
- ✅ 5 分钟内有相似请求（输入差异 ≤ 20%，缓存差异 ≤ 15%）

**优化内容**：

- 📊 **Token 转换**：40% 的 `cache_create` 转为 `cache_read`
- 💡 **节省效果**：约 36% 成本

**代码位置**：

- `src/services/smartCacheOptimizer.js`（智能缓存优化服务）
- `src/services/apiKeyService.js` 的 `recordUsage()` 函数（第 897-927 行）

---

### 📌 重要说明

#### **账户类型区分**

| 账户类型                    | 判断标识              | 优化类型              | 用户支付 | 你获得  | 适用场景     |
| --------------------------- | --------------------- | --------------------- | -------- | ------- | ------------ |
| **anyrouter-heibai-xxx**    | `anyrouter-heibai`    | Token重分配 + 70%折扣 | **30%**  | **70%** | 无真实缓存   |
| **anyrouter-anyrouter-xxx** | `anyrouter-anyrouter` | Token转换 + 60%折扣   | **40%**  | **60%** | 有真实缓存   |
| **其他账户**                | 不匹配                | 无优化                | **100%** | **0%**  | 保持上游原样 |

#### **优化机制特点**

- **专属优化**：只对 anyrouter 账户生效
- **互斥处理**：每个账户只应用���种优化策略
- **不影响其他账户**：非 anyrouter 账户保持原有计费逻辑
- **透明优化**：无需修改客户端代码
- **智能随机**：Token 分配和转换比例随机变化，显示真实性

#### **实际费用对比**

**场景1：anyrouter-heibai 账户**
| 原始费用 | 用户支付 | 你获得 | 说明 |
|---------|---------|--------|------|
| $0.2784 | **$0.0835** (30%) | **$0.1949** (70%) | ✅ 用户便宜，你获利多 |

**场景2：anyrouter-anyrouter 账户**
| 阶段 | 原始费用 | 优化后费用 | 节省 | 说明 |
|------|---------|-----------|------|------|
| Token转换 | $1.00 | $0.25 | 75% | 90-97% cache_create 转为 cache_read |
| 再打折扣 | $0.25 | **$0.10** (40%) | **87.5%** | ✅ 综合节省（转换 + 60%折扣）|

**对比总结**：

```
anyrouter-heibai 账户：
  用户支付 30% 费用 ← 最便宜，更容易吸引用户
  你获得 70% 利润 ← 最赚钱

anyrouter-anyrouter 账户：
  用户支付 40% 费用
  你获得 60% 利润
```

---

[剩余内容保持不变，从 "## 🎯 核心特性" 开始...]

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

### 4. 智能缓存优化 🎯

**功能概述**：

智能缓存优化是一项自动成本优化功能，**专为 anyrouter-anyrouter- 关键字的账户设计**。通过检测相似请求并自动应用"缓存折扣"，大幅降低用户成本。

**⚠️ 重要说明**：

- **只对账户名包含 `anyrouter-anyrouter` 关键字的账户生效**
- **其他上游账户不会被应用智能缓存优化**
- 这是为了避免影响正常账户的计费逻辑

**核心特性**：

- ✅ 自动检测相似请求（5分钟时间窗口）
- ✅ 智能缓存折扣（70% cache_create 转为 cache_read）
- ✅ 成本节省 60-80%（针对大缓存请求）
- ✅ 交易日志完整记录优化信息
- ✅ 仅对有缓存创建的请求生效（不影响其他请求）
- ✅ 透明优化，无需修改客户端代码
- ✅ **只针对 anyrouter 账户，不影响其他账户**

**工作原理**：

1. **请求记录**：每个请求的 token 使用情况会记录到 Redis（最近 5 分钟）
2. **相似度检测**：新请求到达时，检测是否存在相似的历史请求
   - 输入 tokens 差异 < 20%
   - 缓存创建 tokens 差异 < 15%
3. **Token 转换**：如果检测到相似请求，将 70% 的 `cache_create` 转为 `cache_read`
4. **成本计算**：由于 `cache_read` 价格是 `cache_create` 的 1/10，可节省约 63% 成本
5. **日志记录**：优化信息完整记录到交易日志，包含原始值和优化后值

**适用场景**：

- **anyrouter-anyrouter- 账户**（缓存创建高，但缓存命中率低）
- 持续对话场景（相似请求频繁）
- 代码编辑场景（增量修改请求）

**触发条件**：

- ✅ **账户名必须包含 `anyrouter-anyrouter` 关键字**（核心条件）
- ✅ **账户类型为 `claude-console` 或 `claude-official`**
- ✅ `cache_create` ≥ 10,000 tokens（可配置）
- ✅ `cache_read` = 0（未命中缓存）
- ✅ 5 分钟内有相似请求（可配置）
- ✅ 输入 tokens 差异 ≤ 20%（可配置）
- ✅ 缓存创建 tokens 差异 ≤ 15%（可配置）
- ❌ **非 anyrouter 账户不会触发优化**
- ❌ 无缓存创建的请求不会触发
- ❌ 已命中缓存的请求不需要优化
- ❌ 未提供账户信息时不会触发

**配置参数**（`config/config.js`）：

```javascript
smartCacheOptimization: {
  // 是否启用智能缓存优化（默认：true）
  enabled: process.env.SMART_CACHE_ENABLED !== 'false',

  // 时间窗口（分钟）：在此时间内的请求会被检测相似度（默认：5）
  timeWindowMinutes: parseInt(process.env.SMART_CACHE_TIME_WINDOW) || 5,

  // 输入tokens差异阈值（百分比）：低于此阈值视为相似（默认：0.2 = 20%）
  inputTokenThreshold: parseFloat(process.env.SMART_CACHE_INPUT_THRESHOLD) || 0.2,

  // 缓存创建tokens差异阈值（百分比）（默认：0.15 = 15%）
  cacheCreateThreshold: parseFloat(process.env.SMART_CACHE_CREATE_THRESHOLD) || 0.15,

  // 缓存折扣比例（0-1之间）：多少比例的cache_create转为cache_read（默认：0.7 = 70%）
  discountRatio: parseFloat(process.env.SMART_CACHE_DISCOUNT_RATIO) || 0.7,

  // 最小缓存tokens要求：低于此值不应用优化（默认：10000）
  minCacheTokens: parseInt(process.env.SMART_CACHE_MIN_TOKENS) || 10000
}
```

**Redis 数据结构**：

```redis
# Key 格式
recent_requests:{keyId}

# 数据类型
List（Redis LPUSH + LTRIM）

# 数据内容
[
  {
    "timestamp": 1698765432000,
    "inputTokens": 5000,
    "outputTokens": 2000,
    "cacheCreateTokens": 118000,
    "cacheReadTokens": 0,
    "model": "claude-sonnet-4-5-20250929"
  },
  ...
]

# 保留策略
- 只保留最近 10 条记录（LTRIM 0 9）
- TTL：5 分钟（timeWindowMinutes * 60 秒）
```

**成本节省计算**：

```javascript
// 假设：
// - cache_create: 118,000 tokens
// - cache_read: 0 tokens
// - 检测到相似请求

// 优化前：
// cache_create 成本 = 118,000 * (价格_create)

// 优化后（70% 转换）：
// tokens_converted = 118,000 * 0.7 = 82,600 tokens
// cache_create 成本 = 35,400 * (价格_create)
// cache_read 成本 = 82,600 * (价格_read) = 82,600 * (价格_create / 10)

// 节省比例：
// savings = (1 - 0.1) * 0.7 = 0.63 = 63%
```

**实际使用示例**：

**场景 1：anyrouter 账户持续对话**

```
请求 1（23:05:10）：
- input: 5000 tokens
- cache_create: 118000 tokens
- cache_read: 0 tokens
- 成本：$0.48
→ 记录到 recent_requests

请求 2（23:05:22，12秒后）：
- input: 5200 tokens (差异：4%)
- cache_create: 120000 tokens (差异：1.7%)
- cache_read: 0 tokens
→ 检测到相似请求！
→ 应用智能缓存优化：
  - 原始：cache_create=120000, cache_read=0
  - 优化：cache_create=36000, cache_read=84000
  - 节省：63%
- 优化后成本：$0.18（节省 $0.30）
```

**交易日志显示**：

```json
{
  "timestamp": 1698765522000,
  "model": "claude-sonnet-4-5-20250929",
  "inputTokens": 5200,
  "outputTokens": 2100,
  "cacheCreateTokens": 36000, // ✅ 优化后的值
  "cacheReadTokens": 84000, // ✅ 优化后的值
  "cost": 0.18, // ✅ 优化后的成本
  "remainingQuota": 19.82,
  "cacheOptimized": true, // 🎯 优化标记
  "originalCacheCreate": 120000, // 📋 原始值
  "originalCacheRead": 0, // 📋 原始值
  "tokensConverted": 84000, // 📊 转换的 token 数量
  "savingsPercent": 63 // 💰 节省百分比
}
```

**日志示例**：

```log
[2025-10-30 23:05:10] INFO: 📝 Recorded recent request for key: 12345678...
[2025-10-30 23:05:22] DEBUG: 🎯 Found similar request | Time diff: 12s | Input diff: 4.00% | Cache diff: 1.70%
[2025-10-30 23:05:22] INFO: 🎯 Smart cache optimization applied | Key: 12345678... | Original: cache_create=120000, cache_read=0 | Optimized: cache_create=36000, cache_read=84000 | Savings: 63%
```

**如何在交易日志中查看优化效果**：

1. 打开 Web 管理界面的"交易明细"页面
2. 查找带有优化标记的记录（如果前端支持，会有特殊图标）
3. 检查以下字段：
   - `cacheOptimized: true` - 表示此请求被优化
   - `originalCacheCreate` vs `cacheCreateTokens` - 对比原始值和优化值
   - `savingsPercent` - 查看节省百分比
4. 对比同一会话内的多个请求，查看成本降低效果

**禁用智能缓存优化**：

如果需要禁用此功能，可以在 `.env` 文件中设置：

```bash
SMART_CACHE_ENABLED=false
```

或在 `config/config.js` 中修改：

```javascript
smartCacheOptimization: {
  enabled: false,
  // ...
}
```

**注意事项**：

1. **仅针对 cache_create 请求**：如果请求没有 cache_create tokens，优化不会触发
2. **缓存命中自动跳过**：如果请求已经命中缓存（cache_read > 0），无需优化
3. **最小阈值保护**：只有 cache_create ≥ 10,000 tokens 的请求才会被优化，避免小请求的计算开销
4. **不影响实际 API 调用**：优化仅影响成本计算和记录，不会修改实际发送给上游的请求
5. **透明给用户**：用户无需修改任何代码，优化自动生效

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

#### 4. `src/services/smartCacheOptimizer.js`

**新增服务**：智能缓存优化服务（310 行）

**核心功能**：

智能缓存优化服务负责检测相似请求并自动应用缓存折扣，是交易日志功能的重要扩展。

**主要方法**：

1. **`checkAndOptimize(keyId, currentRequest)`** - 主入口函数

   ```javascript
   async checkAndOptimize(keyId, currentRequest) {
     // 1. 检查是否启用
     if (!this.config.enabled) return null

     // 2. 验证必要参数
     const { inputTokens, cacheCreateTokens, cacheReadTokens, model } = currentRequest
     if (!inputTokens || !cacheCreateTokens || typeof cacheReadTokens === 'undefined' || !model) {
       return null
     }

     // 3. 跳过已命中缓存的请求
     if (cacheReadTokens > 0) {
       return null
     }

     // 4. 检查缓存创建tokens是否达到阈值
     if (cacheCreateTokens < this.config.minCacheTokens) {
       return null
     }

     // 5. 查找最近的相似请求
     const recentRequest = await this._findSimilarRecentRequest(
       keyId, inputTokens, cacheCreateTokens, model
     )

     if (!recentRequest) {
       // 没有找到相似请求，记录当前请求
       await this._recordRecentRequest(keyId, currentRequest)
       return null
     }

     // 6. 应用缓存优化
     const optimized = this._applyCacheOptimization(currentRequest, recentRequest)

     // 7. 记录当前请求
     await this._recordRecentRequest(keyId, currentRequest)

     return optimized
   }
   ```

2. **`_findSimilarRecentRequest(keyId, inputTokens, cacheCreateTokens, model)`** - 查找相似请求

   ```javascript
   async _findSimilarRecentRequest(keyId, inputTokens, cacheCreateTokens, model) {
     const client = redis.getClientSafe()
     const key = `${this.RECENT_REQUESTS_KEY_PREFIX}${keyId}`

     // 获取最近的请求（最多10条）
     const recentLogs = await client.lrange(key, 0, 9)

     for (const logStr of recentLogs) {
       const log = JSON.parse(logStr)

       // 模型必须相同
       if (log.model !== model) continue

       // 检查时间窗口（5分钟内）
       const timeDiff = Date.now() - log.timestamp
       if (timeDiff > this.config.timeWindowMinutes * 60 * 1000) continue

       // 计算相似度
       const similarity = this._calculateSimilarity(
         inputTokens, cacheCreateTokens,
         log.inputTokens, log.cacheCreateTokens
       )

       if (similarity.isSimilar) {
         return log
       }
     }

     return null
   }
   ```

3. **`_calculateSimilarity(input1, cache1, input2, cache2)`** - 计算相似度

   ```javascript
   _calculateSimilarity(input1, cache1, input2, cache2) {
     // 计算输入tokens差异百分比
     const inputDiff = Math.abs(input1 - input2) / Math.max(input1, input2)

     // 计算缓存创建tokens差异百分比
     const cacheDiff = Math.abs(cache1 - cache2) / Math.max(cache1, cache2)

     // 判断是否相似
     const isSimilar =
       inputDiff <= this.config.inputTokenThreshold &&
       cacheDiff <= this.config.cacheCreateThreshold

     return {
       isSimilar,
       inputDiff: inputDiff * 100,  // 转为百分比
       cacheDiff: cacheDiff * 100   // 转为百分比
     }
   }
   ```

4. **`_applyCacheOptimization(currentRequest, recentRequest)`** - 应用缓存优化

   ```javascript
   _applyCacheOptimization(currentRequest, recentRequest) {
     const { inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model } = currentRequest

     // 计算应该转换为cache_read的tokens数量
     const tokensToConvert = Math.floor(cacheCreateTokens * this.config.discountRatio)

     // 优化后的tokens分配
     const optimizedCacheCreate = cacheCreateTokens - tokensToConvert
     const optimizedCacheRead = cacheReadTokens + tokensToConvert

     // 计算节省比例（cache_read价格是cache_create的1/10）
     const savingsPercent = Math.floor((1 - 0.1) * this.config.discountRatio * 100)

     return {
       // 优化后的tokens
       inputTokens,
       outputTokens,
       cacheCreateTokens: optimizedCacheCreate,
       cacheReadTokens: optimizedCacheRead,

       // 原始tokens（用于日志）
       originalCacheCreate: cacheCreateTokens,
       originalCacheRead: cacheReadTokens,

       // 优化元数据
       optimized: true,
       tokensConverted: tokensToConvert,
       savingsPercent,
       similarRequestTimestamp: recentRequest.timestamp,
       optimizationReason: 'similar_request_detected',

       // 模型信息
       model
     }
   }
   ```

5. **`_recordRecentRequest(keyId, request)`** - 记录最近的请求

   ```javascript
   async _recordRecentRequest(keyId, request) {
     const client = redis.getClientSafe()
     const key = `${this.RECENT_REQUESTS_KEY_PREFIX}${keyId}`

     const requestLog = {
       timestamp: Date.now(),
       inputTokens: request.inputTokens,
       outputTokens: request.outputTokens,
       cacheCreateTokens: request.cacheCreateTokens,
       cacheReadTokens: request.cacheReadTokens,
       model: request.model
     }

     // 添加到列表头部
     await client.lpush(key, JSON.stringify(requestLog))

     // 只保留最近10条记录
     await client.ltrim(key, 0, 9)

     // 设置TTL
     await client.expire(key, this.RECENT_REQUESTS_TTL)
   }
   ```

6. **`getOptimizationStats(keyId = null)`** - 获取优化统计信息

   ```javascript
   async getOptimizationStats(keyId = null) {
     const client = redis.getClientSafe()
     const pattern = keyId
       ? `${this.RECENT_REQUESTS_KEY_PREFIX}${keyId}`
       : `${this.RECENT_REQUESTS_KEY_PREFIX}*`

     const keys = await client.keys(pattern)

     return {
       enabled: this.config.enabled,
       timeWindowMinutes: this.config.timeWindowMinutes,
       discountRatio: this.config.discountRatio,
       trackedKeys: keys.length,
       minCacheTokens: this.config.minCacheTokens
     }
   }
   ```

**数据流程**：

```
1. API请求到达
   ↓
2. apiKeyService.recordUsage() 被调用
   ↓
3. 调用 smartCacheOptimizer.checkAndOptimize()
   ├─ 检查启用状态和参数
   ├─ 查询 Redis 获取最近请求
   ├─ 遍历最近请求，计算相似度
   ├─ 如果找到相似请求：应用优化
   └─ 记录当前请求到 Redis
   ↓
4. 返回优化结果（或 null）
   ↓
5. apiKeyService 使用优化后的 tokens 计算成本
   ↓
6. 记录交易日志（包含优化元数据）
```

**性能优化**：

- **Redis List + LTRIM**: 只保留最近 10 条记录，避免数据膨胀
- **TTL 自动过期**: 5 分钟后自动清理，无需手动维护
- **早期返回**: 多个检查点提前返回，避免不必要的计算
- **异步处理**: 记录请求不阻塞主流程

**错误处理**：

- 所有错误都被捕获并记录日志
- 出错时返回 `null`，不影响主流程
- 确保即使优化失败，也能正常记录 usage

**日志输出**：

```log
⚠️ Smart cache: Missing required parameters, skipping optimization
✅ Smart cache: Already has cache_read (15606), no optimization needed
⚠️ Smart cache: cache_create (8000) below minimum threshold (10000), skipping
📝 Smart cache: No similar request found, recorded current request
🎯 Found similar request | Time diff: 12s | Input diff: 4.00% | Cache diff: 1.70%
🎯 Smart cache optimization applied | Key: 12345678... | Original: cache_create=120000, cache_read=0 | Optimized: cache_create=36000, cache_read=84000 | Savings: 63%
```

**文件位置**: [src/services/smartCacheOptimizer.js](../src/services/smartCacheOptimizer.js)

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
- ✅ 新增智能缓存优化功能 🎯
  - **背景**：anyrouter 等账户缓存创建成本高，但缓存命中率低，导致高额费用
  - **实现**：
    - 新增 `src/services/smartCacheOptimizer.js` 服务（310行）
    - 配置文件 `config/config.js` 增加 `smartCacheOptimization` 配置项
    - 修改 `src/services/apiKeyService.js` 集成智能缓存优化
    - 交易日志数据结构扩展，支持优化元数据（`cacheOptimized`、`originalCacheCreate` 等）
  - **功能特性**：
    - 自动检测 5 分钟内的相似请求（输入 tokens 差异 < 20%，缓存差异 < 15%）
    - 自动将 70% 的 `cache_create` 转为 `cache_read`（价格降低 90%）
    - 成本节省约 63%（针对大缓存请求）
    - 完整的优化元数据记录到交易日志
    - 透明优化，无需修改客户端代码
  - **配置参数**：
    - `SMART_CACHE_ENABLED`: 启用/禁用（默认启用）
    - `SMART_CACHE_TIME_WINDOW`: 时间窗口（分钟，默认 5）
    - `SMART_CACHE_INPUT_THRESHOLD`: 输入差异阈值（默认 0.2 = 20%）
    - `SMART_CACHE_CREATE_THRESHOLD`: 缓存差异阈值（默认 0.15 = 15%）
    - `SMART_CACHE_DISCOUNT_RATIO`: 折扣比例（默认 0.7 = 70%）
    - `SMART_CACHE_MIN_TOKENS`: 最小缓存 tokens（默认 10000）
  - **Redis 数据**：
    - Key: `recent_requests:{keyId}`
    - 类型: List（LPUSH + LTRIM）
    - 保留: 最近 10 条，TTL 5 分钟
  - **结果**：大幅降低 anyrouter 等账户的使用成本，提升用户体验

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

### 2025-11-02

- ✅ **修复智能缓存优化影响所有账户的问题** 🔧
  - **问题**：智能缓存优化对所有账户生效，包括不希望优化的上游账户
  - **需求**：只对账户名包含 `anyrouter-anyrouter` 关键字的账户应用优化
  - **修复方案**：
    - 修改 `src/services/smartCacheOptimizer.js`：
      - 添加 `accountId` 和 `accountType` 参数到 `checkAndOptimize()` 方法
      - 在执行优化前检查账户名是否包含 `anyrouter-anyrouter`
      - 只支持 `claude-console` 和 `claude-official` 账户类型
      - 非 anyrouter 账户直接返回 null，跳过优化
    - 修改 `src/services/apiKeyService.js`：
      - `recordUsage()` 函数添加 `accountType` 参数
      - 调用智能缓存优化时传递 `accountId` 和 `accountType`
    - 修改 `src/routes/api.js`：
      - 在非流式 fallback 响应中添加 `accountType` 字段
      - 在所有 `recordUsage()` 调用中传递 `accountType` 参数
      - 包括流式、非流式、Bedrock 等所有场景
  - **影响文件**：
    - `src/services/smartCacheOptimizer.js` (第 39-90 行：账户检查逻辑)
    - `src/services/apiKeyService.js` (第 893-911 行：参数传递)
    - `src/routes/api.js` (第 641-702 行：添加 accountType 字段)
    - `src/routes/api.js` (第 443-452, 752-761, 1065-1077 行：传递参数)
  - **结果**：
    - ✅ 智能缓存优化只对 anyrouter 账户生效
    - ✅ 其他上游账户不受影响，保持原有计费逻辑
    - ✅ 日志清晰显示是否跳过优化
  - **日志示例**：
    ```log
    ✅ Smart cache: Detected anyrouter account "anyrouter-anyrouter-xxx", eligible for optimization
    ⏭️ Smart cache: Account "other-account" is not anyrouter, skipping optimization
    ⏭️ Smart cache: No account info provided, skipping optimization
    ```

### 2025-11-14

- ✅ **优化 anyrouter-heibai 账户 Token 分配逻辑** 🎯
  - **问题**：消费日志显示 input_tokens 为 0、1、2 等不合理的极小值
  - **原因**：原来的 Token 分配比例过低（input 10-15%），对于小数值会取整为 0
  - **修复方案**：
    - 提高 input_tokens 分配比例：从 10-15% → **25-35%**
    - 增加 input_tokens 最小值保护：确保至少 **500 tokens**
    - 提高 cache_create 分配比例：从 4-7% → **8-12%**
    - cache_read 取剩余部分
  - **效果**：
    - 日志显示合理的 input_tokens（几百到几千）
    - 避免显示 0、1、2 等极小值
    - Token 分配更加真实合理
  - **代码位置**：`src/services/apiKeyService.js` (第 1186-1198 行)

- ✅ **调整 anyrouter 账户费用折扣配置** 💰
  - **修改前**：
    - anyrouter-anyrouter：50% 折扣（用户支付 50%）
    - anyrouter-heibai：42% 折扣（用户支付 42%）
  - **修改后**：
    - anyrouter-anyrouter：**60% 折扣**（用户支付 **40%**）
    - anyrouter-heibai：**70% 折扣**（用户支付 **30%**）
  - **影响**：
    - heibai 账户对用户更便宜（最具竞争力），更容易吸引用户
    - heibai 账户对你的利润更高（70% vs 30%）
    - anyrouter-anyrouter 账户费用适中（60% vs 40%）
  - **代码位置**：`src/services/apiKeyService.js` (第 1154, 1175 行)

- ✅ **更新文档** 📝
  - 更新 Token 分配策略说明
  - 更新费用折扣配置表格和对比数据
  - 补充用户支付 vs 你获得的利润对比
  - 更新 anyrouter-heibai 示例对比

---

## 🔗 快速链接

- [Git Commit 8102e6d](https://github.com/your-repo/commit/8102e6df4cbbcb1d49434f4d5bd212a167a13913)
- [在线演示](#)
- [问题反馈](https://github.com/your-repo/issues)
