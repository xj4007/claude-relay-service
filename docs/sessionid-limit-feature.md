# SessionId 限制功能文档

> **最新版本**: v1.2.1 (2025-11-19)
> **状态**: ✅ 功能完全可用（已修复账户重复选择 Bug）
> **重要提示**: ⚠️ 单账户组存在已知限制，详见配置建议章节

## 快速参考

### 功能状态

| 功能项                     | 状态        | 说明                                         |
| -------------------------- | ----------- | -------------------------------------------- |
| SessionId 提取             | ✅ 正常     | 提取完整 36 位 UUID                          |
| Redis 记录                 | ✅ 正常     | 使用 Sorted Set 存储                         |
| 限制检查（新账户选择）     | ✅ 正常     | 在 `_getAllAvailableAccounts` 中检查         |
| 限制检查（Sticky Session） | ✅ 已修复   | v1.2 修复账户排除逻辑                        |
| 账户排除机制               | ✅ 已修复   | v1.2 新增，防止重复选择超限账户              |
| 滚动窗口过期               | ✅ 正常     | 基于 Score 自动清理                          |
| TTL 自动延长               | ✅ 正常     | 每次操作重置 TTL                             |
| 调试日志                   | ✅ 完善     | 详细的分步日志                               |
| 单账户组限制               | ⚠️ 已知限制 | 单账户组可能绕过限制，建议使用多账户组或禁用 |

### 配置示例

```javascript
// 账户配置
{
  sessionIdLimitEnabled: true,    // 启用限制
  sessionIdMaxCount: 1,           // 最多 1 个 session
  sessionIdWindowMinutes: 3       // 3 分钟窗口
}
```

### Redis 查询命令

```bash
# 查看账户的所有 sessionId
redis-cli ZRANGE account_session_ids:{accountId} 0 -1 WITHSCORES

# 查看数量
redis-cli ZCARD account_session_ids:{accountId}

# 查看 TTL
redis-cli TTL account_session_ids:{accountId}

# 查看所有追踪 key
redis-cli KEYS "account_session_ids:*"
```

### 日志关键字

```bash
# 查看 sessionId 相关日志
tail -f logs/claude-relay-*.log | grep -E "SessionId"

# 关键日志标识：
# 🔍 [SessionId-Sticky] - Sticky Session 检查日志
# 🔍 [Redis-SessionId] - Redis 操作日志
# 🚫 [SessionId-Sticky] Sticky account reached sessionId limit - 超限被拒绝
# ✅ [SessionId-Sticky] Recorded sessionId - 记录成功
```

---

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

| 文件路径                                        | 修改内容                                          | 代码行数 |
| ----------------------------------------------- | ------------------------------------------------- | -------- |
| **src/models/redis.js**                         | 添加 SessionId 追踪方法 + 详细日志                | +150 行  |
| **src/services/claudeConsoleAccountService.js** | 添加字段支持                                      | +20 行   |
| **src/services/claudeAccountService.js**        | 添加字段支持                                      | +17 行   |
| **src/services/unifiedClaudeScheduler.js**      | 集成限制检查逻辑 + 记录逻辑 + Sticky Session 检查 | +250 行  |
| **src/routes/api.js**                           | 传递 requestBody 参数（4处调用点）                | +4 行    |

> **⚠️ 重要更新（2025-11-19）**：
>
> - 修复了 Sticky Session 复用时不检查限制的 Bug
> - 添加了完整的 requestBody 传递链路
> - 增强了调试日志输出
> - 完善了限制检查逻辑

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
   ;((sessionIdLimitEnabled = false), (sessionIdMaxCount = 0), (sessionIdWindowMinutes = 0))
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

3. **\_getAllAvailableAccounts 方法** (第 361 行)
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

| 文件路径                                                  | 修改内容                   |
| --------------------------------------------------------- | -------------------------- |
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
<div v-if="form.platform === 'claude' || form.platform === 'claude-console'" class="space-y-4">
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

