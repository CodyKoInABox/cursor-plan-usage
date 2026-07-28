import * as vscode from 'vscode';
import type {
  AuthResult,
  CurrentPeriodUsageResponse,
  PlanInfoResponse,
  UsageSnapshot,
} from './types';

function apiBaseUrl(): string {
  return vscode.workspace
    .getConfiguration('cursorPlanUsage')
    .get<string>('apiBaseUrl', 'https://api2.cursor.sh')
    .replace(/\/$/, '');
}

export class CursorApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'CursorApiError';
  }
}

async function postJson<T>(
  path: string,
  accessToken: string,
  body: unknown = {}
): Promise<T> {
  const url = `${apiBaseUrl()}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // ignore
    }
    throw new CursorApiError(
      `Cursor API ${path} failed (${res.status}${detail ? `: ${detail}` : ''})`,
      res.status
    );
  }

  return (await res.json()) as T;
}

function titleCasePlan(membershipType?: string): string {
  if (!membershipType) {
    return 'Pro';
  }
  const lower = membershipType.toLowerCase();
  if (lower === 'pro' || lower === 'pro_plus' || lower === 'proplus') {
    return lower.includes('plus') ? 'Pro+' : 'Pro';
  }
  if (lower === 'business' || lower === 'team') {
    return 'Business';
  }
  if (lower === 'free' || lower === 'free_trial') {
    return 'Free';
  }
  return membershipType.charAt(0).toUpperCase() + membershipType.slice(1);
}

function pickPercent(...values: Array<number | undefined>): number {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.max(0, Math.min(100, v));
    }
  }
  return 0;
}

/**
 * Fetch current-period usage + plan info and map to UI snapshot.
 * Endpoints are unofficial Connect-RPC dashboard APIs and may change.
 */
export async function fetchUsageSnapshot(auth: AuthResult): Promise<UsageSnapshot> {
  const usage = await postJson<CurrentPeriodUsageResponse>(
    '/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
    auth.accessToken,
    {}
  );

  let planName: string | undefined;
  try {
    const plan = await postJson<PlanInfoResponse>(
      '/aiserver.v1.DashboardService/GetPlanInfo',
      auth.accessToken,
      {}
    );
    planName = plan.planInfo?.planName;
  } catch {
    // GetPlanInfo is best-effort; membership type / defaults still work
  }

  const membership =
    usage.membershipType ?? auth.membershipType;
  const displayPlan =
    planName?.trim() ||
    (membership ? titleCasePlan(membership) : 'Pro');

  return {
    planName: displayPlan,
    membershipType: membership,
    email: auth.email,
    autoPercentUsed: pickPercent(usage.planUsage?.autoPercentUsed),
    apiPercentUsed: pickPercent(usage.planUsage?.apiPercentUsed),
    billingCycleStart: usage.billingCycleStart,
    billingCycleEnd: usage.billingCycleEnd,
    refreshedAt: new Date().toISOString(),
  };
}
