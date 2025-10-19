<template>
  <div class="transaction-log-card mb-8 rounded-3xl p-6 shadow-xl">
    <!-- 标题区域 -->
    <div class="card-title mb-6">
      <h2 class="mb-2 text-2xl font-bold text-gray-900 dark:text-gray-200">
        <i class="fas fa-receipt mr-3" />
        交易明细
      </h2>
      <p class="text-base text-gray-600 dark:text-gray-400">
        查看最近 24 小时的 API 调用记录（仅保留 24 小时数据）
      </p>
    </div>

    <!-- 日期范围筛选 -->
    <div class="mb-6 flex flex-wrap items-center gap-4">
      <div class="flex items-center gap-2">
        <label class="text-sm font-medium text-gray-700 dark:text-gray-300">
          <i class="fas fa-calendar-alt mr-2" />
          时间范围:
        </label>
        <select
          v-model="selectedRange"
          class="filter-select rounded-lg border-2 border-gray-300 bg-white px-4 py-2 text-sm transition-all focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          @change="handleRangeChange"
        >
          <option value="1h">最近 1 小时</option>
          <option value="6h">最近 6 小时</option>
          <option value="12h">最近 12 小时</option>
          <option value="24h">最近 24 小时</option>
          <option value="custom">自定义</option>
        </select>
      </div>

      <!-- 自定义日期范围 -->
      <div v-if="selectedRange === 'custom'" class="flex items-center gap-2">
        <input
          v-model="customStartDate"
          class="filter-input rounded-lg border-2 border-gray-300 bg-white px-3 py-2 text-sm transition-all focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          type="datetime-local"
        />
        <span class="text-gray-500 dark:text-gray-400">至</span>
        <input
          v-model="customEndDate"
          class="filter-input rounded-lg border-2 border-gray-300 bg-white px-3 py-2 text-sm transition-all focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          type="datetime-local"
        />
        <button
          class="btn-apply rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600"
          @click="applyCustomRange"
        >
          应用
        </button>
      </div>

      <button
        class="btn-refresh ml-auto rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition-all hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
        :disabled="transactionLogsLoading"
        @click="refreshLogs"
      >
        <i class="fas fa-sync-alt mr-2" :class="{ 'fa-spin': transactionLogsLoading }" />
        刷新
      </button>
    </div>

    <!-- 加载状态 -->
    <div v-if="transactionLogsLoading" class="loading-container py-12 text-center">
      <i class="fas fa-spinner fa-spin mb-4 text-4xl text-blue-500" />
      <p class="text-gray-600 dark:text-gray-400">加载交易记录中...</p>
    </div>

    <!-- 错误提示 -->
    <div
      v-else-if="transactionLogsError"
      class="error-container rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-900/20 dark:text-red-400"
    >
      <i class="fas fa-exclamation-circle mr-2" />
      {{ transactionLogsError }}
    </div>

    <!-- 空状态 -->
    <div
      v-else-if="!transactionLogs || transactionLogs.length === 0"
      class="empty-container py-12 text-center"
    >
      <i class="fas fa-inbox mb-4 text-6xl text-gray-300 dark:text-gray-600" />
      <p class="text-lg text-gray-600 dark:text-gray-400">暂无交易记录</p>
      <p class="mt-2 text-sm text-gray-500 dark:text-gray-500">
        在选定的时间范围内没有找到任何 API 调用记录
      </p>
    </div>

    <!-- 交易记录表格 -->
    <div v-else class="table-container overflow-x-auto">
      <table class="transaction-table w-full">
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th>输入 Tokens</th>
            <th>输出 Tokens</th>
            <th>缓存创建</th>
            <th>缓存读取</th>
            <th>消费额度</th>
            <th>剩余额度</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(log, index) in transactionLogs" :key="index">
            <td class="timestamp">
              {{ formatTimestamp(log.timestamp) }}
            </td>
            <td class="model">
              <span class="model-badge">{{ log.model }}</span>
            </td>
            <td class="tokens">{{ formatNumber(log.inputTokens) }}</td>
            <td class="tokens">{{ formatNumber(log.outputTokens) }}</td>
            <td class="tokens">{{ formatNumber(log.cacheCreateTokens) }}</td>
            <td class="tokens">{{ formatNumber(log.cacheReadTokens) }}</td>
            <td class="cost">
              <span class="cost-value">${{ formatCost(log.cost) }}</span>
            </td>
            <td class="quota">
              <span v-if="log.remainingQuota !== null" class="quota-value">
                ${{ formatCost(log.remainingQuota) }}
              </span>
              <span v-else class="text-gray-400 dark:text-gray-500">无限制</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分页控件 -->
    <div
      v-if="transactionLogs && transactionLogs.length > 0 && pagination.totalPages > 1"
      class="mt-6 flex flex-wrap items-center justify-between gap-4"
    >
      <!-- 分页信息 -->
      <div class="text-sm text-gray-600 dark:text-gray-400">
        显示第 {{ (pagination.page - 1) * pagination.pageSize + 1 }} -
        {{ Math.min(pagination.page * pagination.pageSize, pagination.total) }} 条，共
        {{ pagination.total }} 条记录
      </div>

      <!-- 分页按钮 -->
      <div class="flex items-center gap-2">
        <!-- 上一页 -->
        <button
          class="pagination-btn"
          :class="{ disabled: pagination.page === 1 }"
          :disabled="pagination.page === 1 || transactionLogsLoading"
          @click="goToPage(pagination.page - 1)"
        >
          <i class="fas fa-chevron-left" />
          <span class="ml-1 hidden sm:inline">上一页</span>
        </button>

        <!-- 页码按钮 -->
        <div class="flex items-center gap-1">
          <button
            v-for="page in visiblePages"
            :key="page"
            class="pagination-number"
            :class="{ active: page === pagination.page }"
            :disabled="transactionLogsLoading"
            @click="goToPage(page)"
          >
            {{ page }}
          </button>
        </div>

        <!-- 下一页 -->
        <button
          class="pagination-btn"
          :class="{ disabled: pagination.page === pagination.totalPages }"
          :disabled="pagination.page === pagination.totalPages || transactionLogsLoading"
          @click="goToPage(pagination.page + 1)"
        >
          <span class="mr-1 hidden sm:inline">下一页</span>
          <i class="fas fa-chevron-right" />
        </button>
      </div>
    </div>

    <!-- 统计信息 -->
    <div
      v-if="transactionLogs && transactionLogs.length > 0"
      class="mt-6 rounded-lg bg-gray-50 p-4 dark:bg-gray-800/50"
    >
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="stat-item">
          <i class="fas fa-list-ol mr-2 text-blue-500" />
          <span class="text-sm text-gray-600 dark:text-gray-400">本页记录:</span>
          <span class="ml-2 font-semibold text-gray-900 dark:text-gray-200">
            {{ transactionLogs.length }}
          </span>
        </div>
        <div class="stat-item">
          <i class="fas fa-database mr-2 text-indigo-500" />
          <span class="text-sm text-gray-600 dark:text-gray-400">总记录数:</span>
          <span class="ml-2 font-semibold text-gray-900 dark:text-gray-200">
            {{ pagination.total }}
          </span>
        </div>
        <div class="stat-item">
          <i class="fas fa-coins mr-2 text-green-500" />
          <span class="text-sm text-gray-600 dark:text-gray-400">本页消费:</span>
          <span class="ml-2 font-semibold text-gray-900 dark:text-gray-200">
            ${{ formatCost(totalCost) }}
          </span>
        </div>
        <div class="stat-item">
          <i class="fas fa-clock mr-2 text-purple-500" />
          <span class="text-sm text-gray-600 dark:text-gray-400">数据保留:</span>
          <span class="ml-2 font-semibold text-gray-900 dark:text-gray-200">24 小时</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useApiStatsStore } from '@/stores/apistats'

