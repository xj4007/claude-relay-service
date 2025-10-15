# Claude Console 账户并发控制分析报告

## 📊 当前实现分析

### ✅ 已实现的功能

#### 1. 非流式请求的并发控制（完善）
**文件**: `src/services/claudeConsoleRelayService.js:171-626`

```javascript
// 并发控制流程
1. 检查账户的 accountConcurrencyLimit 配置
2. 如果 > 0，生成唯一的 requestId
3. 调用 incrAccountConcurrency() 增加计数
4. 如果超过限制，立即减少计数并抛出错误
5. 正常处理完成后，在 finally 块中调用 decrAccountConcurrency()
```

**优点**：
- ✅ 使用 `finally` 块确保无论成功或失败都会清理
- ✅ 客户端断开也会触发清理
- ✅ 有 10 分钟的租期作为兜底保护

#### 2. Redis 并发计数实现
**文件**: `src/services/claudeConsoleAccountService.js:1529-1562`

```javascript
// 并发计数机制
- Key 格式: account_concurrency:console:{accountId}:{requestId}
- 使用 SET EX 命令，自动过期（默认 600 秒）
- 通过 KEYS 命令统计当前并发数
```

**优点**：
- ✅ 简单直观
- ✅ 自动过期清理（防止永久泄漏）
- ✅ 支持租期续约

### ⚠️ 发现的问题

#### ✅ 已解决：流式请求并发控制

**位置**: `src/services/claudeConsoleRelayService.js:629-759`

**更新时间**: 2025年1月

**问题描述**（已解决）：
流式请求函数 `relayStreamRequestWithUsageCapture()` 之前缺少并发控制逻辑。

**解决方案**：
已添加完整的并发控制逻辑，现在流式请求与非流式请求保持一致：

```javascript
// 当前代码（已添加并发控制）
async relayStreamRequestWithUsageCapture(...) {
  let requestId = null
  let concurrencyIncremented = false

  const cleanupConcurrency = async () => {
    if (concurrencyIncremented && requestId && accountId) {
      await claudeConsoleAccountService.decrAccountConcurrency(accountId, requestId)
    }
  }

  try {
    // ✅ 检查并发限制
    if (account.accountConcurrencyLimit > 0) {
      requestId = uuidv4()
      const currentConcurrency = await incrAccountConcurrency(accountId, requestId)
      concurrencyIncremented = true

      if (currentConcurrency > account.accountConcurrencyLimit) {
        await cleanupConcurrency()
        throw new Error(`Concurrency limit exceeded: ${currentConcurrency}/${limit}`)
      }
    }

    // 发送流式请求
    await this._makeClaudeConsoleStreamRequest(...)
  } catch (error) {
    throw error
  } finally {
    // ✅ 确保清理并发计数
    await cleanupConcurrency()
  }
}
```

**改进效果**：
- ✅ 流式请求现在受并发限制
- ✅ `accountConcurrencyLimit` 配置对所有请求类型生效
- ✅ 防止账户超载
- ✅ 使用 `finally` 块确保资源清理
- ✅ 客户端断开也会触发清理

#### ✅ 已优化：SCAN 命令替代 KEYS

**位置**: `src/services/claudeConsoleAccountService.js:1549-1564`

**优化前**：
```javascript
async getAccountConcurrency(accountId) {
  const keys = await client.keys(`${key}:*`)  // ❌ KEYS 命令阻塞 Redis
  return keys.length
}
```

**优化后**：
```javascript
async getAccountConcurrency(accountId) {
  const pattern = `${this.ACCOUNT_CONCURRENCY_PREFIX}${accountId}:*`
  let cursor = '0'
  let count = 0

  // 使用 SCAN 命令避免阻塞 Redis
  do {
    const reply = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = reply[0]
    count += reply[1].length
  } while (cursor !== '0')

  return count
}
```

**优化效果**：
- ✅ 不再阻塞 Redis（生产环境安全）
- ✅ 高并发场景下性能更好
- ✅ 游标迭代，内存占用更低

#### ✅ 新增：粘性会话并发守护（2025-10）

- 位置：`src/services/unifiedClaudeScheduler.js`
- 作用：同一会话复用 Console 账号前先确认并发余量
  - 若已满并且守护开启，则按照 `session.stickyConcurrency.pollIntervalMs` 轮询
  - 最长等待 `session.stickyConcurrency.maxWaitMs`，期间一旦释放并发即继续复用
  - 超时仍满载时会清理粘性映射并切换到其他可用账号
