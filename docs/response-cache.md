# 响应缓存机制说明

## 📋 概述

本文档说明了 Claude Relay Service 中的响应缓存功能。该功能用于缓存**客户端断开但上游成功返回的响应**，避免客户端重试时重复请求上游 API，节省资源并提升用户体验。

---

## 🎯 设计目标

### 问题场景

```
第1次请求：
客户端 → 15秒超时断开
服务器 → 继续等待上游
上游   → 54秒返回结果 ✅（但客户端已经走了，结果被丢弃）

客户端重试（第2次请求）：
客户端 → 又发起同样的请求
服务器 → 又要等上游54秒 ❌（浪费！明明刚才已经有结果了）
```

### 解决方案

```
第1次请求：
客户端 → 15秒超时断开
服务器 → 继续等待上游
上游   → 54秒返回结果 → 💾 缓存起来（TTL: 3分钟）

客户端重试（第2次请求）：
客户端 → 发起同样的请求
服务器 → 🚀 直接从缓存返回！（秒回）
```

---

## 🔑 核心设计

### 缓存策略

- **仅缓存**：客户端断开但上游成功返回的响应（不缓存正常响应）
- **仅非流式**：目前只支持非流式响应缓存
- **成功响应**：只缓存 HTTP 200 状态码的响应
- **TTL**：180秒（3分钟）自动过期
- **大小限制**：单个响应最大 5MB

### 缓存键生成

基于请求内容生成唯一的缓存键（SHA256 哈希）：

```javascript
缓存键 = hash(
  model +           // claude-sonnet-4-5-20250929
  messages +        // 完整对话内容
  system +          // system prompt
  max_tokens +      // 最大token数
  temperature +     // 温度参数
  top_p +           // top_p参数
  top_k +           // top_k参数
  stop_sequences    // 停止序列
)
```

**不包含**：`metadata`、`stream`（这些不影响输出内容）

---

## 📁 Redis 数据结构

### 非流式响应缓存

```
键名：response_cache:{cacheKey}
类型：Hash
字段：
  - statusCode: "200"
  - headers: "{...json...}"
  - body: "{...完整响应体...}"
  - usage: "{...token使用信息...}"
  - cachedAt: "1735123456789"
TTL：180秒（3分钟）
```

### 流式响应缓存（预留，未实现）

```
键名：stream_cache:{cacheKey}
类型：List (有序)
内容：
  - [0] {"event":"message_start","data":{...}}
  - [1] {"event":"content_block_start","data":{...}}
  - [2] {"event":"content_block_delta","data":{...}}
  - [...]
TTL：180秒
```

---

## 🔧 实现细节

### 核心文件

1. **responseCacheService.js** - 缓存服务
   - 位置：`src/services/responseCacheService.js`
   - 功能：缓存键生成、缓存读写、统计信息

2. **claudeConsoleRelayService.js** - 请求代理服务（已集成缓存）
   - 位置：`src/services/claudeConsoleRelayService.js`
   - 集成点：
     - 第214-232行：请求前检查缓存
     - 第424-446行：客户端断开时存储缓存

3. **admin.js** - 管理路由（新增缓存统计端点）
   - 位置：`src/routes/admin.js`
   - 新增端点：`GET /admin/cache-stats`

### 关键代码逻辑

#### 1. 请求前检查缓存

```javascript
// claudeConsoleRelayService.js:214-232
const isStreamRequest = requestBody.stream === true
const cacheKey = responseCacheService.generateCacheKey(modifiedRequestBody, mappedModel)

if (!isStreamRequest && cacheKey) {
  const cachedResponse = await responseCacheService.getCachedResponse(cacheKey)
  if (cachedResponse) {
    // 缓存命中，直接返回
    logger.info(`🎯 [CACHE-HIT] Returning cached response | Key: ${apiKeyData.name}`)
    return {
      statusCode: cachedResponse.statusCode,
      headers: cachedResponse.headers,
      body: cachedResponse.body,
      usage: cachedResponse.usage,
    }
  }
}
```

