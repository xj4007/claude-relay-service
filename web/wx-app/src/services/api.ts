import type { ApiKey, LogItem } from '@/types';
import { MOCK_KEYS, MOCK_LOGS } from './mockData';

const DELAY = 500;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const api = {
    async validateKey(key: string): Promise<{ valid: boolean; keyData?: ApiKey; message?: string }> {
        await delay(DELAY);
        if (MOCK_KEYS[key]) {
            return { valid: true, keyData: MOCK_KEYS[key] };
        }
        return { valid: false, message: 'Invalid API Key' };
    },

    async getLogs(key: string): Promise<LogItem[]> {
        await delay(DELAY);
        return MOCK_LOGS;
    },

    async checkin(key: string): Promise<{ success: boolean; reward: number; newQuota: number; message?: string }> {
        await delay(DELAY);
        // Mock checkin logic
        return { success: true, reward: 100, newQuota: 5100 };
    },

    async recharge(key: string, amount: number): Promise<{ success: boolean; newQuota: number }> {
        await delay(DELAY);
        return { success: true, newQuota: 5000 + amount };
    }
};
