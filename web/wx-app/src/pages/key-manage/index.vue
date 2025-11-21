<template>
  <view class="container">
    <view class="header">
      <text class="title">Manage API Keys</text>
    </view>

    <view class="add-key-section">
      <input
        class="input"
        v-model="newKey"
        placeholder="Enter API Key (cr_...)"
        :disabled="isValidating"
      />
      <button
        class="btn-add"
        @click="validateAndAdd"
        :loading="isValidating"
        :disabled="!newKey || isValidating"
      >
        Validate & Add
      </button>
    </view>

    <view class="key-list">
      <view v-for="key in keyStore.keys" :key="key.keyId" class="key-item">
        <view class="key-info">
          <text class="key-name">{{ key.name }}</text>
          <text class="key-mask">{{ maskKey(key.key) }}</text>
        </view>
        <view class="key-actions">
          <button
            size="mini"
            type="warn"
            @click="removeKey(key.keyId)"
          >Remove</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useKeyStore } from '@/stores/useKeyStore';
import { api } from '@/services/api';

const keyStore = useKeyStore();
const newKey = ref('');
const isValidating = ref(false);

const validateAndAdd = async () => {
  if (!newKey.value.startsWith('cr_')) {
    uni.showToast({ title: 'Key must start with cr_', icon: 'none' });
    return;
  }

  isValidating.value = true;
  try {
    const res = await api.validateKey(newKey.value);
    if (res.valid && res.keyData) {
      keyStore.addKey(res.keyData);
      newKey.value = '';
      uni.showToast({ title: 'Key Added', icon: 'success' });
    } else {
      uni.showToast({ title: res.message || 'Invalid Key', icon: 'none' });
    }
  } catch (e) {
    uni.showToast({ title: 'Validation Failed', icon: 'none' });
  } finally {
    isValidating.value = false;
  }
};

const removeKey = (keyId: string) => {
  uni.showModal({
    title: 'Confirm',
    content: 'Are you sure to remove this key?',
    success: (res) => {
      if (res.confirm) {
        keyStore.removeKey(keyId);
      }
    }
  });
};

const maskKey = (key: string) => {
  return key.substring(0, 6) + '...' + key.substring(key.length - 4);
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
  font-size: 20px;
  font-weight: bold;
}
.add-key-section {
  margin-bottom: 30px;
}
.input {
  border: 1px solid #ddd;
  padding: 10px;
  border-radius: 4px;
  margin-bottom: 10px;
}
.btn-add {
  background-color: #000;
  color: #fff;
}
.key-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 15px;
  border-bottom: 1px solid #eee;
}
.key-name {
  font-weight: bold;
  display: block;
}
.key-mask {
  color: #999;
  font-size: 12px;
}
</style>
