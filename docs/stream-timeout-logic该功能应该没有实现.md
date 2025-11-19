# 流式超时监控与强制流式转换机制

> **创建日期**: 2025-01-10
> **版本**: v1.0
> **功能**: 针对 Sonnet/Opus 大模型的流式超时检测与自动转换

---

## 📋 功能概述

本文档说明了 Claude Relay Service 中针对大模型（Sonnet、Opus）的两个核心优化机制：

1. **强制流式转换**：自动将 Sonnet/Opus 的非流式请求转换为流式，提升错误检测速度
2. **流式超时监控**：3分钟超时检测机制，快速发现上游问题并触发账户切换

---

## 🎯 设计目标

### 问题背景

1. **大模型响应慢**：Sonnet 和 Opus 模型处理时间较长，非流式请求容易超时
2. **错误检测延迟**：非流式请求必须等待完整响应才能发现问题（可能长达10分钟）
3. **上游问题难定位**：慢响应、卡死、网络中断等问题在非流式模式下难以及时发现

### 解决方案

**核心思路**：对大模型使用流式请求 + 超时监控，出错时快速切换账户

- ✅ **流式请求优势**：错误立即可见（<100ms），部分响应可保留
- ✅ **超时监控**：3分钟绝对超时 + 30秒空闲超时，覆盖各种异常场景
- ✅ **客户端透明**：自动转换并聚合响应，客户端仍收到标准JSON格式

---

## 🏗️ 架构设计

### 1. 强制流式转换机制

#### 触发条件

```javascript
// 检测逻辑：src/utils/streamHelpers.js:shouldForceStreamForModel()
function shouldForceStreamForModel(modelName) {
  const lowerModel = modelName.toLowerCase()
  return lowerModel.includes('sonnet') || lowerModel.includes('opus')
}
```

**触发条件**：
- 客户端发送 `stream: false` 或未设置 `stream` 字段
- 模型名称包含 `sonnet` 或 `opus`（不区分大小写）

**不触发**：
- Haiku 等小模型（响应快，无需强制转换）
- 客户端已明确指定 `stream: true`

#### 转换流程

```
客户端请求 (stream: false)
    ↓
检测模型 (sonnet/opus?)
    ↓ 是
修改请求体 (stream: true)
    ↓
创建内部流 + 聚合器
    ↓
调用流式服务 → 上游API
    ↓
实时聚合SSE数据
    ↓
构建完整JSON响应
    ↓
返回给客户端 (标准格式)
```

#### 关键组件

**StreamResponseAggregator** (响应聚合器)：
```javascript
class StreamResponseAggregator {
  processSSELine(line) {
    // 解析 SSE 事件
    // - message_start: 提取 model、usage
    // - content_block_delta: 收集文本块
    // - message_delta: 更新最终 usage
  }

  buildFinalResponse() {
    // 构建标准 Claude Messages API 格式
    return {
      id: 'msg_xxx',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-xxx',
      content: [{ type: 'text', text: '聚合的完整文本' }],
      usage: { input_tokens: 100, output_tokens: 200 }
    }
  }
}
```

---

### 2. 流式超时监控机制

#### 两种超时类型

**绝对超时（Total Timeout）**：
- **定义**：从请求开始到现在的总时间
- **阈值**：180秒（3分钟）
- **用途**：防止请求无限期挂起

**空闲超时（Idle Timeout）**：
- **定义**：距离上次收到数据的时间
- **阈值**：30秒
- **用途**：检测"假活"流（连接建立但不发数据）

#### 监控器实现

```javascript
class StreamTimeoutMonitor {
  constructor(totalTimeoutMs = 180000, idleTimeoutMs = 30000) {
    this.totalTimeoutMs = totalTimeoutMs
    this.idleTimeoutMs = idleTimeoutMs
    this.lastDataTime = Date.now()
    this.startTime = Date.now()
  }

  start(onTimeout) {
    // 绝对超时：3分钟后触发
    this.totalTimeout = setTimeout(() => {
      onTimeout('TOTAL_TIMEOUT', Date.now() - this.startTime)
    }, this.totalTimeoutMs)

    // 空闲超时：每5秒检查一次
    this.idleCheckInterval = setInterval(() => {
      const idleTime = Date.now() - this.lastDataTime
      if (idleTime > this.idleTimeoutMs) {
        onTimeout('IDLE_TIMEOUT', idleTime)
        this.stop()
      }
    }, 5000)
  }

  markDataReceived() {
    this.lastDataTime = Date.now() // 重置空闲计时器
  }

  stop() {
    clearTimeout(this.totalTimeout)
    clearInterval(this.idleCheckInterval)
  }
}
```

#### 集成位置