| 使用场景     | 时间窗口 | 最大数量 | 说明                             |
| ------------ | -------- | -------- | -------------------------------- |
| **严格限制** | 5 分钟   | 2-3 个   | 适合高价值账户，严格控制并发会话 |
| **平衡配置** | 10 分钟  | 5 个     | 平衡会话分散和用户体验           |
| **宽松限制** | 30 分钟  | 10 个    | 适合低负载场景，更灵活           |
| **禁用**     | -        | 0        | 不启用限制                       |

---

### ⚠️ 重要：单账户组的特殊行为

**问题场景**：

- 当账户组**只有 1 个账户**时
- 配置了 sessionId 限制（如：`sessionIdMaxCount: 1`）
- 系统行为会与预期不同

**实际行为**：

```
Session-1 请求 → ✅ 成功（1/1）
    ↓
Session-2 请求（新会话）
    ↓
检查限制 → 🚫 超限！(1/1, Session-2 不在列表)
    ↓
删除 sticky session → 重新选择账户
    ↓
❌ 报错: "No available accounts in group" (因为唯一的账户被排除了)
    ↓
错误被捕获 → 重试
    ↓
⚠️ 重试时重新创建 sticky session → 绑定到同一账户
    ↓
✅ Session-2 请求成功 (虽然超过了限制！)
```

**根本原因**：

- 当唯一的账户因 sessionId 超限被排除后，组内没有其他可用账户
- 系统报错后触发重试机制
- 重试时重新创建了 sticky session，仍然绑定到同一账户
- 最终请求成功，**限制被绕过**

**验证方法**：

查看 Redis 中的 sessionId 列表：

```bash
redis-cli ZRANGE account_session_ids:{accountId} 0 -1 WITHSCORES
```

**预期**：应该只有 Session-1 的 sessionId
**实际**：只有 Session-1 的 sessionId（Session-2 从未被记录！）

**日志特征**：

```log
🚫 [SessionId-Sticky] Sticky account reached sessionId limit: 1/1
🧹 Cleared sticky session mapping
❌ No available accounts in group claude-augmunt

(立即)
🎯 Created new sticky session mapping: anyrouter-88code-拼车50刀 (同一账户!)
✅ Request succeeded
```

**解决方案**：

根据实际需求选择以下方案之一：

**方案 1：增加账户（推荐）** ✅

```javascript
// 添加第二个账户到组内
// Session-1 使用账户 A
// Session-2 自动切换到账户 B
```

**优点**：

- 完全符合 sessionId 限制的设计初衷
- 实现真正的会话隔离
- 提高系统可用性

**方案 2：提高 sessionId 限制**

```javascript
// 修改配置
{
  sessionIdMaxCount: 3 // 允许单账户服务多个会话
}
```

**优点**：

- 不需要添加新账户
- 仍然有限制，防止无限制占用

**缺点**：

- 失去了严格的会话隔离

**方案 3：禁用 sessionId 限制**

```javascript
// 禁用限制
{
  sessionIdLimitEnabled: false
}
```

**何时使用**：

- 只有 1 个账户，且无法增加
- 不需要会话隔离功能

**配置原则**：

- ✅ **多账户组** + sessionId 限制 = 完美搭配
- ⚠️ **单账户组** + sessionId 限制 = 限制会被绕过
- 💡 **单账户组**建议：
  - 禁用 sessionId 限制
  - 或提高 `sessionIdMaxCount` 到合理值（如 5-10）

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

### 问题 4：单账户组配置了限制但仍能请求成功 ⚠️

**症状：**

- 账户组只有 1 个账户
- 配置了 `sessionIdMaxCount: 1`
- 但多个不同的 session 都能请求成功
- Redis 中只记录了第一个 sessionId

**实际日志：**

```log
🚫 [SessionId-Sticky] Sticky account reached sessionId limit: 1/1
🧹 Cleared sticky session mapping
❌ Failed to select account from group: No available accounts in group

(立即重试)
🎯 Created new sticky session mapping: anyrouter-88code-拼车50刀 (同一账户!)
✅ Request succeeded
```

