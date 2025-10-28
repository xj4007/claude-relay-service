# 内容安全审核系统文档

## 📋 概述

内容审核系统是一个严格的NSFW（不安全内容）检测和拦截机制，用于保护服务免受不适当内容的影响。系统会在请求发送到Claude API之前，对**所有输入内容**进行审查。

## 🎯 核心功能

### 1. 全面内容审核

#### 审核范围

- ✅ **最后一条 user 消息** + **倒数第一条 assistant 回复**（上下文审核）
- ✅ 所有 **system 角色** 的系统提示词
- ✅ 支持多轮对话上下文，避免编���讨论被误判
- ✅ 支持多模态内容（文本、代码等）

#### 审核覆盖场景

| 场景       | 说明                                               |
| ---------- | -------------------------------------------------- |
| 单轮对话   | 审核用户输入（首次对话,无assistant上下文）         |
| 多轮对话   | 审核**最后一条user消息 + 倒数第一条assistant回复** |
| 编程上下文 | 通过assistant回复识别编程讨论,避免技术词汇被误判   |
| 混合内容   | 同时审核 user+assistant 消息和 system 消息         |
| 数组格式   | 支持 `[{type: "text", text: "..."}, ...]` 格式     |

### 2. 严格的NSFW检测

#### 禁止内容列表

- 🚫 **性/成人内容**：色色、搞黄、涩涩、NSFW、裸体、性爱等
- 🚫 **暴力内容**：恐怖、自伤、攻击等
- 🚫 **违法内容**：毒品、武器、黑客等
- 🚫 **仇恨言论**：歧视性内容
- 🚫 **脏话/辱骂**：草泥马、操、傻逼等
- 🚫 **政治攻击**：攻击性政治言论

#### 允许的内容

- ✅ 技术讨论（代码、API、架构、算法）
- ✅ 学术资料和研究讨论
- ✅ 编程教学和示例
- ✅ 系统设计讨论

### 3. 完整的违规追踪

#### 日志记录的信息

当检测到违规内容时，系统会记录以下完整信息：

```javascript
{
  "timestamp": "2025-01-15T10:30:45.123Z",     // 违规时间
  "apiKey": "user_app_key_001",                 // API Key名称
  "keyId": "cr_xxxxx",                          // API Key ID
  "userId": "user_12345",                       // 用户ID
  "sensitiveWords": ["色色", "NSFW"],          // 检测到的违规词汇
  "messageCount": 5,                            // 消息总数
  "fullContent": "..."                          // 完整的输入内容
}
```

#### 日志位置

- 主日志：`logs/claude-relay-*.log`
- 检索关键词：`🚨 NSFW Violation Detected`

### 4. 故障处理策略

系统支持两种故障处理策略，可根据实际情况选择：

#### Fail-Close（故障关闭，默认策略）

- ❌ 审核API调用失败 → **拒绝请求**
- ❌ 审核服务异常 → **拒绝请求**
- ✅ 内容通过审核 → **允许请求**
- 🛡️ **适用场景**：生产环境，安全优先，可接受少量误杀

#### Fail-Open（故障放行）

- ⚠️ 审核API调用失败 → **放��请求**（避免误杀）
- ⚠️ 审核服务异常 → **放行请求**（避免误杀）
- ✅ 内容通过审核 → **允许请求**
- 🎯 **适用场景**：审核服务不稳定时，用户体验优先，降低误杀率

#### 重试机制

- 📌 **模��级联重试**：
  1. 先用默认模型重试 3 次
  2. 如果失败，换成 Pro 模型重试 3 次（TPM更大）
  3. 如果还失败，切换到下一个 API Key
  4. 对新 Key 重复步骤 1-2
- ⏳ 指数退避延迟：5s → 10s
- 🔄 所有模型和 Key 都耗尽后，根据 `failStrategy` 决定是拒绝还是放行

## 🔧 使用方式

### 启用审核

在 `config/config.js` 中配置：

