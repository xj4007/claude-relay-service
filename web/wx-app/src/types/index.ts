export interface ApiKey {
  keyId: string;
  name: string;
  key: string; // The full key string (cr_...)
  permissions: string;
  dailyCostLimit: number;
  totalCostLimit: number;
  currentDailyCost: number;
  currentTotalCost: number;
  isActive: boolean;
  expiresAt: string;
}

export interface UserState {
  openid: string;
  checkinCount: number;
  lastCheckinDate: string;
}

export interface LogItem {
  id: string;
  date: string;
  time: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface QuotaHistory {
    type: 'recharge' | 'checkin';
    amount: number;
    beforeQuota: number;
    afterQuota: number;
    timestamp: number;
    timeAgo: string;
}
