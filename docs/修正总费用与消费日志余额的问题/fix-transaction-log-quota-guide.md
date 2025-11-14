# 修复交易日志剩余额度指南



一些查询命令
 从输出可以看到：
  ⚠️  DRY RUN MODE - No changes will be made

  但是脚本说所有日志都是正确的：
  ✓ All logs are correct for flytest1
  Total logs fixed: 0

  这意味着脚本认为数据是正确的，但你在前端看到的还是不对。

  让我们排查问题

  步骤 1：获取当前实际数据

  请运行这个命令，把输出发给我：

  redis-cli get "usage:cost:total:425a5307-9bc8-4b25-b4b1-39ebaed2c9b8"

  步骤 2：获取最近一条消费日志

  redis-cli zrevrange "transaction_log:425a5307-9bc8-4b25-b4b1-39ebaed2c9b8" 0 0 WITHSCORES

  步骤 3：获取 API Key 配置

  redis-cli get "api_key:425a5307-9bc8-4b25-b4b1-39ebaed2c9b8"






## 问题说明

对于已经存在的旧消费日志记录，其中的 `remainingQuota`（剩余额度）可能基于旧代码计算，导致与当前的总费用限制不一致。

**示例问题**：
- 总费用限制显示：`$230.5111 / $1000.00`
- 消费日志剩余额度：`$781.48`
- 预期剩余：`$1000 - $230.5111 = $769.4889`
- 差异：`$781.48 - $769.4889 = $11.9911`

## 解决方案

使用修复脚本重新计算并更新交易日志中的 `remainingQuota`。

## 使用方法

### 1. 查看帮助信息

```bash
node scripts/fix-transaction-log-quota.js --help
```

### 2. 干跑模式（推荐先运行）

**先用干跑模式查看会修复哪些数据，不会实际修改**：

```bash
# 检查所有 API Key 的交易日志
node scripts/fix-transaction-log-quota.js --dry-run

# 仅检查指定的 API Key
node scripts/fix-transaction-log-quota.js --dry-run --key-id <你的keyId>
```

### 3. 实际修复

**确认无误后，执行实际修复**：

```bash
# 修复所有 API Key 的交易日志
node scripts/fix-transaction-log-quota.js

# 仅修复指定的 API Key
node scripts/fix-transaction-log-quota.js --key-id <你的keyId>
```

## 修复原理

### 计算逻辑

脚本会按照以下步骤重新计算每条交易日志的 `remainingQuota`：

1. **获取当前总成本**：
   ```javascript
   currentTotalCost = $230.5111  // 从 Redis 读取最新值
   ```

2. **倒推历史成本**：
   - 对于最新的日志：`totalCostAtTime = currentTotalCost`
   - 对于历史日志：`totalCostAtTime = currentTotalCost - 后续所有消费`

3. **重新计算剩余额度**：
   ```javascript
   remainingQuota = totalCostLimit - totalCostAtTime
   ```

### 示例流程

假设当前总成本为 `$230.5111`，总限额为 `$1000`：

```
交易日志（按时间倒序）：
┌─────────────────────┬────────┬──────────────┬─────────────────┐
│ 时间                │ 消费   │ 累计成本     │ 剩余额度        │
├─────────────────────┼────────┼──────────────┼─────────────────┤
│ 2025-01-14 10:05:00 │ $5.00  │ $230.51      │ $769.49  ✅ 最新│
│ 2025-01-14 10:00:00 │ $10.00 │ $225.51      │ $774.49  🔧 修复│
│ 2025-01-14 09:55:00 │ $15.00 │ $215.51      │ $784.49  🔧 修复│
│ 2025-01-14 09:50:00 │ $20.00 │ $200.51      │ $799.49  🔧 修复│
└─────────────────────┴────────┴──────────────┴─────────────────┘

修复后，每条日志的剩余额度都与其记录时的实际总成本一致！
```

## 输出示例

### 干跑模式输出

```
🚀 Starting transaction log quota fix...
⚠️  DRY RUN MODE - No changes will be made

🔗 Connected to Redis
📋 Found 50 API Keys to process

🔍 Processing: My API Key (abc123-...)
   Total Cost Limit: $1000
   📊 Found 15 transaction logs
   💰 Current total cost: $230.511100
   🔧 [2025-01-14T09:55:00.000Z] Fixed: $781.48 → $784.49 (diff: $3.01)
   🔧 [2025-01-14T09:50:00.000Z] Fixed: $790.20 → $799.49 (diff: $9.29)
   ✅ Fixed 2 logs for My API Key

============================================================
📊 Fix Transaction Log Quota - Summary
============================================================
Mode: DRY RUN (no changes made)
Total API Keys processed: 1
Total logs processed: 15
Total logs fixed: 2
Total errors: 0
============================================================

💡 This was a dry run. To apply changes, run without --dry-run flag.
```

