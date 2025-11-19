# Claude Console 账户并发控制机制总结

**文档版本**: 2.0
**最后更新**: 2025-01-02
**状态**: ✅ 已修复并发计数泄漏和等待机制

---

## 📚 概述

本文档详细总结 Claude Relay Service 中 **Claude Console 账户级别的并发限制机制**，包括完整的并发控制流程、资源管理、等待策略和故障恢复。

### 核心功能

- ✅ **原子性槽位抢占**: 先增加计数再检查，避免竞态条件
- ✅ **自动资源释放**: 使用 finally 块确保并发槽位在任何情况下都能释放
- ✅ **租约自动刷新**: 流式请求每5分钟刷新租约，防止长连接超时
- ✅ **智能等待机制**: 粘性会话账户满载时等待最多30秒
- ✅ **优雅降级**: 等待超时后自动切换到其他可用账户
- ✅ **防计数泄漏**: 双重保障确保并发计数准确

---

## 🏗️ 核心架构

### 系统组件

```
┌─────────────────────────────────────────────────────────────┐
│                    客户端请求                                │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              unifiedClaudeScheduler                          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  1. 选择账户（优先级、粘性会话）                     │   │
│  │  2. 检查并发限制                                     │   │
│  │  3. 等待机制（最多30秒）                             │   │
│  │  4. 超时后切换账户                                   │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│         claudeConsoleRelayService                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  🔒 原子性抢占槽位                                   │   │
│  │  ├─ incrConsoleAccountConcurrency(accountId, UUID)  │   │
│  │  ├─ 检查是否超限                                     │   │
│  │  └─ 超限则回滚 (decrConsoleAccountConcurrency)      │   │
│  │                                                       │   │
│  │  📤 执行 API 请求                                    │   │
│  │  ├─ 非流式: 直接请求                                 │   │
│  │  └─ 流式: 启动租约刷新定时器（每5分钟）              │   │
│  │                                                       │   │
│  │  🧹 finally 块: 确保资源清理                         │   │
│  │  ├─ clearInterval(leaseRefreshInterval)             │   │
│  │  └─ decrConsoleAccountConcurrency(accountId, UUID)  │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                     Redis                                    │
│  Key: concurrency:console_account:{accountId}               │
│  Type: Sorted Set (score = expireAt timestamp)              │
│  Members: {requestId} (UUID)                                │
│  TTL: 600秒 (10分钟，自动过期防泄漏)                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔄 并发控制完整流程

### 1️⃣ 非流式请求流程

**位置**: `src/services/claudeConsoleRelayService.js:relayRequest()`

```javascript
async relayRequest(...) {
  let requestId = uuidv4()           // 生成唯一请求ID
  let concurrencyAcquired = false    // 并发获取标志

  try {
    // 🔒 步骤1: 原子性抢占槽位
    if (account.maxConcurrentTasks > 0) {
      const newConcurrency = await redis.incrConsoleAccountConcurrency(
        accountId,
        requestId,
        600  // 10分钟租期
      )
      concurrencyAcquired = true

      // 🚫 步骤2: 检查是否超限
      if (newConcurrency > account.maxConcurrentTasks) {
        // 超限，立即回滚
        await redis.decrConsoleAccountConcurrency(accountId, requestId)
        concurrencyAcquired = false

        // 抛出专用错误码
        const error = new Error('Console account concurrency limit reached')
        error.code = 'CONSOLE_ACCOUNT_CONCURRENCY_FULL'
        throw error
      }

      logger.debug(`🔓 Acquired slot: ${newConcurrency}/${maxConcurrentTasks}`)
    }

    // 📤 步骤3: 执行实际请求
    const response = await axios(requestConfig)

    // ✅ 步骤4: 处理响应
    return { statusCode, headers, body, accountId }

  } catch (error) {
    // ❌ 步骤5: 错误处理
    throw error

  } finally {
    // 🧹 步骤6: 确保释放并发槽位（无论成功或失败）
    if (concurrencyAcquired && requestId && accountId) {
      try {
        await redis.decrConsoleAccountConcurrency(accountId, requestId)
        logger.debug(`🔓 Released concurrency slot: ${accountId}`)
      } catch (cleanupError) {
        logger.error(`❌ Failed to release concurrency:`, cleanupError)
      }
    }
  }
}
```

**关键设计点**:

- ✅ **先抢占再检查**: 避免并发竞争导致超限
- ✅ **超限立即回滚**: 不占用槽位
- ✅ **finally 保证释放**: 成功/失败/异常都会释放
- ✅ **防重复释放**: 使用 `concurrencyAcquired` 标志

---

### 2️⃣ 流式请求流程

**位置**: `src/services/claudeConsoleRelayService.js:relayStreamRequestWithUsageCapture()`

```javascript
async relayStreamRequestWithUsageCapture(...) {
  let requestId = uuidv4()
  let concurrencyAcquired = false
  let leaseRefreshInterval = null    // 租约刷新定时器

  try {
    // 🔒 步骤1: 原子性抢占槽位（同非流式）
    if (account.maxConcurrentTasks > 0) {
      const newConcurrency = await redis.incrConsoleAccountConcurrency(
        accountId, requestId, 600
      )
      concurrencyAcquired = true

      if (newConcurrency > account.maxConcurrentTasks) {
        await redis.decrConsoleAccountConcurrency(accountId, requestId)
        concurrencyAcquired = false
        throw new Error('Console account concurrency limit reached')
      }

      // 🔄 步骤2: 启动租约刷新定时器（流式请求特有）
      leaseRefreshInterval = setInterval(async () => {
        try {
          await redis.refreshConsoleAccountConcurrencyLease(
            accountId, requestId, 600
          )
          logger.debug(`🔄 Refreshed lease for ${accountId}`)
        } catch (refreshError) {
          logger.error(`❌ Failed to refresh lease:`, refreshError)
        }
      }, 5 * 60 * 1000)  // 每5分钟刷新一次
    }

    // 📡 步骤3: 执行流式请求
    await this._makeClaudeConsoleStreamRequest(...)

  } catch (error) {
    throw error

  } finally {
    // 🧹 步骤4: 清理租约刷新定时器
    if (leaseRefreshInterval) {
      clearInterval(leaseRefreshInterval)
      logger.debug(`🛑 Stopped lease refresh timer: ${accountId}`)
    }

    // 🧹 步骤5: 释放并发槽位
    if (concurrencyAcquired && requestId && accountId) {
      try {
        await redis.decrConsoleAccountConcurrency(accountId, requestId)
        logger.debug(`🔓 Released stream concurrency slot: ${accountId}`)
      } catch (cleanupError) {
        logger.error(`❌ Failed to release concurrency:`, cleanupError)
      }
    }
  }
}
```

**流式请求额外机制**:

- 🔄 **租约自动刷新**: 每5分钟刷新一次，防止长连接超时
- 🛑 **定时器清理**: finally 块中清理定时器资源
- ⏱️ **10分钟基础租期**: 即使刷新失败，也有10分钟自动过期保底

---

## 🕒 智能等待机制

### 等待策略

**位置**: `src/services/unifiedClaudeScheduler.js:_ensureStickyConsoleConcurrency()`

```javascript
async _ensureStickyConsoleConcurrency(accountId, sessionHash) {
  const account = await getAccount(accountId)
  const limit = account.maxConcurrentTasks

  let currentConcurrency = await redis.getConsoleAccountConcurrency(accountId)

  // ✅ 如果有空位，立即返回
  if (currentConcurrency < limit) {
    return true
  }

  // 🔍 检查配置
  const waitEnabled = config.session.stickyConcurrency.waitEnabled
  if (!waitEnabled) {
    logger.debug(`⏸️ Wait disabled, fallback immediately`)
    return false
  }

  // ⏱️ 开始等待
  const pollInterval = config.session.stickyConcurrency.pollIntervalMs || 200
  const maxWaitMs = config.session.stickyConcurrency.maxWaitMs || 1200
  const deadline = Date.now() + maxWaitMs
  let polls = 0

  while (Date.now() < deadline) {
    polls++
    await delay(pollInterval)

    currentConcurrency = await redis.getConsoleAccountConcurrency(accountId)

    // ✅ 等到空位了
    if (currentConcurrency < limit) {
      logger.info(
        `🕒 Wait succeeded: ${currentConcurrency}/${limit} after ${polls} poll(s)`
      )
      return true
    }
  }

  // ⌛ 等待超时
  logger.warn(`⌛ Still at limit after waiting ${maxWaitMs}ms`)
  return false
}
```

### 分组选择中的应用

**位置**: `src/services/unifiedClaudeScheduler.js:selectAccountFromGroup()`

```javascript
// 🔒 检查 Claude Console 账户的并发限制
if (accountType === 'claude-console' && account.maxConcurrentTasks > 0) {
  const currentConcurrency = await redis.getConsoleAccountConcurrency(account.id)

  if (currentConcurrency >= account.maxConcurrentTasks) {
    // 🕒 尝试等待并发释放（最多等待30秒）
    const canProceed = await this._ensureStickyConsoleConcurrency(
      account.id,
      sessionHash
    )

    if (!canProceed) {
      // ❌ 等待超时，跳过此账户
      logger.info(`🚫 Skipping group member ${account.name} due to concurrency limit`)
      continue
    }

    // ✅ 等待成功，继续使用此账户
    logger.info(`✅ Concurrency slot available after waiting`)
  }
}
```

### 等待机制行为

| 场景           | 并发状态   | 等待时间 | 结果                  |
| -------------- | ---------- | -------- | --------------------- |
| **立即可用**   | 0/1        | 0ms      | ✅ 立即获得槽位       |
| **短时间等待** | 1/1 → 0/1  | 5秒      | ✅ 等待5秒后获得槽位  |
| **等待成功**   | 1/1 → 0/1  | 20秒     | ✅ 等待20秒后获得槽位 |
| **等待超时**   | 1/1 (持续) | 30秒     | ⌛ 等待超时，切换账户 |
| **禁用等待**   | 1/1        | 0ms      | 🔄 立即切换账户       |

---

## 💾 Redis 数据结构

### 并发计数键结构

```
键名: concurrency:console_account:{accountId}
类型: Sorted Set (ZSET)
```

### 数据存储方式

```javascript
// 每个活跃请求存储为一个 member
// score = expireAt timestamp (当前时间 + 600秒)

