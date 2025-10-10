# 慢速响应监控机制说明

> ⚠️ **重要更新（2025-01-10 v2.0）**：
>
> 慢速响应降级机制已**重大优化**。**成功响应不再自动触发降级**，仅记录超长响应（>60秒）用于监控。
>
> **设计理念**：慢但成功 ≠ 有问题。可能是正常的复杂请求（大上下文、Prompt Caching首次缓存、复杂推理等）。
>
> 管理员可通过 Web 管理界面或 CLI 工具手动调整账户优先级。

---

## 📋 概述

本文档说明了 Claude Relay Service 中的账户慢速响应监控机制。该机制记录超长响应时间用于监控分析，同时保留手动调整优先级的能力，避免误判正常的复杂请求。

---

## 🎯 设计目标

1. **监控超长响应**：记录响应时间 >60秒 的请求，用于性能分析
2. **避免自动惩罚**：成功响应不因慢而被降级（可能是正常的复杂任务）
3. **保留手动控制**：管理员可通过 Web 界面或 CLI 手动调整账户优先级
4. **依赖错误处理**：真正的性能问题由 5xx/429/529 错误机制自动处理
5. **逻辑一致性**：与"成功清除错误计数"的行为保持一致

---

## 📊 三种场景详解

### 场景 A：客户端提前断开（不降级）❌

#### 触发条件

- 客户端在上游响应前断开连接
- 等待延迟取消时间（默认 180 秒）后上游仍未响应

#### 行为

```
客户端请求 → 客户端断开（15秒） → 等待上游响应（180秒） → 超时取消 → ❌ 不降级
```

#### 原因分析

这种情况**不是上游的错**，可能是：

- 网络波动导致客户端断开
- 客户端超时设置太短（如 Claude Code 默认 10-15 秒）
- 用户手动取消请求
- 上游正在处理大型请求（如大量 prompt caching）

#### 日志示例

```log
🔌 Client disconnected after 14739ms, waiting 180000ms for upstream response
⏰ Upstream timeout after 194839ms (waited 180000ms after client disconnect), aborting request
ℹ️ Not marking account as slow - client disconnected before upstream could respond
```

#### 代码位置

`src/services/claudeConsoleRelayService.js:257-272`

```javascript
setTimeout(() => {
  if (abortController && !abortController.signal.aborted) {
    const totalWaitTime = Date.now() - requestStartTime
    logger.warn(
      `⏰ Upstream timeout after ${totalWaitTime}ms (waited ${waitTime}ms after client disconnect), aborting request | Acc: ${account.name}`
    )

    // ⚠️ 不降级：这是客户端提前断开导致的，不是上游慢
    logger.info(
      `ℹ️ Not marking account as slow - client disconnected before upstream could respond | Acc: ${account.name}`
    )

    abortController.abort()
  }
}, waitTime)
```

---

### 场景 B：上游真的慢（仅记录日志）📊

#### 触发条件

- 客户端保持连接
- 上游响应时间超过 **60 秒**
- 请求成功返回

#### 行为

```
客户端请求 → 上游响应（70秒） → 返回结果 → 📊 记录日志，不降级
```

#### 监控机制

1. **仅记录日志**：响应时间 >60秒 时记录到日志，用于监控分析
2. **不自动降级**：成功响应不因慢而被惩罚
3. **保留数据结构**：Redis Sorted Set 结构保留，供手动标记使用

#### 日志示例

```log
✅ [RESP] Status: 200 | Acc: anyrouter-augmunt1 | 🐌 70000ms
🐌 Very slow response: 70000ms | Acc: anyrouter-augmunt1 | 请求成功，仅记录用于监控
```

#### 代码位置

`src/services/claudeConsoleRelayService.js:500-507`

```javascript
// 📊 记录超慢响应用于监控（>60秒），但不自动降级
// 原因：慢但成功的请求可能是正常的复杂任务
if (upstreamDuration > 60000) {
  logger.info(
    `🐌 Very slow response: ${upstreamDuration}ms | Acc: ${account.name} | 请求成功，仅记录用于监控`
  )
}
```

#### 手动调整优先级

如需降低慢速账户的优先级，管理员可通过以下方式手动操作：

1. **Web 管理界面**：
   - 访问：`/admin-next/accounts`
   - 点击账户 → "编辑" → 修改优先级字段

2. **CLI 工具**：

   ```bash
   npm run cli accounts update -- --id <accountId> --priority 70
   ```

3. **Redis 直接修改**：

   ```bash
   redis-cli HSET claude_console_account:{accountId} priority 70
   ```

4. **手动调用 API 方法**：
   ```javascript
   // 仅供管理脚本使用
   await claudeConsoleAccountService.markAccountSlow(accountId, responseTime)
   ```