**根本原因：**

这是**已知的边界情况**，不是 Bug：

1. Session-2 因为 sessionId 超限被正确拒绝
2. 账户被加入 `excludedAccounts` 列表
3. 但组内只有 1 个账户，没有其他可用账户
4. 报错 "No available accounts"
5. 错误被捕获后**触发重试机制**
6. 重试时 `excludedAccounts` 没有传递，重新创建 sticky session
7. 绑定到同一账户，请求成功（**限制被绕过**）

**为什么 Redis 中只有一个 sessionId？**

- Session-2 从未被真正记录
- 因为在检查阶段就被拒绝了
- 只是重试时绕过了检查

**解决方案：**

**推荐方案**：增加账户数量 ✅

```bash
# 添加第二个账户到组内
# Session-1 → 账户 A
# Session-2 → 自动切换到账户 B
```

**备选方案 1**：提高限制

```javascript
{
  sessionIdMaxCount: 3 // 允许单账户服务多个会话
}
```

**备选方案 2**：禁用限制

```javascript
{
  sessionIdLimitEnabled: false // 完全禁用 sessionId 限制
}
```

**预防措施：**

- ✅ sessionId 限制功能**专为多账户组设计**
- ⚠️ 单账户组建议禁用此功能或提高限制值
- 💡 详见"配置建议"中的"单账户组的特殊行为"章节

---

## 🐛 Bug 修复记录（v1.2 - 2025-11-19）

### 问题描述

**发现时间**：2025-11-19（v1.1 发布后）

**问题现象**：

- 尽管 v1.1 修复了 sticky session 检查逻辑
- 但账户因 sessionId 超限被拒绝后，**重新选择时又选中了同一账户**
- Redis 中只记录了第一个 sessionId，新的 sessionId 永远不会被记录
- 结果：限制检查正常，但**账户排除机制失效**

**根本原因**：

**优先级冲突**：Sticky Session 优先级 > SessionId 限制优先级

具体流程：

1. ✅ Sticky session 检查发现超限
2. ✅ 删除 sticky session 映射
3. ✅ 返回 `null` 触发重新选择
4. ❌ **重新选择时没有排除该账户**
5. ❌ 选择逻辑又选中了同一账户（因为它仍然是最优选择）
6. ❌ 创建新的 sticky session 绑定到同一账户
7. ❌ 请求成功（绕过了限制！）

**示例日志**：

```
🚫 [SessionId-Sticky] Sticky account reached sessionId limit: 1/1
🧹 [SessionId-Sticky] Cleared sticky session mapping
🎯 Created new sticky session mapping: anyrouter-88code-拼车50刀 (同一账户!)
✅ Request succeeded  # ← 限制被绕过
```

### 修复内容

#### 核心修改：账户排除机制

**设计原则**：**SessionId 限制优先级 > Sticky Session 优先级**

当账户因 sessionId 超限被拒绝时：

1. ✅ 删除 sticky session 映射
2. ✅ **返回特殊对象，标记该账户需要被排除**
3. ✅ 调用方将该账户加入 `excludedAccounts`
4. ✅ 重新选择时**跳过该账户**
5. ✅ 选择其他可用账户

#### 1. 修改 `_tryReuseStickyMapping` 返回值

**文件**：`src/services/unifiedClaudeScheduler.js`

**位置**：第 1265 行

**修改前**：

```javascript
if (currentCount >= maxCount && !isCurrentSessionInList) {
  logger.warn(`🚫 Sticky account reached sessionId limit`)
  await this._deleteSessionMapping(sessionHash)
  logger.info(`🧹 Cleared sticky session mapping`)
  return null // ❌ 只返回 null，没有告知需要排除该账户
}
```

**修改后**：

