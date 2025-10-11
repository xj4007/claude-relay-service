# Model Not Found 智能错误处理机制 ✅

## 实现概览

针对上游服务商可能只开放部分 Claude 模型（如仅开放 Sonnet 但未开放 Haiku）的情况，实现了智能的 `model_not_found` 错误处理机制，避免因次要模型不可用而错误地禁用正常账号。

### ✅ 实现日期
- **日期**: 2025-01-11
- **文件**: `src/services/claudeConsoleRelayService.js`

---

## 核心问题

### 问题场景

```
用户账号: anyrouter-公益1
├─ Sonnet 模型: ✅ 上游已开放
├─ Opus 模型: ✅ 上游已开放
└─ Haiku 模型: ❌ 上游未开放

Claude Code 终端请求:
├─ 发送 Sonnet 请求 → 成功
├─ 发送 Haiku 请求 → 503 model_not_found
├─ 连续失败8次 → 账号被标记 temp_error
└─ ❌ 导致 Sonnet 请求也无法使用该账号
```

### 错误日志示例

```json
{
  "error": {
    "code": "model_not_found",
    "message": "分组 Droid 下模型 claude-3-5-haiku-20241022 无可用渠道（distributor）",
    "type": "new_api_error"
  }
}
```

**问题**：系统将此错误视为账号故障，达到阈值（8次）后禁用账号，但实际上账号本身正常，只是未配置该模型。

---

## 解决方案

### 核心思路

**区分主要模型和次要模型，根据账号对主要模型的支持情况智能判断是否应该切换账号。**

#### 模型分类

| 类型 | 模型 | 重要性 | 处理策略 |
|------|------|--------|---------|
| **主要模型** | Sonnet, Opus | 核心模型 | 失败立即计入错误 |
| **次要模型** | Haiku, 其他 | 辅助模型 | 智能判断后决定 |

### 智能判断流程图

```
收到 model_not_found 错误
         ↓
    [模型分类判断]
         ↓
    ┌─────────────┐
    │ 是主要模型? │
    └─────────────┘
         ↓
    ┌────┴────┐
   YES        NO
    ↓          ↓
[计入错误]  [检查历史]
    ↓          ↓
[达阈值?]  [有主模型成功?]
    ↓          ↓
   YES      ┌──┴──┐
    ↓      YES    NO
[禁用账号] [不计入] [计入错误]
```

---

## 实现细节

### 1. 账号模型支持追踪

#### Redis 数据结构

```redis
Key: claude_console_account:{accountId}:main_model_success
Value: "true"
TTL: 7天
```

#### 记录成功请求

```javascript
// ✅ 在请求成功时调用
async _recordMainModelSuccess(accountId, model) {
  if (this._isMainClaudeModel(model)) {
    const redis = require('../models/redis').getClientSafe()
    const key = `claude_console_account:${accountId}:main_model_success`

    // 设置7天过期时间
    await redis.setex(key, 7 * 24 * 60 * 60, 'true')
    logger.debug(`✅ Recorded main model success for account ${accountId}: ${model}`)
  }
}
```

#### 调用时机

- **非流式请求**: 第599行，200/201 状态码时
- **流式请求**: 第1005-1007行，流式响应成功时

### 2. 主要模型识别

```javascript
_isMainClaudeModel(model) {
  if (!model) return false
  const modelLower = model.toLowerCase()
  return (
    modelLower.includes('sonnet') ||
    modelLower.includes('opus') ||
    modelLower.includes('claude-3-5-sonnet') ||
    modelLower.includes('claude-3-opus')
  )
}
```

**主要模型特征**:
- 包含 `sonnet` 关键词
- 包含 `opus` 关键词
- 明确的模型 ID

### 3. 智能错误处理