**位置**：`src/services/claudeConsoleRelayService.js:_makeClaudeConsoleStreamRequest()`

```javascript
// 1. 创建监控器
const monitor = new StreamTimeoutMonitor(180000, 30000)

monitor.start((timeoutType, duration) => {
  // 2. 超时回调
  logger.error(`⏱️ Stream timeout: ${timeoutType} after ${duration}ms`)

  // 3. 记录超时事件
  this._handleStreamTimeout(accountId, timeoutType, duration)

  // 4. 发送错误给客户端
  this._sendSanitizedStreamError(responseStream, 504, 'Stream timeout', accountId)

  // 5. 中止请求
  reject(new Error(`Stream timeout: ${timeoutType}`))
})

// 6. 收到数据时标记
response.data.on('data', (chunk) => {
  monitor.markDataReceived() // 重置空闲计时器
  // ... 处理数据
})

// 7. 完成时停止
response.data.on('end', () => {
  monitor.stop()
})
```

---

### 3. 账户超时标记机制

#### Redis 数据结构

```
键名：claude_console_account:{accountId}:stream_timeouts
类型：Sorted Set (ZSET)
成员：{timestamp}:{timeoutType}:{duration}
分数：timestamp（用于排序和过期清理）
TTL：2小时
```

**示例数据**：
```
ZADD claude_console_account:123:stream_timeouts
  1704902400000 "1704902400000:TOTAL_TIMEOUT:180500"
  1704903000000 "1704903000000:IDLE_TIMEOUT:35000"
```

#### 超时累计与阈值

```javascript
async _handleStreamTimeout(accountId, timeoutType, duration) {
  // 1. 记录超时事件
  await claudeConsoleAccountService.recordStreamTimeout(accountId, timeoutType, duration)

  // 2. 获取1小时内超时次数
  const timeoutCount = await claudeConsoleAccountService.getStreamTimeoutCount(accountId)

  // 3. 阈值判断：2次/小时 → temp_error
  const threshold = 2
  if (timeoutCount >= threshold) {
    logger.error(`❌ Account ${accountId} exceeded timeout threshold (${timeoutCount})`)
    await claudeConsoleAccountService.markAccountTempError(accountId)
  }
}
```

**为什么是2次阈值？**
- ✅ 比5xx错误（3次）更严格：超时通常说明更严重的问题
- ✅ 允许偶发超时：网络波动可能导致单次超时
- ✅ 快速响应：连续2次超时立即切换账户

---

## ⚙️ 配置说明

### 配置文件

**位置**：`config/config.js`

```javascript
module.exports = {
  // 流式请求超时配置
  streamTimeout: {
    total: parseInt(process.env.STREAM_TOTAL_TIMEOUT) || 180000,  // 3分钟
    idle: parseInt(process.env.STREAM_IDLE_TIMEOUT) || 30000,     // 30秒
    enabled: process.env.STREAM_TIMEOUT_ENABLED !== 'false'       // 默认启用
  }
}
```

### 环境变量

```bash
# .env 文件
STREAM_TOTAL_TIMEOUT=180000      # 绝对超时（毫秒），默认3分钟
STREAM_IDLE_TIMEOUT=30000        # 空闲超时（毫秒），默认30秒
STREAM_TIMEOUT_ENABLED=true      # 是否启用，默认true
```

### 配置建议

| 场景 | total | idle | 说明 |
|------|-------|------|------|
| **生产环境（推荐）** | 180000 (3分钟) | 30000 (30秒) | 平衡检测速度与容错性 |
| **高速网络** | 120000 (2分钟) | 20000 (20秒) | 更快发现问题 |
| **不稳定网络** | 300000 (5分钟) | 60000 (60秒) | 更宽容的超时设置 |
| **调试模式** | 600000 (10分钟) | 120000 (2分钟) | 避免打断调试 |

---

## 📊 典型场景分析

### 场景 A：正常的慢响应（不超时）

```
客户端发送请求 (sonnet, stream: false)
    ↓
强制转换为流式 (stream: true)
    ↓
0s: 创建超时监控器
5s: 收到 message_start → 重置空闲计时器
10s: 收到第一个文本块 → 重置空闲计时器
30s: 持续收到数据 → 持续重置空闲计时器
60s: 收到最后数据块
61s: 流结束 → 停止监控器
    ↓
聚合完成，返回JSON ✅
```

**结果**：✅ 正常完成，无超时触发

---

### 场景 B：上游卡死（空闲超时）

```
客户端发送请求
    ↓
0s: 创建监控器
5s: 收到 message_start
10s: 收到部分文本
45s: 【30秒无新数据】→ 触发空闲超时 ⏰
    ↓
记录超时事件 → Redis +1
检查超时次数 (2次) → 标记 temp_error
发送504错误给客户端
    ↓
下次请求自动跳过此账户 ✅
```