ZADD concurrency:console_account:12345 1735689600000 "a7b3c4d5-e6f7-8901-2345-67890abcdef1"
ZADD concurrency:console_account:12345 1735689605000 "b8c4d5e6-f7a8-9012-3456-78901bcdef23"

// 自动清理过期成员
ZREMRANGEBYSCORE concurrency:console_account:12345 -inf {currentTimestamp}

// 获取当前并发数
ZCARD concurrency:console_account:12345  // 返回 2
```

### Redis 操作方法

| 方法                                      | 操作                     | 作用           |
| ----------------------------------------- | ------------------------ | -------------- |
| `incrConsoleAccountConcurrency()`         | ZADD + EXPIRE            | 增加并发计数   |
| `decrConsoleAccountConcurrency()`         | ZREM + ZREMRANGEBYSCORE  | 减少并发计数   |
| `getConsoleAccountConcurrency()`          | ZREMRANGEBYSCORE + ZCARD | 获取当前并发数 |
| `refreshConsoleAccountConcurrencyLease()` | EXPIRE                   | 刷新租约       |

### Lua 脚本保证原子性

```lua
-- 增加并发计数
local key = KEYS[1]
local requestId = ARGV[1]
local expireAt = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

-- 清理过期成员
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

-- 添加新请求
redis.call('ZADD', key, expireAt, requestId)