```javascript
async _handleServerError(accountId, statusCode, errorData = null, requestedModel = null) {
  // 🎯 特殊处理：检查是否为 model_not_found 错误
  let isModelNotFound = false
  if (errorData) {
    const errorStr = typeof errorData === 'string' ? errorData : JSON.stringify(errorData)
    isModelNotFound =
      errorStr.includes('model_not_found') ||
      errorStr.includes('无可用渠道') ||
      errorStr.includes('distributor')
  }

  if (isModelNotFound) {
    // 🧠 智能判断：区分主要模型和次要模型
    const isMainModel = this._isMainClaudeModel(requestedModel)

    if (isMainModel) {
      // 主要模型（sonnet/opus）不支持 → 账号确实有问题
      logger.warn(
        `⚠️ Main model "${requestedModel}" not found for account ${accountId} - counting as account error`
      )
      // 继续执行正常的错误计数逻辑
    } else {
      // 次要模型（haiku等）不支持 → 检查账号是否支持过任何主要模型
      const hasMainModelSuccess = await this._checkAccountMainModelSupport(accountId)

      if (hasMainModelSuccess) {
        // 账号支持过主要模型，说明账号正常
        logger.warn(
          `ℹ️ Minor model "${requestedModel}" not found for account ${accountId}, but main models work - not counting as account error`
        )
        return // 🎯 不记录错误计数，直接返回
      } else {
        // 从未成功过主要模型，可能账号本身有问题
        logger.warn(
          `⚠️ Model "${requestedModel}" not found and no main model success history - counting as account error`
        )
        // 继续执行正常的错误计数逻辑
      }
    }
  }

  // 记录错误并检查阈值...
}
```

#### 错误识别关键词

- `model_not_found` - 标准错误码
- `无可用渠道` - 中文错误提示
- `distributor` - 上游渠道相关

---

## 实际场景演示

### 场景 1：Haiku 不支持但 Sonnet 可用（正常情况）

```
时间线:
T1: Sonnet 请求 → ✅ 200 成功
    → 记录: main_model_success = true (7天有效)

T2: Haiku 请求 → ❌ 503 model_not_found
    → 检测: 次要模型失败
    → 查询: 有主模型成功历史
    → 决策: ✅ 不计入错误，不切换账号
    → 日志: ℹ️ Minor model "haiku" not found, but main models work

T3: Haiku 请求 (连续10次) → ❌ 503 model_not_found
    → ✅ 均不计入错误
    → ✅ 账号状态保持正常

T4: Sonnet 请求 → ✅ 200 成功
    → ✅ 继续使用该账号
```

### 场景 2：Sonnet 也不支持（账号异常）

```
时间线:
T1: Haiku 请求 → ❌ 503 model_not_found
    → 检测: 次要模型失败
    → 查询: 无主模型成功历史
    → 决策: ⚠️ 计入错误 (1/8)

T2: Sonnet 请求 → ❌ 503 model_not_found
    → 检测: 主要模型失败
    → 决策: ⚠️ 计入错误 (2/8)
    → 日志: ⚠️ Main model "sonnet" not found - counting as account error

T3-T8: 连续 Sonnet/Haiku 请求失败
    → 错误计数: 3/8 → 4/8 → ... → 9/8

T9: 错误计数超过阈值
    → ❌ 标记账号为 temp_error
    → ❌ 账号从调度池中移除
    → 🔄 切换到其他账号
```

### 场景 3：新账号首次使用（保守处理）

```
时间线:
T1: Haiku 请求 → ❌ 503 model_not_found
    → 检测: 次要模型失败
    → 查询: 无主模型成功历史（新账号）
    → 决策: ⚠️ 计入错误 (1/8) [保守处理]

T2: Sonnet 请求 → ✅ 200 成功
    → 记录: main_model_success = true
    → ✅ 清除错误计数

T3: Haiku 请求 → ❌ 503 model_not_found
    → 检测: 次要模型失败
    → 查询: 有主模型成功历史（刚记录）
    → 决策: ✅ 不计入错误
    → 状态: 账号正常运行
```

---

## 日志输出

### 成功记录主模型

```
✅ Recorded main model success for account befebc0e-acbe: claude-3-5-sonnet-20241022
```

### 次要模型失败（账号正常）

```
ℹ️ Minor model "claude-3-5-haiku-20241022" not found for account befebc0e-acbe, but main models work - not counting as account error
```

### 主要模型失败（账号异常）

```
⚠️ Main model "claude-3-5-sonnet-20241022" not found for account befebc0e-acbe - counting as account error
⏱️ Service Unavailable for Claude Console account befebc0e-acbe, error count: 5/8
```