```javascript
module.exports = {
  // ... 其他配置

  contentModeration: {
    enabled: true, // 启用审核
    apiBaseUrl: 'https://api.siliconflow.cn', // 硅基流动API地址

    // 🔑 多API Key支持（推荐）：逗号分隔多个key，自动去除空格
    apiKeys: ['sk-xxxxx', 'sk-yyyyy', 'sk-zzzzz'],
    // 或者使用单个key（向后兼容）
    apiKey: 'sk-xxxxx', // 单个审核API密钥（如果提供apiKeys则忽略）

    // 三级审核模型配置
    model: 'deepseek-ai/DeepSeek-V3.2-Exp', // 默认模型（快速检测）
    proModel: 'Pro/deepseek-ai/DeepSeek-V3.2-Exp', // Pro模型（TPM更大，重试时备选）
    advancedModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', // 高级模型（高精度）
    enableSecondCheck: true, // 启用二次审核（默认true）

    // API限制
    maxTokens: 100, // 最大响应token数
    timeout: 10000, // 超时时间（毫秒）

    // 重试配置
    maxRetries: 3, // 单个模型最多重试次数
    retryDelay: 5000, // 初始延迟（毫秒，会递增：5s, 10s）

    // 故障策略：当所有API Key和模型都失败时的行为
    // - 'fail-close'（默认，推荐）: 审核服务不可用时拒绝请求，确保安全但可能误杀正常用户
    // - 'fail-open': 审核服务不可用时放行请求，避免误杀但安全性降低
    failStrategy: 'fail-close'
  }
}
```

### 多API Key + 模型级联轮询机制

当配置多个API Key时，系统会自动实现**智能轮询 + 模型级联重试**：

1. **优先使用第一个Key + 默认模型**：所有请求首先尝试第一个Key的默认模型
2. **模型级联重试**：如果默认模型连续失败3次，切换到Pro模型重试3次
3. **自动切换到下一个Key**：如果Pro模型也失败3次，切换到第二个Key
4. **新Key重复模型级联**：对新Key也执行默认模型→Pro模型的级联重试
5. **轮询所有Key**：依次尝试所有配置的Key（每个Key都尝试2个模型）
6. **失败后拒绝**：所有Key和模型都耗尽后才拒绝请求

**适用场景**：

- ✅ 应对硅基流动的RPM/TPM限流（Pro模型TPM更大）
- ✅ 提高服务可用性和容错能力
- ✅ 多账户负载分担
- ✅ 自动降级到高TPM模型

**示例日志**：

```
🔑 Using API Key 1/3: sk-abc...xyz
📋 Key 1 - Trying Default Model (1/2): deepseek-ai/DeepSeek-V3.2-Exp
🔄 Key 1 - Default Model - Attempt 1/3
❌ Key 1 - Default Model - Attempt 3 threw error: rate limit exceeded
🔄 Switching to Pro Model (higher TPM)...
📋 Key 1 - Trying Pro Model (2/2): Pro/deepseek-ai/DeepSeek-V3.2-Exp
🔄 Key 1 - Pro Model - Attempt 1/3
✅ Moderation succeeded! Key 1, Pro Model, attempt 1
```

### 环境变量配置（可选）

```bash
# .env 文件
CONTENT_MODERATION_ENABLED=true
CONTENT_MODERATION_API_BASE_URL=https://api.siliconflow.cn

# 🔑 多API Key配置（逗号分隔，推荐）
MODERATION_API_KEY=sk-xxxxx,sk-yyyyy,sk-zzzzz
# 或使用别名
MODERATION_API_KEYS=sk-xxxxx,sk-yyyyy,sk-zzzzz

# 三级审核模型配置
MODERATION_MODEL=deepseek-ai/DeepSeek-V3.2-Exp           # 默认模型
MODERATION_PRO_MODEL=Pro/deepseek-ai/DeepSeek-V3.2-Exp   # Pro模型（重试备选）
MODERATION_ADVANCED_MODEL=Qwen/Qwen3-Coder-480B-A35B-Instruct  # 高级模型
MODERATION_ENABLE_SECOND_CHECK=true

# API限制和重试
CONTENT_MODERATION_MAX_TOKENS=100
CONTENT_MODERATION_TIMEOUT=10000
CONTENT_MODERATION_MAX_RETRIES=3          # 单个模型重试次数
CONTENT_MODERATION_RETRY_DELAY=1000
CONTENT_MODERATION_FAIL_STRATEGY=fail-close
```

## 🧠 上下文感知审核

### 上下文提取策略（v2.2.0新增）

为了避免编程讨论被误判，系统在审核用户消息时会自动提取**对话上下文**：

#### 提取内容