const apiStatsStore = useApiStatsStore()
const {
  transactionLogs,
  transactionLogsLoading,
  transactionLogsError,
  apiId,
  transactionLogsPagination
} = storeToRefs(apiStatsStore)
const { setTransactionLogsDateRange, setTransactionLogsPage } = apiStatsStore

// 分页数据
const pagination = computed(() => transactionLogsPagination.value)

// 计算可见的页码
const visiblePages = computed(() => {
  const current = pagination.value.page
  const total = pagination.value.totalPages
  const pages = []

  if (total <= 7) {
    // 总页数小于等于7，显示所有页码
    for (let i = 1; i <= total; i++) {
      pages.push(i)
    }
  } else {
    // 总页数大于7，显示部分页码
    if (current <= 4) {
      // 当前页在前面
      for (let i = 1; i <= 5; i++) {
        pages.push(i)
      }
      pages.push('...')
      pages.push(total)
    } else if (current >= total - 3) {
      // 当前页在后面
      pages.push(1)
      pages.push('...')
      for (let i = total - 4; i <= total; i++) {
        pages.push(i)
      }
    } else {
      // 当前页在中间
      pages.push(1)
      pages.push('...')
      for (let i = current - 1; i <= current + 1; i++) {
        pages.push(i)
      }
      pages.push('...')
      pages.push(total)
    }
  }

  return pages.filter((p) => p !== '...')
})