### 新账号首次失败（保守处理）

```
⚠️ Model "claude-3-5-haiku-20241022" not found and no main model success history - counting as account error
⏱️ Service Unavailable for Claude Console account cac9a880-53ae, error count: 1/8
```

---

## 配置和阈值

### 错误阈值策略

| 状态码 | 阈值 | 说明 |
|--------|------|------|
| 504 | 15次 | 超时错误更宽容 |
| 503/529 | 8次 | 服务不可用 |
| 500/502 | 5次 | 严重服务器错误 |

### Redis TTL

- **主模型成功记录**: 7天
- **错误计数**: 30分钟滑动窗口

---

## 代码位置

### 核心方法

| 方法 | 行号 | 功能 |
|------|------|------|
| `_handleServerError()` | 1293-1368 | 统一错误处理入口 |
| `_isMainClaudeModel()` | 1370-1380 | 判断是否为主要模型 |
| `_checkAccountMainModelSupport()` | 1382-1395 | 查询主模型成功历史 |
| `_recordMainModelSuccess()` | 1397-1411 | 记录主模型成功 |

### 调用位置

| 位置 | 行号 | 场景 |
|------|------|------|
| 非流式请求错误 | 558 | 捕获 5xx 错误 |
| 非流式请求成功 | 599 | 记录成功 |
| 流式错误收集 | 969-975 | 收集错误数据后处理 |
| 流式catch错误 | 1194-1201 | catch块中错误 |
| 流式请求成功 | 1005-1007 | 记录成功 |

---

## 优势和效果

### ✅ 优势

1. **避免误判**: 次要模型不可用不会导致账号被禁用
2. **保持可用性**: 主要模型可用的账号继续服务
3. **智能切换**: 只在真正需要时才切换账号
4. **历史记忆**: 7天内的成功记录提供判断依据
5. **保守安全**: 新账号或无历史时保守处理

### 📊 预期效果

**修改前**:
```
Haiku 失败 8次 → 账号被禁用 → Sonnet 也无法使用 ❌
```

**修改后**:
```
Haiku 失败任意次 + Sonnet 成功过 → 账号保持可用 → 服务正常 ✅
```

---

## 测试建议

### 测试用例 1: 正常账号（Sonnet可用，Haiku不可用）

```bash
# 1. 先发送 Sonnet 请求（确保成功记录）
curl -X POST http://localhost:3000/api/v1/messages \
  -H "x-api-key: cr_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet-20241022", "messages": [...]}'

# 预期: ✅ 200 成功
# 日志: ✅ Recorded main model success for account xxx

# 2. 发送多次 Haiku 请求（测试不会禁用账号）
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/v1/messages \
    -H "x-api-key: cr_xxx" \
    -H "Content-Type: application/json" \
    -d '{"model": "claude-3-5-haiku-20241022", "messages": [...]}'
done

# 预期: ❌ 503 model_not_found (10次)
# 日志: ℹ️ Minor model ... not found, but main models work - not counting
# 账号状态: ✅ 依然可用

# 3. 再次发送 Sonnet 请求（验证账号仍可用）
curl -X POST http://localhost:3000/api/v1/messages \
  -H "x-api-key: cr_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet-20241022", "messages": [...]}'

# 预期: ✅ 200 成功
```

### 测试用例 2: 异常账号（所有模型不可用）

```bash
# 使用新账号发送 Sonnet 请求
for i in {1..9}; do
  curl -X POST http://localhost:3000/api/v1/messages \
    -H "x-api-key: cr_xxx" \
    -H "Content-Type: application/json" \
    -d '{"model": "claude-3-5-sonnet-20241022", "messages": [...]}'
done

# 预期: ❌ 503 model_not_found (9次)
# 日志: ⚠️ Main model "sonnet" not found - counting as account error
# 账号状态: ❌ 第9次后被标记为 temp_error
```

### 测试用例 3: 新账号冷启动