```javascript
if (currentCount >= maxCount && !isCurrentSessionInList) {
  logger.warn(`🚫 Sticky account reached sessionId limit`)
  await this._deleteSessionMapping(sessionHash)
  logger.info(`🧹 Cleared sticky session mapping`)
  // ✅ 返回特殊对象，告知调用方需要排除该账户
  return { excludeAccountId: accountId, reason: 'sessionId_limit' }
}
```

#### 2. 修改 `selectAccountFromGroup` 处理逻辑

**文件**：`src/services/unifiedClaudeScheduler.js`

**位置**：第 1763-1772 行

**修改前**：

```javascript
const reusedAccount = await this._tryReuseStickyMapping(...)
if (reusedAccount) {
  return reusedAccount  // ❌ 直接返回，未检查是否是排除标记
}
```

**修改后**：

```javascript
const reusedAccount = await this._tryReuseStickyMapping(...)
// 🔍 检查是否因 sessionId 限制被拒绝
if (reusedAccount && reusedAccount.excludeAccountId) {
  logger.info(
    `🚫 [SessionId-Limit] Account ${reusedAccount.excludeAccountId} excluded due to ${reusedAccount.reason}, adding to excludedAccounts`
  )
  excludedAccounts.push(reusedAccount.excludeAccountId)
  // 继续往下走，重新选择账户
} else if (reusedAccount) {
  return reusedAccount
}
```

### 工作流程对比

#### ❌ v1.1 的错误流程

```
请求 Session-2 (新会话)
    ↓
检查 sticky session → 发现账户 A
    ↓
检查 sessionId 限制 → 超限！(1/1, Session-2 不在列表)
    ↓
删除 sticky session
    ↓
返回 null → 触发重新选择
    ↓
❌ selectAccountFromGroup 重新选择
    ↓
❌ 账户 A 仍然是最优选择（没有被排除！）
    ↓
❌ 选中账户 A
    ↓
❌ 创建新的 sticky session 绑定到账户 A
    ↓
❌ 请求成功（限制被绕过！）
```

#### ✅ v1.2 的正确流程

```
请求 Session-2 (新会话)
    ↓
检查 sticky session → 发现账户 A
    ↓
检查 sessionId 限制 → 超限！(1/1, Session-2 不在列表)
    ↓
删除 sticky session
    ↓
✅ 返回 { excludeAccountId: 'A', reason: 'sessionId_limit' }
    ↓
✅ selectAccountFromGroup 识别排除标记
    ↓
✅ 将账户 A 加入 excludedAccounts
    ↓
✅ 重新选择（跳过账户 A）
    ↓
✅ 选中账户 B
    ↓
✅ 创建 sticky session 绑定到账户 B
    ↓
✅ 请求成功（正确切换账户！）
```

### 何时可以重新使用被排除的账户？

**答案**：等待滚动窗口过期

例如配置：

- `sessionIdWindowMinutes: 3`（3 分钟窗口）
- `sessionIdMaxCount: 1`（最多 1 个 session）

**时间线**：

```
10:00 - Session-1 使用账户 A
        ├─ Redis: [Session-1(score: 10:00)]
        └─ Count: 1/1

10:02 - Session-2 请求
        ├─ 检查账户 A: 1/1，Session-2 不在列表
        ├─ 🚫 拒绝账户 A，加入 excludedAccounts
        └─ ✅ 切换到账户 B

10:04 - Session-3 请求（新会话，新的粘性会话）
        ├─ 检查账户 A:
        │   ├─ 清理 10:01 之前的记录
        │   └─ Session-1(10:00) 被清理！✂️
        ├─ Redis: [] (空)
        ├─ Count: 0/1
        └─ ✅ 账户 A 可用！选中账户 A
```

**关键点**：

- ⏰ 3 分钟后，Session-1 自动从 Redis 中清理
- ✅ 账户 A 的 sessionId 列表变空
- ✅ 下次请求时可以重新选择账户 A

### 验证测试

**测试场景**：