// 日期范围选择
const selectedRange = ref('24h')
const customStartDate = ref('')
const customEndDate = ref('')

// 计算总消费
const totalCost = computed(() => {
  if (!transactionLogs.value || transactionLogs.value.length === 0) return 0
  return transactionLogs.value.reduce((sum, log) => sum + (log.cost || 0), 0)
})

// 监听 apiId 变化，自动加载交易日志
watch(
  apiId,
  (newId) => {
    if (newId) {
      handleRangeChange()
    }
  },
  { immediate: true }
)

// 处理时间范围变化
function handleRangeChange() {
  if (!apiId.value) return

  if (selectedRange.value === 'custom') {
    return
  }

  const now = Date.now()
  let startTime = null

  switch (selectedRange.value) {
    case '1h':
      startTime = now - 60 * 60 * 1000
      break
    case '6h':
      startTime = now - 6 * 60 * 60 * 1000
      break
    case '12h':
      startTime = now - 12 * 60 * 60 * 1000
      break
    case '24h':
    default:
      startTime = now - 24 * 60 * 60 * 1000
      break
  }

  setTransactionLogsDateRange(startTime, now)
}

// 应用自定义时间范围
function applyCustomRange() {
  if (!customStartDate.value || !customEndDate.value) {
    alert('请选择开始和结束时间')
    return
  }

  const start = new Date(customStartDate.value).getTime()
  const end = new Date(customEndDate.value).getTime()

  if (start >= end) {
    alert('开始时间必须早于结束时间')
    return
  }

  setTransactionLogsDateRange(start, end)
}

// 刷新日志
function refreshLogs() {
  handleRangeChange()
}

// 分页跳转
function goToPage(page) {
  if (page < 1 || page > pagination.value.totalPages || page === pagination.value.page) {
    return
  }
  setTransactionLogsPage(page)
}