#### Redis 数据结构（保留供手动使用）

```
键名：claude_console_account:{accountId}:slow_responses
类型：Sorted Set (ZSET)
成员：{timestamp}:{responseTime}
分数：timestamp
TTL：2 小时
用途：供手动标记时记录慢响应历史
```

---

### ~~场景 C：响应快速（恢复）~~ ❌ 已移除

**此场景已在 v2.0 中移除**

由于不再自动降级，因此也不需要自动恢复优先级。

如需恢复账户优先级，请使用场景 B 中的手动调整方法。

---

## ⚙️ 配置参数

### 延迟取消配置（保持不变）

```javascript
// config/config.js:77-84
upstreamWaitAfterClientDisconnect: {
  nonStream: 180000,  // 非流式请求等待时间（毫秒）
  stream: 180000,     // 流式请求等待时间（毫秒）
  enabled: true       // 是否启用延迟取消
}
```

### 环境变量（保持不变）

```bash
# .env
UPSTREAM_WAIT_NON_STREAM=180000  # 默认 180 秒
UPSTREAM_WAIT_STREAM=180000      # 默认 180 秒
UPSTREAM_WAIT_ENABLED=true       # 默认启用
```

### 慢速监控阈值（v2.0 更新）

```javascript
// 超慢响应日志阈值：60 秒（仅记录，不降级）
if (upstreamDuration > 60000) {
  /* 记录日志用于监控 */
}
```

### 已移除的配置（v2.0）

```javascript
// ❌ 已移除：慢响应降级阈值（原 20 秒）
// ❌ 已移除：快速响应恢复阈值（原 10 秒）
// 原因：不再自动降级/恢复，改为手动控制
```

---

## 🔧 相关代码文件

### 核心服务文件

1. **claudeConsoleRelayService.js**
   - 路径：`src/services/claudeConsoleRelayService.js`
   - 功能：处理请求转发、客户端断开检测、响应时间统计

2. **claudeConsoleAccountService.js**
   - 路径：`src/services/claudeConsoleAccountService.js`
   - 功能：账户管理、慢响应记录、优先级调整

### 关键方法

#### markAccountSlow(accountId, responseTime)

- 位置：`src/services/claudeConsoleAccountService.js:730-797`
- 功能：记录慢响应并降低账户优先级
- Redis 操作：

  ```javascript
  // 添加慢响应记录
  await client.zadd(slowKey, now, `${now}:${responseTime}`)

  // 清理 1 小时前的记录
  await client.zremrangebyscore(slowKey, '-inf', oneHourAgo)

  // 计算新优先级
  const slowCount = await client.zcard(slowKey)
  const newPriority = Math.min(90, basePriority + Math.floor(slowCount / 2) * 10)

  // 更新账户优先级
  await client.hset(accountKey, 'priority', newPriority.toString())
  ```

#### restoreAccountPriority(accountId)

- 位置：`src/services/claudeConsoleAccountService.js:800-837`
- 功能：检查慢响应次数，符合条件时恢复优先级到 50
- 恢复条件：
  ```javascript
  const slowCount = await client.zcard(slowKey)
  if (slowCount < 2 && currentPriority > 50) {
    // 恢复到默认优先级 50
    await client.hset(accountKey, 'priority', '50')
  }
  ```

---

## 🛠️ 故障排除

### 问题 1：账户被误判为慢速

#### 症状

```log
⚠️ Account priority lowered: 50 → 90 (14 slow responses/hour)
```

但上游实际响应时间很快（<10秒）

#### 原因

- 延迟取消配置未启用（`enabled: false`）
- 客户端断开被误判为慢响应

#### 解决方案

1. 检查配置：

   ```bash
   grep "UPSTREAM_WAIT_ENABLED" .env
   grep -A 5 "upstreamWaitAfterClientDisconnect" config/config.js
   ```

2. 确保启用延迟取消：

   ```javascript
   // config/config.js
   upstreamWaitAfterClientDisconnect: {
     enabled: true // 必须为 true
   }
   ```

3. 清理误判的慢响应记录：
   ```bash
   redis-cli KEYS "claude_console_account:*:slow_responses" | xargs redis-cli DEL
   redis-cli HSET claude_console_account:{accountId} priority 50
   ```

### 问题 2：Redis 键类型错误

#### 症状

```log
❌ WRONGTYPE Operation against a key holding the wrong kind of value
```

#### 原因

- `getAllAccounts()` 方法会扫描所有 `claude_console_account:*` 键
- 误将 `slow_responses` (ZSET) 当作账户数据 (HASH) 读取

#### 解决方案

已修复（2025-01-09）：

