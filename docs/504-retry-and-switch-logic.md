# 504错误重试和账户切换逻辑详解

## 🎯 问题场景

用户提问：

> 如果出现多次504的情况，逻辑也是继续等待而不会切换账号吗？
> 比如我设定了慢请求延长时间是120秒，如果到了120秒还是504的情况呢？

## 📊 完整的逻辑流程分析

### 时间线流程图

```
请求开始
    ↓
客户端15秒超时断开 ━━━━━━━━━━━━━━━┓
    ↓                                ┃
继续等待上游响应                     ┃ 客户端已断开
    ↓                                ┃ clientDisconnected = true
【情况A】上游60秒返回504 ←━━━━━━━━━┛
    ↓
【修复后的逻辑】
├─ 检测到：status=504 && clientDisconnected=true
├─ 判断：这是中间代理超时，不是真正失败
├─ 动作：⚠️ 仅记录警告，不计入账户错误
└─ 结果：账户保持正常状态，继续等待
    ↓
继续等待剩余60秒（总共120秒配置）
    ↓
【情况B】上游101秒返回200成功 ✅
    ↓
├─ 缓存成功响应（TTL=180秒）
├─ 清除账户的5xx错误计数
└─ 账户状态：正常，可继续使用

【情况C】上游120秒后依然无响应
    ↓
├─ 服务器主动abort请求
├─ 记录：ERR_CANCELED
└─ 不计入账户错误（因为是超时abort）
```

### 关键代码位置解析

#### 1. 客户端断开检测 ([claudeConsoleRelayService.js:300-340](../src/services/claudeConsoleRelayService.js#L300-L340))

```javascript
const handleClientDisconnect = () => {
  clientDisconnected = true
  clientDisconnectTime = Date.now()
  const elapsedTime = clientDisconnectTime - requestStartTime

  // 获取等待时间配置
  const waitTime = config.upstreamWaitAfterClientDisconnect.nonStream || 120000

  logger.info(
    `🔌 Client disconnected after ${elapsedTime}ms, waiting ${waitTime}ms for upstream response`
  )

  // ⏳ 延迟取消：给上游120秒时间完成请求
  setTimeout(() => {
    if (abortController && !abortController.signal.aborted) {
      logger.warn(`⏰ Upstream timeout after ${waitTime}ms, aborting request`)
      abortController.abort() // ✅ 主动取消，不计入账户错误
    }
  }, waitTime)
}
```

**关键点**：

- ✅ 客户端断开后，服务器不会立即放弃
- ✅ 继续等待 `waitTime` (默认120秒) 让上游完成
- ✅ 超时后主动abort，不算账户失败

#### 2. 504错误处理逻辑 ([claudeConsoleRelayService.js:547-567](../src/services/claudeConsoleRelayService.js#L547-L567))

```javascript
} else if (response.status >= 500 && response.status <= 504) {
  // 🔥 5xx错误处理
  // ⚠️ 智能判断：区分中间代理504和真正的上游504
  if (response.status === 504 && clientDisconnected) {
    logger.warn(
      `⚠️ 504 Gateway Timeout while client disconnected - likely intermediate proxy timeout, not marking account as error`
    )
    // ✅ 不记录为服务器错误，因为上游可能稍后成功
  } else {
    // ❌ 客户端未断开时的504 = 真正的上游问题
    await this._handleServerError(accountId, response.status)
  }
}
```

**关键判断**：

```
if (504错误 && 客户端已断开) {
  → 这是中间代理(anyrouter/nginx)的超时
  → 不计入账户错误
  → 账户保持正常状态
} else {
  → 这是真正的上游504
  → 记录账户错误，累计3次后标记temp_error
}
```

#### 3. 错误计数和账户降级 ([claudeConsoleRelayService.js:1209-1232](../src/services/claudeConsoleRelayService.js#L1209-L1232))

```javascript
async _handleServerError(accountId, statusCode) {
  // 记录错误到Redis（key: claude_console_account:{id}:5xx_errors）
  await claudeConsoleAccountService.recordServerError(accountId, statusCode)
  const errorCount = await claudeConsoleAccountService.getServerErrorCount(accountId)

  const threshold = 3 // ⚠️ 3次错误触发阈值

  if (errorCount > threshold) {
    // ❌ 超过阈值：标记为 temp_error
    logger.error(
      `❌ Account ${accountId} exceeded error threshold (${errorCount} errors), marking as temp_error`
    )
    await claudeConsoleAccountService.markAccountTempError(accountId)
  }
}
```

**错误计数特点**：

- 🕐 5分钟过期：Redis key TTL = 300秒
- 🔢 阈值为3：超过3次错误才降级
- ⏰ 自动恢复：5分钟后自动清除temp_error状态

