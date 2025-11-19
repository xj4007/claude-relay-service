# SessionId 限制功能文档

## 功能概述

SessionId 限制功能用于**限制单个账户在指定时间窗口内最多服务的不同 sessionId 数量**，防止账户被过多不同客户端会话占用，实现更合理的负载均衡和资源分配。

### 核心逻辑

- **账户级别限制**：每个 Claude 官方/Console 账户可独立配置
- **时间窗口**：在 N 分钟内统计（如 5 分钟）
- **最大数量**：最多服务 M 个不同的 sessionId（如 3 个）
- **智能粘性**：如果当前 sessionId 已在账户列表中，继续使用该账户（保持会话连续性）
- **自动过期**：超过时间窗口的 sessionId 自动清理

### 工作流程示例

**配置：5 分钟内最多 3 个 sessionId**

```
时间线：
T0: Session-1 请求 → 账户 A（1/3）✅
T1: Session-2 请求 → 账户 A（2/3）✅
T2: Session-3 请求 → 账户 A（3/3）✅
T3: Session-4 请求 → 账户 A 已满，使用账户 B ✅
T4: Session-1 再次请求 → 检测到在账户 A 列表中，继续使用账户 A ✅
T5 (5分钟后): Session-1 记录过期，账户 A 可接受新的 sessionId
```

---

## 实现细节

### 1. 数据库设计

#### Redis 数据结构

```redis
# 键名格式
account_session_ids:{accountId}

# 数据类型
Sorted Set (ZSET)

# Score: 时间戳（毫秒）
# Member: sessionId (36位UUID)

# 示例
ZADD account_session_ids:abc123 1732012345678 "17cf0fd3-d51b-4b59-977d-b899dafb3022"
ZADD account_session_ids:abc123 1732012567890 "28de1fe4-e62c-5c6a-a88e-c9badec4133f"

# TTL: 2倍窗口时间（自动清理，防止内存泄漏）
EXPIRE account_session_ids:abc123 600
```

#### 账户数据字段

在 Redis 中，每个账户添加以下字段：

```javascript
{
  // 现有字段...
  id: 'uuid',
  name: 'Account Name',
  platform: 'claude-console',  // 或 'claude'

  // ✅ 新增字段
  sessionIdLimitEnabled: 'true',      // 是否启用限制
  sessionIdMaxCount: '3',             // 最大 sessionId 数量
  sessionIdWindowMinutes: '5'         // 时间窗口（分钟）
}
```

---

### 2. 后端实现

#### 修改的文件清单

| 文件路径 | 修改内容 | 代码行数 |
|---------|---------|---------|
| **src/models/redis.js** | 添加 SessionId 追踪方法 | +127 行 |
| **src/services/claudeConsoleAccountService.js** | 添加字段支持 | +20 行 |
| **src/services/claudeAccountService.js** | 添加字段支持 | +17 行 |
| **src/services/unifiedClaudeScheduler.js** | 集成限制检查逻辑 | +85 行 |
| **src/services/claudeRelayService.js** | 传递 requestBody 参数 | +1 行 |

---

#### 2.1 Redis 模型层 (src/models/redis.js)

**位置：第 1980-2107 行**

新增 3 个方法：

```javascript
// 📋 添加 sessionId 到账户追踪列表
async addAccountSessionId(accountId, sessionId, windowMinutes)

// 📋 获取账户当前有效 sessionId 数量
async getAccountSessionIdCount(accountId, windowMinutes)

// 📋 获取账户所有有效 sessionId（调试用）
async getAccountSessionIds(accountId, windowMinutes)
```

**核心特性：**
- 使用 Lua 脚本确保原子操作
- 自动清理过期记录（ZREMRANGEBYSCORE）
- 设置 TTL 防止内存泄漏
- 批量查询优化（支持 Promise.all）

---

#### 2.2 Claude Console 账户服务 (src/services/claudeConsoleAccountService.js)

**修改位置：**

1. **createAccount 方法** (第 74-77 行)
   ```javascript
   // 📋 SessionId 限制相关字段
   sessionIdLimitEnabled = false,
   sessionIdMaxCount = 0,
   sessionIdWindowMinutes = 0
   ```

