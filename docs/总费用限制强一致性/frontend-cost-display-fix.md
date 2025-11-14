# 前端费用显示一致性修复

## 📋 问题描述

### 问题 1：StatsOverview.vue 费用显示不一致

**位置**：`web/admin-spa/src/components/apistats/StatsOverview.vue`

**现象**：使用统计概览中的"今日/本月费用"显示错误的数据，与 Redis 中实际的总费用不一致。

**示例**：
- **前端显示**："今日费用 $237.06"
- **Redis 实际值**：`221.82`（从 `usage:cost:total:{keyId}` 读取）
- **差异**：约 $15.24

### 问题 2：ApiKeysView.vue 总费用限制显示不一致

**位置**：`web/admin-spa/src/views/ApiKeysView.vue`

**现象**：API Keys 列表中的"总费用限制"进度条显示错误的当前费用。

**示例**：
- **前端显示**："总费用限制 $237.06 / $1000.00"
- **Redis 实际值**：`221.82 / 1000.00`
- **差异**：约 $15.24

## 🔍 根本原因

### 数据流分析

#### StatsOverview.vue 数据流

```
用户查询
  → Store: useApiStatsStore()
  → 调用 /apiStats/api/user-stats（已修复 ✅）
  → 调用 /apiStats/api/user-model-stats（返回模型费用）
  → currentPeriodData 计算属性汇总所有模型费用（❌ 问题点）
  → StatsOverview.vue 显示
```

#### ApiKeysView.vue 数据流

```
管理员查看
  → loadApiKeys()
  → 调用 /admin/api-keys（已修复 ✅）
  → key.usage.total.cost = costStats.total (forceRefresh=true)
  → LimitProgressBar 组件显示
```

### 核心问题

**问题出在前端 Store 的 `currentPeriodData` 计算属性**（`src/stores/apistats.js` 第 72-99 行）：

**旧逻辑**：
```javascript
// ❌ 错误：汇总所有模型的重新计算费用
modelStats.value.forEach((model) => {
  summary.cost += model.costs?.total || 0  // 每个模型都重新计算了费用
})
```

**问题**：
1. `/api/user-model-stats` 接口为每个模型重新计算费用（使用 `CostCalculator`）
2. 前端汇总这些重新计算的费用
3. 重新计算可能使用不同的定价数据或月度数据不完整
4. 导致汇总后的总费用与 Redis 中的真实 `usage:cost:total` 不一致

## ✅ 修复方案

### 修复文件

`web/admin-spa/src/stores/apistats.js`

### 具体修改

修改 `currentPeriodData` 计算属性，在 **'total'** 模式下优先使用来自 `/api/user-stats` 的真实总费用：

**修改前**（第 72-99 行）：
```javascript
// 单个 Key 模式下直接从 modelStats 计算（确保与模型使用统计显示一致）
if (modelStats.value && modelStats.value.length > 0) {
  const summary = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    allTokens: 0,
    cost: 0,
    formattedCost: '$0.000000'
  }

  modelStats.value.forEach((model) => {
    summary.requests += model.requests || 0
    summary.inputTokens += model.inputTokens || 0
    summary.outputTokens += model.outputTokens || 0
    summary.cacheCreateTokens += model.cacheCreateTokens || 0
    summary.cacheReadTokens += model.cacheReadTokens || 0
    summary.allTokens += model.allTokens || 0
    // ❌ 问题：汇总重新计算的费用
    const costValue = typeof model.costs?.total === 'number' ? model.costs.total : 0
    summary.cost += costValue
  })

  summary.formattedCost = formatCost(summary.cost)
  return summary
}
```

**修改后**：
```javascript
// 🔒 对于 'total' 模式，优先使用 statsData.usage.total.cost（来自 /api/user-stats 的真实总费用）
// 这确保总费用与 Redis 中的 usage:cost:total 一致，避免模型费用汇总导致的不一致
if (statsPeriod.value === 'total' && statsData.value?.usage?.total?.cost !== undefined) {
  // 使用 statsData 中的真实总费用，但其他字段从 modelStats 汇总
  if (modelStats.value && modelStats.value.length > 0) {
    const summary = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      allTokens: 0,
      cost: 0,
      formattedCost: '$0.000000'
    }

    modelStats.value.forEach((model) => {
      summary.requests += model.requests || 0
      summary.inputTokens += model.inputTokens || 0
      summary.outputTokens += model.outputTokens || 0
      summary.cacheCreateTokens += model.cacheCreateTokens || 0
      summary.cacheReadTokens += model.cacheReadTokens || 0
      summary.allTokens += model.allTokens || 0
    })

    // 🔒 使用来自 /api/user-stats 的真实总费用（强制刷新的）
    summary.cost = statsData.value.usage.total.cost
    summary.formattedCost = statsData.value.usage.total.formattedCost || formatCost(summary.cost)
    return summary
  }

  // 如果没有 modelStats，直接返回 statsData.usage.total
  return statsData.value.usage.total
}

// 单个 Key 模式下，对于 daily/monthly 从 modelStats 计算
if (modelStats.value && modelStats.value.length > 0) {
  // ... 其他时间段仍然汇总模型费用
}
```

## 🎯 修复逻辑

### 数据来源优先级（'total' 模式）

1. **总费用（cost）**：
   - ✅ 使用 `statsData.usage.total.cost`
   - 来源：`/api/user-stats` 接口
   - 后端：`redis.getCostStats(keyId, true)` - 强制刷新
   - 确保与 `usage:cost:total:{keyId}` 完全一致

