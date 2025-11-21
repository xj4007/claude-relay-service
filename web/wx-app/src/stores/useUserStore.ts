import { defineStore } from 'pinia';

export const useUserStore = defineStore('user', {
    state: () => ({
        openid: '',
        checkinHistory: [] as string[], // Date strings
    }),
    actions: {
        login() {
            // Mock login
            this.openid = 'mock_openid_' + Math.random().toString(36).substr(2, 9);
        },
        addCheckin(date: string) {
            this.checkinHistory.push(date);
        },
        hasCheckedIn(date: string) {
            return this.checkinHistory.includes(date);
        }
    }
});