#### 2. 客户端断开时存储缓存

```javascript
// claudeConsoleRelayService.js:424-446
if (clientDisconnected) {
  logger.warn(`⚠️ Client timeout too short! Upstream responded in ${upstreamDuration}ms`)

  // 💾 缓存响应（仅非流式且成功的响应）
  if (!isStreamRequest && response.status === 200 && cacheKey && response.data) {
    let usage = null
    if (response.data.usage) {
      usage = response.data.usage
    }

    responseCacheService
      .cacheResponse(
        cacheKey,
        {
          statusCode: response.status,
          headers: response.headers,
          body: response.data,
          usage: usage,
        },
        180 // TTL: 3分钟
      )
      .catch((err) => {
        logger.error(`❌ Failed to cache response: ${err.message}`)
      })
  }
}
```

---

## 📊 监控和统计

### 缓存统计端点

```bash
GET /admin/cache-stats
```

**响应示例：**

```json
{
  "success": true,
  "data": {
    "responseCacheCount": 5,
    "responseCacheSizeMB": "1.23",
    "streamCacheCount": 0,
    "ttlSeconds": 180,
    "maxCacheSizeMB": 5
  }
}
```

### 日志标识符

#### 缓存命中

```log
🎯 [CACHE-HIT] Returning cached response | Key: augmunt | Acc: anyrouter-duck
```

#### 缓存存储

```log
💾 Cached response: a1b2c3d4... | Size: 123.45KB | TTL: 180s
```

#### 缓存未命中

```log
📋 Cache miss: a1b2c3d4...
```

---

## 🔍 Redis 调试命令

### 查看缓存键

```bash
# 查看所有缓存键
redis-cli KEYS "response_cache:*"

# 查看某个缓存的详细信息
redis-cli HGETALL "response_cache:{cacheKey}"

# 查看缓存剩余TTL
redis-cli TTL "response_cache:{cacheKey}"
```

### 手动清理缓存

```bash
# 清除所有响应缓存
redis-cli KEYS "response_cache:*" | xargs redis-cli DEL

# 清除特定缓存
redis-cli DEL "response_cache:{cacheKey}"
```

### 查看缓存大小

```bash
# 查看某个缓存的body大小
redis-cli HGET "response_cache:{cacheKey}" body | wc -c
```

---

## 🎯 使用场景

### 适用场景 ✅

1. **客户端超时设置过短**
   - 客户端15秒超时，但上游需要30-60秒
   - 客户端重试时可以立即从缓存获取结果

2. **大型 Prompt Caching 请求**
   - 首次请求需要较长时间计算缓存
   - 客户端等不及断开，重试时立即返回

3. **网络波动导致的断开**
   - 客户端网络不稳定提前断开
   - 重连后可以快速获取结果

### 不适用场景 ❌

1. **流式响应**（未实现流式缓存）
2. **需要实时数据的场景**（缓存可能过时）
3. **错误响应**（只缓存成功响应）
4. **正常完成的请求**（无需缓存）

---

## ⚙️ 配置参数

### 缓存服务配置

位置：`src/services/responseCacheService.js`

```javascript
class ResponseCacheService {
  constructor() {
    this.CACHE_PREFIX = 'response_cache:'        // 缓存键前缀
    this.STREAM_CACHE_PREFIX = 'stream_cache:'   // 流缓存前缀
    this.DEFAULT_TTL = 180                        // 默认TTL：3分钟
    this.MAX_CACHE_SIZE = 5 * 1024 * 1024        // 最大5MB
  }
}
```

### 修改 TTL

```javascript
// claudeConsoleRelayService.js:441
responseCacheService.cacheResponse(
  cacheKey,
  response,
  300  // 改为5分钟
)
```

### 修改最大缓存大小

```javascript
// responseCacheService.js
this.MAX_CACHE_SIZE = 10 * 1024 * 1024  // 改为10MB
```

