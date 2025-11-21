<template>
  <view class="grid-container">
    <view class="grid-item" v-for="(item, index) in items" :key="index" @click="handleItemClick(item)">
      <text class="icon">{{ item.icon }}</text>
      <text class="label">{{ item.label }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
const items = [
  { label: 'Check-in', icon: '📅', path: '/pages/checkin/index' },
  { label: 'Balance', icon: '💰', path: '/pages/balance/index' },
  { label: 'Logs', icon: '📊', path: '/pages/consumption-logs/index' },
  { label: 'Recharge', icon: '💳', path: '/pages/recharge/index' },
  { label: 'More', icon: '📋', path: '' },
  { label: 'Settings', icon: '⚙️', path: '' },
  { label: 'Help', icon: '❓', path: '' },
  { label: 'About', icon: 'ℹ️', path: '' },
];

const handleItemClick = (item: any) => {
  if (item.path) {
    uni.navigateTo({ url: item.path });
  } else {
    uni.showToast({ title: 'Coming Soon', icon: 'none' });
  }
};
</script>

<style scoped>
.grid-container {
  display: flex;
  flex-wrap: wrap;
  padding: 10px;
}
.grid-item {
  width: 33.33%;
  height: 100px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px solid #f0f0f0;
  box-sizing: border-box;
}
.icon {
  font-size: 24px;
  margin-bottom: 5px;
}
.label {
  font-size: 14px;
  color: #333;
}
</style>
