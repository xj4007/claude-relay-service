# 内容安全审核系统文档 v2.6.0

## 📋 概述

内容审核系统是一个NSFW（不安全内容）检测和拦截机制，用于保护服务免受不适当内容的影响。系统会在请求发送到Claude API之前，对输入内容进行审查。

**v2.6.0 核心特性**：
- ✨ **Session级审核缓存**：同一session在30分钟内只校验一次
- ✨ **智能内容提取**：用户输入+系统提示词各截取100字符
- ✨ **宽松审核策略**：结合上下文判断，减少误判

## 🚀 Session级审核缓存

### 工作原理

1. **Session识别**：从请求中提取 `metadata.user_id` 中的会话UUID
2. **缓存检查**：检查Redis中是否已有该session的审核记录
3. **首次审核**：未缓存时，提取内容进行审核
4. **缓存结果**：审核通过后缓存30分钟

### 数据流程

```
请求到达 → 提取sessionId → 检查Redis缓存
                              ↓
                    ┌─ 存在 → 直接放行 ✅
                    │
                    └─ 不存在 → 提取审核内容(用户100字+系统100字)
                                        ↓
                                   调用审核API (Phase 1 → Phase 2)
                                        ↓
                              ┌─ 通过 → 缓存结果(TTL=30分钟) → 放行 ✅
                              └─ 违规 → 拒绝请求 ❌
```

### Redis Key 设计

- **Key格式**: `moderation_session:{sessionId}`
- **Value**: `1` (简单标记)
- **TTL**: 1800秒 (30分钟，可通过 `sessionCacheTTL` 配置)
- **示例**: `moderation_session:17cf0fd3-d51b-4b59-977d-b899dafb3022`

### Redis 查询命令

```bash
# 查看所有审核session缓存的key
redis-cli KEYS "moderation_session:*"

# 查看某个session是否已审核
redis-cli EXISTS "moderation_session:17cf0fd3-d51b-4b59-977d-b899dafb3022"

# 查看某个session的剩余TTL（秒）
redis-cli TTL "moderation_session:17cf0fd3-d51b-4b59-977d-b899dafb3022"

# 手动删除某个session的审核缓存（强制下次重新审核）
redis-cli DEL "moderation_session:17cf0fd3-d51b-4b59-977d-b899dafb3022"

# 批量删除所有审核session缓存（谨慎使用）
redis-cli KEYS "moderation_session:*" | xargs redis-cli DEL

# 统计当前缓存的session数量
redis-cli KEYS "moderation_session:*" | wc -l
```

**注意**：如果Redis配置了密码，需要加上 `-a <password>` 参数。

## 🎯 智能内容提取

### 提取规则

| 内容类型 | 提取方式 | 说明 |
|---------|---------|------|
| 用户输入 | 最后一条user消息前100字符 | 不足100字符则取全部 |
| 系统提示词 | 每个先截取100字符，再合并 | 确保每个系统提示词都被检查 |

### 审核内容格式

**单个系统提示词：**
```
[System Context]: You are a coding assistant powered by Claude...

[User Input]: 帮我写一个函数
```

**多个系统提示词（每个先截取100字符再合并）：**
```
[System Context]: You are a coding assistant powered by Claude...
You must follow the coding standards...
Always write clean and maintainable code...

[User Input]: 帮我写一个函数
```

### 为什么这样设计？

1. **宽松审核**：系统提示词在前，提供上下文（如"你是编程助手"），即使用户输入简短也能正确判断
2. **全面覆盖**：每个系统提示词都被检查，避免遗漏
3. **性能优化**：只截取关键内容，减少token消耗

## 🔧 配置说明

### config.js 配置