-- 设置键过期时间
redis.call('PEXPIRE', key, ttl)

-- 返回当前并发数
return redis.call('ZCARD', key)
```

---

## 📝 配置说明

### 环境变量

```bash
# 粘性会话并发等待机制
STICKY_CONCURRENCY_WAIT_ENABLED=true         # 是否启用等待（默认: true）
STICKY_CONCURRENCY_MAX_WAIT_MS=30000         # 最大等待时间（默认: 1200ms）
STICKY_CONCURRENCY_POLL_INTERVAL_MS=1000     # 轮询间隔（默认: 200ms）
```

### 配置文件 (`config/config.js`)

```javascript
session: {
  stickyTtlHours: 1,                // 粘性会话 TTL（小时）
  renewalThresholdMinutes: 0,       // 续期阈值（分钟）
  stickyConcurrency: {
    waitEnabled: process.env.STICKY_CONCURRENCY_WAIT_ENABLED !== 'false',
    maxWaitMs: parseInt(process.env.STICKY_CONCURRENCY_MAX_WAIT_MS) || 1200,
    pollIntervalMs: parseInt(process.env.STICKY_CONCURRENCY_POLL_INTERVAL_MS) || 200
  }
}
```

### 推荐配置

| 场景                 | waitEnabled | maxWaitMs | pollIntervalMs | 说明                    |
| -------------------- | ----------- | --------- | -------------- | ----------------------- |
| **生产环境（推荐）** | true        | 30000     | 1000           | 等待30秒，每秒轮询      |
| **低延迟优先**       | true        | 5000      | 500            | 等待5秒，快速轮询       |
| **立即切换**         | false       | -         | -              | 不等待，直接切换        |
| **高负载环境**       | true        | 60000     | 2000           | 等待60秒，降低Redis压力 |

---

## 🎯 关键代码位置

### 主要文件

| 文件                                        | 行号      | 功能                      |
| ------------------------------------------- | --------- | ------------------------- |
| `src/services/claudeConsoleRelayService.js` | 178-753   | 非流式请求处理 + 并发控制 |
| `src/services/claudeConsoleRelayService.js` | 755-923   | 流式请求处理 + 租约刷新   |
| `src/services/unifiedClaudeScheduler.js`    | 832-894   | 等待机制实现              |
| `src/services/unifiedClaudeScheduler.js`    | 1529-1548 | 分组选择中的等待          |
| `src/models/redis.js`                       | 1630-1808 | Redis 并发操作封装        |

### 关键方法

```javascript
// 1. 并发控制入口
claudeConsoleRelayService.relayRequest()
claudeConsoleRelayService.relayStreamRequestWithUsageCapture()