- 组内有 2 个账户（A、B）
- 配置：`sessionIdMaxCount: 1`, `sessionIdWindowMinutes: 3`
- 预期：Session-2 应该切换到账户 B

**测试步骤**：

1. **Session-1 请求**

```bash
# 日志输出
✅ Selected account A
✅ Recorded sessionId xxx (1/1)
```

2. **Session-2 请求（新会话）**

```bash
# v1.2 日志输出
🚫 [SessionId-Sticky] Sticky account A reached sessionId limit: 1/1
🧹 Cleared sticky session mapping
🚫 [SessionId-Limit] Account A excluded due to sessionId_limit
✅ Selected account B  # ← 正确切换！
```

3. **验证 Redis 数据**

```bash
redis-cli ZRANGE account_session_ids:A 0 -1 WITHSCORES
# 输出：只有 Session-1 ✅

redis-cli ZRANGE account_session_ids:B 0 -1 WITHSCORES
# 输出：只有 Session-2 ✅
```

**测试结果**：✅ 账户正确切换，限制完全生效

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

| 版本   | 日期       | 变更说明                                            |
| ------ | ---------- | --------------------------------------------------- |
| v1.0   | 2025-11-18 | 初始实现，支持 Claude 官方和 Console 账户           |
| v1.1   | 2025-11-19 | 🐛 修复 Sticky Session 不检查限制的 Bug + 完善实现  |
| v1.2   | 2025-11-19 | 🐛 修复账户排除机制失效的 Bug，实现正确的优先级控制 |
| v1.2.1 | 2025-11-19 | 📝 文档更新：添加单账户组的已知限制说明和解决方案   |

---

## 🐛 Bug 修复记录（v1.1 - 2025-11-19）

### 问题描述

**发现时间**：2025-11-19

**问题现象**：

- SessionId 限制配置已启用（如：3 分钟内最多 1 个 session）
- 但实际可以放行多个不同的 sessionId（如：2 个、3 个）
- Redis 中正确记录了所有 sessionId，但限制检查未生效

**根本原因**：

1. **Sticky Session 复用时缺少限制检查**
   - 代码位置：`unifiedClaudeScheduler.js` 的 `_tryReuseStickyMapping` 方法
   - 问题：当使用 sticky session（粘性会话）时，只记录 sessionId，**没有检查是否超限**
   - 影响：大部分请求都走 sticky session 路径，导致限制形同虚设

2. **requestBody 参数未传递**
   - 代码位置：`src/routes/api.js` 的 4 处 `selectAccountForApiKey` 调用
   - 问题：调用调度器时没有传递 `requestBody`，导致无法提取 sessionId
   - 影响：即使有检查逻辑，也因为拿不到 sessionId 而无法执行

### 修复内容

#### 1. 修复 Sticky Session 检查逻辑

**文件**：`src/services/unifiedClaudeScheduler.js`

**位置**：`_tryReuseStickyMapping` 方法（第 1215-1280 行）

**修改前**：

```javascript
// ❌ 只记录，不检查
if (sessionIdLimitEnabled && windowMinutes > 0) {
  await redis.addAccountSessionId(accountId, currentSessionId, windowMinutes)
  logger.info(`✅ Recorded sessionId ...`)
}
```

**修改后**：

```javascript
// ✅ 先检查，再记录
if (sessionIdLimitEnabled && windowMinutes > 0 && maxCount > 0) {
  // 1️⃣ 先查询当前列表
  const sessionIds = await redis.getAccountSessionIds(accountId, windowMinutes)
  const currentCount = sessionIds.length
  const sessionIdList = sessionIds.map((s) => s.sessionId)
  const isCurrentSessionInList = sessionIdList.includes(currentSessionId)

  // 2️⃣ 检查是否超限
  if (currentCount >= maxCount && !isCurrentSessionInList) {
    logger.warn(`🚫 Sticky account reached sessionId limit: ${currentCount}/${maxCount}`)
    // 3️⃣ 删除粘性会话映射，强制重新选择账户
    await this._deleteSessionMapping(sessionHash)
    return null // 返回 null 触发重新选择
  }

  // 4️⃣ 通过检查，记录 sessionId
  await redis.addAccountSessionId(accountId, currentSessionId, windowMinutes)
  logger.info(`✅ Recorded sessionId ... (${currentCount + 1}/${maxCount})`)
}
```