```bash
# 1. 新账号首次发送 Haiku 请求
curl -X POST http://localhost:3000/api/v1/messages \
  -H "x-api-key: cr_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-haiku-20241022", "messages": [...]}'

# 预期: ❌ 503 model_not_found
# 日志: ⚠️ Model ... not found and no main model success history - counting
# 错误计数: 1/8

# 2. 发送 Sonnet 请求（建立主模型成功历史）
curl -X POST http://localhost:3000/api/v1/messages \
  -H "x-api-key: cr_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet-20241022", "messages": [...]}'

# 预期: ✅ 200 成功
# 日志: ✅ Recorded main model success
# 错误计数: 清零

# 3. 再次发送 Haiku 请求
curl -X POST http://localhost:3000/api/v1/messages \
  -H "x-api-key: cr_xxx" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-haiku-20241022", "messages": [...]}'

# 预期: ❌ 503 model_not_found
# 日志: ℹ️ Minor model ... not found, but main models work - not counting
# 账号状态: ✅ 保持正常
```

---

## 验证方法

### 1. 检查 Redis 数据

```bash
# 查看主模型成功标记
redis-cli GET "claude_console_account:{accountId}:main_model_success"
# 输出: "true" (如果有成功记录)

# 查看错误计数
redis-cli ZCARD "claude_console_account:{accountId}:5xx_errors"
# 输出: 错误次数

# 查看错误详情
redis-cli ZRANGE "claude_console_account:{accountId}:5xx_errors" 0 -1 WITHSCORES
```

### 🔧 手动操作 Redis（运维必备）

当你已知上游账户某个模型不可用，想要手动标记账号支持主模型，避免触发错误计数，可以直接操作 Redis：


##### 远程 Redis（带密码，推荐）
```bash
# 完整连接命令（IP + 端口 + 密码 + 数据库）
redis-cli -h <IP地址> -p <端口> -a <密码> -n 0

redis-cli -h 127.0.0.1 -p 26739 -a "xxxxx" -n 0
```

##### Docker 环境
```bash
# 进入 Redis 容器（默认 db0）
docker exec -it redis redis-cli -n 0

# 或者从宿主机连接
docker exec -it redis redis-cli -h localhost -p 6379 -a "password" -n 0
```

#### 场景 1：手动标记账号支持主模型

**使用场景**：新添加的账号，你明确知道它支持 Sonnet 但不支持 Haiku。

```bash
# 替换 {accountId} 为实际的账号ID（如：befebc0e-acbe-43ff-8510-03962ba26fd8）
redis-cli SETEX "claude_console_account:{accountId}:main_model_success" 604800 "true"

# 解释：
# SETEX - 设置键值并指定过期时间
# 604800 - 7天的秒数 (7 * 24 * 60 * 60)
# "true" - 标记值
```

**示例**：
```bash
# 为账号 befebc0e-acbe-43ff-8510-03962ba26fd8 标记主模型支持
redis-cli SETEX "claude_console_account:befebc0e-acbe-43ff-8510-03962ba26fd8:main_model_success" 604800 "true"

# 验证设置成功
redis-cli GET "claude_console_account:befebc0e-acbe-43ff-8510-03962ba26fd8:main_model_success"
# 输出: "true"

# 查看剩余有效期（秒）
redis-cli TTL "claude_console_account:befebc0e-acbe-43ff-8510-03962ba26fd8:main_model_success"
# 输出: 604800 (7天)
```

#### 场景 2：批量标记多个账号

**使用场景**：批量初始化多个账号的主模型支持标记。

```bash
#!/bin/bash
# 批量标记脚本

ACCOUNT_IDS=(
  "befebc0e-acbe-43ff-8510-03962ba26fd8"
  "cac9a880-53ae-4143-9cb9-428357cb6e9d"
  "另一个账号ID"
)

for accountId in "${ACCOUNT_IDS[@]}"; do
  echo "标记账号: $accountId"
  redis-cli SETEX "claude_console_account:${accountId}:main_model_success" 604800 "true"
done

echo "批量标记完成"
```

#### 场景 3：清除错误计数

**使用场景**：账号被误判后，手动清除错误计数。

```bash
# 清除5xx错误计数
redis-cli DEL "claude_console_account:{accountId}:5xx_errors"

# 验证清除成功
redis-cli ZCARD "claude_console_account:{accountId}:5xx_errors"
# 输出: (integer) 0
```