// 2. 等待机制
unifiedClaudeScheduler._ensureStickyConsoleConcurrency()

// 3. Redis 操作
redis.incrConsoleAccountConcurrency(accountId, requestId, leaseSeconds)
redis.decrConsoleAccountConcurrency(accountId, requestId)
redis.getConsoleAccountConcurrency(accountId)
redis.refreshConsoleAccountConcurrencyLease(accountId, requestId, leaseSeconds)
```

---

## 🐛 故障排查

### 问题1: 并发计数不准确

**症状**: 日志显示并发数与实际不符

**排查步骤**:

```bash
# 1. 连接 Redis
redis-cli

# 2. 查看特定账户的并发请求
KEYS concurrency:console_account:*

# 3. 查看详细信息
ZRANGE concurrency:console_account:12345 0 -1 WITHSCORES

# 4. 检查过期成员
ZREMRANGEBYSCORE concurrency:console_account:12345 -inf {currentTimestamp}
ZCARD concurrency:console_account:12345
```

**可能原因**:

- ❌ Redis 连接异常导致释放失败
- ❌ 程序崩溃且 finally 块未执行（极少）
- ✅ 租期过期自动清理（正常）

**解决方案**:

- ✅ 系统会在10分钟后自动清理过期计数
- 🔧 重启服务会触发启动时清理
- 🛠️ 手动清理: `redis-cli DEL concurrency:console_account:{accountId}`

### 问题2: 等待机制不工作

**症状**: 遇到并发满载立即失败，没有等待

**排查步骤**:

```bash
# 1. 检查配置
echo $STICKY_CONCURRENCY_WAIT_ENABLED
echo $STICKY_CONCURRENCY_MAX_WAIT_MS