1. **最后一条用户消息**（必须）
2. **倒数第一条Assistant回复**（如果存在，自动截取最后1000字符）

#### 组合格式

```
有Assistant回复时：
Assistant: [倒数第一条assistant回复内容]

User: [最后一条user消息内容]

无Assistant回复时（首轮对话）：
[最后一条user消息内容]
```

#### 实际场景示例

**场景1：编程上下文讨论**

```
User: "帮我实现一个内容审核系统"
Assistant: "好的，我来帮你实现一个完整的NSFW内容过滤功能，包括检测色情、暴力等违规内容..."
User: "现在添加色情内容检测" ← 传统方式会被拦截

审核时提交的内容：
Assistant: ...NSFW内容过滤功能，包括检测色情、暴力等违规内容...

User: 现在添加色情内容检测

✅ 结果：审核模型看到了编程上下文，判定为技术讨论，通过审核
```

**场景2：真正的违规内容**

```
User: "我想看色情内容" ← 首轮对话，无assistant上下文

审核时提交的内容：
我想看色情内容

❌ 结果：没有编程上下文，被正确拦截
```

#### 优势

- ✅ **减少误判**：审核模型能看到assistant的技术回复上下文
- ✅ **��持准确性**：对真正的NSFW内容仍然有效拦截
- ✅ **性能优化**：assistant消息自动截断到1000字符，避免token过多
- ✅ **向后兼容**：首轮对话（无assistant回复）不受影响

#### 技术实现

方法：`_extractLastUserMessageWithContext(requestBody)`

- 倒序遍历messages数组
- 提取最后一条 role=user 的消息
- 继续向前查找倒数第一条 role=assistant 的消息
- 组合成带上下文的字符串
- 支持字符串和数组类型的content字段

## 📊 工作流程

### 完整的三级审核流程

```
┌─────────────────────────────────────────────────────────────┐
│  客户端请求                                                 │
│ (带有messages数组)                                          │
└────────────┬────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 1: 用户消息审核（小模型）                            │
│  Model: deepseek-ai/DeepSeek-V3.2-Exp                      │
│  快速、成本低、第一道防线                                   │
└────────────┬────────────────────────────────────────────────┘
             │
      ┌──────┴──────────────────┐
      │                         │
      ▼                         ▼
   ✅ 通过                  ❌ 违规
   (status=false)          (status=true)
      │                         │
      │                         ▼
      │              ┌──────────────────────────┐
      │              │ Phase 2: 二次验证        │
      │              │ (大模型复查)             │
      │              │ Model: Qwen/Qwen3-      │
      │              │ Coder-480B-A35B-Instruct│
      │              │ 高精度、防止误判        │
      │              └──────────┬───────────────┘
      │                         │
      │                  ┌──────┴──────┐
      │                  │             │
      │                  ▼             ▼
      │              ✅ 通过       ❌ 仍违规
      │           (误判纠正)      (确认违规)
      │                  │             │
      │                  ▼             ▼
      │              继续检查    logNSFWViolation()
      │              系统提示词   记录完整信息
      │                  │             │
      │                  ▼             ▼
      │         ┌─────────────────┐ ┌────────────┐
      │         │ Phase 3: 系统   │ │ HTTP 400   │
      │         │ 提示词审核      │ │ 违规内容   │
      │         │ (大模型直接)    │ └────────────┘
      │         │ 仅当用户消息    │
      │         │ 通过但含NSFW词  │
      │         └────────┬────────┘
      │                  │
      │           ┌──────┴──────┐
      │           │             │
      │           ▼             ▼
      │        ✅ 通过      ❌ 违规
      │           │             │
      ▼           ▼             ▼
   继续处理   继续处理    ┌────────────┐
   请求       请求        │ HTTP 400   │
                          │ 违规内容   │
                          └────────────┘
```

### 三级审核详细说明

#### 第一级：用户消息快速检测（小模型）

- **模型**：`deepseek-ai/DeepSeek-V3.2-Exp`
- **特点**：快速、成本低、适合第一道防线
- **触发条件**：所有请求都会执行
- **结果处理**：
  - ✅ 通过（status=false, words=[]）→ 跳过系统提示词检查，直接放行
  - ⚠️ 通过但含NSFW词（status=false, words=[...]）→ 继续检查系统提示词
  - ❌ 违规（status=true）→ 触发第二级验证