2. **createAccount 数据存储** (第 129-131 行)
   ```javascript
   sessionIdLimitEnabled: sessionIdLimitEnabled.toString(),
   sessionIdMaxCount: sessionIdMaxCount.toString(),
   sessionIdWindowMinutes: sessionIdWindowMinutes.toString()
   ```

3. **updateAccount 方法** (第 408-416 行)
   ```javascript
   if (updates.sessionIdLimitEnabled !== undefined) {
     updatedData.sessionIdLimitEnabled = updates.sessionIdLimitEnabled.toString()
   }
   // ... 其他两个字段
   ```

4. **getAllAccounts 方法返回** (第 244-247 行)
   ```javascript
   sessionIdLimitEnabled: accountData.sessionIdLimitEnabled === 'true',
   sessionIdMaxCount: parseInt(accountData.sessionIdMaxCount) || 0,
   sessionIdWindowMinutes: parseInt(accountData.sessionIdWindowMinutes) || 0
   ```

---

#### 2.3 Claude 官方账户服务 (src/services/claudeAccountService.js)

**修改位置：**

1. **createAccount 方法** (第 80-82 行) - 添加参数
2. **createAccount 数据存储** (第 129-131, 165-167 行) - 两处存储逻辑
3. **updateAccount allowedUpdates** (第 666-668 行) - 允许更新这些字段
4. **getAllAccounts 返回** (第 574-577 行) - 返回这些字段

---

#### 2.4 统一调度器 (src/services/unifiedClaudeScheduler.js)

**核心修改：**

1. **导入 sessionHelper** (第 9 行)
   ```javascript
   const sessionHelper = require('../utils/sessionHelper')
   ```

2. **selectAccountForApiKey 方法** (第 152 行)
   ```javascript
   const { excludedAccounts = [], requestBody = null } = options
   ```

3. **_getAllAvailableAccounts 方法** (第 361 行)
   - 添加 `requestBody` 参数
   - 提取 sessionId (第 369-376 行)
   ```javascript
   let currentSessionId = null
   if (requestBody) {
     currentSessionId = sessionHelper.extractSessionUUID(requestBody)
   }
   ```

4. **Claude 官方账户过滤** (第 546-572 行)
   ```javascript
   // 📋 检查 sessionId 限制（如果启用）
   if (currentSessionId && account.sessionIdLimitEnabled === 'true') {
     const maxCount = parseInt(account.sessionIdMaxCount) || 0
     const windowMinutes = parseInt(account.sessionIdWindowMinutes) || 0

     if (maxCount > 0 && windowMinutes > 0) {
       const sessionIds = await redis.getAccountSessionIds(account.id, windowMinutes)
       const currentCount = sessionIds.length
       const sessionIdList = sessionIds.map(s => s.sessionId)
       const isCurrentSessionInList = sessionIdList.includes(currentSessionId)

       if (currentCount >= maxCount && !isCurrentSessionInList) {
         logger.info(`🚫 Official account ${account.name} reached sessionId limit`)
         continue  // 跳过该账户
       }
     }
   }
   ```

5. **Claude Console 账户批量检查** (第 669-726 行)
   ```javascript
   // 📋 批量查询所有账户的 sessionId 数量（Promise.all 并行执行）
   if (accountsNeedingSessionIdCheck.length > 0) {
     const sessionIdCheckPromises = accountsNeedingSessionIdCheck.map(...)
     const sessionIdResults = await Promise.all(sessionIdCheckPromises)

     for (const { checkInfo, sessionIds } of sessionIdResults) {
       const isCurrentSessionInList = sessionIdList.includes(currentSessionId)

       if (currentCount >= maxCount && !isCurrentSessionInList) {
         continue  // 跳过该账户
       }
     }
   }
   ```

---

#### 2.5 中继服务 (src/services/claudeRelayService.js)

**修改位置：第 134 行**

```javascript
accountSelection = await unifiedClaudeScheduler.selectAccountForApiKey(
  apiKeyData,
  sessionHash,
  requestBody.model,
  { requestBody } // ✅ 传递 requestBody 用于 sessionId 限制检查
)
```