### 实际修复输出

```
🚀 Starting transaction log quota fix...

🔗 Connected to Redis
📋 Found 50 API Keys to process

🔍 Processing: My API Key (abc123-...)
   Total Cost Limit: $1000
   📊 Found 15 transaction logs
   💰 Current total cost: $230.511100
   🔧 [2025-01-14T09:55:00.000Z] Fixed: $781.48 → $784.49 (diff: $3.01)
   🔧 [2025-01-14T09:50:00.000Z] Fixed: $790.20 → $799.49 (diff: $9.29)
   ✅ Fixed 2 logs for My API Key

============================================================
📊 Fix Transaction Log Quota - Summary
============================================================
Mode: LIVE (changes applied)
Total API Keys processed: 1
Total logs processed: 15
Total logs fixed: 2
Total errors: 0
============================================================

✅ Transaction logs have been successfully fixed!
   Please refresh the frontend to see the corrected remaining quotas.
```

## 注意事项

### 1. 数据保留期限

交易日志只保留 **12 小时**，因此：
- 只能修复最近 12 小时内的日志
- 超过 12 小时的日志已被自动清理

### 2. 并发安全

- 脚本会使用 Redis Pipeline 批量更新，确保原子性
- 建议在低峰期运行，避免与正在进行的请求冲突

### 3. 备份建议

虽然脚本有干跑模式，但建议在正式修复前：

```bash
# 导出当前数据作为备份
npm run data:export
```

### 4. 验证修复结果

修复完成后：

1. 刷新前端页面
2. 查看交易日志
3. 验证剩余额度是否与总费用限制一致

```
总费用限制：$230.51 / $1000.00
最新日志剩余：$769.49  ✅ 一致
计算验证：$1000 - $230.51 = $769.49  ✅ 正确
```

## 常见问题

### Q1: 脚本会修复哪些数据？

只修复满足以下条件的日志：
- API Key 设置了 `totalCostLimit` 或 `dailyCostLimit`
- 交易日志中的 `remainingQuota` 与实际计算值不一致（差异 > $0.01）
- 或者日志中缺少 `remainingQuota` 字段

### Q2: 修复后还会再次出现不一致吗？

不会！因为我们已经修复了核心代码：
- `redis.getCostStats()` 现在支持 `forceRefresh=true`
- 所有关键路径都使用强制刷新，确保读取最新数据
- 新产生的交易日志都会有准确的 `remainingQuota`

### Q3: 如何只修复特定的 API Key？

```bash
# 1. 先找到 Key ID（在前端 API Keys 列表中，或通过日志）
# 2. 运行脚本时指定 --key-id 参数
node scripts/fix-transaction-log-quota.js --key-id abc123-def456-...
```

### Q4: 修复过程中出错怎么办？

- 脚本会记录所有错误到日志
- 使用 Redis Pipeline，要么全部成功，要么全部失败
- 如果出错，可以重新运行脚本
- 如有必要，可以从备份恢复：`npm run data:import`

### Q5: 修复需要多长时间？

- 干跑模式：通常几秒钟（仅读取数据）
- 实际修复：取决于日志数量，通常每个 Key 不超过 1 秒
- 对于 50 个 API Key，预计总时间不超过 1 分钟

## 完整修复流程

### 推荐步骤

```bash
# 1. 备份当前数据
npm run data:export

# 2. 干跑模式，查看要修复的内容
node scripts/fix-transaction-log-quota.js --dry-run

# 3. 确认无误后，执行实际修复
node scripts/fix-transaction-log-quota.js

# 4. 刷新前端，验证结果
# 打开浏览器 → API Stats → 查看交易明细

# 5. 验证数据一致性
# 总费用限制显示：$X / $Y
# 交易日志剩余：$Y - $X  ✅ 应该一致
```

## 相关文档

- [总费用限制强一致性修复方案](./cost-limit-consistency-fix.md)
- [修复总结](../COST_LIMIT_FIX_SUMMARY.md)
- [快速参考](../COST_LIMIT_QUICK_REFERENCE.md)

---

**修复日期**：2025-11-14
**版本**：v1.0
**状态**：✅ 可用
