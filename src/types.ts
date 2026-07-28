/** Snapshot shown in the sidebar / status bar. */
export interface UsageSnapshot {
  planName: string;
  membershipType?: string;
  email?: string;
  autoPercentUsed: number;
  apiPercentUsed: number;
  billingCycleEnd?: string | number;
  billingCycleStart?: string | number;
  refreshedAt: string;
}

export interface AuthResult {
  accessToken: string;
  membershipType?: string;
  email?: string;
  source: 'db' | 'setting';
}

export interface PlanUsageBlock {
  autoPercentUsed?: number;
  apiPercentUsed?: number;
  totalPercentUsed?: number;
}

export interface CurrentPeriodUsageResponse {
  planUsage?: PlanUsageBlock;
  billingCycleStart?: string | number;
  billingCycleEnd?: string | number;
  displayMessage?: string;
  membershipType?: string;
}

export interface PlanInfoResponse {
  planInfo?: {
    planName?: string;
    includedAmountCents?: number;
    price?: string;
  };
}