**示例**：
```bash
# 清除账号的错误计数
redis-cli DEL "claude_console_account:befebc0e-acbe-43ff-8510-03962ba26fd8:5xx_errors"

# 如果账号被标记为 temp_error，还需要恢复账号状态
redis-cli HSET "claude_console_account:befebc0e-acbe-43ff-8510-03962ba26fd8" status "active"
redis-cli HSET "claude_console_account:befebc0e-acbe-43ff-8510-03962ba26fd8" schedulable "true"
```

#### 场景 4：查看所有需要处理的账号

```bash
# 查找所有 Claude Console 账号
redis-cli KEYS "claude_console_account:*" | grep -v ":5xx_errors" | grep -v ":main_model_success" | grep -v ":slow_responses" | grep -v ":temp_error" | grep -v ":stream_timeouts"

# 或者更精确的方式：查看所有账号ID
redis-cli KEYS "claude_console_account:*" | grep -E "^claude_console_account:[a-f0-9-]+$"
```

#### 场景 5：临时延长主模型成功标记有效期

**使用场景**：账号即将过期（快到7天），手动延长有效期。

```bash
# 延长到14天
redis-cli EXPIRE "claude_console_account:{accountId}:main_model_success" 1209600

# 或者重新设置为7天
redis-cli EXPIRE "claude_console_account:{accountId}:main_model_success" 604800

# 查看当前剩余时间
redis-cli TTL "claude_console_account:{accountId}:main_model_success"
```

#### 完整的运维流程示例

```bash
#!/bin/bash
# 新账号初始化完整流程

ACCOUNT_ID="befebc0e-acbe-43ff-8510-03962ba26fd8"
ACCOUNT_NAME="anyrouter-公益1"

echo "=== 初始化账号: $ACCOUNT_NAME ($ACCOUNT_ID) ==="

# 1. 标记主模型支持（7天）
echo "1. 标记主模型支持..."
redis-cli SETEX "claude_console_account:${ACCOUNT_ID}:main_model_success" 604800 "true"

# 2. 清除可能存在的错误计数
echo "2. 清除错误计数..."
redis-cli DEL "claude_console_account:${ACCOUNT_ID}:5xx_errors"

# 3. 确保账号状态正常
echo "3. 确保账号状态正常..."
redis-cli HSET "claude_console_account:${ACCOUNT_ID}" status "active"
redis-cli HSET "claude_console_account:${ACCOUNT_ID}" schedulable "true"

# 4. 验证设置
echo "4. 验证设置..."
echo "  - 主模型标记: $(redis-cli GET "claude_console_account:${ACCOUNT_ID}:main_model_success")"
echo "  - 错误计数: $(redis-cli ZCARD "claude_console_account:${ACCOUNT_ID}:5xx_errors")"
echo "  - 账号状态: $(redis-cli HGET "claude_console_account:${ACCOUNT_ID}" status)"
echo "  - 可调度: $(redis-cli HGET "claude_console_account:${ACCOUNT_ID}" schedulable)"

echo "=== 初始化完成 ==="
```

#### Redis 命令速查表

| 操作 | 命令 | 说明 |
|------|------|------|
| 设置主模型支持 | `SETEX key 604800 "true"` | 7天有效期 |
| 查看主模型支持 | `GET key` | 返回 "true" 或 nil |
| 延长有效期 | `EXPIRE key 604800` | 重置为7天 |
| 查看剩余时间 | `TTL key` | 返回秒数 |
| 删除标记 | `DEL key` | 立即删除 |
| 清除错误计数 | `DEL errors_key` | 删除整个计数 |
| 查看错误次数 | `ZCARD errors_key` | 返回错误数量 |
| 恢复账号状态 | `HSET account_key status "active"` | 标记为活跃 |
| 启用调度 | `HSET account_key schedulable "true"` | 允许调度 |

#### 注意事项

1. **替换占位符**：所有 `{accountId}` 都需要替换为实际的账号ID
2. **验证操作**：每次手动操作后，建议用 `GET` 或 `HGET` 验证
3. **日志监控**：操作后观察日志，确认系统行为符合预期
4. **备份建议**：大批量操作前建议备份 Redis 数据

### 2. 监控日志关键字

