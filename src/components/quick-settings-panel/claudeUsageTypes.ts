// Shape of GET /api/providers/claude/usage (success response).
// Any window may be `null` when the plan does not expose it.

export type ClaudeUsageWindow = {
  utilization: number; // 0-100
  resetsAt: string | null; // ISO 8601
};

// Mirrors server/shared/types.ts ClaudeExtraUsage (duplicated on purpose across
// the API boundary, not shared). `enabled: true` only means the account has an
// extra-usage pool at all — every other field is `null` when upstream omits
// it, and must never be zero-filled: an amount claims a fact the account
// hasn't confirmed.
export type ClaudeExtraUsage = {
  enabled: boolean;
  monthlyLimit: number | null; // in cents (minor currency units), e.g. 8000 = $80.00
  usedCredits: number | null; // in cents, e.g. 5127 = $51.27
  utilization: number | null; // 0-100
  currency: string | null;
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