// 格式化时间戳
function formatTimestamp(timestamp) {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

// 格式化数字
function formatNumber(num) {
  if (num === 0) return '0'
  if (!num) return '-'
  return num.toLocaleString()
}

// 格式化费用
function formatCost(cost) {
  if (cost === 0) return '0.000000'
  if (!cost) return '0.000000'
  if (cost >= 1) return cost.toFixed(2)
  if (cost >= 0.01) return cost.toFixed(4)
  return cost.toFixed(6)
}
</script>

<style scoped>
/* 卡片样式 */
.transaction-log-card {
  background: var(--surface-color);
  backdrop-filter: blur(25px);
  border: 1px solid var(--border-color);
  box-shadow:
    0 25px 50px -12px rgba(0, 0, 0, 0.25),
    0 0 0 1px rgba(255, 255, 255, 0.05),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

:global(.dark) .transaction-log-card {
  box-shadow:
    0 25px 50px -12px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(75, 85, 99, 0.2),
    inset 0 1px 0 rgba(107, 114, 128, 0.15);
}

/* 标题样式 */
.card-title h2 {
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  font-weight: 700;
}

:global(.dark) .card-title h2 {
  color: #f9fafb;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}

.card-title p {
  color: #6b7280;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.05);
}

:global(.dark) .card-title p {
  color: #9ca3af;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.2);
}

/* 表格样式 */
.transaction-table {
  border-collapse: separate;
  border-spacing: 0;
}

.transaction-table thead tr {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.transaction-table th {
  padding: 12px 16px;
  text-align: left;
  font-size: 0.875rem;
  font-weight: 600;
  color: white;
  white-space: nowrap;
}

.transaction-table th:first-child {
  border-top-left-radius: 8px;
}

.transaction-table th:last-child {
  border-top-right-radius: 8px;
}

.transaction-table tbody tr {
  background: white;
  border-bottom: 1px solid #e5e7eb;
  transition: all 0.2s ease;
}

:global(.dark) .transaction-table tbody tr {
  background: rgba(31, 41, 55, 0.5);
  border-bottom: 1px solid rgba(75, 85, 99, 0.3);
}

.transaction-table tbody tr:hover {
  background: #f9fafb;
  transform: translateX(2px);
}

:global(.dark) .transaction-table tbody tr:hover {
  background: rgba(31, 41, 55, 0.8);
}

.transaction-table td {
  padding: 12px 16px;
  font-size: 0.875rem;
  color: #374151;
}

:global(.dark) .transaction-table td {
  color: #d1d5db;
}

/* 特殊列样式 */
.timestamp {
  font-family: 'Courier New', monospace;
  color: #6b7280;
  font-size: 0.8125rem;
}

:global(.dark) .timestamp {
  color: #9ca3af;
}

.model-badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 6px;
  background: #dbeafe;
  color: #1e40af;
  font-size: 0.75rem;
  font-weight: 500;
}

:global(.dark) .model-badge {
  background: rgba(59, 130, 246, 0.2);
  color: #93c5fd;
}

.tokens {
  font-family: 'Courier New', monospace;
  text-align: right;
}

.cost-value {
  color: #059669;
  font-weight: 600;
}

:global(.dark) .cost-value {
  color: #34d399;
}

.quota-value {
  color: #7c3aed;
  font-weight: 600;
}

:global(.dark) .quota-value {
  color: #a78bfa;
}

/* 分页样式 */
.pagination-btn {
  display: inline-flex;
  align-items: center;
  padding: 8px 16px;
  border-radius: 8px;
  background: white;
  border: 1px solid #e5e7eb;
  color: #374151;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

:global(.dark) .pagination-btn {
  background: rgba(31, 41, 55, 0.8);
  border-color: rgba(75, 85, 99, 0.5);
  color: #d1d5db;
}

.pagination-btn:hover:not(:disabled):not(.disabled) {
  background: #f9fafb;
  border-color: #d1d5db;
  transform: translateY(-1px);
}

:global(.dark) .pagination-btn:hover:not(:disabled):not(.disabled) {
  background: rgba(55, 65, 81, 0.8);
  border-color: rgba(107, 114, 128, 0.8);
}

.pagination-btn.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pagination-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pagination-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: white;
  border: 1px solid #e5e7eb;
  color: #374151;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

:global(.dark) .pagination-number {
  background: rgba(31, 41, 55, 0.8);
  border-color: rgba(75, 85, 99, 0.5);
  color: #d1d5db;
}

.pagination-number:hover:not(:disabled):not(.active) {
  background: #f9fafb;
  border-color: #d1d5db;
  transform: translateY(-1px);
}

:global(.dark) .pagination-number:hover:not(:disabled):not(.active) {
  background: rgba(55, 65, 81, 0.8);
  border-color: rgba(107, 114, 128, 0.8);
}

.pagination-number.active {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-color: #667eea;
  color: white;
  cursor: default;
}

.pagination-number:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 响应式 */
@media (max-width: 768px) {
  .transaction-log-card {
    padding: 1.25rem;
  }

  .card-title h2 {
    font-size: 1.5rem;
  }

  .card-title p {
    font-size: 0.875rem;
  }

  .table-container {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .transaction-table {
    min-width: 800px;
  }

  .transaction-table th,
  .transaction-table td {
    padding: 8px 12px;
    font-size: 0.8125rem;
  }
}
</style>