#### 第二级：大模型二次验证（防止误判）

- **模型**：`Qwen/Qwen3-Coder-480B-A35B-Instruct`
- **特点**：高精度、防止技术讨论被误拦截
- **触发条件**：仅当第一级判定违规时执行
- **目的**：确认是真正的违规还是误判
- **结果处理**：
  - ✅ 通过（status=false）→ 误判纠正，继续后续流程
  - ❌ 仍违规（status=true）→ 确认违规，拒绝请求

#### 第三级：系统提示词审核（高精度）

- **模型**：`Qwen/Qwen3-Coder-480B-A35B-Instruct`（直接使用大模型）
- **特点**：系统提示词只检查一次，使用最高精度模型
- **触发条件**：仅当用户消息通过且不含NSFW词，或通过但含NSFW词时执行
- **目的**：防止系统提示词中的隐藏恶意指令
- **结果处理**：
  - ✅ 通过（status=1）→ 所有审核通过，允许请求
  - ❌ 违规（status=0）→ 拒绝请求

### 成本优化策略

| 场景                 | 调用次数 | 说明                                   |
| -------------------- | -------- | -------------------------------------- |
| 合法内容（无NSFW词） | 1次      | 仅小模型，跳过系统提示词检查           |
| 合法内容（含NSFW词） | 2次      | 小模型 + 系统提示词大模型              |
| 违规内容             | 2次      | 小模型 + 大模型验证                    |
| 最坏情况             | 3次      | 小模型 + 大模型验证 + 系统提示词大模型 |

**成本节省**：相比之前的并发双检查（每次2个API调用），现在平均成本降低50-80%

## 🔍 审核API接口

### 请求格式

```javascript
POST /v1/chat/completions

{
  "model": "qwen-7b-chat",
  "messages": [
    {
      "role": "system",
      "content": "You are a content safety moderator. ..."
    },
    {
      "role": "user",
      "content": "要审核的完整内容（所有消息合并）"
    }
  ],
  "response_format": { "type": "json_object" },
  "max_tokens": 100,
  "top_p": 0.7
}
```

### 响应格式

**违规内容：**

```json
{
  "status": "true",
  "words": ["色色", "NSFW"]
}
```

**安全内容：**

```json
{
  "status": "false",
  "words": []
}
```

## 📝 错误响应

### 内容违规

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "type": "content_moderation_error",
    "message": "小红帽AI检测到违规词汇：[色色、NSFW]，禁止NSFW，多次输入违规内容将自动封禁。在终端可按ESC+ESC可返回上次输入进行修改。"
  }
}
```

### 审核服务不可用

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "type": "content_moderation_error",
    "message": "小红帽AI内容审核服务暂不可用，请稍后重试。如问题持续，请联系管理员。"
  }
}
```

## 🔐 核心实现

### 关键方法

#### `moderateContent(requestBody, apiKeyInfo)`

- **功能**：主审核入口
- **参数**：
  - `requestBody`：完整的Claude API请求体（包含messages）
  - `apiKeyInfo`：API Key信息对象 `{keyName, keyId, userId}`
- **返回**：`{passed: boolean, message?: string}`

#### `_extractAllContent(requestBody)`

- **功能**：从请求体中提取所有待审核内容
- **处理**：
  - 遍历所有消息
  - 提取 user 和 system 角色的内容
  - 支持字符串和数组格式
  - 用双换行符（`\n\n`）分隔
- **返回**：合并后的内容字符串

#### `_logNSFWViolation(requestBody, sensitiveWords, apiKeyInfo)`

- **功能**：记录NSFW违规信息
- **记录项**：
  - 时间戳
  - API Key身份信息
  - 违规词汇
  - 消息计数
  - 完整输入内容

#### `_callModerationAPIWithRetry(userInput, modelOverride)`

- **功能**：调用审核API并进行重试
- **参数**：
  - `userInput`：待审核的内容
  - `modelOverride`：可选，覆盖默认模型（用于二次审核时切换到大模型）
- **机制**：
  - 最多3次尝试
  - 指数退避延迟（1s, 2s, 3s）
  - 所有失败则返回 `{success: false}`
- **返回**：`{success: boolean, data: {status: string, words: array}}`

#### `_callModerationAPI(userInput, model)`