**关键改进**：

- ✅ 在记录前先检查是否超限
- ✅ 如果超限，删除 sticky session 映射，强制重新选择账户
- ✅ 添加详细的日志输出（Step 4）

#### 2. 完善 requestBody 传递链路

**文件**：`src/routes/api.js`

**修改位置**（共 4 处）：

1. **第 204 行**：流式请求账户选择

```javascript
// 修改前
{ excludedAccounts }

// 修改后
{ excludedAccounts, requestBody: req.body }
```

2. **第 733 行**：非流式降级账户选择

```javascript
// 修改前
{ excludedAccounts: allExcluded }

// 修改后
{ excludedAccounts: allExcluded, requestBody: req.body }
```

3. **第 946 行**：非流式重试账户选择

```javascript
// 修改前
{ excludedAccounts }

// 修改后
{ excludedAccounts, requestBody: req.body }
```

4. **第 1424 行**：Token 计数账户选择

```javascript
// 修改前
requestedModel

// 修改后
;(requestedModel, { requestBody: req.body })
```

**文件**：`src/services/unifiedClaudeScheduler.js`

**修改位置**（共 3 处）：

1. **第 196 行**：调用 `selectAccountFromGroup` 时传递 `requestBody`
2. **第 1706 行**：`selectAccountFromGroup` 方法签名添加 `requestBody` 参数
3. **第 1734 行**：分组内调用 `_tryReuseStickyMapping` 时传递 `requestBody`

#### 3. 增强调试日志

**文件**：`src/models/redis.js`

**位置**：`addAccountSessionId` 方法（第 1982-2039 行）

**新增日志**：

```javascript
logger.info(
  `🔍 [Redis-SessionId] addAccountSessionId called: accountId=${accountId}, sessionId=${sessionId}, windowMinutes=${windowMinutes}`
)
logger.info(
  `🔍 [Redis-SessionId] Executing Lua script: key=${key}, now=${now}, windowStart=${windowStart}`
)
logger.info(
  `✅ [Redis-SessionId] Successfully added sessionId ${sessionId} to account ${accountId} (count: ${count}, window: ${windowMinutes}min, key: ${key})`
)
```

**文件**：`src/services/unifiedClaudeScheduler.js`

**位置**：`_tryReuseStickyMapping` 方法

**新增日志**：

```javascript
logger.info(
  `🔍 [SessionId-Sticky] Step 1: requestBody exists: ${!!requestBody}, accountType: ${accountType}`
)
logger.info(`🔍 [SessionId-Sticky] Step 2: Extracted sessionId: ${currentSessionId || 'NULL'}`)
logger.info(
  `🔍 [SessionId-Sticky] Step 3: enabled=${sessionIdLimitEnabled}, window=${windowMinutes}, maxCount=${maxCount}`
)
logger.info(
  `🔍 [SessionId-Sticky] Step 4: Current count=${currentCount}/${maxCount}, isInList=${isCurrentSessionInList}`
)
logger.warn(
  `🚫 [SessionId-Sticky] Sticky account reached sessionId limit: ${currentCount}/${maxCount}`
)
logger.info(
  `🧹 [SessionId-Sticky] Cleared sticky session mapping for session ${sessionHash} due to sessionId limit`
)
logger.info(
  `✅ [SessionId-Sticky] Recorded sessionId ... (${currentCount + 1}/${maxCount}, window: ${windowMinutes}min)`
)
```

### 验证测试

**测试场景**：