```javascript
// src/services/claudeConsoleAccountService.js:145-148
for (const key of keys) {
  // 跳过非账户键（如 slow_responses、temp_error 等辅助数据）
  if (key.includes(':slow_responses') || key.includes(':temp_error')) {
    continue
  }
  // ... 读取账户数据
}
```

### 问题 3：查看账户慢响应记录

#### 查询命令

```bash
# 查看所有慢响应键
redis-cli KEYS "claude_console_account:*:slow_responses"

# 查看某个账户的慢响应数量
redis-cli ZCARD "claude_console_account:{accountId}:slow_responses"

# 查看某个账户的慢响应详细记录
redis-cli ZRANGE "claude_console_account:{accountId}:slow_responses" 0 -1 WITHSCORES

# 查看账户当前优先级
redis-cli HGET "claude_console_account:{accountId}" priority
```

#### 手动清理

```bash
# 清理所有慢响应记录
redis-cli KEYS "claude_console_account:*:slow_responses" | xargs redis-cli DEL

# 恢复所有账户优先级到 50
redis-cli KEYS "claude_console_account:*" | while read key; do
  if [[ ! "$key" =~ ":slow_responses" ]]; then
    redis-cli HSET "$key" priority 50
  fi
done
```

---

## 📈 监控和日志

### 关键日志标识符

#### 慢速降级相关

```log
🐌 Recorded slow response for account {name}: {time}ms ({count} slow responses in last hour)
⚠️ Account {name} priority lowered: {old} → {new} ({count} slow responses/hour)
```

#### 优先级恢复相关

```log
✅ Restored account priority: {name} ({old} → 50)
```

#### 客户端断开相关

```log
🔌 Client disconnected after {time}ms, waiting {wait}ms for upstream response
⏰ Upstream timeout after {total}ms (waited {wait}ms after client disconnect), aborting request
ℹ️ Not marking account as slow - client disconnected before upstream could respond
```

#### 响应时间标识

```log
⚡ - 快速响应 (<5秒)
⏱️ - 中速响应 (5-10秒)
🐌 - 慢速响应 (>10秒)
```

---

## 🔄 版本历史

### v2.0 (2025-01-10) ⭐ 重大优化

**核心改进**：

- ✅ **移除自动慢速降级**：成功响应（200/201）不再因慢而被自动惩罚
- ✅ **逻辑一致性**：与"成功清除错误计数"行为保持一致
- ✅ **避免误判**：不再误判正常的复杂请求（大上下文、Prompt Caching首次缓存、复杂推理等）
- ✅ **保留监控**：超慢响应（>60秒）仍记录日志用于性能分析
- ✅ **手动控制**：管理员可通过 Web 界面/CLI 手动调整账户优先级
- ✅ **依赖错误处理**：完全依赖成熟的 5xx/429/529 错误机制处理真正的问题

**设计理念**：

> 慢但成功 ≠ 有问题。系统应该信任上游的成功响应，不应该因为处理时间长而惩罚账户。
> 真正的性能问题会通过错误状态（5xx/429/529）被自动检测和处理。

**具体修改**：

- 修改 `claudeConsoleRelayService.js:500-507` - 移除自动调用 `markAccountSlow()` 和 `restoreAccountPriority()`
- 修改 `claudeConsoleAccountService.js:751,828` - 为方法添加注释，说明仅供手动调用
- 更新 `docs/slow-response-logic.md` - 完整更新文档说明新逻辑

---

### v1.1 (2025-01-09)

- ✅ 修复：客户端断开不再触发慢速降级
- ✅ 修复：`getAllAccounts()` 跳过 `slow_responses` 键，避免 Redis 类型错误
- ✅ 优化：增加详细日志说明降级/恢复原因

### v1.0 (初始版本)

- ✅ 实现慢速响应检测和优先级调整
- ✅ 实现延迟取消机制
- ✅ 实现自动恢复快速账户优先级

---

## 📚 相关文档

- [CLAUDE.md](../CLAUDE.md) - 项目完整文档
- [config.example.js](../config/config.example.js) - 配置示例
- [unifiedClaudeScheduler.js](../src/services/unifiedClaudeScheduler.js) - 账户调度器

---

## 💡 最佳实践

1. **合理设置延迟取消时间**
   - 对于大型 prompt caching 请求，建议设置 180-300 秒
   - 对于普通请求，120 秒通常足够

2. **定期检查慢响应记录**
   - 使用 Redis 命令查看慢响应统计
   - 识别真正慢的上游账户

3. **客户端超时设置**
   - 建议客户端超时时间 > 延迟取消时间
   - 避免客户端提前断开导致资源浪费

4. **监控账户优先级**
   - 通过 Web 界面或 CLI 工具查看账户优先级
   - 及时发现和处理性能问题

---

**最后更新：2025-01-10（v2.0 重大优化）**