- **功能**：实际调用审核API
- **参数**：
  - `userInput`：待审核的内容
  - `model`：使用的模型名称（支持动态切换）
- **返回**：`{success: boolean, data: {status: string, words: array}}`

#### `_callSystemModerationAPI(systemMessages)`

- **功能**：审核系统提示词（直接使用大模型）
- **特点**：
  - 直接使用 `this.advancedModel`（高精度）
  - 系统提示词只检查一次，无需二次验证
  - 使用专门的系统提示词审核提示
- **返回**：`{success: boolean, data: {status: number}}`（status: 1=安全, 0=违规）

## 📈 监控和调试

### 查看违规日志

```bash
# 搜索所有NSFW违规
grep "🚨 NSFW Violation Detected" logs/claude-relay-*.log

# 查看特定用户的违规记录
grep "user_12345" logs/claude-relay-*.log | grep "NSFW"

# 统计违规次数
grep -c "🚨 NSFW Violation Detected" logs/claude-relay-*.log
```

### CLI检查状态

```bash
# 查看审核服务是否启用
npm run cli status

# 检查日志中的审核相关信息
npm run service:logs | grep -E "moderation|NSFW"
```

### 日志字段说明

| 字段           | 说明                 | 示例                       |
| -------------- | -------------------- | -------------------------- |
| timestamp      | ISO格式时间戳        | `2025-01-15T10:30:45.123Z` |
| apiKey         | API Key名称          | `user_app_key_001`         |
| keyId          | API Key ID           | `cr_xxxxx`                 |
| userId         | 用户ID               | `user_12345`               |
| sensitiveWords | 检测到的违规词汇数组 | `["色色", "NSFW"]`         |
| messageCount   | 本次请求的消息总数   | `5`                        |
| fullContent    | 完整的合并内容       | 所有user和system消息       |

## ⚙️ 配置说明

### 完整配置选项

```javascript
contentModeration: {
  // 核心配置
  enabled: true,                    // 是否启用审核（默认false）
  apiBaseUrl: 'https://api.siliconflow.cn', // 审核API基础地址
  apiKey: 'sk_xxxxx',              // 审核API认证密钥

  // 三级审核模型配置
  model: 'deepseek-ai/DeepSeek-V3.2-Exp',           // 默认模型（快速检测）
  proModel: 'Pro/deepseek-ai/DeepSeek-V3.2-Exp',    // Pro模型（TPM更大，重试备选）
  advancedModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', // 高级模型（高精度）
  enableSecondCheck: true,          // 启用二次审核（默认true）
                                    // false时第一级违规直接拒绝，不进行大模型验证

  // API限制
  maxTokens: 100,                  // 审核API最大响应tokens
  timeout: 10000,                  // 请求超时（毫秒，默认10s）

  // 重试策略
  maxRetries: 3,                   // 单个模型最多重试次数（默认3）
  retryDelay: 1000,                // 初始重试延迟（毫秒，默认1s）
                                   // 实际延迟: 1s, 2s, 3s, ...

  // 故障策略
  failStrategy: 'fail-close'       // 仅支持fail-close（严格模式）
                                   // API失败或异常时拒绝请求
}
```

### 环境变量映射

```bash
# 核心配置
CONTENT_MODERATION_ENABLED=true
CONTENT_MODERATION_API_BASE_URL=https://api.siliconflow.cn
CONTENT_MODERATION_API_KEY=sk_xxxxx

# 三级审核模型配置
MODERATION_MODEL=deepseek-ai/DeepSeek-V3.2-Exp           # 默认模型
MODERATION_PRO_MODEL=Pro/deepseek-ai/DeepSeek-V3.2-Exp   # Pro模型（重试备选）
MODERATION_ADVANCED_MODEL=Qwen/Qwen3-Coder-480B-A35B-Instruct  # 高级模型
MODERATION_ENABLE_SECOND_CHECK=true

# API限制
CONTENT_MODERATION_MAX_TOKENS=100
CONTENT_MODERATION_TIMEOUT=10000

# 重试策略
CONTENT_MODERATION_MAX_RETRIES=3   # 单个模型重试次数
CONTENT_MODERATION_RETRY_DELAY=1000

# 故障策略
CONTENT_MODERATION_FAIL_STRATEGY=fail-close
```

## 🚀 最佳实践

### 1. 模型级联重试的最优配置