**说明：** 有 2 处相同的调用（流式和非流式），都需要添加 `{ requestBody }` 参数。

---

### 3. 前端实现

#### 修改的文件

| 文件路径 | 修改内容 |
|---------|---------|
| **web/admin-spa/src/components/accounts/AccountForm.vue** | 添加 SessionId 限制配置 UI |

---

#### 🔑 关键：显示条件

**SessionId 限制配置只在以下账户类型中显示：**
- ✅ Claude 官方账户（`platform === 'claude'`）
- ✅ Claude Console 账户（`platform === 'claude-console'`）
- ❌ 其他平台（Gemini、OpenAI、Bedrock、Azure、Droid、CCR）不显示

**为什么需要条件判断？**
- SessionId 是 Claude Code 客户端特有的会话标识
- 只有 Claude 官方和 Console 账户才会接收到带 sessionId 的请求
- 其他平台不使用 sessionId，所以不需要这个配置

---

#### 3.1 表单数据初始化 (第 3807-3809 行)

```javascript
// SessionId 限制相关字段
sessionIdLimitEnabled:
  props.account?.sessionIdLimitEnabled === 'true' ||
  props.account?.sessionIdLimitEnabled === true ||
  false,
sessionIdMaxCount: props.account?.sessionIdMaxCount
  ? parseInt(props.account.sessionIdMaxCount)
  : 0,
sessionIdWindowMinutes: props.account?.sessionIdWindowMinutes
  ? parseInt(props.account.sessionIdWindowMinutes)
  : 0,
```

---

#### 3.2 新建账户表单 (第 1486-1545 行)

⚠️ **重要**：SessionId 限制配置只在 **Claude 官方**和 **Claude Console** 账户中显示！

```vue
<!-- SessionId 限制配置（Claude 官方和 Console 账户） -->
<div
  v-if="(form.platform === 'claude' || form.platform === 'claude-console') && !isEdit"
  class="space-y-4"
>
  <div class="flex items-center gap-2">
    <input
      id="sessionIdLimitEnabled-create"
      v-model="form.sessionIdLimitEnabled"
      type="checkbox"
      class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
    />
    <label for="sessionIdLimitEnabled-create">
      启用 SessionId 限制
      <span title="限制单个账户在时间窗口内最多服务的不同 sessionId 数量">
        <i class="fas fa-question-circle"></i>
      </span>
    </label>
  </div>

  <div v-if="form.sessionIdLimitEnabled" class="ml-6 space-y-3">
    <div>
      <label>时间窗口（分钟）</label>
      <input v-model.number="form.sessionIdWindowMinutes" type="number" min="1" />
      <p class="text-xs text-gray-500">统计窗口时长，建议 5-60 分钟</p>
    </div>

    <div>
      <label>最大 SessionId 数量</label>
      <input v-model.number="form.sessionIdMaxCount" type="number" min="1" />
      <p class="text-xs text-gray-500">窗口内最多服务的不同 sessionId 数量，建议 3-10</p>
    </div>
  </div>
</div>
```

**关键点**：
- 条件：`v-if="(form.platform === 'claude' || form.platform === 'claude-console') && !isEdit"`
- 只在新建模式（`!isEdit`）且平台为 Claude 官方或 Console 时显示
- 必须先选择正确的平台，SessionId 配置才会出现

---

#### 3.3 编辑账户表单 (第 2617-2673 行)

⚠️ **重要**：同样只在 **Claude 官方**和 **Claude Console** 账户中显示！

```vue
<!-- SessionId 限制配置（编辑模式，Claude 官方和 Console 账户） -->
<div
  v-if="form.platform === 'claude' || form.platform === 'claude-console'"
  class="space-y-4"
>
  <!-- 与新建模式相同的 UI，但 checkbox ID 为 sessionIdLimitEnabled -->
</div>
```

**关键点**：
- 条件：`v-if="form.platform === 'claude' || form.platform === 'claude-console'"`
- 编辑模式下，只有 Claude 官方或 Console 账户能看到这个配置
- 其他平台（Gemini、OpenAI、Bedrock 等）不显示此配置

---

