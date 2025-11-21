import { defineStore } from 'pinia';
import type { ApiKey } from '@/types';

export const useKeyStore = defineStore('key', {
    state: () => ({
        keys: [] as ApiKey[],
        currentKeyId: '' as string,
    }),
    getters: {
        currentKey: (state) => state.keys.find(k => k.keyId === state.currentKeyId) || null,
        hasKeys: (state) => state.keys.length > 0,
    },
    actions: {
        addKey(keyData: ApiKey) {
            if (!this.keys.find(k => k.keyId === keyData.keyId)) {
                this.keys.push(keyData);
                this.saveKeys();
            }
            if (!this.currentKeyId) {
                this.currentKeyId = keyData.keyId;
            }
        },
        removeKey(keyId: string) {
            this.keys = this.keys.filter(k => k.keyId !== keyId);
            if (this.currentKeyId === keyId) {
                this.currentKeyId = this.keys[0]?.keyId || '';
            }
            this.saveKeys();
        },
        selectKey(keyId: string) {
            this.currentKeyId = keyId;
        },
        saveKeys() {
            uni.setStorageSync('crs_keys', this.keys);
        },
        loadKeys() {
            const keys = uni.getStorageSync('crs_keys');
            if (keys) {
                this.keys = keys;
                if (this.keys.length > 0) {
                    this.currentKeyId = this.keys[0].keyId;
                }
            }
        }
    }
});
