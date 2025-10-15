# 🛡️ 错误处理和账户自动切换规则

## 📋 目录

- [概述](#概述)
- [错误类型和处理策略](#错误类型和处理策略)
- [连续错误检测机制](#连续错误检测机制)
- [账户状态管理](#账户状态管理)
- [自动恢复机制](#自动恢复机制)
- [配置参数](#配置参数)
- [日志示例](#日志示例)
- [故障排查](#故障排查)

---

## 概述

本系统实现了**智能错误检测和自动账户切换机制**，当上游供应商出现连续错误时，会自动禁用问题账户并切换到其他可用账户，避免请求持续失败。

### 核心特性

- ✅ **连续错误判断**：不会因单次网络抖动就禁用账户
- ✅ **滑动窗口机制**：统计最近5分钟错误，Redis 键 TTL 约 10 分钟提供缓冲
- ✅ **自动恢复**：临时禁用的账户会在6分钟后自动恢复
- ✅ **成功清零**：一旦请求成功，错误计数立即清零
- ✅ **Webhook通知**：账户异常和恢复时发送通知

---

## 错误类型和处理策略

### 1️⃣ 即时禁用错误（单次触发）

这些错误会**立即标记账户为不可用**，无需累积：

| 错误码 | 错误类型 | 处理方式 | 恢复策略 |
|--------|---------|---------|---------|
| **401** | 认证失败 | `markAccountUnauthorized()` | 手动重置或刷新凭据 |
| **403** | 权限不足/账户被封 | `markAccountBlocked()` | 仅手动恢复 |
| **403（并发超限）** | 供应商并发限制（Too many active sessions） | `markAccountTempError()` | 6分钟后自动恢复 |
| **429** | 请求频率限制 | `markAccountRateLimited()` | 自动恢复（根据 rate-limit-reset 时间）|
| **529** | 服务过载 | `markAccountOverloaded()` | 10分钟后自动恢复 |

### 2️⃣ 累积判断错误（连续触发）

这些错误需要**连续出现多次**才会禁用账户：

| 错误码 | 错误类型 | 累积阈值 | 窗口时间 | 处理方式 |
|--------|---------|---------|---------|---------|
| **500** | 内部服务器错误 | 3次 | 5分钟 | `markAccountTempError()` |
| **502** | 网关错误 | 3次 | 5分钟 | `markAccountTempError()` |
| **503** | 服务不可用 | 3次 | 5分钟 | `markAccountTempError()` |
| **504** | 网关超时 | 3次 | 5分钟 | `markAccountTempError()` |

> 🆕 当上游供应商（例如 88code）返回 `Too many active sessions` 或类似并发限制提示时，系统会先触发粘性会话并发守护：尝试在 1.2 秒封顶窗口内复用原账号；若仍满载则立刻切换账号并调用 `markAccountTempError()` 暂停该账号 6 分钟，恢复后自动清理粘性会话映射。

---

## 连续错误检测机制

### 工作原理

```
请求流程：
┌──────────────────────────────────────────────────────────────┐
│  请求 → 上游API → 返回 500 错误                                 │
│         ↓                                                     │
│  recordServerError(accountId, 500)  ← 记录到Redis             │
│         ↓                                                     │
│  Redis Key: claude_console_account:{id}:5xx_errors            │
│  Value: 1 (自动递增)                                           │
│  TTL: 600秒 (5分钟滑动窗口 + 缓冲)                                    │
│         ↓                                                     │
│  getServerErrorCount(accountId)  ← 查询当前计数               │
│         ↓                                                     │
│  errorCount >= 3 ?                                            │
│    ├─ 是 → markAccountTempError(accountId)                   │
│    │        ↓                                                 │
│    │   status = 'temp_error'                                 │
│    │   schedulable = false                                   │
│    │   设置6分钟后自动恢复定时器                                │
│    │                                                          │
│    └─ 否 → 日志记录: "⏱️ Server error count: X/3"            │
└──────────────────────────────────────────────────────────────┘
```

> ℹ️ 一旦 `errorCount` 达到 3，该账号会立即进入 `temp_error` 状态。调度器在会话粘性阶段会验证账户状态并排除 `temp_error` 账户，保障下一次重试会切换到其他可用账号。

### 关键代码位置

**Claude Console 账户服务**：
- 错误记录：[src/services/claudeConsoleAccountService.js:1349-1362](../src/services/claudeConsoleAccountService.js#L1349-L1362)
- 错误计数：[src/services/claudeConsoleAccountService.js:1365-1376](../src/services/claudeConsoleAccountService.js#L1365-L1376)
- 标记临时错误：[src/services/claudeConsoleAccountService.js:1392-1496](../src/services/claudeConsoleAccountService.js#L1392-L1496)

**中继服务错误处理**：
- 非流式错误处理：[src/services/claudeConsoleRelayService.js:459-470](../src/services/claudeConsoleRelayService.js#L459-L470)
- 流式错误处理：[src/services/claudeConsoleRelayService.js:728-733](../src/services/claudeConsoleRelayService.js#L728-L733)
- 统一错误处理方法：[src/services/claudeConsoleRelayService.js:1017-1041](../src/services/claudeConsoleRelayService.js#L1017-L1041)

**调度器过滤**：
- 会话粘性检查：[src/services/unifiedClaudeScheduler.js:736-742](../src/services/unifiedClaudeScheduler.js#L736-L742)
- 账户选择过滤：[src/services/unifiedClaudeScheduler.js:520](../src/services/unifiedClaudeScheduler.js#L520)

---

## 账户状态管理

### 账户状态定义

| 状态 | 含义 | 可调度 | 自动恢复 |
|------|-----|--------|---------|
| `active` | 正常可用 | ✅ 是 | - |
| `temp_error` | 临时错误（连续5xx） | ❌ 否 | ✅ 6分钟 |
| `rate_limited` | 请求频率限制 | ❌ 否 | ✅ 根据reset时间 |
| `overloaded` | 服务过载 (529) | ❌ 否 | ✅ 10分钟 |
| `unauthorized` | 认证失败 (401) | ❌ 否 | ⚠️ 手动或刷新token |
| `blocked` | 账户被封 (403) | ❌ 否 | ⚠️ 仅手动恢复 |
| `quota_exceeded` | 配额超限 | ❌ 否 | ⚠️ 次日UTC 0点自动重置 |

### 状态转换图

```
                     ┌─────────────────────────────────┐
                     │        active (正常)             │
                     └──────────┬──────────────────────┘
                                │
                 ┌──────────────┼──────────────┐
                 │              │              │
         [连续3次5xx]      [单次429]      [单次529]
                 ↓              ↓              ↓
         ┌──────────────┐ ┌──────────┐ ┌──────────┐
         │ temp_error   │ │rate_limit│ │overloaded│
         │ (6分钟恢复)   │ │(动态恢复) │ │(10分钟)  │
         └──────┬───────┘ └─────┬────┘ └─────┬────┘
                │               │            │
                └───────────────┴────────────┘
                                │
                         [请求成功/时间到]
                                ↓
                     ┌─────────────────────┐
                     │   active (恢复)      │
                     └─────────────────────┘
```

---

## 自动恢复机制

### temp_error 状态恢复流程

```javascript
// 1. 标记为 temp_error
markAccountTempError(accountId) {
  // 设置状态
  status = 'temp_error'
  schedulable = false
  tempErrorAt = new Date()

  // 2. 启动6分钟定时器
  setTimeout(async () => {
    // 验证确实过了5分钟（防止重复定时器）
    if (now - tempErrorAt >= 5分钟) {
      // 恢复状态
      status = 'active'
      schedulable = true

      // 清除错误计数
      clearServerErrors(accountId)

      // 发送恢复通知
      webhookNotifier.sendAccountAnomalyNotification({
        status: 'recovered',
        errorCode: 'TEMP_ERROR_RECOVERED'
      })
    }
  }, 6 * 60 * 1000)  // 6分钟
}
```

### 请求成功时的清零逻辑

```javascript
// 非流式请求成功 (200/201)
if (response.status === 200 || response.status === 201) {
  // 检查是否有错误计数
  const errorCount = await getServerErrorCount(accountId)

  if (errorCount > 0) {
    // 清除Redis中的错误计数
    await clearServerErrors(accountId)

    logger.info(`✅ Cleared ${errorCount} server error(s) after successful request`)
  }
}
```

---

## 配置参数

### 可调整参数

| 参数 | 默认值 | 位置 | 说明 |
|------|--------|-----|------|
| **错误阈值** | 3 次 | `claudeConsoleRelayService.js:1024` | 超过此值触发 temp_error |
| **错误窗口** | 5 分钟 | `claudeConsoleAccountService.js:1356` | Redis TTL，滑动窗口 |
| **自动恢复时间** | 6 分钟 | `claudeConsoleAccountService.js:1472` | temp_error 状态持续时间 |
| **过载恢复时间** | 10 分钟 | `claudeConsoleAccountService.js:851` | overloaded 状态持续时间 |
| **粘性等待开关** | true | `config/config.js` → `session.stickyConcurrency.waitEnabled` | 是否在粘性会话上限时先短暂等待 |
| **粘性等待上限** | 1200 ms | `config/config.js` → `session.stickyConcurrency.maxWaitMs` | 单次粘性守护最长等待时长 |
| **粘性轮询间隔** | 200 ms | `config/config.js` → `session.stickyConcurrency.pollIntervalMs` | 检查并发是否释放的轮询间隔 |

### 如何修改配置

#### 修改错误阈值（例如改为5次）

```javascript
// src/services/claudeConsoleRelayService.js:1024
const threshold = 5 // 原来是 3
```

#### 修改错误窗口（例如改为10分钟）

```javascript
// src/services/claudeConsoleAccountService.js:1356
await client.expire(key, 600) // 原来是 300（5分钟）
```

#### 修改自动恢复时间（例如改为3分钟）

```javascript
// src/services/claudeConsoleAccountService.js:1472
}, 3 * 60 * 1000) // 原来是 6 * 60 * 1000
```

#### 调整粘性会话等待策略

```javascript
// config/config.js
session: {
  stickyConcurrency: {
    waitEnabled: process.env.STICKY_CONCURRENCY_WAIT_ENABLED !== 'false',
    maxWaitMs: parseInt(process.env.STICKY_CONCURRENCY_MAX_WAIT_MS) || 1200,
    pollIntervalMs: parseInt(process.env.STICKY_CONCURRENCY_POLL_INTERVAL_MS) || 200
  }
}
```

```bash
# 示例：缩短等待窗口，加快切换账号
export STICKY_CONCURRENCY_WAIT_ENABLED=true
export STICKY_CONCURRENCY_MAX_WAIT_MS=800
export STICKY_CONCURRENCY_POLL_INTERVAL_MS=150
```

---

## 日志示例

### 正常场景（错误未超阈值）

```log
📝 [2025-10-08 21:02:31] INFO: 📝 Recorded 500 error for Claude Console account xxx
📝 [2025-10-08 21:02:31] WARN: ⏱️ Server error for Claude Console account xxx, error count: 1/3
📝 [2025-10-08 21:02:45] INFO: 📝 Recorded 500 error for Claude Console account xxx
📝 [2025-10-08 21:02:45] WARN: ⏱️ Server error for Claude Console account xxx, error count: 2/3
📝 [2025-10-08 21:03:00] INFO: ✅ [RESP] Status: 200 | Acc: anyrouter-me68006 | ⚡ 182ms
📝 [2025-10-08 21:03:00] INFO: ✅ Cleared 2 server error(s) for account xxx after successful request
```

### 触发 temp_error 场景

```log
📝 [2025-10-08 21:02:31] WARN: ⏱️ Server error for account xxx, error count: 1/3
📝 [2025-10-08 21:02:45] WARN: ⏱️ Server error for account xxx, error count: 2/3
📝 [2025-10-08 21:03:00] WARN: ⏱️ Server error for account xxx, error count: 3/3
📝 [2025-10-08 21:03:15] WARN: ⏱️ Server error for account xxx, error count: 4/3
📝 [2025-10-08 21:03:15] ERROR: ❌ Account xxx exceeded 5xx error threshold (4 errors), marking as temp_error
📝 [2025-10-08 21:03:15] WARN: ⚠️ Claude Console account anyrouter-me68006 (xxx) marked as temp_error and disabled for scheduling
📝 [2025-10-08 21:03:20] INFO: 🎯 Using different account: backup-account-01
📝 [2025-10-08 21:09:15] SUCCESS: ✅ Auto-recovered temp_error after 5 minutes: anyrouter-me68006 (xxx)
```

### 多账户自动切换场景

```log
📝 [21:02:31] INFO: 📤 [REQ] Key: augmunt | Acc: anyrouter-me68006 | Model: claude-sonnet-4-5
📝 [21:02:31] ERROR: ❌ [500] Account: anyrouter-me68006 | Error: 负载已达上限
📝 [21:02:31] WARN: ⏱️ Server error count: 1/3

📝 [21:02:45] INFO: 📤 [REQ] Key: augmunt | Acc: anyrouter-me68006 | Model: claude-sonnet-4-5
📝 [21:02:45] ERROR: ❌ [500] Account: anyrouter-me68006 | Error: 负载已达上限
📝 [21:02:45] WARN: ⏱️ Server error count: 2/3

📝 [21:03:00] INFO: 📤 [REQ] Key: augmunt | Acc: anyrouter-me68006 | Model: claude-sonnet-4-5
📝 [21:03:00] ERROR: ❌ [500] Account: anyrouter-me68006 | Error: 负载已达上限
📝 [21:03:00] WARN: ⏱️ Server error count: 3/3

📝 [21:03:15] INFO: 📤 [REQ] Key: augmunt | Acc: anyrouter-me68006 | Model: claude-sonnet-4-5
📝 [21:03:15] ERROR: ❌ Account exceeded threshold (4 errors), marking temp_error
📝 [21:03:15] WARN: ⚠️ Account anyrouter-me68006 disabled for scheduling

📝 [21:03:20] INFO: 🎯 API key augmunt switched to account: claude-backup-01
📝 [21:03:20] INFO: 📤 [REQ] Key: augmunt | Acc: claude-backup-01 | Model: claude-sonnet-4-5
📝 [21:03:20] INFO: ✅ [RESP] Status: 200 | Acc: claude-backup-01 | ⚡ 1245ms
```

---

## 故障排查

### 问题1: 账户一直是 temp_error 状态

**可能原因**：
- 服务重启导致定时器丢失
- 时间戳字段损坏

**解决方法**：

```bash
# 方法1: 使用Web界面手动重置账户状态
访问: http://your-server:3000/admin-next/accounts
点击账户 → "重置状态" 按钮

# 方法2: 使用Redis CLI手动恢复
redis-cli
> HSET claude_console_account:{accountId} status "active"
> HSET claude_console_account:{accountId} schedulable "true"
> HDEL claude_console_account:{accountId} errorMessage tempErrorAt tempErrorAutoStopped
> DEL claude_console_account:{accountId}:5xx_errors
```

### 问题2: 账户被频繁标记为 temp_error

**可能原因**：
- 上游供应商确实不稳定
- 阈值设置过低（默认3次）

**解决方法**：

1. 提高错误阈值：

```javascript
// src/services/claudeConsoleRelayService.js:1024
const threshold = 5 // 从3改为5
```

2. 延长错误窗口：

```javascript
// src/services/claudeConsoleAccountService.js:1356
await client.expire(key, 600) // 从300秒改为600秒（10分钟）
```

### 问题3: 错误计数没有清零

**检查步骤**：

```bash
# 1. 查看Redis中的错误计数
redis-cli
> GET claude_console_account:{accountId}:5xx_errors

# 2. 查看账户状态
> HGETALL claude_console_account:{accountId}

# 3. 手动清除错误计数
> DEL claude_console_account:{accountId}:5xx_errors
```

**查看日志**：

```bash
# 查看是否有成功请求的日志
grep "Cleared.*server error" logs/claude-relay-*.log

# 查看最近的错误记录
grep "Recorded.*error for.*account" logs/claude-relay-*.log | tail -20
```

### 问题4: 为什么我的账户状态是 temp_error 但还在被使用？

**检查项**：

1. 确认账户 `schedulable` 字段：

```bash
redis-cli HGET claude_console_account:{accountId} schedulable
# 应该返回 "false"
```

2. 检查调度器日志：

```bash
grep "not schedulable" logs/claude-relay-*.log
# 应该看到: "🚫 Claude Console account xxx is not schedulable"
```

3. 如果是专用账户（API Key绑定），则即使 temp_error 也会继续使用

---

## Redis 数据结构

### 错误计数键

```
Key:   claude_console_account:{accountId}:5xx_errors
Type:  String
Value: "4"  (错误计数)
TTL:   300 秒 (5分钟滑动窗口)
```

### 账户状态字段

```
Key:   claude_console_account:{accountId}
Type:  Hash

Fields:
  status              → "temp_error"
  schedulable         → "false"
  errorMessage        → "Account temporarily disabled due to consecutive 5xx errors"
  tempErrorAt         → "2025-10-08T13:03:15.123Z"
  tempErrorAutoStopped→ "true"
```

---

## Webhook 通知

### 账户标记为 temp_error 时

```json
{
  "accountId": "343fd9d8-45b9-4dbd-a7a4-b50dbfc285d0",
  "accountName": "anyrouter-me68006",
  "platform": "claude-console",
  "status": "temp_error",
  "errorCode": "CONSECUTIVE_5XX_ERRORS",
  "reason": "Account temporarily disabled due to consecutive 5xx errors",
  "timestamp": "2025-10-08T13:03:15.123Z"
}
```

### 账户自动恢复时

```json
{
  "accountId": "343fd9d8-45b9-4dbd-a7a4-b50dbfc285d0",
  "accountName": "anyrouter-me68006",
  "platform": "claude-console",
  "status": "recovered",
  "errorCode": "TEMP_ERROR_RECOVERED",
  "reason": "Account auto-recovered after 5 minutes from temp_error status",
  "timestamp": "2025-10-08T13:09:15.456Z"
}
```

---

## 最佳实践

### 1. 多账户部署

为确保高可用性，建议配置多个上游账户：

```
推荐配置:
- 3个以上 Claude Console 账户（不同供应商）
- 设置不同的优先级（priority: 10, 20, 30）
- 相同优先级账户会自动负载均衡
```

### 2. 监控和告警

```bash
# 设置Webhook接收端点
config/config.js:
  webhook: {
    enabled: true,
    url: 'https://your-webhook.com/alerts'
  }

# 告警建议：
- temp_error 状态 → 低优先级（会自动恢复）
- blocked 状态 → 高优先级（需要人工处理）
- 连续多个账户 temp_error → 检查网络或上游供应商
```

### 3. 定期检查

```bash
# 每天检查账户状态
npm run cli accounts list

# 查看错误率统计
grep "temp_error" logs/claude-relay-*.log | wc -l

# 检查自动恢复情况
grep "Auto-recovered" logs/claude-relay-*.log
```

---

## 相关文档

- [账户管理指南](./ACCOUNT_MANAGEMENT.md)
- [调度器配置](./SCHEDULER_CONFIG.md)
- [Webhook集成](./WEBHOOK_INTEGRATION.md)
- [故障排查完整指南](./TROUBLESHOOTING.md)

---

**文档版本**: v1.0
**最后更新**: 2025-10-08
**适用版本**: claude-relay-service v1.0.0+