```bash
# 监控主模型成功记录
tail -f logs/claude-relay-*.log | grep "Recorded main model success"

# 监控次要模型错误（不计入）
tail -f logs/claude-relay-*.log | grep "but main models work"

# 监控主模型错误（计入）
tail -f logs/claude-relay-*.log | grep "Main model.*not found.*counting"
```

### 3. 账号状态查看

```bash
# CLI 工具查看账号状态
npm run cli accounts list

# 查看特定账号详情
npm run cli accounts claude console list
```

---

## 相关文件

- **核心实现**: `src/services/claudeConsoleRelayService.js`
- **账号服务**: `src/services/claudeConsoleAccountService.js`
- **错误转换**: `src/utils/sseConverter.js`
- **重试文档**: `docs/STREAM_RETRY_IMPLEMENTATION.md`

---

## 设计决策：不主动发起健康检查

### 为什么不在次要模型失败时主动测试主模型？

在设计过程中，我们考虑过在检测到次要模型（如Haiku）失败时，自动发起一个主模型（Sonnet）的测试请求来验证账号是否真的有问题。但经过权衡，我们决定**不实现这个功能**，原因如下：

#### 1. 成本考虑 💰
- 每次 Haiku 失败都发送一个 Sonnet 测试请求会产生额外的 API 调用成本
- 在高并发场景下，这些测试请求会迅速累积
- 即使使用最小 token（max_tokens: 50），也会产生不必要的费用

#### 2. 延迟问题 ⏱️
- 健康检查需要等待 Sonnet 请求完成（通常1-3秒）
- 这会延长客户端的等待时间
- 在错误重试场景中，这种延迟会更加明显

#### 3. 误判风险 ⚠️
- 健康检查可能遇到临时性网络问题而失败
- 可能遇到上游服务的临时限流
- 增加系统复杂度，引入新的潜在错误点

#### 4. 现有机制已足够 ✅
当前基于历史记录的判断机制已经能很好地工作：
- **冷启动时**：新账号首次使用 Haiku 失败会计入错误（保守处理）
- **正常使用后**：只要 Sonnet 成功过一次（7天内），Haiku 失败就不会触发切换
- **自然建立信任**：随着账号的正常使用，系统自动建立主模型成功历史

### 推荐的使用模式

为了让系统快速建立账号的主模型支持历史，建议：

1. **新账号初始化**
   ```bash
   # 添加账号后，手动发送一个 Sonnet 测试请求
   curl -X POST http://your-service/api/v1/messages \
     -H "x-api-key: your_key" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "claude-3-5-sonnet-20241022",
       "max_tokens": 50,
       "messages": [{"role": "user", "content": "Hello"}]
     }'
   ```

2. **正常使用即可建立历史**
   - Claude Code 的大部分请求都是 Sonnet 模型
   - 只要正常使用，系统会自动记录主模型成功状态
   - 7天内有效，定期使用会自动续期

3. **监控和告警**
   - 使用 Webhook 通知功能监控账号状态变化
   - 如果账号被标记为 temp_error，及时检查原因
   - 通过 Web 界面查看账号的错误统计

### 未来可能的改进

如果确实需要主动健康检查功能，可以考虑：

1. **可选配置**
   ```javascript
   // config/config.js
   modelNotFoundHandling: {
     enableHealthCheck: false, // 默认禁用
     healthCheckCooldown: 300  // 5分钟冷却时间
   }
   ```

2. **智能触发**
   - 只在特定条件下触发（如连续5次次要模型失败）
   - 添加冷却时间，避免频繁测试
   - 异步执行，不阻塞客户端请求

3. **成本控制**
   - 使用专用的健康检查账号
   - 限制每小时/每天的健康检查次数
   - 记录健康检查的成本统计

---

## 总结

该机制通过智能区分主要模型和次要模型的失败情况，结合账号历史成功记录，有效避免了因上游服务商部分模型未配置而导致的账号误判和禁用。系统在保持高可用性的同时，确保了错误处理的准确性和合理性。

**核心价值**:
- 🎯 精准错误判断
- ✅ 避免账号误杀
- 🔄 智能切换策略
- 📊 历史数据支持
- 🛡️ 保守安全机制
- 💰 零额外成本（基于现有请求历史）
