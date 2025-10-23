# 内容安全审核系统文档

## 📋 概述

内容审核系统是一个严格的NSFW（不安全内容）检测和拦截机制，用于保护服务免受不适当内容的影响。系统会在请求发送到Claude API之前，对**所有输入内容**进行审查。

## 🎯 核心功能

### 1. 全面内容审核

#### 审核范围
- ✅ 所有 **user 角色** 的消息内容
- ✅ 所有 **system 角色** 的系统提示词
- ✅ 支持多轮对话（不仅仅是最后一条消息）
- ✅ 支持多模态内容（文本、代码等）

#### 审核覆盖场景
| 场景 | 说明 |
|------|------|
| 单轮对话 | 直接审核用户输入 |
| 多轮对话 | 审核**所有历史消息**合并后的内容 |
| 混合内容 | 同时审核 user 和 system 消息 |
| 数组格式 | 支持 `[{type: "text", text: "..."}, ...]` 格式 |

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

#### Fail-Close（故障关闭）
- ❌ 审核API调用失败 → **拒绝请求**
- ❌ 审核服务异常 → **拒绝请求**
- ✅ 内容通过审核 → **允许请求**

#### 重试机制
- 📌 最多重试 3 次
- ⏳ 指数退避延迟：1s → 2s → 3s
- 🔄 所有重试都失败后拒绝请求

## 🔧 使用方式

### 启用审核

在 `config/config.js` 中配置：

```javascript
module.exports = {
  // ... 其他配置

  contentModeration: {
    enabled: true,                    // 启用审核
    apiBaseUrl: 'https://api.qwen...',// 硅基流动API地址
    apiKey: 'sk-xxxxx',              // 审核API密钥
    model: 'qwen-7b-chat',           // 审核模型
    maxTokens: 100,                  // 最大响应token数
    timeout: 10000,                  // 超时时间（毫秒）

    // 重试配置
    maxRetries: 3,                   // 最多重试次数
    retryDelay: 1000,                // 初始延迟（毫秒）
    failStrategy: 'fail-close'       // 故障策略
  }
}
```

### 环境变量配置（可选）

```bash
# .env 文件
CONTENT_MODERATION_ENABLED=true
CONTENT_MODERATION_API_KEY=sk_xxxxx
CONTENT_MODERATION_MODEL=qwen-7b-chat
```

## 📊 工作流程

```
┌─────────────────────────┐
│  客户端请求            │
│ (带有messages数组)     │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  extractAllContent()    │
│  提取所有内容：        │
│  - 所有 user 消息     │
│  - 所有 system 消息   │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  调用审核 API          │
│ (硅基流动/Qwen)       │
│ 最多重试3次           │
└────────────┬────────────┘
             │
      ┌──────┴──────┐
      │             │
      ▼             ▼
   ✅ 通过       ❌ 违规
      │             │
      │             ▼
      │        logNSFWViolation()
      │        记录完整信息
      │             │
      │             ▼
      │        返回错误响应
      │             │
      ▼             ▼
   继续处理    ┌────────────┐
   请求        │ HTTP 400   │
              │ 违规内容   │
              └────────────┘
```

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

#### `_callModerationAPIWithRetry(content)`
- **功能**：调用审核API并进行重试
- **机制**：
  - 最多3次尝试
  - 指数退避延迟
  - 所有失败则返回 `{success: false}`

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

| 字段 | 说明 | 示例 |
|------|------|------|
| timestamp | ISO格式时间戳 | `2025-01-15T10:30:45.123Z` |
| apiKey | API Key名称 | `user_app_key_001` |
| keyId | API Key ID | `cr_xxxxx` |
| userId | 用户ID | `user_12345` |
| sensitiveWords | 检测到的违规词汇数组 | `["色色", "NSFW"]` |
| messageCount | 本次请求的消息总数 | `5` |
| fullContent | 完整的合并内容 | 所有user和system消息 |

## ⚙️ 配置说明

### 完整配置选项

```javascript
contentModeration: {
  // 核心配置
  enabled: true,                    // 是否启用审核（默认false）
  apiBaseUrl: 'https://api.qwen...', // 审核API基础地址
  apiKey: 'sk_xxxxx',              // 审核API认证密钥
  model: 'qwen-7b-chat',           // 使用的审核模型

  // API限制
  maxTokens: 100,                  // 审核API最大响应tokens
  timeout: 10000,                  // 请求超时（毫秒，默认10s）

  // 重试策略
  maxRetries: 3,                   // 最多重试次数（默认3）
  retryDelay: 1000,                // 初始重试延迟（毫秒，默认1s）
                                   // 实际延迟: 1s, 2s, 3s, ...

  // 故障策略
  failStrategy: 'fail-close'       // 仅支持fail-close（严格模式）
}
```

### 环境变量映射

```bash
CONTENT_MODERATION_ENABLED=true
CONTENT_MODERATION_API_BASE_URL=https://api.qwen...
CONTENT_MODERATION_API_KEY=sk_xxxxx
CONTENT_MODERATION_MODEL=qwen-7b-chat
CONTENT_MODERATION_MAX_TOKENS=100
CONTENT_MODERATION_TIMEOUT=10000
CONTENT_MODERATION_MAX_RETRIES=3
CONTENT_MODERATION_RETRY_DELAY=1000
```

## 🚀 最佳实践

### 1. 定期监控违规日志

```bash
# 每日检查违规统计
grep "🚨 NSFW Violation Detected" logs/claude-relay-$(date +%Y-%m-%d).log | wc -l

# 识别频繁违规的用户
grep "🚨 NSFW Violation Detected" logs/claude-relay-*.log | \
  jq -r '.userId' | sort | uniq -c | sort -rn
```

### 2. 调整超时和重试配置

- 📌 如果审核API响应慢，增加 `timeout`
- 📌 如果网络不稳定，增加 `maxRetries`
- 📌 生产环境建议 `timeout: 15000`，`maxRetries: 3`

### 3. 处理误报

- 📌 技术内容被误拦截：检查审核API的系统提示词
- 📌 增加审核API的上下文理解能力
- 📌 考虑维护白名单或例外规则

### 4. 性能优化

- 📌 审核API应部署在网络延迟低的地方
- 📌 使用轻量级审核模型（qwen-7b 而不是更大的模型）
- 📌 监控 `timeout` 导致的重试次数

## 🔗 相关文件

- **主服务**：`src/services/contentModerationService.js`
- **API路由**：`src/routes/api.js`（第109-130行）
- **配置文件**：`config/config.js`
- **日志输出**：`logs/claude-relay-*.log`
- **日志工具**：`src/utils/logger.js`

## ❓ 常见问题

### Q: 为什么技术讨论被拦截了？
A: 这通常是审核API误判。可以：
1. 检查提示词中的 EXCEPTION 部分是否足够清晰
2. 考虑增加示例说明什么是技术讨论
3. 联系审核API提供商调整模型

### Q: 如何关闭审核？
A: 在 `config/config.js` 中设置：
```javascript
contentModeration: {
  enabled: false  // 禁用审核
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

### Q: API Key信息为什么很重要？
A: 它允许您：
- 🔍 追踪是谁在请求NSFW内容
- 📊 统计违规频率
- 🛡️ 实施自动封禁机制
- 📝 生成审核报告

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

**最后更新**：2025-01-15
**版本**：1.0.0
**维护者**：小红帽AI审核团队
