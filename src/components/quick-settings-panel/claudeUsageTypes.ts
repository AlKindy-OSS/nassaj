// Shape of GET /api/providers/claude/usage (success response).
// Any window may be `null` when the plan does not expose it.

export type ClaudeUsageWindow = {
  utilization: number; // 0-100
  resetsAt: string | null; // ISO 8601
};

export type ClaudeExtraUsage = {
  enabled: boolean;
  monthlyLimit: number; // in cents (minor currency units), e.g. 8000 = $80.00
  usedCredits: number; // in cents, e.g. 5127 = $51.27
  utilization: number; // 0-100
  currency: string;
};

export type ClaudeUsage = {
  plan: string | null;
  session: ClaudeUsageWindow | null;
  weeklyAllModels: ClaudeUsageWindow | null;
  weeklySonnet: ClaudeUsageWindow | null;
  weeklyOpus: ClaudeUsageWindow | null;
  extraUsage: ClaudeExtraUsage | null;
  fetchedAt: string;
  stale: boolean;
};

// Discriminated state exposed by the useClaudeUsage hook.
export type ClaudeUsageState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: ClaudeUsage }
  | { status: 'error'; code: string | null };
