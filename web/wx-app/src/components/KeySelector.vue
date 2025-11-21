<template>
  <view class="key-selector">
    <view v-if="keyStore.hasKeys" class="selector-container">
      <picker mode="selector" :range="keyNames" @change="onKeyChange">
        <view class="picker">
          Current Key: {{ currentKeyName }} ▼
        </view>
      </picker>
    </view>
    <view v-else class="no-keys">
      <text>No API Key Configured</text>
      <button size="mini" @click="goToManage">Configure Key</button>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useKeyStore } from '@/stores/useKeyStore';

const keyStore = useKeyStore();

const keyNames = computed(() => keyStore.keys.map(k => k.name));
const currentKeyName = computed(() => keyStore.currentKey?.name || 'Select Key');

const onKeyChange = (e: any) => {
  const index = e.detail.value;
  const key = keyStore.keys[index];
  if (key) {
    keyStore.selectKey(key.keyId);
  }
};

const goToManage = () => {
  uni.navigateTo({ url: '/pages/key-manage/index' });
};
</script>

<style scoped>
.key-selector {
  padding: 10px;
  background-color: #f8f8f8;
  border-bottom: 1px solid #eee;
}
.picker {
  font-size: 14px;
  color: #333;
}
.no-keys {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