- 配置：`sessionIdMaxCount: 1`, `sessionIdWindowMinutes: 3`
- 预期：3 分钟内只能服务 1 个不同的 sessionId

**测试步骤**：

1. **第一个会话请求**

```bash
# 日志输出
🔍 [SessionId-Sticky] Step 4: Current count=0/1, isInList=false
✅ [SessionId-Sticky] Recorded sessionId xxx (1/1, window: 3min)
```

2. **第二个会话请求（新 session）**

```bash
# 日志输出
🔍 [SessionId-Sticky] Step 4: Current count=1/1, isInList=false
🚫 [SessionId-Sticky] Sticky account reached sessionId limit: 1/1
🧹 [SessionId-Sticky] Cleared sticky session mapping
# 然后切换到其他账户
```

3. **验证 Redis 数据**

```bash
redis-cli ZRANGE account_session_ids:xxx 0 -1 WITHSCORES
# 输出：只有 1 个 sessionId ✅
```

**测试结果**：✅ 限制正常生效，第二个 session 被正确拒绝并切换账户

---

## 🕐 TTL 和滚动窗口机制详解

### 核心概念

SessionId 限制功能使用两个时间维度：

1. **滚动窗口（Window）**：真正的限制时间（如 3 分钟）
2. **TTL（Time To Live）**：Redis key 的保留时间（如 6 分钟 = 2 × 窗口）

### 为什么 TTL = 2 × 窗口时间？

**代码位置**：`src/models/redis.js` 第 2016 行

```javascript
const ttlSeconds = Math.ceil((windowMs * 2) / 1000)
// 窗口 3 分钟 → TTL 6 分钟
```

**原因**：

- **防止内存泄漏**：即使窗口过期，数据还会保留一段时间
- **安全余量**：确保在窗口边界附近的请求不会因为 key 过期而丢失数据
- **自动清理**：如果长时间没有新请求，Redis 会自动删除整个 key

### 滚动窗口工作原理

**每次添加 sessionId 时**：

```lua
-- 1. 添加当前 sessionId（分数 = 当前时间戳）
redis.call('ZADD', key, now, sessionId)

-- 2. 清理窗口外的过期记录
local windowStart = now - windowMinutes * 60 * 1000
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)

-- 3. 重置 TTL（每次操作都会延长）
redis.call('EXPIRE', key, ttl)

-- 4. 返回当前有效数量
return redis.call('ZCARD', key)
```

### 实际案例演示

**配置**：

- 窗口 = 3 分钟
- 限制 = 1 个 session
- 当前时间 = 10:00

#### 时间线演示

```
10:00 - Session-1 请求
├─ 添加到 Redis: score = 10:00:00
├─ 清理 09:57:00 之前的记录（窗口外）
├─ 设置 TTL = 6 分钟（过期时间: 10:06:00）
├─ 当前列表: [Session-1(10:00:00)]
└─ Count: 1/1 ✅ 成功

10:02 - Session-2 请求（新会话）
├─ 检查当前列表
├─ 清理 09:59:00 之前的记录
│   └─ Session-1(10:00:00) 还在窗口内，不清理
├─ 当前列表: [Session-1(10:00:00)]
├─ Count: 1/1, Session-2 不在列表
└─ 🚫 被拒绝！删除 sticky session，切换账户 ❌

10:03:30 - Session-2 再次请求（使用新账户）
├─ 新账户接受请求
└─ 原账户列表不变: [Session-1(10:00:00)]

10:03:30 - Session-1 再次请求
├─ 检查列表: [Session-1(10:00:00)]
├─ Session-1 在列表中
└─ ✅ 继续使用原账户（不受限制）

10:04:00 - Session-3 请求（新会话）
├─ 检查原账户列表
├─ 清理 10:01:00 之前的记录
│   └─ Session-1(10:00:00) 被清理！✂️
├─ 当前列表: []
├─ Count: 0/1
├─ 添加 Session-3: score = 10:04:00
├─ 更新 TTL = 6 分钟（新过期时间: 10:10:00）← 延长了！
└─ Count: 1/1 ✅ 成功

10:10:00 - 如果没有新请求
└─ Redis 自动删除整个 key（TTL 过期）
```