#### 3.4 表单提交数据

**新建账户提交（第 4711-4714 行）：**
```javascript
// SessionId 限制字段
data.sessionIdLimitEnabled = form.value.sessionIdLimitEnabled || false
data.sessionIdMaxCount = form.value.sessionIdMaxCount || 0
data.sessionIdWindowMinutes = form.value.sessionIdWindowMinutes || 0
```

**编辑账户提交（第 5024-5027 行）：** 同样的代码，在更新逻辑中也有一份。

---

#### 3.5 关键：watch 函数更新 (第 5627-5629 行)

⚠️ **重要提醒**：这是最容易遗漏的地方！

在 `AccountForm.vue` 中有一个 `watch` 函数监听 `props.account` 的变化。当用户**点击编辑按钮**时，`props.account` 从 `null` 变为当前账户对象，这个 watch 会**完全重建** `form.value` 对象。

**如果在这个 watch 函数中遗漏了某些字段，那些字段在编辑模式下就无法正确显示！**

```javascript
// 位置：约第 5500 行开始的 watch 函数
watch(
  () => props.account,
  (newAccount) => {
    if (newAccount) {
      form.value = {
        // ... 其他字段 ...

        // ✅ 并发控制字段
        maxConcurrentTasks: newAccount.maxConcurrentTasks || 0,

        // ✅ SessionId 限制字段（第 5627-5629 行）- 必须添加！
        sessionIdLimitEnabled: newAccount.sessionIdLimitEnabled || false,
        sessionIdMaxCount: newAccount.sessionIdMaxCount || 0,
        sessionIdWindowMinutes: newAccount.sessionIdWindowMinutes || 0
      }
    }
  },
  { deep: true }
)
```

**为什么 `maxConcurrentTasks` 能正常显示而 `sessionId` 字段不行？**

因为 `maxConcurrentTasks` 在 watch 函数中有更新，而 `sessionId` 字段最初被遗漏了！

**添加新字段时的检查清单：**
1. ✅ `form` 对象初始化（第 3807-3809 行）
2. ✅ CREATE 模式 UI（第 1486-1545 行）+ 显示条件
3. ✅ EDIT 模式 UI（第 2617-2673 行）+ 显示条件
4. ✅ CREATE 提交逻辑（第 4711-4714 行）
5. ✅ UPDATE 提交逻辑（第 5024-5027 行）
6. ✅ **watch 函数更新（第 5627-5629 行）** ← 最容易遗漏！

---

#### 🐛 故障排除：如果字段不显示

**问题 1：新建账户时看不到 SessionId 配置**
- ✅ 检查是否选择了 Claude 官方或 Claude Console 平台
- ✅ 其他平台（Gemini、OpenAI 等）不会显示此配置
- ✅ 必须先在平台下拉菜单中选择正确的平台

**问题 2：编辑账户时看不到 SessionId 配置**
- ✅ 检查账户的 `platform` 字段是否为 `claude` 或 `claude-console`
- ✅ 打开浏览器控制台（F12），查看是否有 Vue 报错
- ✅ 检查 watch 函数是否正确更新了字段（第 5627-5629 行）

**问题 3：编辑时字段显示但没有值**
- ✅ **最常见原因**：watch 函数中遗漏了字段更新
- ✅ 检查第 5627-5629 行的 watch 函数是否包含所有三个字段
- ✅ 查看 API 返回的账户数据是否包含这些字段

**问题 4：保存后值没有生效**
- ✅ 检查 CREATE 提交逻辑（第 4711-4714 行）
- ✅ 检查 UPDATE 提交逻辑（第 5024-5027 行）
- ✅ 查看浏览器网络请求，确认字段是否被发送到后端

---

### 4. SessionId 提取逻辑

#### sessionId 格式

Claude Code 客户端在请求体的 `metadata.user_id` 字段中包含 sessionId：

```javascript
{
  "model": "claude-sonnet-4-5-20250929",
  "messages": [...],
  "metadata": {
    "user_id": "user_d98385411c93cd074b2cefd5c9831fe77f24a53e4ecdcd1f830bba586fe62cb9_account__session_17cf0fd3-d51b-4b59-977d-b899dafb3022"
  }
}
```

