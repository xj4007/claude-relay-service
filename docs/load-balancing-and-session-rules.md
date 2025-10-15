# 负载均衡与会话粘性规则详解

本文档详细说明 Claude Relay Service 的负载均衡机制和会话粘性规则。

## 目录
- [核心概念](#核心概念)
- [sessionHash 生成规则](#sessionhash-生成规则)
- [负载均衡算法](#负载均衡算法)
- [账户选择策略](#账户选择策略)
- [实际场景分析](#实际场景分析)
- [配置参数](#配置参数)
- [故障排除](#故障排除)

## 核心概念

### sessionHash
- **作用**: 标识同一个对话会话，确保会话连续性
- **格式**: 32字符的十六进制字符串 (如: `a1b2c3d4e5f6789012345678901234ab`)
- **生命周期**: 默认1小时（可配置）
- **存储**: Redis中以 `unified_claude_session_mapping:{sessionHash}` 格式存储

### 会话粘性 (Sticky Session)
- **定义**: 同一个sessionHash在TTL期间内始终使用同一个供应商账户
- **目的**: 保持对话上下文连续性，避免频繁切换账户
- **续期策略**: 智能续期，剩余时间少于阈值时自动续期
> ⚠️ 如果粘性的账户进入 `temp_error` 或 `rate_limited` 等非可用状态，调度器会删除映射并重新选取账户。Claude Console 账户在 5 分钟内出现 3 次 5xx/504 错误，或遇到 88code 并发限制（`Too many active sessions`），都会自动被标记为 `temp_error` 并至少暂停 6 分钟。自 2025-10 起，当粘性账户并发达到上限时，调度器会按 `session.stickyConcurrency` 配置短暂轮询（默认 200ms 间隔、1.2s 封顶）；若超时仍满载，则立即删除粘性映射并切换到其他账号，避免会话长时间阻塞。

## sessionHash 生成规则

### 生成优先级（按顺序检查）

#### 1. **最高优先级：metadata.user_id 中的 session ID**
```json
{
  "metadata": {
    "user_id": "session_12345678-1234-1234-1234-123456789abc"
  }
}
```
- 直接提取 `session_` 后的36字符UUID
- Claude Code等客户端会自动生成此字段
- **保证**：每个客户端实例有独立会话

#### 2. **缓存控制内容 (cache_control)**
```json
{
  "system": [
    {
      "type": "text",
      "text": "你是一个AI助手...",
      "cache_control": {"type": "ephemeral"}
    }
  ]
}
```
- 提取所有带 `cache_control: {"type": "ephemeral"}` 的内容
- 生成SHA256哈希的前32字符
- **特点**：支持 Anthropic 的 prompt caching 机制

#### 3. **系统提示词 (system)**
```json
{
  "system": "你是一个专业的编程助手..."
}
```
- 使用完整的system内容生成哈希
- **特点**：相同system的请求会共享会话

#### 4. **第一条消息内容**
```json
{
  "messages": [
    {
      "role": "user", 
      "content": "请帮我写一个Python函数"
    }
  ]
}
```
- 使用第一条用户消息的文本内容
- **特点**：相同问题会使用同一账户

#### 5. **无会话哈希**
- 如果以上都无法生成，返回 `null`
- **结果**：不使用会话粘性，每次请求都重新负载均衡

### 哈希生成算法
```javascript
const hash = crypto.createHash('sha256')
  .update(content)
  .digest('hex')
  .substring(0, 32)
```

## 负载均衡算法

### 主要调度器
- **文件位置**: `src/services/unifiedClaudeScheduler.js`
- **方法**: `selectAccountForApiKey(apiKeyData, sessionHash, requestedModel)`

### 账户选择策略（按优先级）

#### 1. **专属账户绑定**
```javascript
// API Key 绑定专属账户
if (apiKeyData.claudeAccountId) {
  return boundAccount // 直接使用，无负载均衡
}

// API Key 绑定账户分组
if (apiKeyData.claudeAccountId.startsWith('group:')) {
  return selectAccountFromGroup(groupId) // 组内负载均衡
}
```

#### 2. **会话粘性检查**
```javascript
if (sessionHash) {
  const mappedAccount = await this._getSessionMapping(sessionHash)
  if (mappedAccount && isAvailable) {
    await this._extendSessionMappingTTL(sessionHash) // 智能续期
    return mappedAccount
  }
}
```

#### 3. **负载均衡池选择**
```javascript
// 获取所有可用账户
const availableAccounts = await this._getAllAvailableAccounts()

// 按优先级排序
const sortedAccounts = this._sortAccountsByPriority(availableAccounts)

// 选择第一个
const selectedAccount = sortedAccounts[0]
```

### 排序算法 (LRU + Priority)
```javascript
_sortAccountsByPriority(accounts) {
  return accounts.sort((a, b) => {
    // 1. 优先级排序（数字越小优先级越高）
    if (a.priority !== b.priority) {
      return a.priority - b.priority
    }
    
    // 2. LRU排序（最久未使用的优先）
    const aLastUsed = new Date(a.lastUsedAt || 0).getTime()
    const bLastUsed = new Date(b.lastUsedAt || 0).getTime()
    return aLastUsed - bLastUsed
  })
}
```

### 账户过滤条件
- `isActive === 'true'` (激活状态)
- `status !== 'error/blocked/temp_error'` (无错误状态)
- 非限流状态 (`!isRateLimited`)
- 支持请求的模型
- 可调度状态 (`schedulable !== false`)

## 实际场景分析

### 场景1: 同一台电脑开10个终端

#### 情况A: 发送相同内容
```bash
# 10个终端都执行
claude ask "请写一个Python排序函数"
```

**结果分析**:
- ✅ **sessionHash相同** (基于相同的第一条消息内容)
- ✅ **使用同一个供应商账户**
- ✅ **会话粘性生效** (1小时内)

#### 情况B: 发送不同内容
```bash
# 终端1: claude ask "写Python函数"
# 终端2: claude ask "解释JavaScript"  
# 终端3: claude ask "调试这段代码"
# ...
```

**结果分析**:
- ✅ **sessionHash不同** (基于不同消息内容)
- ✅ **负载均衡分配** (按优先级+LRU算法)
- ✅ **各自独立会话**

#### 情况C: Claude Code自动生成session
```json
// Claude Code可能自动添加
{
  "metadata": {
    "user_id": "session_uuid-1234"  // 每个终端不同
  }
}
```

**结果分析**:
- ✅ **每个终端独立sessionHash**
- ✅ **完全负载均衡**
- ✅ **每个终端独立会话粘性**

### 场景2: 多用户共享API Key

#### 10个不同用户使用同一个API Key
- **用户A**: 在办公室使用 (sessionHash: abc123...)
- **用户B**: 在家里使用 (sessionHash: def456...)  
- **用户C**: 在咖啡厅使用 (sessionHash: ghi789...)

**负载均衡效果**:
- ✅ **自动分散到不同账户**
- ✅ **每个用户独立会话粘性**
- ✅ **避免单账户过载**

### 场景3: 专属账户绑定

#### API Key绑定专属Claude账户
```javascript
apiKeyData.claudeAccountId = "claude_account_123"
```

**结果**:
- ❌ **无负载均衡** (所有请求使用同一账户)
- ⚠️ **可能导致账户过载**
- ✅ **保证数据隔离**

#### API Key绑定账户分组
```javascript
apiKeyData.claudeAccountId = "group:premium_group"
```

**结果**:
- ✅ **组内负载均衡** (仅在指定组内分配)
- ✅ **资源隔离** (不影响其他组)
- ✅ **灵活配置** (可调整组内账户)

## 配置参数

### 会话配置 (config/config.js)
```javascript
session: {
  // 粘性会话TTL（小时），默认1小时
  stickyTtlHours: parseFloat(process.env.STICKY_SESSION_TTL_HOURS) || 1,
  
  // 续期阈值（分钟），默认0分钟（不续期）
  renewalThresholdMinutes: parseInt(process.env.STICKY_SESSION_RENEWAL_THRESHOLD_MINUTES) || 0,

  // 粘性会话并发守护：并发打满时的短暂轮询策略
  stickyConcurrency: {
    waitEnabled: process.env.STICKY_CONCURRENCY_WAIT_ENABLED !== 'false',
    maxWaitMs: parseInt(process.env.STICKY_CONCURRENCY_MAX_WAIT_MS) || 1200,
    pollIntervalMs: parseInt(process.env.STICKY_CONCURRENCY_POLL_INTERVAL_MS) || 200
  }
}
```

### 环境变量配置
```bash
# 会话粘性时长（小时）
STICKY_SESSION_TTL_HOURS=2

# 续期阈值（分钟），剩余时间少于此值时自动续期
STICKY_SESSION_RENEWAL_THRESHOLD_MINUTES=30

# 粘性并发守护（可选）
STICKY_CONCURRENCY_WAIT_ENABLED=true
STICKY_CONCURRENCY_MAX_WAIT_MS=1200
STICKY_CONCURRENCY_POLL_INTERVAL_MS=200
```

### Redis键名格式
```
unified_claude_session_mapping:{sessionHash}  # 统一调度器会话映射
sticky_session:{sessionHash}                  # 传统会话映射（兼容）
```

## 故障排除

### 问题1: 所有请求使用同一账户
**可能原因**:
- API Key绑定了专属账户
- sessionHash生成逻辑导致哈希相同
- 只有一个可用账户

**排查步骤**:
1. 检查API Key配置: `claudeAccountId` 字段
2. 查看日志中的sessionHash值
3. 确认可用账户数量

### 问题2: 会话频繁切换账户
**可能原因**:
- sessionHash生成失败 (返回null)
- 会话TTL过短
- 账户频繁不可用

**排查步骤**:
1. 检查sessionHash生成日志
2. 调整 `stickyTtlHours` 配置
3. 检查账户状态和限流情况

### 问题3: 负载不均衡
**可能原因**:
- 账户优先级设置不当
- 部分账户频繁出错
- LRU算法异常

**排查步骤**:
1. 检查账户优先级配置
2. 查看账户错误日志
3. 确认 `lastUsedAt` 更新正常

### 问题4: 粘性会话长时间等待同一账号
**可能原因**:
- 粘性目标账号并发已满且等待窗口设置过长
- `STICKY_CONCURRENCY_WAIT_ENABLED` 关闭，导致始终尝试复用旧会话

**排查步骤**:
1. 检查调度器日志中 `Sticky concurrency wait` 和 `⌛ Sticky account` 提示
2. 查看 `config/config.js` 中 `session.stickyConcurrency` 配置
3. 适当缩短 `STICKY_CONCURRENCY_MAX_WAIT_MS` 或扩充账号池

### 调试技巧

#### 查看sessionHash生成日志
```bash
# 搜索sessionHash相关日志
grep "Session hash generated" logs/claude-relay-*.log
```

#### 查看会话映射
```bash
# Redis中查看会话映射
redis-cli KEYS "unified_claude_session_mapping:*"
redis-cli GET "unified_claude_session_mapping:abc123..."
```

#### 查看账户选择日志
```bash
# 搜索账户选择日志  
grep "Selected account" logs/claude-relay-*.log
```

## 最佳实践

### 1. 会话配置建议
- **开发环境**: `stickyTtlHours: 0.5` (30分钟)
- **生产环境**: `stickyTtlHours: 2` (2小时)  
- **长对话场景**: 启用续期 `renewalThresholdMinutes: 30`

### 2. 账户配置建议
- **优先级设置**: 高质量账户设置较小数值 (如10、20)
- **账户分组**: 按业务场景分组，避免混用
- **监控告警**: 设置账户状态和限流监控

### 3. API Key管理建议
- **专属绑定**: 重要客户使用专属账户
- **分组使用**: 按客户等级分组分配
- **负载均衡**: 普通客户使用共享池

## 总结

Claude Relay Service 的负载均衡机制通过以下方式实现智能分配:

1. **智能会话识别**: 基于请求内容生成sessionHash
2. **粘性会话保持**: 确保对话连续性和上下文一致性  
3. **优先级+LRU算法**: 保证高质量账户优先使用和负载均衡
4. **多层次策略**: 支持专属绑定、分组管理和共享池
5. **故障自动恢复**: 账户异常时自动切换，保证服务可用性

通过合理配置这些机制，可以实现高效、稳定的多账户AI服务代理。