```javascript
// 推荐配置：成本、性能和精度的最佳平衡
contentModeration: {
  enabled: true,
  apiBaseUrl: 'https://api.siliconflow.cn',
  apiKey: 'sk_xxxxx',

  // 模型级联配置
  model: 'deepseek-ai/DeepSeek-V3.2-Exp',           // 默认模型（快速检测）
  proModel: 'Pro/deepseek-ai/DeepSeek-V3.2-Exp',    // Pro模型（TPM更大，重试备选）
  advancedModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', // 高级模型（高精度验证）
  enableSecondCheck: true,          // 启用二次验证（防止误判）

  // 性能配置
  maxTokens: 100,
  timeout: 10000,                   // 10秒超时
  maxRetries: 3,                    // 每个模型重试3次
  retryDelay: 1000,
  failStrategy: 'fail-close'
}
```

**为什么选择Pro模型作为备选？**

| 特性 | 默认模型 | Pro模型 | 说明 |
| --- | --- | --- | --- |
| TPM限制 | 较低 | **更高** | Pro版TPM限制更大，适合高并发 |
| 响应速度 | 快 | 快 | 两者速度相当 |
| 成本 | 低 | 稍高 | 仅在需要时使用Pro模型 |
| 适用场景 | 常规请求 | **限流重试** | 默认模型限流时的最佳选择 |

### 2. 监控模型级联重试的执行情况

```bash
# 查看默认模型的请求
grep "Trying Default Model" logs/claude-relay-*.log

# 查看Pro模型的触发情况（说明默认模型遇到限流）
grep "Trying Pro Model" logs/claude-relay-*.log

# 查看成功的审核及使用的模型
grep "Moderation succeeded" logs/claude-relay-*.log

# 统计各模型的使用次数
grep -o "Default Model\|Pro Model" logs/claude-relay-*.log | sort | uniq -c

# 查看API Key切换情况
grep "Switching to next API Key" logs/claude-relay-*.log

# 统计被拦截的请求
grep "CONFIRMED violation after second check" logs/claude-relay-*.log | wc -l

# 统计误判被纠正的情况
grep "False positive corrected" logs/claude-relay-*.log | wc -l
```

### 3. 成本优化建议

| 场景         | 优化方案                                            |
| ------------ | --------------------------------------------------- |
| 高流量场景   | 保持三级审核，成本已优化到最低                      |
| 低误报率需求 | 启用 `enableSecondCheck: true`（默认）              |
| 极端成本控制 | 设置 `enableSecondCheck: false`（不推荐，误判率高） |
| 高精度需求   | 所有模型都用大模型（成本高，不推荐）                |

### 4. 处理技术讨论的误判

当技术讨论被误拦截时：

```bash
# 查看被拦截的具体内容
grep "CONFIRMED violation" logs/claude-relay-*.log | grep "算法\|检测\|过滤"

# 分析误判模式
grep "False positive corrected" logs/claude-relay-*.log | \
  jq -r '.sensitiveWords' | sort | uniq -c | sort -rn
```

**解决方案**：

- ✅ 三级审核已内置防误判机制（第二级大模型验证）
- ✅ 系统提示词直接用大模型（最高精度）
- 📌 如果仍有误判，可调整审核API的系统提示词

### 5. 性能监控

```bash
# 监控审核API的响应时间
grep "Moderation API" logs/claude-relay-*.log | \
  grep "responded in" | \
  sed 's/.*responded in \([0-9]*\)ms.*/\1/' | \
  awk '{sum+=$1; count++} END {print "平均响应时间: " sum/count "ms"}'

# 监控重试情况
grep "Moderation attempt" logs/claude-relay-*.log | \
  grep -c "attempt 2\|attempt 3"

# 监控超时情况
grep "timeout" logs/claude-relay-*.log | wc -l
```

### 6. 定期审查违规日志

```bash
# 每日检查违规统计
grep "🚨 NSFW Violation Detected" logs/claude-relay-$(date +%Y-%m-%d).log | wc -l

# 识别频繁违规的用户
grep "🚨 NSFW Violation Detected" logs/claude-relay-*.log | \
  jq -r '.userId' | sort | uniq -c | sort -rn

# 查看最常见的违规词汇
grep "CONFIRMED violation" logs/claude-relay-*.log | \
  jq -r '.sensitiveWords[]' | sort | uniq -c | sort -rn
```