**结果**：✅ 30秒内检测到问题，已切换账户

---

### 场景 C：上游超长响应（绝对超时）

```
客户端发送请求
    ↓
0s-180s: 持续收到数据（每10秒一次）
180s: 【达到3分钟】→ 触发绝对超时 ⏰
    ↓
记录超时事件
标记账户 (如果累计2次)
发送504错误
    ↓
账户被降级或切换 ✅
```

**结果**：✅ 3分钟硬性限制，防止无限等待

---

### 场景 D：网络中断（流错误）

```
客户端发送请求
    ↓
0-20s: 正常收到数据
20s: 网络中断 → 触发 data.on('error')
    ↓
停止监控器
发送脱敏错误
    ↓
不记录为超时（这是网络问题，非账户问题）
```

**结果**：✅ 通过 5xx 错误机制处理（另一个累计阈值）

---

## 🔧 运维管理

### 查看超时记录

```bash
# Redis CLI 查看账户超时记录
redis-cli ZRANGE "claude_console_account:123:stream_timeouts" 0 -1 WITHSCORES

# 输出示例：
# "1704902400000:TOTAL_TIMEOUT:180500"  1704902400000
# "1704903000000:IDLE_TIMEOUT:35000"    1704903000000
```

### 清理超时记录

```bash
# 清理单个账户的超时记录
redis-cli DEL "claude_console_account:123:stream_timeouts"

# 清理所有账户的超时记录
redis-cli KEYS "claude_console_account:*:stream_timeouts" | xargs redis-cli DEL
```

### 手动恢复账户

```bash
# 重置账户状态
redis-cli HSET "claude_console_account:123" status "active"

# 重置优先级
redis-cli HSET "claude_console_account:123" priority "50"
```

### 查看日志

```bash
# 查看超时相关日志
tail -f logs/claude-relay-combined.log | grep "Stream timeout"

# 查看账户标记日志
tail -f logs/claude-relay-combined.log | grep "temp_error"
```

---

## 🛠️ 故障排除

### 问题 1：频繁触发空闲超时

**症状**：
```log
⏱️ Stream timeout detected (IDLE_TIMEOUT): 35000ms
```

**可能原因**：
1. 上游真的在发送数据时卡顿
2. 网络不稳定，丢包导致数据延迟
3. 空闲超时设置过短（<30秒）

**解决方案**：
```bash
# 增加空闲超时到60秒
export STREAM_IDLE_TIMEOUT=60000

# 或在 config.js 中修改
streamTimeout: {
  idle: 60000
}
```

---

### 问题 2：绝对超时过早触发

**症状**：
```log
⏱️ Stream timeout detected (TOTAL_TIMEOUT): 180200ms
```

请求明明在正常处理，但3分钟到了就被中止。

**可能原因**：
1. 某些大型请求（如大文件分析）确实需要超过3分钟
2. 配置的绝对超时太短

**解决方案**：
```bash
# 增加绝对超时到5分钟
export STREAM_TOTAL_TIMEOUT=300000

# 或针对特定账户调整优先级（避免切换）
redis-cli HSET "claude_console_account:123" priority "10"
```

---

### 问题 3：账户被误标记为 temp_error

**症状**：
```log
❌ Account 123 exceeded timeout threshold (2 timeouts), marking as temp_error
```

但账户实际上是正常的，只是偶尔慢。

**可能原因**：
1. 2次阈值太严格
2. 短时间内出现2次正常的慢响应（如大上下文请求）

**解决方案**：

**方法1：手动清除超时记录**
```bash
# 清除超时记录
redis-cli DEL "claude_console_account:123:stream_timeouts"

# 恢复账户状态
redis-cli HSET "claude_console_account:123" status "active"
```

**方法2：修改阈值（代码级别）**
```javascript
// src/services/claudeConsoleRelayService.js:_handleStreamTimeout()
const threshold = 3 // 改为3次
```

**方法3：增加超时容忍度**
```bash
# 增加超时时间，减少误触发
export STREAM_TOTAL_TIMEOUT=300000  # 5分钟
export STREAM_IDLE_TIMEOUT=60000    # 60秒
```

---

### 问题 4：强制转换后响应格式不对

**症状**：
客户端收到的响应缺少字段或格式错误。

**可能原因**：
1. `StreamResponseAggregator` 解析 SSE 失败
2. 上游返回了非标准格式

**调试步骤**：

1. **检查日志**：
```bash
tail -f logs/claude-relay-combined.log | grep "Aggregator"
```