2. **其他字段（requests, tokens）**：
   - 从 `modelStats` 汇总
   - 这些字段不受费用重新计算影响
   - 保持模型级别的统计准确性

3. **Daily/Monthly 模式**：
   - 仍然从 `modelStats` 汇总所有字段
   - 因为 `/api/user-stats` 只提供总费用，没有每日/每月细分

## 🚀 修复效果

### 修复后的数据流

#### StatsOverview.vue（'total' 模式）

```
用户查询
  → /api/user-stats: 获取真实总费用 ($221.82)
  → /api/user-model-stats: 获取模型详情
  → currentPeriodData: 使用 statsData.usage.total.cost ($221.82)
  → StatsOverview.vue: 显示 $221.82 ✅
```

#### StatsOverview.vue（'daily'/'monthly' 模式）

```
用户切换到今日/本月
  → /api/user-model-stats: 获取对应时段的模型费用
  → currentPeriodData: 汇总模型费用
  → StatsOverview.vue: 显示汇总费用
```

#### ApiKeysView.vue

```
管理员查看
  → /admin/api-keys
  → apiKeyService.js: getCostStats(keyId, true)
  → key.usage.total.cost = 强制刷新的真实费用
  → LimitProgressBar: 显示 $221.82 / $1000.00 ✅
```

## 📊 验证方法

### 1. 验证 StatsOverview.vue

```bash
# 1. 打开前端 API 统计页面
# 2. 输入 API Key 并查询
# 3. 确保时间段选择为"全部"
# 4. 检查"费用"字段显示值

# 5. 打开浏览器控制台
# 6. 执行以下命令查看实际数据
console.log('statsData.usage.total.cost:',
  useApiStatsStore().statsData.usage.total.cost)
```

### 2. 验证 ApiKeysView.vue

```bash
# 1. 打开管理后台 API Keys 页面
# 2. 刷新页面（Ctrl+Shift+R）
# 3. 查看某个 Key 的"总费用限制"进度条
# 4. 确认显示值与 Redis 一致

# 5. 对比 Redis 实际值
redis-cli get "usage:cost:total:<API_KEY_ID>"
```

### 3. 端到端验证

```bash
# 1. 查询 Redis 真实值
ACTUAL=$(redis-cli get "usage:cost:total:425a5307-9bc8-4b25-b4b1-39ebaed2c9b8")
echo "Redis 实际值: $ACTUAL"

# 2. 调用 API 接口
curl -X POST http://localhost:3000/apiStats/api/user-stats \
  -H "Content-Type: application/json" \
  -d '{"apiId": "425a5307-9bc8-4b25-b4b1-39ebaed2c9b8"}' \
  | jq '.data.usage.total.cost'

# 3. 前端显示
# 打开浏览器查看前端显示值

# 4. 三者应该完全相同 ✅
```

## 🔧 部署步骤

### 1. 构建前端

```bash
npm run build:web
```

### 2. 重启服务

```bash
npm run service:restart
```

### 3. 清除浏览器缓存

在浏览器中：
- 硬刷新（Ctrl+Shift+R 或 Cmd+Shift+R）
- 或打开控制台执行：
  ```javascript
  localStorage.clear()
  sessionStorage.clear()
  location.reload(true)
  ```

### 4. 验证修复

1. 打开 API 统计页面
2. 输入 API Key 查询
3. 确认"全部"时间段的费用显示正确
4. 切换到"今日"/"本月"确认也正常
5. 打开 API Keys 管理页面
6. 确认总费用限制进度条显示正确

## ⚠️ 注意事项

### 1. 时间段模式差异

- **'total' 模式**：使用 `/api/user-stats` 的真实总费用
- **'daily'/'monthly' 模式**：汇总 `/api/user-model-stats` 的模型费用
- 这是正确的行为，因为只有总费用有强制刷新的真实值

### 2. 模型统计显示

修复后，`currentPeriodData` 在 'total' 模式下：
- **费用**：使用真实总费用（与 Redis 一致）
- **请求数、Token 数**：从模型统计汇总（保持准确）
- 两者数据源不同，但都是正确的

### 3. 后端接口依赖

前端修复依赖以下后端接口的正确性：
- ✅ `/api/user-stats` - 已修复（使用 `forceRefresh=true`）
- ✅ `/admin/api-keys` - 已修复（使用 `forceRefresh=true`）
- `/api/user-model-stats` - 保持不变（用于模型级别统计）

## 📚 相关修复

这次修复是 **总费用限制强一致性** 系列修复的第三部分：

1. ✅ **核心代码修复** - `redis.js`, `auth.js`, `apiKeyService.js`
2. ✅ **User Stats API 修复** - `apiStats.js` (`/api/user-stats` 接口)
3. ✅ **前端显示修复** - `apistats.js` Store（本次修复）
4. ✅ **历史数据修复** - `scripts/fix-transaction-log-quota.js`

## 🎉 总结

通过修改前端 Store 的 `currentPeriodData` 计算属性，确保在显示总费用时：

- ✅ **数据一致性**：与 Redis `usage:cost:total` 完全一致
- ✅ **性能优化**：避免不必要的模型费用汇总计算
- ✅ **用户体验**：所有页面显示的总费用保持一致
- ✅ **向后兼容**：不影响 daily/monthly 模式的显示

---

**修复日期**：2025-11-14
**影响范围**：`web/admin-spa/src/stores/apistats.js`
**向后兼容**：是（仅优化数据来源，不改变 UI 结构）
**需要重新构建前端**：是
