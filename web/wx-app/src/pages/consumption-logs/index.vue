<template>
  <view class="container">
    <view class="header">
      <text class="title">Consumption Logs</text>
    </view>

    <view v-if="keyStore.currentKey" class="logs-list">
      <view v-for="log in logs" :key="log.id" class="log-item">
        <view class="log-header">
          <text class="log-model">{{ log.model }}</text>
          <text class="log-cost">-¥{{ log.cost.toFixed(4) }}</text>
        </view>
        <view class="log-details">
          <text>{{ log.date }} {{ log.time }}</text>
          <text>{{ log.inputTokens }} / {{ log.outputTokens }} tokens</text>
        </view>
      </view>
      <view v-if="logs.length === 0" class="empty-state">
        <text>No logs found.</text>
      </view>
    </view>

    <view v-else class="no-key">
      <text>Please select a key first.</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useKeyStore } from '@/stores/useKeyStore';
import { api } from '@/services/api';
import type { LogItem } from '@/types';

const keyStore = useKeyStore();
const logs = ref<LogItem[]>([]);

onMounted(async () => {
  if (keyStore.currentKey) {
    logs.value = await api.getLogs(keyStore.currentKey.keyId);
  }
});
</script>

<style scoped>
.container {
  padding: 20px;
}
.header {
  margin-bottom: 20px;
}
.title {
  font-size: 24px;
  font-weight: bold;
}
.log-item {
  padding: 15px;
  border-bottom: 1px solid #eee;
}
.log-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 5px;
}
.log-model {
  font-weight: bold;
  color: #333;
}
.log-cost {
  color: #f44336;
  font-weight: bold;
}
.log-details {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #999;
}
.no-key, .empty-state {
  text-align: center;
  color: #999;
  margin-top: 50px;
}
</style>