## 🔗 相关文件

- **主服务**：`src/services/contentModerationService.js`
- **API路由**：`src/routes/api.js`（第109-130行）
- **配置文件**：`config/config.js`
- **日志输出**：`logs/claude-relay-*.log`
- **日志工具**：`src/utils/logger.js`

## ❓ 常见问题

### Q: 为什么技术讨论被拦截了？

A: 三级审核系统已内置防误判机制：

1. ✅ 第一级（小模型）快速检测
2. ✅ 第二级（大模型）自动验证，纠正误判
3. ✅ 第三级（大模型）系统提示词高精度审核

如果仍有误判，可以：

- 检查日志中的 `False positive corrected` 来确认是否被纠正
- 查看 `CONFIRMED violation` 来确认是真正的违规
- 如果大模型仍误判，可调整审核API的系统提示词

### Q: 三级审核会不会太慢？

A: 不会，成本已优化：

- **合法内容（无NSFW词）**：仅1次API调用（小模型）
- **合法内容（含NSFW词）**：2次API调用（小模型 + 系统提示词大模型）
- **违规内容**：2次API调用（小模型 + 大模型验证）
- **平均响应时间**：2-5秒（取决于网络）

### Q: 如何禁用二次验证？

A: 在 `config/config.js` 中设置：

```javascript
contentModeration: {
  enableSecondCheck: false // 禁用二次验证（不推荐���
}
```

**警告**：禁用二次验证会导致技术讨论被误拦截的风险增加。

### Q: 如何关闭审核？

A: 在 `config/config.js` 中设置：

```javascript
contentModeration: {
  enabled: false // 禁用审核
}
```

### Q: 违规日志的 fullContent 太长怎么办？

A: 日志文件会自动分割和压缩，您可以：

- 使用日志系统的查询功能过滤
- 定期归档旧日志
- 检索时使用 grep 和 jq 工具过滤关键字段

### Q: 能否针对特定用户不审核？

A: 当前版本不支持白名单。可以在应用层面实现：

1. 在中间件中对特定用户跳过审核
2. 或者在审核之前检查用户权限级别

### Q: 如何配置多个API Key？

A: 支持两种配置方式：

**方式1：环境变量（推荐）**

```bash
MODERATION_API_KEY=sk-xxxxx,sk-yyyyy,sk-zzzzz
# 或使用别名
MODERATION_API_KEYS=sk-xxxxx,sk-yyyyy,sk-zzzzz
```

**方式2：config.js**

```javascript
contentModeration: {
  apiKeys: ['sk-xxxxx', 'sk-yyyyy', 'sk-zzzzz']
}
```

系统会自动：

- 去除空格和空值
- 按顺序轮询
- 记录每个Key的成功/失败次数

### Q: 如何查看各个Key的使用情况？

A: 查看日志中的统计信息：

```bash
# 查看Key使用成功次数
grep "Key .* success:" logs/claude-relay-*.log

# 查看Key使用失败次数
grep "Key .* failure:" logs/claude-relay-*.log

# 查看Key切换情况
grep "Switching to next API Key" logs/claude-relay-*.log
```

### Q: 多个Key都失败了怎么办？

A: 系统会：

1. 尝试所有配置的Key
2. 每个Key重试`maxRetries`次（默认3次）
3. 所有Key都失败后返回fail-close错误
4. 日志会记录总尝试次数：`Total attempts: Key数量 × maxRetries`

**排查步骤**：

1. 检查所有Key的额度和状态
2. 查看是否所有Key都遇到限流
3. 考虑增加Key数量或提升配额
4. 检查网络连接和防火墙设置

### Q: API Key信息为什么很重要？

A: 它允许您：

- 🔍 追踪是谁在请求NSFW内容
- 📊 统计违规频率
- 🛡️ 实施自动封禁机制
- 📝 生成审核报告

### Q: 第二级验证用的是什么模型？

A: 默认使用 `Qwen/Qwen3-Coder-480B-A35B-Instruct`（大模型）：

- 高精度，适合验证和纠正误判
- 成本比小模型高，但仅在需要时调用
- 可通过 `advancedModel` 配置修改

### Q: 系统提示词为什么直接用大模型？

A: 因为：