- 配置入口：`config/config.js` → `session.stickyConcurrency`

```javascript
session: {
  stickyTtlHours: 1,
  renewalThresholdMinutes: 0,
  stickyConcurrency: {
    waitEnabled: process.env.STICKY_CONCURRENCY_WAIT_ENABLED !== 'false',
    maxWaitMs: parseInt(process.env.STICKY_CONCURRENCY_MAX_WAIT_MS) || 1200,
    pollIntervalMs: parseInt(process.env.STICKY_CONCURRENCY_POLL_INTERVAL_MS) || 200
  }
}
```

> ℹ️ 流式请求建议保留默认 200ms 轮询 + 1.2s 总等待，既能复用上下文又能在阻塞时快速切换账号。

---

## 🔍 Redis 查询和管理命令

### 1️⃣ 查询账户并发配置

```bash
# 查看账户的并发限制配置
redis-cli
HGET claude_console_account:cac9a880-53ae-4143-9cb9-428357cb6e9d accountConcurrencyLimit
# 输出：2
```

### 2️⃣ 查询账户当前并发数

```bash
# 方法1：查看所有并发请求的键
KEYS account_concurrency:console:cac9a880-53ae-4143-9cb9-428357cb6e9d:*

# 示例输出（表示当前有 2 个并发请求）：
# 1) "account_concurrency:console:cac9a880-53ae-4143-9cb9-428357cb6e9d:abc123-uuid1"
# 2) "account_concurrency:console:cac9a880-53ae-4143-9cb9-428357cb6e9d:def456-uuid2"

# 方法2：统计数量
redis-cli --raw keys "account_concurrency:console:cac9a880-53ae-4143-9cb9-428357cb6e9d:*" | wc -l
```

### 3️⃣ 查看具体请求的剩余时间（TTL）

```bash
# 查看某个请求键的剩余过期时间（秒）
TTL account_concurrency:console:cac9a880-53ae-4143-9cb9-428357cb6e9d:abc123-uuid1
# 输出：587  （还剩 587 秒过期）
```

### 4️⃣ 手动清理并发计数（紧急情况）

#### 场景1：清理特定账户的所有并发计数

```bash
# ⚠️ 谨慎操作！会清除该账户的所有并发记录

# 方法1：逐个删除（推荐，更安全）
redis-cli --scan --pattern "account_concurrency:console:cac9a880-53ae-4143-9cb9-428357cb6e9d:*" | xargs redis-cli del

# 方法2：Lua 脚本批量删除（更快）
redis-cli --eval cleanup.lua 0 "account_concurrency:console:cac9a880-53ae-4143-9cb9-428357cb6e9d"
```

**cleanup.lua 脚本内容**：
```lua
local pattern = ARGV[1] .. ":*"
local cursor = "0"
local deleted = 0

repeat
    local result = redis.call("SCAN", cursor, "MATCH", pattern, "COUNT", 100)
    cursor = result[1]
    local keys = result[2]

    for i, key in ipairs(keys) do
        redis.call("DEL", key)
        deleted = deleted + 1
    end
until cursor == "0"

return deleted
```

#### 场景2：清理单个请求的并发计数

```bash
# 删除特定的 requestId
DEL account_concurrency:console:cac9a880-53ae-4143-9cb9-428357cb6e9d:abc123-uuid1
```

#### 场景3：清理所有 Console 账户的并发计数

```bash
# ⚠️⚠️⚠️ 极度危险！仅在系统维护时使用

# 删除所有 Console 账户的并发计数
redis-cli --scan --pattern "account_concurrency:console:*" | xargs redis-cli del
```

### 5️⃣ 监控并发情况（实时）

```bash
# 实时监控 Redis 命令（查看并发操作）
redis-cli monitor | grep "account_concurrency:console"

# 或者每秒统计一次
while true; do
  echo "当前时间: $(date)"
  redis-cli keys "account_concurrency:console:*" | wc -l
  sleep 1
done
```

### 6️⃣ 查询所有账户的并发情况（批量）

```bash
#!/bin/bash
# 脚本：check-all-concurrency.sh

# 获取所有 Claude Console 账户
account_ids=$(redis-cli keys "claude_console_account:*" | grep -v ":slow_responses\|:5xx_errors\|:temp_error" | sed 's/claude_console_account://')

for account_id in $account_ids; do
  # 获取账户名称
  name=$(redis-cli hget "claude_console_account:$account_id" name)

  # 获取并发限制
  limit=$(redis-cli hget "claude_console_account:$account_id" accountConcurrencyLimit)

  # 统计当前并发数
  current=$(redis-cli keys "account_concurrency:console:$account_id:*" | wc -l)

  if [ "$current" -gt 0 ]; then
    echo "账户: $name | 限制: $limit | 当前: $current"
  fi
done
```