---

## 🔄 工作流程

### 完整流程图

```
客户端请求
    ↓
生成缓存键 (cacheKey)
    ↓
检查缓存是否存在？
    ├─ 是 → 🎯 缓存命中 → 立即返回结果
    └─ 否 → 发送请求到上游
              ↓
        客户端保持连接？
          ├─ 是 → 上游响应 → 正常返回（不缓存）
          └─ 否 → 客户端断开
                    ↓
              等待上游响应（120秒）
                    ↓
              上游成功返回？
                ├─ 是 → 💾 缓存响应（TTL: 180s）
                └─ 否 → 记录错误（不缓存）
```

---

## 🛠️ 故障排除

### 问题1：缓存未命中

**症状：**

```log
📋 Cache miss: a1b2c3d4...
```

但明明刚才请求过相同内容。

**原因：**

- 请求参数有微小差异（如 temperature、max_tokens）
- 消息内容有变化
- 缓存已过期（超过180秒）

**解决：**

```bash
# 检查缓存键是否存在
redis-cli KEYS "response_cache:*"

# 查看缓存内容
redis-cli HGETALL "response_cache:{cacheKey}"
```

### 问题2：缓存占用过大

**症状：**

```log
⚠️ Response too large to cache: 6.78MB > 5MB
```

**原因：**

- 响应体超过 5MB 限制

**解决：**

```javascript
// 修改 responseCacheService.js
this.MAX_CACHE_SIZE = 10 * 1024 * 1024  // 增加到10MB
```

### 问题3：缓存未生效

**症状：**

客户端重试仍然等待很久。

**检查步骤：**

1. 确认请求是非流式（`stream: false` 或未设置）
2. 检查上游返回状态码是 200
3. 查看日志是否有缓存存储记录
4. 检查 Redis 连接是否正常

---

## 📈 性能优化建议

### 1. 调整 TTL

根据实际场景调整缓存过期时间：

- **快速迭代场景**：60-120秒（避免返回过时结果）
- **稳定内容场景**：300-600秒（更长的缓存复用）

### 2. 监控缓存命中率

```bash
# 通过日志统计
grep "CACHE-HIT" logs/claude-relay-*.log | wc -l
grep "Cache miss" logs/claude-relay-*.log | wc -l
```

### 3. 定期清理过期缓存

Redis 会自动删除过期键，但可以手动触发：

```bash
redis-cli --scan --pattern "response_cache:*" | while read key; do
  ttl=$(redis-cli TTL "$key")
  if [ "$ttl" -lt 0 ]; then
    redis-cli DEL "$key"
  fi
done
```

---

## 🚀 未来扩展

### 流式响应缓存（TODO）

**挑战：**

- 需要完整接收所有 chunks
- 重放时的时序问题（立即发送 vs 模拟延迟）
- 内存占用较大

**实现思路：**

1. 创建流缓存收集器
2. 边接收边缓存每个 chunk
3. 收到 `message_stop` 事件后标记完整
4. 重放时立即发送所有 chunks（选项A）

### 智能缓存管理

- **LRU 淘汰策略**：缓存数量超限时淘汰最少使用的
- **缓存预热**：常用请求提前缓存
- **缓存命中率统计**：实时监控缓存效率

---

## 📚 相关文档

- [slow-response-logic.md](./slow-response-logic.md) - 慢速响应降级机制
- [CLAUDE.md](../CLAUDE.md) - 项目完整文档
- [config.example.js](../config/config.example.js) - 配置示例

---

## 📝 版本历史

### v1.0 (2025-01-09)

- ✅ 实现非流式响应缓存
- ✅ 基于请求内容的缓存键生成
- ✅ 客户端断开时自动缓存上游成功响应
- ✅ 缓存统计端点（`/admin/cache-stats`）
- ✅ TTL 自动过期（180秒）
- ✅ 大小限制（5MB）

---

**最后更新：2025-01-09**