```javascript
contentModeration: {
  enabled: true,                              // 启用审核
  apiBaseUrl: 'https://api.siliconflow.cn',   // 审核API地址
  apiKeys: ['sk-xxxxx', 'sk-yyyyy'],          // 多API Key支持

  // 审核模型配置
  model: 'MiniMaxAI/MiniMax-M2',              // 默认模型（快速检测）
  proModel: 'Pro/deepseek-ai/DeepSeek-V3.2-Exp', // Pro模型（TPM更大）
  advancedModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', // 高级模型（复核）
  enableSecondCheck: true,                    // 启用二次审核

  // API限制
  maxTokens: 100,
  timeout: 10000,

  // 重试配置
  maxRetries: 3,
  retryDelay: 5000,
  failStrategy: 'fail-close',                 // 失败时拒绝请求

  // 熔断机制
  circuitBreakerEnabled: true,
  circuitBreakerDuration: 300000,             // 5分钟

  // 性能监控与降级
  performanceMonitoringEnabled: true,
  slowResponseThreshold: 8000,                // 8秒
  maxConsecutiveFailures: 3,
  degradationDuration: 300000,                // 5分钟

  // 🆕 Session级审核缓存配置
  sessionCacheEnabled: true,                  // 启用session级缓存（默认true）
  sessionCacheTTL: 1800,                      // 缓存时效（秒），默认30分钟
  sessionContentMaxLength: 100                // 审核内容截取长度，默认100字符
}
```

### 环境变量

```bash
# 核心配置
CONTENT_MODERATION_ENABLED=true
MODERATION_API_BASE_URL=https://api.siliconflow.cn
MODERATION_API_KEY=sk-xxxxx,sk-yyyyy

# 模型配置
MODERATION_MODEL=MiniMaxAI/MiniMax-M2
MODERATION_PRO_MODEL=Pro/deepseek-ai/DeepSeek-V3.2-Exp
MODERATION_ADVANCED_MODEL=Qwen/Qwen3-Coder-480B-A35B-Instruct
MODERATION_ENABLE_SECOND_CHECK=true

# Session级审核缓存
MODERATION_SESSION_CACHE_ENABLED=true        # 启用session级缓存
MODERATION_SESSION_CACHE_TTL=1800            # 缓存时效（秒）
MODERATION_SESSION_CONTENT_MAX_LENGTH=100    # 内容截取长度
```

## 📊 审核流程

### 二级审核机制

```
Session首次请求
    ↓
Phase 1: 默认模型快速检测
    ↓
  ┌─ 通过 (status=false) → 缓存结果 → 放行 ✅
  │
  └─ 违规 (status=true) → Phase 2: 高级模型复核
                              ↓
                    ┌─ 通过 → 误判纠正 → 缓存结果 → 放行 ✅
                    └─ 仍违规 → 记录违规日志 → 拒绝请求 ❌
```

### 故障处理

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| fail-close（默认） | 审核失败时拒绝请求 | 生产环境，安全优先 |
| fail-open | 审核失败时放行请求 | 审核服务不稳定时 |

### 熔断与降级

- **熔断器**：检测到审核API故障后，自动停用审核5分钟
- **性能降级**：连续3次慢响应或失败后，自动降级5分钟

## 📝 日志示例

```
🆕 Session cache enabled: TTL=1800s (30min), content max length=100 chars
🔍 Session 17cf0fd3... first check, performing moderation...
📝 Session content extraction: user=85chars, system=200chars, total=300chars
🔍 Session Phase 1: Moderating content with default model MiniMaxAI/MiniMax-M2
✅ Session Phase 1: Content passed moderation, allowing request
✅ Session 17cf0fd3... marked as moderated (TTL: 1800s)

# 后续同一session请求
✅ Session 17cf0fd3... already moderated, skipping check
```

## ❓ 常见问题

### Q: 为什么同一session只审核一次？

A: 为了性能优化：
- 减少审核API调用次数
- 降低延迟
- 节省成本
- 30分钟后session过期，会重新审核

### Q: 如果用户在session内切换到违规内容怎么办？

A: 这是权衡的结果：
- 30分钟内确实不会再次检测
- 但大多数用户不会这样做
- 如需更严格，可缩短 `sessionCacheTTL`

### Q: 没有sessionId时如何处理？

A: 自动回退到原有逻辑：
- 每次请求都进行审核
- 日志会显示 `⚠️ No sessionId found, falling back to original moderation logic`

### Q: 如何禁用session缓存？

A: 设置环境变量或配置：
```bash
MODERATION_SESSION_CACHE_ENABLED=false
```

---

**最后更新**：2025-12-01
**版本**：2.6.0
**维护者**：小红帽AI审核团队
