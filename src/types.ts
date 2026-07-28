/** Snapshot shown in the sidebar / status bar. */
export interface UsageSnapshot {
  planName: string;
  membershipType?: string;
  email?: string;
  autoPercentUsed: number;
  apiPercentUsed: number;
  /** Included plan spend in cents (when API provides it). */
  includedSpendCents?: number;
  /** Plan included limit in cents (when API provides it). */
  includedLimitCents?: number;
  billingCycleEnd?: string | number;
  billingCycleStart?: string | number;
  refreshedAt: string;
  /** Usage since ~1h ago (or since first sample if shorter). */
  lastHour?: UsageWindow;
  /** Usage since this IDE / extension session started. */
  session?: UsageWindow;
}

/** Delta for a time window relative to a baseline sample. */
export interface UsageWindow {
  autoPercentDelta: number;
  apiPercentDelta: number;
  /** ISO timestamp of the baseline sample. */
  since: string;
  /** True when history is shorter than the nominal window (e.g. <1h of samples). */
  partial: boolean;
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
  totalSpend?: number;
  includedSpend?: number;
  bonusSpend?: number;
  remaining?: number;
  limit?: number;
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