---

## 🛠️ 常见问题处理

### 问题1：并发计数没有正确减少

**原因**：
1. 服务异常崩溃，finally 块未执行
2. 流式请求没有并发控制（当前bug）
3. Redis 连接失败，decr 操作失败

**解决方案**：
```bash
# 等待 10 分钟让 TTL 自动清理
# 或手动清理（见上面的命令）

# 检查哪些请求已经超时（应该被清理但还存在）
redis-cli --scan --pattern "account_concurrency:console:*" | while read key; do
  ttl=$(redis-cli ttl "$key")
  if [ "$ttl" -lt 60 ]; then
    echo "即将过期: $key (剩余 ${ttl}秒)"
  fi
done
```

### 问题2：账户一直显示满载

**诊断步骤**：
```bash
# 1. 查看实际并发数
redis-cli keys "account_concurrency:console:账户ID:*"

# 2. 查看每个请求的 TTL
for key in $(redis-cli keys "account_concurrency:console:账户ID:*"); do
  echo "$key: $(redis-cli ttl $key)秒"
done

# 3. 如果所有请求 TTL 都很长且没有实际流量，说明有泄漏
# 手动清理
redis-cli del $(redis-cli keys "account_concurrency:console:账户ID:*")
```

### 问题3：需要临时提高并发限制

```bash
# 临时修改（重启后失效）
redis-cli hset claude_console_account:账户ID accountConcurrencyLimit 10

# 或通过 Web 界面修改（永久生效）
```

---

## 📋 推荐的监控脚本

### 创建监控脚本

```bash
#!/bin/bash
# monitor-concurrency.sh

echo "=== Claude Console 账户并发监控 ==="
echo "按 Ctrl+C 退出"
echo ""

while true; do
  clear
  echo "更新时间: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # 统计总并发
  total_concurrency=$(redis-cli keys "account_concurrency:console:*" | wc -l)
  echo "📊 总并发请求数: $total_concurrency"
  echo ""

  # 每个账户的并发情况
  echo "账户详情:"
  redis-cli keys "claude_console_account:*" | \
    grep -v ":slow_responses\|:5xx_errors\|:temp_error" | \
    sed 's/claude_console_account://' | \
    while read account_id; do
      name=$(redis-cli hget "claude_console_account:$account_id" name 2>/dev/null)
      limit=$(redis-cli hget "claude_console_account:$account_id" accountConcurrencyLimit 2>/dev/null)
      current=$(redis-cli keys "account_concurrency:console:$account_id:*" 2>/dev/null | wc -l)

      if [ -n "$name" ] && [ "$current" -gt 0 ]; then
        percent=$(awk "BEGIN {printf \"%.0f\", ($current/$limit)*100}")
        printf "  %-30s %2d/%2d (%3d%%)\n" "$name" "$current" "$limit" "$percent"
      fi
    done

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  sleep 2
done
```

**使用方法**：
```bash
chmod +x monitor-concurrency.sh
./monitor-concurrency.sh
```

---

## ✅ 总结

### 当前状态（已完善）
- ✅ Redis 数据正确存储
- ✅ 非流式请求并发控制完善
- ✅ **流式请求并发控制已完善**（2025年1月更新）
- ✅ 自动过期机制作为兜底
- ✅ **KEYS 命令已优化为 SCAN**（2025年1月更新）

### 改进总结
1. **流式请求并发控制** ✅
   - 添加了 `requestId` 生成和并发计数
   - 实现了与非流式请求一致的并发检查逻辑
   - 使用 `finally` 块确保资源清理
   - 支持客户端断开时的自动清理

2. **性能优化** ✅
   - 将 `getAccountConcurrency` 方法从 `KEYS` 命令改为 `SCAN` 命令
   - 避免生产环境中阻塞 Redis
   - 提升高并发场景下的性能表现

### 推荐操作
1. **日常监控**：使用上面的监控脚本
2. **紧急清理**：使用 `redis-cli del` 命令
3. **定期检查**：每周查看是否有异常的并发泄漏
4. **配置验证**：确保 `accountConcurrencyLimit` 配置合理

### 安全建议
- 不要在生产环境频繁使用 `KEYS` 命令
- 手动清理前先备份数据
- 监控 Redis 的 CPU 使用率