# 2. 查看日志
grep "Wait disabled" logs/claude-relay-*.log
grep "Sticky concurrency wait" logs/claude-relay-*.log
```

**可能原因**:

- ❌ `STICKY_CONCURRENCY_WAIT_ENABLED=false`
- ❌ 等待时间配置为0
- ❌ 不是分组选择场景（普通池选择不等待）

**解决方案**:

```bash
# 启用等待机制
export STICKY_CONCURRENCY_WAIT_ENABLED=true
export STICKY_CONCURRENCY_MAX_WAIT_MS=30000
```

### 问题3: 流式请求租约过期

**症状**: 长时间流式请求后并发槽位被自动释放

**排查步骤**:

```bash
# 查看租约刷新日志
grep "Refreshed concurrency lease" logs/claude-relay-*.log
grep "Failed to refresh concurrency lease" logs/claude-relay-*.log
```

**可能原因**:

- ❌ 定时器被意外清理
- ❌ Redis 连接异常
- ✅ 请求时间超过 10 分钟且刷新失败

**解决方案**:

- ✅ 系统每5分钟自动刷新（默认行为）
- 🔧 检查 Redis 连接稳定性
- 📊 监控刷新失败日志

### 问题4: 频繁出现并发超限错误

**症状**: 日志中大量 `CONSOLE_ACCOUNT_CONCURRENCY_FULL` 错误

**排查步骤**:

```bash
# 1. 统计并发超限次数
grep "CONSOLE_ACCOUNT_CONCURRENCY_FULL" logs/claude-relay-*.log | wc -l

# 2. 查看账户并发配置
# 通过 Web 界面查看账户的 maxConcurrentTasks 设置

# 3. 查看实际并发峰值
redis-cli ZCARD concurrency:console_account:{accountId}
```

**可能原因**:

- ❌ 并发限制设置过低
- ❌ 请求量突增
- ❌ 账户数量不足

**解决方案**:

- 📈 增加 `maxConcurrentTasks` 值（推荐: 3-5）
- ➕ 添加更多 Console 账户
- 🎯 配置账户分组，分散流量

---

## 📊 日志示例

### 正常流程日志

```
[2025-01-02 10:00:00] INFO: 📤 Processing Console request, account: MyAccount (12345), request: abc-123
[2025-01-02 10:00:00] DEBUG: 🔓 Acquired concurrency slot: 2/3
[2025-01-02 10:00:05] INFO: ✅ [RESP] Status: 200 | Acc: MyAccount | ⚡ 4500ms
[2025-01-02 10:00:05] DEBUG: 🔓 Released concurrency slot for account 12345
```

### 并发超限 + 等待成功

```
[2025-01-02 10:00:00] INFO: 📤 Processing request, account: MyAccount (12345), request: abc-123
[2025-01-02 10:00:00] INFO: 🚫 Skipping group member MyAccount due to concurrency limit: 3/3
[2025-01-02 10:00:00] INFO: 🕒 Sticky concurrency wait: polling... (1/30)
[2025-01-02 10:00:01] INFO: 🕒 Sticky concurrency wait: polling... (2/30)
[2025-01-02 10:00:05] INFO: 🕒 Wait succeeded: 2/3 after 5 poll(s)
[2025-01-02 10:00:05] INFO: ✅ Concurrency slot available after waiting for group member MyAccount
[2025-01-02 10:00:05] DEBUG: 🔓 Acquired concurrency slot: 3/3
```

### 等待超时 + 切换账户

```
[2025-01-02 10:00:00] INFO: 🕒 Sticky concurrency wait: polling... (1/30)
...
[2025-01-02 10:00:30] WARN: ⌛ Still at limit (3/3) after waiting 30000ms
[2025-01-02 10:00:30] INFO: 🔄 Deleted sticky session mapping
[2025-01-02 10:00:30] INFO: 🎯 Selected new account: BackupAccount
```

### 租约刷新日志（流式）

```
[2025-01-02 10:00:00] DEBUG: 🔓 Acquired concurrency slot for stream: 2/3
[2025-01-02 10:05:00] DEBUG: 🔄 Refreshed concurrency lease for stream account MyAccount
[2025-01-02 10:10:00] DEBUG: 🔄 Refreshed concurrency lease for stream account MyAccount
[2025-01-02 10:12:00] DEBUG: 🛑 Stopped lease refresh timer for account 12345
[2025-01-02 10:12:00] DEBUG: 🔓 Released stream concurrency slot for account 12345
```

---

## ✅ 最佳实践

### 1. 并发限制配置

```javascript
// 个人账户（推荐）
maxConcurrentTasks: 3

