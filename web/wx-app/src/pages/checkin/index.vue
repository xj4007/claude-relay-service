<template>
  <view class="container">
    <view class="header">
      <text class="title">Daily Check-in</text>
    </view>

    <view class="checkin-card">
      <view class="status-icon">
        <text class="icon">{{ hasCheckedIn ? '✅' : '📅' }}</text>
      </view>
      <view class="status-text">
        <text v-if="hasCheckedIn">Checked in today!</text>
        <text v-else>Check in to earn quota</text>
      </view>
      
      <button 
        class="btn-checkin" 
        :disabled="hasCheckedIn || isLoading"
        :loading="isLoading"
        @click="handleCheckin"
      >
        {{ hasCheckedIn ? 'Checked In' : 'Check In Now' }}
      </button>
    </view>

    <view class="history-section">
      <text class="section-title">Check-in History</text>
      <view v-if="userStore.checkinHistory.length === 0" class="empty-history">
        <text>No history yet.</text>
      </view>
      <view v-else class="history-list">
        <view v-for="(date, index) in userStore.checkinHistory" :key="index" class="history-item">
          <text>{{ date }}</text>
          <text class="reward">+ ¥100</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useUserStore } from '@/stores/useUserStore';
import { useKeyStore } from '@/stores/useKeyStore';
import { api } from '@/services/api';

const userStore = useUserStore();
const keyStore = useKeyStore();
const isLoading = ref(false);

const today = new Date().toISOString().split('T')[0];
const hasCheckedIn = computed(() => userStore.hasCheckedIn(today));

const handleCheckin = async () => {
  if (!keyStore.currentKey) {
    uni.showToast({ title: 'Please select a key first', icon: 'none' });
    return;
  }

  isLoading.value = true;
  try {
    const res = await api.checkin(keyStore.currentKey.keyId);
    if (res.success) {
      userStore.addCheckin(today);
      uni.showToast({ title: `Success! +¥${res.reward}`, icon: 'success' });
    } else {
      uni.showToast({ title: res.message || 'Failed', icon: 'none' });
    }
  } catch (e) {
    uni.showToast({ title: 'Error', icon: 'none' });
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
  margin-bottom: 30px;
  text-align: center;
}
.title {
  font-size: 24px;
  font-weight: bold;
}
.checkin-card {
  background-color: #f8f8f8;
  padding: 30px;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 30px;
}
.icon {
  font-size: 60px;
  margin-bottom: 20px;
}
.status-text {
  font-size: 18px;
  margin-bottom: 20px;
  font-weight: bold;
}
.btn-checkin {
  width: 200px;
  background-color: #000;
  color: #fff;
  border-radius: 25px;
}
.btn-checkin[disabled] {
  background-color: #ccc;
  color: #fff;
}
.section-title {
  font-size: 18px;
  font-weight: bold;
  margin-bottom: 15px;
  display: block;
}
.history-item {
  display: flex;
  justify-content: space-between;
  padding: 15px 0;
  border-bottom: 1px solid #eee;
}
.reward {
  color: #4caf50;
  font-weight: bold;
}
.empty-history {
  text-align: center;
  color: #999;
  padding: 20px;
}
</style>