#### 4. 账户可用性检查 ([unifiedClaudeScheduler.js:731-796](../src/services/unifiedClaudeScheduler.js#L731-L796))

```javascript
async _isAccountAvailable(accountId, accountType, requestedModel) {
  if (accountType === 'claude-console') {
    const account = await claudeConsoleAccountService.getAccount(accountId)

    // 检查账户状态（🔥 排除 temp_error）
    if (
      account.status !== 'active' &&
      account.status !== 'unauthorized' &&
      account.status !== 'overloaded'
    ) {
      return false // ❌ temp_error 状态的账户会被跳过
    }

    // 检查是否可调度
    if (!this._isSchedulable(account.schedulable)) {
      return false // ❌ schedulable='false' 会被跳过
    }

    // 其他检查：限流、超额、并发...
    return true
  }
}
```

**调度器行为**：

- ❌ `temp_error` 状态的账户不会被选中
- ❌ `schedulable='false'` 的账户不会被选中
- ✅ 自动切换到其他可用账户

## 🔄 完整的故障处理流程

### 场景1：连续收到504，但上游实际成功（修复后）

```
请求1:
├─ 客户端15s超时 → anyrouter 60s返回504
├─ 判断：clientDisconnected=true → ⚠️ 忽略504
├─ 等待：上游101s成功 → ✅ 缓存响应
└─ 账户错误计数：0/3 ✅

请求2:
├─ 命中缓存（3分钟内）→ 立即返回 ✅
└─ 账户错误计数：0/3 ✅

请求3:
├─ 未命中缓存 → 重复请求1流程
└─ 账户错误计数：0/3 ✅

结果：账户始终保持健康状态，不会被降级 ✅✅✅
```

### 场景2：真正的上游504错误（客户端未断开）

```
请求1:
├─ 客户端200s超时（假设客户端设置很长）
├─ 上游60s返回504
├─ 判断：clientDisconnected=false → ❌ 记录错误
└─ 账户错误计数：1/3 ⚠️

请求2:
├─ 上游60s返回504
└─ 账户错误计数：2/3 ⚠️

请求3:
├─ 上游60s返回504
└─ 账户错误计数：3/3 ⚠️

请求4:
├─ 上游60s返回504
├─ 账户错误计数：4/3 → 超过阈值！
├─ 动作：markAccountTempError()
├─ 账户状态：temp_error, schedulable='false'
└─ 调度器：自动切换到其他账户 🔄

5分钟后:
├─ 自动恢复任务触发
├─ 账户状态：active, schedulable='true'
├─ 错误计数：清零
└─ 账户重新加入调度池 ✅
```

### 场景3：120秒后依然无响应（超时abort）

```
请求流程:
├─ 客户端15s断开 → clientDisconnected=true
├─ anyrouter 60s返回504 → ⚠️ 忽略（中间代理超时）
├─ 继续等待到120s（配置的waitTime）
├─ 120s超时 → abortController.abort()
├─ 错误类型：ERR_CANCELED
└─ 不计入账户错误（这是服务器主动取消）❌

账户状态：正常，可继续使用 ✅
下次请求：会重新尝试该账户 🔄
```

## 🎯 回答你的问题

### Q1: 出现多次504，会继续等待还是切换账号？

**答案**：取决于504的来源

**情况A：客户端已断开时收到504**（中间代理超时）

```
行为：⚠️ 忽略504错误，不计入账户错误
等待：继续等待到120秒配置
切换：不会切换账户（除非超过120秒才abort）
结果：如果上游在120秒内成功，会缓存响应并清零错误
```

**情况B：客户端未断开时收到504**（真正的上游失败）

```
行为：❌ 记录为账户错误
计数：错误计数 +1（5分钟过期）
切换：连续3次以上错误 → 标记temp_error → 自动切换账户
恢复：5分钟后自动恢复
```

### Q2: 设定120秒等待，到了120秒还是504怎么办？

**完整流程**：

```
0s    - 请求开始
15s   - 客户端超时断开（clientDisconnected=true）
60s   - anyrouter返回504 → ⚠️ 忽略（中间代理超时）
      - 继续等待...（还有60秒）
120s  - 达到waitTime限制 → abortController.abort()
      - 错误类型：ERR_CANCELED
      - 不计入账户错误 ✅
      - 账户保持正常状态 ✅

下次请求：
      - 调度器重新选择账户
      - 仍然可能选择同一账户（如果它是最优先的）🔄
      - 如果连续失败，会逐渐累积真正的错误
```

**关键点**：