// 团队账户
maxConcurrentTasks: 5

// 企业账户
maxConcurrentTasks: 10

// 测试环境
maxConcurrentTasks: 1
```

### 2. 等待机制配置

```bash
# 生产环境（推荐）
STICKY_CONCURRENCY_WAIT_ENABLED=true
STICKY_CONCURRENCY_MAX_WAIT_MS=30000
STICKY_CONCURRENCY_POLL_INTERVAL_MS=1000
```

### 3. 监控指标

- 📊 **并发使用率**: `currentConcurrency / maxConcurrentTasks`
- ⏱️ **等待成功率**: 成功等到槽位的请求比例
- ⌛ **平均等待时间**: 等待机制的平均耗时
- 🔄 **账户切换率**: 因并发超限切换账户的频率
- 🧹 **计数泄漏检测**: Redis 中过期但未清理的计数

### 4. 性能优化建议

- ✅ 使用 Redis Sorted Set 而非 KEYS（已实现）
- ✅ Lua 脚本保证原子性（已实现）
- ✅ 租约自动过期防泄漏（已实现）
- 🔧 根据负载调整轮询间隔
- 📈 监控 Redis 性能指标

---

## 🎓 总结

### 核心机制

1. **原子性抢占**: 先增加计数再检查，避免竞态
2. **超限回滚**: 检测到超限立即释放槽位
3. **自动释放**: finally 块确保资源清理
4. **租约刷新**: 流式请求每5分钟刷新租约
5. **智能等待**: 粘性会话满载时等待最多30秒
6. **优雅降级**: 等待超时后自动切换账户
7. **防计数泄漏**: 10分钟自动过期 + 双重清理

### 数据流

```
请求 → 调度器选择账户 → 检查并发
  ↓
并发未满 → 抢占槽位 → 执行请求 → 释放槽位 → 返回
  ↓
并发已满 → 等待30秒
  ↓
等待成功 → 抢占槽位 → 执行请求 → 释放槽位 → 返回
  ↓
等待超时 → 切换账户 → 重新检查 → ...
```

### 关键优势

- ✅ **零泄漏**: finally + 自动过期双重保障
- ✅ **高可用**: 等待机制 + 自动降级
- ✅ **上下文保持**: 粘性会话尽可能使用相同账户
- ✅ **性能优化**: Lua 脚本 + Sorted Set
- ✅ **可观测性**: 详细日志 + Redis 可查询

---

**文档维护**: Claude Relay Service Team
**问题反馈**: GitHub Issues
**相关文档**: [account-concurrency-limit.md](./account-concurrency-limit.md)