### 关键理解点

#### ✅ TTL 会延长

每次调用 `addAccountSessionId` 都会重置 TTL：

```lua
redis.call('EXPIRE', key, ttl)  -- 每次都重新设置
```

**示例**：

- T0: 创建 key，TTL = 6 分钟（10:00 → 10:06）
- T3: 新请求，TTL = 6 分钟（10:03 → 10:09）← 延长了！
- T7: 新请求，TTL = 6 分钟（10:07 → 10:13）← 再次延长！

#### ✅ SessionId 会过期（基于 Score）

真正的限制是基于**滚动窗口**，通过 Score（时间戳）判断：

```lua
-- 每次操作都清理窗口外的记录
local windowStart = now - windowMinutes * 60 * 1000
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
```

**示例**：

- 10:00:00 - 添加 Session-1（score: 10:00:00）
- 10:03:30 - 新请求，清理 10:00:30 之前的记录
  - Session-1(10:00:00) 被自动删除 ✂️

#### ✅ TTL 延长不影响单个 SessionId 过期

- TTL 只是确保 Redis key 不会因为自动清理而丢失
- 单个 sessionId 的过期由 Score（时间戳）决定
- 3 分钟后，旧的 sessionId 一定会被清理（无论 TTL 是否延长）

### Redis 数据示例

```bash
# 查看 key 中的所有 sessionId
redis-cli ZRANGE account_session_ids:xxx 0 -1 WITHSCORES

# 输出示例：
1) "5a940668-36e3-4a41-87ba-136d89b158c6"  # sessionId (完整 36 位 UUID)
2) "1763539253161"                         # score (Unix 时间戳，毫秒)
3) "14cf6608-54b1-455b-a582-0937b4bee93c"
4) "1763539556634"

# 查看 key 的 TTL
redis-cli TTL account_session_ids:xxx
# 输出：360 (6 分钟 = 360 秒)

# 查看数量
redis-cli ZCARD account_session_ids:xxx
# 输出：2
```

### 图解对比

```
时间轴 ────────────────────────────────────────────────>
        10:00      10:03      10:06      10:09      10:12

滚动窗口（3分钟）- 真正的限制机制:
        |←─ 3min ─→|
        [Session-1]  ← 10:03 后过期
                     |←─ 3min ─→|
                     [Session-2]  ← 10:06 后过期

TTL（6分钟）- 防止内存泄漏:
        |←────────── 6min ──────────→|
        (10:00 创建，10:06 过期)
                     |←────────── 6min ──────────→|
                     (10:03 延长，10:09 过期)
                                  |←────────── 6min ──────────→|
                                  (10:06 延长，10:12 过期)
```

### 常见问题

**Q1: 为什么 TTL 是 6 分钟但窗口是 3 分钟？**

A: TTL 是 Redis key 的保留时间，窗口是真正的限制时间。

- 窗口 3 分钟：sessionId 在 3 分钟后过期（通过 Score 判断）
- TTL 6 分钟：整个 key 在 6 分钟后删除（防止内存泄漏）

**Q2: 新请求会延长 TTL 吗？**

A: 是的！每次添加 sessionId 都会重置 TTL。

- 但这**不会延长旧 sessionId** 的有效期
- 旧 sessionId 仍然在 3 分钟后过期

**Q3: 第一个 session 会因为新请求而永不过期吗？**

A: 不会！第一个 session 在 3 分钟后一定会过期。

- 滚动窗口基于 Score（时间戳）判断
- 无论 TTL 如何延长，3 分钟后旧 sessionId 都会被清理

---

## 作者

- **功能实现**: Claude (Anthropic AI Assistant)
- **项目**: Claude Relay Service
- **文档日期**: 2025-11-18

---

## 许可证

与主项目保持一致
