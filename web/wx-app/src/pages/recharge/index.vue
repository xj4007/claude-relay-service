<template>
  <view class="container">
    <view class="header">
      <text class="title">Recharge</text>
    </view>

    <view v-if="keyStore.currentKey" class="recharge-content">
      <view class="current-balance">
        <text>Current Quota: ¥{{ keyStore.currentKey.totalCostLimit.toFixed(2) }}</text>
      </view>

      <view class="amount-grid">
        <view 
          v-for="amount in amounts" 
          :key="amount" 
          class="amount-item"
          :class="{ active: selectedAmount === amount }"
          @click="selectedAmount = amount"
        >
          <text>¥{{ amount }}</text>
        </view>
      </view>

      <button 
        class="btn-recharge" 
        :disabled="!selectedAmount || isLoading"
        :loading="isLoading"
        @click="handleRecharge"
      >
        Recharge ¥{{ selectedAmount || 0 }}
      </button>
      
      <text class="note">Note: This will increase your Total Cost Limit.</text>
    </view>

    <view v-else class="no-key">
      <text>Please select a key first.</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useKeyStore } from '@/stores/useKeyStore';
import { api } from '@/services/api';

const keyStore = useKeyStore();
const amounts = [10, 50, 100, 200, 500, 1000];
const selectedAmount = ref<number | null>(null);
const isLoading = ref(false);

const handleRecharge = async () => {
  if (!selectedAmount.value || !keyStore.currentKey) return;

  isLoading.value = true;
  try {
    const res = await api.recharge(keyStore.currentKey.keyId, selectedAmount.value);
    if (res.success) {
      uni.showToast({ title: 'Recharge Successful', icon: 'success' });
      // Update local key data (mock)
      keyStore.currentKey.totalCostLimit = res.newQuota;
      selectedAmount.value = null;
    }
  } catch (e) {
    uni.showToast({ title: 'Recharge Failed', icon: 'none' });
  } finally {
    isLoading.value = false;
  }
};
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
.current-balance {
  margin-bottom: 20px;
  font-size: 16px;
  color: #666;
}
.amount-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 30px;
}
.amount-item {
  width: calc(33.33% - 10px);
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 18px;
  font-weight: bold;
}
.amount-item.active {
  border-color: #000;
  background-color: #000;
  color: #fff;
}
.btn-recharge {
  background-color: #000;
  color: #fff;
  margin-bottom: 15px;
}
.btn-recharge[disabled] {
  background-color: #ccc;
}
.note {
  font-size: 12px;
  color: #999;
  text-align: center;
  display: block;
}
.no-key {
  text-align: center;
  color: #999;
  margin-top: 50px;
}
</style>
