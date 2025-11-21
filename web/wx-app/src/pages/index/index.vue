<template>
  <view class="content">
    <KeySelector />
    
    <view v-if="keyStore.currentKey" class="main-area">
      <NineGrid />
      
      <view class="stats-card">
        <text class="stats-title">Monthly Stats</text>
        <view class="stats-row">
          <text>Cost: ¥{{ keyStore.currentKey.currentTotalCost }}</text>
        </view>
        <view class="stats-row">
          <text>Remaining: ¥{{ keyStore.currentKey.totalCostLimit - keyStore.currentKey.currentTotalCost }}</text>
        </view>
      </view>
    </view>
    
    <view v-else class="welcome-area">
      <text class="welcome-text">Please configure an API Key to start.</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app';
import { useKeyStore } from '@/stores/useKeyStore';
import KeySelector from '@/components/KeySelector.vue';
import NineGrid from '@/components/NineGrid.vue';

const keyStore = useKeyStore();

onShow(() => {
  keyStore.loadKeys();
});
</script>

<style>
.content {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.main-area {
  flex: 1;
}
.welcome-area {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.welcome-text {
  color: #999;
  font-size: 16px;
}
.stats-card {
  margin: 20px;
  padding: 15px;
  background-color: #f8f8f8;
  border-radius: 8px;
}
.stats-title {
  font-weight: bold;
  margin-bottom: 10px;
  display: block;
}
.stats-row {
  margin-bottom: 5px;
  font-size: 14px;
  color: #666;
}
</style>