- ✅ 120秒abort不算账户失败
- ✅ 账户不会因为单次超时就被降级
- ⚠️ 但如果连续多次请求都超时，可能暴露真实问题
- 🔄 建议调整客户端超时或中间代理超时配置

## 🔧 配置建议

### 推荐的超时配置层次

```yaml
客户端超时: 300秒（5分钟）
  ↓
中间代理超时: 300秒（5分钟）
  ↓
服务器等待上游: 180秒（3分钟）
  ↓
Axios请求超时: 600秒（10分钟）
  ↓
实际上游处理: < 300秒（理想情况）
```

### 为什么这样配置？

1. **客户端超时 = 中间代理超时 (300秒)**
   - 确保客户端和中间代理同步超时
   - 避免"客户端断开 → 收到504"的情况
   - 用户体验：5分钟是合理的等待上限

2. **服务器等待 < 客户端超时 (180秒)**
   - 客户端还在等待时，服务器还在努力获取响应
   - 利用缓存机制：即使客户端超时，后续请求能命中缓存
   - 防止无意义的长时间等待

3. **Axios超时 > 所有超时 (600秒)**
   - 作为最后的保险
   - 防止连接永久挂起
   - 为特殊的超长请求留空间

### 环境变量配置

```bash
# .env 文件
UPSTREAM_WAIT_NON_STREAM=180000    # 服务器等待：3分钟
UPSTREAM_WAIT_STREAM=180000        # 流式等待：3分钟
REQUEST_TIMEOUT=600000             # Axios超时：10分钟
```

## 📊 监控和调试

### 查看账户错误状态

```bash
# 查看所有temp_error账户
npm run cli accounts list | grep temp_error

# 查看特定账户的错误计数
redis-cli GET "claude_console_account:{accountId}:5xx_errors"

# 查看错误计数TTL（剩余过期时间）
redis-cli TTL "claude_console_account:{accountId}:5xx_errors"
```

### 日志关键标识

**正常的中间代理超时**（不影响账户）：

```
⚠️ 504 Gateway Timeout while client disconnected - likely intermediate proxy timeout
```

**真正的504错误**（计入账户错误）：

```
⏱️ Timeout error for Claude Console account xxx, error count: 1/3
```

**账户被降级**：

```
❌ Account xxx exceeded timeout error threshold (4 errors), marking as temp_error
⚠️ Claude Console account xxx marked as temp_error and disabled for scheduling
```

**账户自动恢复**：

```
✅ Auto-recovered temp_error after 5 minutes: xxx
```

### 手动清除账户错误

如果账户被误标记，可以手动清除：

```bash
# 清除错误计数
redis-cli DEL "claude_console_account:{accountId}:5xx_errors"

# 恢复账户状态（通过Web界面或CLI）
npm run cli accounts update {accountId} --status active --schedulable true
```

## 🚀 最佳实践

### 1. 分层防护策略

```
第一层：智能504识别（已修复）
  ↓ 过滤掉中间代理超时
第二层：错误计数和TTL（5分钟）
  ↓ 区分偶发问题和持续故障
第三层：阈值降级（3次）
  ↓ 自动隔离有问题的账户
第四层：自动恢复（5分钟）
  ↓ 给账户第二次机会
```

### 2. 监控告警

定期检查：

- **504错误率**：区分客户端断开的504和真正的504
- **账户降级频率**：如果频繁降级，检查配置
- **缓存命中率**：延迟成功策略的效果
- **平均响应时间**：P95/P99指标

### 3. 渐进式优化

```
阶段1：修复504误判（已完成）✅
  ↓
阶段2：优化客户端和中间代理超时配置 ⏳
  ↓
阶段3：监控真实的响应时间分布 📊
  ↓
阶段4：根据数据调整等待时间和阈值 🎯
```

## 📝 总结

### 修复前的问题

```
任何504 → 记录账户错误 → 3次降级 ❌
即使上游成功，账户也被误杀 ❌❌
```

### 修复后的智能判断

```
504 + 客户端已断开 → ⚠️ 中间代理超时 → 忽略，继续等待 ✅
504 + 客户端未断开 → ❌ 真正失败 → 记录错误 ✅
120秒超时abort → 不计入错误 → 下次重试 ✅
```

### 核心改进

1. ✅ **智能区分504来源**：中间代理 vs 真正上游
2. ✅ **延迟成功缓存**：客户端超时后仍然缓存成功响应
3. ✅ **自动账户恢复**：5分钟后重新加入调度池
4. ✅ **不会因超时而降级**：仅真正的失败才计数

你的系统现在可以更智能地处理504错误，不会再因为网络延迟而错误地禁用正常账户！🎉