**格式：** `user_{64位十六进制}_account__session_{36位UUID}`

#### 提取方法

使用 `sessionHelper.extractSessionUUID(requestBody)` 提取：

```javascript
// src/utils/sessionHelper.js (已有方法)
extractSessionUUID(requestBody) {
  const userId = requestBody.metadata?.user_id
  if (!userId) return null

  const match = userId.match(/_account__session_([a-f0-9-]{36})$/)
  return match ? match[1] : null
}
```

**返回值：** `17cf0fd3-d51b-4b59-977d-b899dafb3022` (36位UUID)

---

## 使用指南

### 管理员配置

1. **登录管理界面**
   - 访问：`http://your-domain:3000/admin-next/`

2. **添加/编辑账户**
   - 选择 Claude Console 或 Claude 官方账户
   - 找到"SessionId 限制"配置区域

3. **配置参数**
   - ☑️ 勾选"启用 SessionId 限制"
   - 输入**时间窗口**（分钟）：建议 5-60
   - 输入**最大 SessionId 数量**：建议 3-10

4. **保存配置**
   - 点击保存后立即生效
   - 重新编辑可查看已保存的值

---

### 配置建议

| 使用场景 | 时间窗口 | 最大数量 | 说明 |
|---------|---------|---------|------|
| **严格限制** | 5 分钟 | 2-3 个 | 适合高价值账户，严格控制并发会话 |
| **平衡配置** | 10 分钟 | 5 个 | 平衡会话分散和用户体验 |
| **宽松限制** | 30 分钟 | 10 个 | 适合低负载场景，更灵活 |
| **禁用** | - | 0 | 不启用限制 |

---

### 日志示例

#### 正常情况

```log
📋 Extracted sessionId from request: 17cf0fd3...
✅ Console account MyAccount passed sessionId check: 2/3 (current session in list)
🔍 Selected account: MyAccount (id: abc123, type: claude-console)
```

#### 超限情况

```log
📋 Extracted sessionId from request: 28de1fe4...
🚫 Console account MyAccount reached sessionId limit: 3/3 (current session not in list, window: 5min)
✅ Console account AnotherAccount passed sessionId check: 1/3
🔍 Selected account: AnotherAccount (id: def456, type: claude-console)
```

---

## 监控和调试

### Redis 命令

#### 查看账户的 sessionId 列表

```bash
# 查看原始数据（带时间戳）
redis-cli ZRANGE account_session_ids:abc123 0 -1 WITHSCORES

# 输出示例：
# 1) "17cf0fd3-d51b-4b59-977d-b899dafb3022"
# 2) "1732012345678"
# 3) "28de1fe4-e62c-5c6a-a88e-c9badec4133f"
# 4) "1732012567890"
```

#### 查看当前数量

```bash
redis-cli ZCARD account_session_ids:abc123
# 输出：2
```

#### 手动清理过期记录

```bash
# 清理 5 分钟前的记录
redis-cli ZREMRANGEBYSCORE account_session_ids:abc123 -inf $(($(date +%s) * 1000 - 5 * 60 * 1000))
```

#### 查看 TTL

```bash
redis-cli TTL account_session_ids:abc123
# 输出：585 (秒)
```

---

### 代码调试

#### 使用 Redis 辅助方法

```javascript
const redis = require('./src/models/redis')

// 获取账户的 sessionId 详情
const sessionIds = await redis.getAccountSessionIds('account-id', 5)
console.log(sessionIds)

// 输出：
// [
//   {
//     sessionId: '17cf0fd3-d51b-4b59-977d-b899dafb3022',
//     timestamp: 1732012345678,
//     addedAt: '2025-11-18T10:25:45.678Z',
//     ageMs: 123456,
//     ageMinutes: 2
//   }
// ]
```

---

## 性能优化

### 1. 批量查询

统一调度器使用 `Promise.all` 批量查询多个账户的 sessionId 数量，避免串行等待：

