import type { ApiKey, LogItem } from '@/types';

export const MOCK_KEYS: Record<string, ApiKey> = {
    'cr_valid_key_1': {
        keyId: 'uuid-1',
        name: 'My First Key',
        key: 'cr_valid_key_1',
        permissions: 'all',
        dailyCostLimit: 100,
        totalCostLimit: 5000,
        currentDailyCost: 12.5,
        currentTotalCost: 2345.67,
        isActive: true,
        expiresAt: '2025-12-31'
    },
    'cr_valid_key_2': {
        keyId: 'uuid-2',
        name: 'Test Key',
        key: 'cr_valid_key_2',
        permissions: 'claude',
        dailyCostLimit: 50,
        totalCostLimit: 1000,
        currentDailyCost: 0,
        currentTotalCost: 123.45,
        isActive: true,
        expiresAt: '2024-12-31'
    }
};

export const MOCK_LOGS: LogItem[] = [
    { id: '1', date: '2024-11-19', time: '10:00:00', model: 'claude-3-opus', inputTokens: 1000, outputTokens: 500, cost: 0.5 },
    { id: '2', date: '2024-11-19', time: '11:30:00', model: 'gpt-4', inputTokens: 500, outputTokens: 200, cost: 0.2 },
    { id: '3', date: '2024-11-18', time: '15:45:00', model: 'gemini-pro', inputTokens: 2000, outputTokens: 1000, cost: 0.1 },
];
