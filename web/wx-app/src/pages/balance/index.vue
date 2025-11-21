<template>
  <view class="container">
    <view class="header">
      <text class="title">Balance & Quota</text>
    </view>

    <view v-if="keyStore.currentKey" class="balance-card">
      <view class="balance-header">
        <text class="label">Remaining Balance</text>
        <text class="amount">¥{{ (keyStore.currentKey.totalCostLimit - keyStore.currentKey.currentTotalCost).toFixed(2) }}</text>
      </view>
      
      <view class="quota-section">
        <view class="quota-item">
          <view class="quota-label">
            <text>Total Quota</text>
            <text>{{ keyStore.currentKey.currentTotalCost.toFixed(2) }} / {{ keyStore.currentKey.totalCostLimit.toFixed(2) }}</text>
          </view>
          <progress 
            :percent="(keyStore.currentKey.currentTotalCost / keyStore.currentKey.totalCostLimit) * 100" 
            stroke-width="6" 
            activeColor="#000" 
            backgroundColor="#eee"
          />
        </view>

        <view class="quota-item">
          <view class="quota-label">
            <text>Daily Limit</text>
            <text>{{ keyStore.currentKey.currentDailyCost.toFixed(2) }} / {{ keyStore.currentKey.dailyCostLimit.toFixed(2) }}</text>
          </view>
          <progress 
            :percent="(keyStore.currentKey.currentDailyCost / keyStore.currentKey.dailyCostLimit) * 100" 
            stroke-width="6" 
            activeColor="#000" 
            backgroundColor="#eee"
          />
        </view>
      </view>
    </view>

    <view v-else class="no-key">
      <text>Please select a key first.</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { useKeyStore } from '@/stores/useKeyStore';

const keyStore = useKeyStore();
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
.balance-card {
  background-color: #fff;
  border: 1px solid #eee;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.05);
}
.balance-header {
  text-align: center;
  margin-bottom: 30px;
  padding-bottom: 20px;
  border-bottom: 1px solid #f5f5f5;
}
.label {
  font-size: 14px;
  color: #666;
  display: block;
  margin-bottom: 10px;
}
.amount {
  font-size: 36px;
  font-weight: bold;
  color: #000;
}
.quota-item {
  margin-bottom: 20px;
}
.quota-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 14px;
  color: #333;
}
.no-key {
  text-align: center;
  color: #999;
  margin-top: 50px;
}
</style>