```javascript
const sessionIdCheckPromises = accountsNeedingSessionIdCheck.map((checkInfo) => {
  return redis.getAccountSessionIds(account.id, windowMinutes).then((sessionIds) => ({
    checkInfo,
    sessionIds
  }))
})

const sessionIdResults = await Promise.all(sessionIdCheckPromises)
```

### 2. Lua 脚本原子操作

所有 Redis 操作使用 Lua 脚本确保原子性，避免竞态条件：

```lua
-- 添加 sessionId 并清理过期记录
local key = KEYS[1]
local sessionId = ARGV[1]
local now = tonumber(ARGV[2])
local windowStart = tonumber(ARGV[3])

redis.call('ZADD', key, now, sessionId)
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
redis.call('EXPIRE', key, ttl)

return redis.call('ZCARD', key)
```

### 3. 自动过期

- 每次添加 sessionId 时，同时清理窗口外的记录
- 设置 TTL 为 2 倍窗口时间，防止内存泄漏
- 无需定时任务清理

---

## 故障排除

### 问题 1：编辑账户时看不到已保存的配置

**症状：** 点击编辑账户，SessionId 字段显示为空或默认值

**原因：**
1. 后端 `getAllAccounts` 方法未返回这些字段
2. 前端表单初始化逻辑有误

**解决方案：**
- 检查后端 API 返回的 JSON 是否包含三个字段
- 检查前端表单数据初始化（第 3748-3758 行）

---

### 问题 2：配置无效，账户仍然服务过多 sessionId

**症状：** 配置了限制但没有生效

**排查步骤：**

1. **检查 Redis 数据**
   ```bash
   redis-cli HGET claude_console_account:abc123 sessionIdLimitEnabled
   # 应该返回 "true"
   ```

2. **检查日志**
   ```bash
   grep "sessionId limit" logs/claude-relay-*.log
   ```

3. **检查调度器逻辑**
   - 确认 `currentSessionId` 成功提取
   - 确认账户过滤逻辑执行

---

### 问题 3：所有账户都被跳过

**症状：** 请求失败，提示没有可用账户

**原因：** 所有账户的 sessionId 限制都已满

**解决方案：**
1. 增加账户数量
2. 调整限制配置（增大最大数量或延长时间窗口）
3. 检查是否有异常客户端发起大量不同 sessionId 的请求

---

## 未来扩展

### 可能的增强功能

1. **记录 sessionId 到账户**
   - 在请求成功后调用 `redis.addAccountSessionId()`
   - 用于统计和分析

2. **管理界面监控**
   - 显示每个账户当前服务的 sessionId 列表
   - 实时统计和图表

3. **动态调整**
   - 根据账户负载自动调整限制
   - 高峰期收紧，低谷期放松

4. **黑白名单**
   - 特定 sessionId 白名单（不计入限制）
   - 特定 sessionId 黑名单（拒绝服务）

---

## 技术栈

- **后端**: Node.js + Express
- **数据库**: Redis (Sorted Set)
- **前端**: Vue 3 + Composition API
- **UI框架**: Tailwind CSS + Element Plus

---

## 相关文件路径

### 后端核心文件

```
src/
├── models/
│   └── redis.js                              # Redis SessionId 追踪方法
├── services/
│   ├── claudeAccountService.js               # Claude 官方账户服务
│   ├── claudeConsoleAccountService.js        # Claude Console 账户服务
│   ├── unifiedClaudeScheduler.js             # 统一调度器（核心逻辑）
│   └── claudeRelayService.js                 # Claude 中继服务
└── utils/
    └── sessionHelper.js                      # SessionId 提取工具（已有）
```

### 前端核心文件

```
web/admin-spa/src/
└── components/
    └── accounts/
        └── AccountForm.vue                   # 账户表单（配置 UI）
```

### 文档

```
docs/
└── sessionid-limit-feature.md                # 本文档
```

---

## 版本历史

| 版本 | 日期 | 变更说明 |
|-----|------|---------|
| v1.0 | 2025-11-18 | 初始实现，支持 Claude 官方和 Console 账户 |

---

## 作者

- **功能实现**: Claude (Anthropic AI Assistant)
- **项目**: Claude Relay Service
- **文档日期**: 2025-11-18

---

## 许可证

与主项目保持一致