2. **查看聚合器状态**：
```javascript
// 在代码中添加调试日志
console.log('Aggregator collected:', aggregator.getTextLength(), 'chars')
console.log('Usage data:', JSON.stringify(aggregator.usage))
```

3. **临时禁用强制转换**：
```javascript
// src/utils/streamHelpers.js:shouldForceStreamForModel()
return false // 临时禁用，测试非流式请求
```

---

## 📈 性能影响分析

### 内存使用

**强制转换的内存开销**：
- `PassThrough` 流：约 16KB 缓冲区
- `StreamResponseAggregator`：约 4KB + 文本内容大小
- **总计**：约 20KB + 响应文本大小

**示例**：
- 小响应（1KB 文本）：约 21KB
- 中响应（10KB 文本）：约 30KB
- 大响应（100KB 文本）：约 120KB

**结论**：✅ 开销可接受，远小于原始请求的内存占用

---

### CPU 使用

**额外 CPU 消耗**：
- SSE 解析：每行约 0.1ms
- JSON 解析：每个事件约 0.05ms
- 文本拼接：O(n) 复杂度，可忽略

**示例**：
- 1000行 SSE 事件：约 150ms CPU 时间
- 对比请求总时间（秒级）：**可忽略**

**结论**：✅ CPU 开销极小

---

### 延迟影响

**端到端延迟对比**：

| 模式 | 首字节延迟 (TTFB) | 完整响应延迟 |
|------|-------------------|--------------|
| **原始流式** | ~100ms | ~30s |
| **强制转换（等待完成）** | ~30s | ~30s |
| **原始非流式** | ~30s | ~30s |

**结论**：✅ 强制转换后总延迟不变，但能获得流式错误检测的优势

---

## 🔍 监控指标

### 关键指标

1. **强制转换率**：
   - 公式：`(强制转换请求数 / 总请求数) × 100%`
   - 预期：30-50%（Sonnet/Opus占比）

2. **超时触发率**：
   - 公式：`(超时请求数 / 流式请求数) × 100%`
   - 健康值：<5%

3. **账户切换频率**：
   - 公式：`(temp_error标记次数 / 账户数) / 小时`
   - 健康值：<0.1次/账户/小时

### 日志采集

```bash
# 统计强制转换次数
grep "Force converting to stream" logs/claude-relay-combined.log | wc -l

# 统计超时次数
grep "Stream timeout detected" logs/claude-relay-combined.log | wc -l

# 统计账户标记次数
grep "marking as temp_error" logs/claude-relay-combined.log | wc -l
```

---

## 📚 相关文档

- [慢响应逻辑文档](./slow-response-logic.md) - 慢响应降级机制（已优化为手动控制）
- [流式 vs 非流式对比分析](./stream-vs-nonstream-error-detection-analysis.md) - 详细对比分析
- [配置文件](../config/config.js) - 完整配置说明
- [CLAUDE.md](../CLAUDE.md) - 项目总体文档

---

## 💡 最佳实践

### 1. 生产环境配置

```bash
# .env
STREAM_TOTAL_TIMEOUT=180000      # 3分钟，推荐
STREAM_IDLE_TIMEOUT=30000        # 30秒，推荐
STREAM_TIMEOUT_ENABLED=true      # 必须启用
```

### 2. 监控告警设置

```bash
# 超时率告警阈值：5%
if [ $(超时请求数 / 总请求数) > 0.05 ]; then
  send_alert "Stream timeout rate too high"
fi

# 账户切换频率告警：每小时>1次
if [ $(temp_error标记次数 / 小时) > 1 ]; then
  send_alert "Account switching too frequent"
fi
```

### 3. 定期维护

```bash
# 每周清理一次超时记录（避免Redis积累）
redis-cli KEYS "claude_console_account:*:stream_timeouts" | xargs redis-cli DEL

# 每月检查账户状态分布
redis-cli KEYS "claude_console_account:*" | while read key; do
  redis-cli HGET "$key" status
done | sort | uniq -c
```

---

## 🔄 版本历史

### v1.0 (2025-01-10) ⭐ 初始版本

**核心功能**：
- ✅ 强制流式转换：Sonnet/Opus 自动转换为流式请求
- ✅ 流式超时监控：3分钟绝对超时 + 30秒空闲超时
- ✅ 账户超时标记：2次/小时阈值触发 temp_error
- ✅ 响应聚合：自动聚合SSE为标准JSON格式
- ✅ 配置灵活：支持环境变量和配置文件

**设计理念**：
> 对大模型使用流式请求 + 超时监控，快速发现上游问题并切换账户，同时对客户端保持透明。

---

**文档版本**: v1.0
**最后更新**: 2025-01-10
**维护者**: Claude Relay Service Team