1. 系统提示词只检查一次（不像用户消息可能多轮）
2. 系统提示词的安全性至关重要
3. 使用大模型确保最高精度，成本影响有限

## 📞 故障排查

### 审核服务总是超时

1. ✅ 检查网络连接
2. ✅ 验证 `apiBaseUrl` 是否正确
3. ✅ 增加 `timeout` 值
4. ✅ 检查审核API服务状态

### 日志中大量"Moderation API failed"

1. ✅ 检查 `apiKey` 是否有效
2. ✅ 确认 API 配额未超
3. ✅ 查看网络日志（启用 DEBUG_HTTP_TRAFFIC）
4. ✅ 检查防火墙/代理设置

### 无法找到违规日志

1. ✅ 确认审核已启用（`enabled: true`）
2. ✅ 搜索关键词：`🚨 NSFW`
3. ✅ 检查日志文件路径：`logs/claude-relay-*.log`
4. ✅ 确认日志级别包含 `warn`

---

## 📋 版本历史

### v2.4.0 (2025-10-28) - 优化审核策略避免TPM超限

- ✨ **重要变更**：不再包含 assistant 回复，仅审核用户最后一次输入
- 🚀 解决大 token 请求时即使使用 Pro 模型也超 TPM 的问题
- ✅ 大幅减少审核请求的 token 数量，提升审核速度
- ✅ 保持二次审核机制，通过大模型识别技术讨论，减少误判
- 🔧 修改 `_extractLastUserMessageWithContext()` 方法，移除 assistant 回复提取逻辑
- 📝 更新文档说明新的审核策略

### v2.3.0 (2025-10-27) - 模型级联重试机制

- ✨ 新增Pro模型配置（`proModel`），TPM限制更大
- ✨ 实现模型级联重试机制：默认模型 → Pro模型 → 下一个API Key
- ✨ 单个API Key支持多模型重试（默认模型3次 + Pro模型3次）
- 🚀 提升限流场景下的成功率，自动降级到高TPM模型
- 📊 优化日志输出，清晰显示当前使用的模型和重试进度
- 🔧 应对硅基流动TPM限流问题（Pro模型限制更宽松）
- 📝 完整的模型级联重试文档和最佳实践
- 🔄 向后兼容：未配置proModel时自动回退到原有逻辑

### v2.2.0 (2025-10-26) - 上下文感知审核

- ✨ 新增上下文感知审核功能：自动提取最后一条user消息+倒数第一条assistant回复
- ✨ 减少编程讨论被误判的情况
- ✨ 审核模型能看到对话上下文,更准确判断技术词汇
- ✨ Assistant消息自动截断到1000字符，优化token使用
- ✅ 保持对真正NSFW内容的拦截能力
- ✅ 向后兼容：首轮对话（无assistant回复）不受影响
- 📝 完整的上下文审核文档和示例
- 🔧 新增方法 `_extractLastUserMessageWithContext()`

### v2.1.0 (2025-10-26) - 多API Key轮询支持

- ✨ 支持配置多个审核API Key（逗号分隔）
- ✨ 智能轮询机制：单Key失败后自动切换到下一个Key
- ✨ 每个Key独立重试（默认3次），失败后切换
- ✨ 完整的Key使用统计（成功/失败次数、最后使用时间）
- ✨ Key脱敏显示（前6位+后4位），保护密钥安全
- 🔧 应对硅基流动RPM/TPM限流问题
- 🔧 提升服务可用性和容错能力
- 📝 完整的多Key配置和故障排查文档
- 📊 详细的轮询日志和统计信息

### v2.0.0 (2025-10-24) - 三级审核系统

- ✨ 实现三级审核机制（小模型 → 大模型验证 → 系统提示词审核）
- ✨ 支持动态模型切换（`modelOverride` 参数）
- ✨ 成本优化：平均成本降低50-80%
- ✨ 防误判机制：第二级大模型自动纠正技术讨论误判
- ✨ 系统提示词直接用大模型（最高精度）
- 📝 完整的三级审核流程文档
- 📝 成本优化策略说明
- 📝 监控和调试指南

### v1.0.0 (2025-01-15) - 初始版本

- 基础的NSFW检测和拦截
- 单模型审核
- 完整的违规追踪和日志记录

---

**最后更新**：2025-10-28
**版本**：2.4.0
**维护者**：小红帽AI审核团队
