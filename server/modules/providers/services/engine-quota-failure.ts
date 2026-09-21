/**
 * Reads an ENGINE's exhaustion out of a failed Claude-body run (B-411).
 *
 * WHY THIS EXISTS. When the Claude body runs on a vendor engine (ADR-037/073),
 * the vendor's HTTP error is the ONLY account of the failure that exists: the
 * Agent SDK surfaces it as a generic query error, `mapSpawnError` maps it to
 * `spawn_failed`, and nothing anywhere names the cause. A spent free tier
 * therefore reaches the user as a run that simply stopped — the exact shape of
 * the Hermes B-91 incident, where "no final response was produced" was read for
 * days as a broken provider when the truth was a finished quota.
 *
 * That silence is about to get much more likely: the free GLM tier meters ~1000
 * requests/day at ~1 request/second, and one agentic turn spends many requests.
 * Exhaustion is the EXPECTED end of a working day on a free key, not an edge
 * case, so it needs a name before the path carries real work (T-1209).
 *
 * SCOPE, deliberately narrow — this classifies, it does not model. A vendor
 * quota has a total, a consumed fraction and a reset; almost none of that
 * crosses an Anthropic-compatible endpoint. What DOES cross is an HTTP status
 * and a message, so that is all this reads. No percentage is invented, and a
 * reset instant is returned only when the vendor actually stated one — the same
 * rule `parseQuotaResetMs` follows for agy, and for the same reason: a wrong
 * countdown renders identically to a right one once the UI has a number.
 */

/**
 * Vendor phrasings for "you are out of quota", matched case-insensitively.
 *
 * Anchored on quota/limit vocabulary rather than on the bare status code,
 * because 429 is ALSO what a per-second rate limit returns — and those two need
 * opposite responses from the user (wait a moment vs. wait for the reset, or
 * pay). `classifyEngineFailure` keeps them apart on that basis.
 *
 * Sources: Z.AI/OpenAI-compatible bodies (`insufficient_quota`,
 * `exceeded your current quota`), Anthropic-compatible bodies
 * (`credit balance is too low`), and the generic gateway phrasings that sit in
 * front of both.
 */
const QUOTA_EXHAUSTED_PATTERN =
  /insufficient[_\s]quota|exceeded\s+your\s+current\s+quota|quota\s+(?:reached|exceeded|exhausted)|out\s+of\s+quota|credit\s+balance\s+is\s+too\s+low|billing\s+(?:hard\s+)?limit|free\s+tier\s+.*exhaust/i;

/**
 * Per-second/per-minute throttling — a wait, not an exhaustion.
 *
 * Kept separate on purpose. The free GLM tier allows ~1 request/second, so a
 * burst of parallel agents trips this constantly while the daily allowance is
 * barely touched. Reporting that as "quota finished" would tell the user to
 * stop working when they only needed to slow down (B-412 handles the waiting).
 */
const RATE_LIMIT_PATTERN =
  /rate[_\s-]?limit|too\s+many\s+requests|requests?\s+per\s+(?:second|minute)|concurrency\s+limit/i;

/** `retry-after: 42` / `"retry_after": 42` — seconds, as HTTP defines it. */
const RETRY_AFTER_SECONDS_PATTERN = /retry[-_\s]?after["'\s:]+(\d+)/i;

/** Upper bound on an accepted countdown: 30 days (mirrors agy's bound). */
const MAX_RESET_MS = 30 * 24 * 60 * 60 * 1000;

export type EngineFailureKind = 'quota_exhausted' | 'rate_limited' | 'other';

export type EngineFailureVerdict = {
  kind: EngineFailureKind;
  /** Epoch ms when the vendor said capacity returns, or null when it did not say. */
  quotaResetsAtMs: number | null;
};

/**
 * Flattens whatever the SDK threw into one searchable string.
 *
 * The status often rides on a numeric field while the vendor's sentence rides
 * on `message`, and either alone is ambiguous — so both are folded in and the
 * patterns run over the whole. Nested `error.message` bodies are included
 * because OpenAI-compatible gateways wrap their payload one level deep.
 */
function flattenError(error: unknown): { text: string; status: number | null } {
  if (typeof error === 'string') return { text: error, status: null };
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  if (!record) return { text: String(error ?? ''), status: null };

  const nested = record.error && typeof record.error === 'object'
    ? (record.error as Record<string, unknown>)
    : null;

  const statusRaw = record.status ?? record.statusCode ?? nested?.status ?? nested?.code;
  const status = typeof statusRaw === 'number' && Number.isFinite(statusRaw) ? statusRaw : null;

  const parts = [
    record.message,
    record.code,
    nested?.message,
    nested?.type,
    record.body,
    statusRaw,
  ]
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .map(String);

  return { text: parts.join(' ') || String(error ?? ''), status };
}

/**
 * Extracts a reset instant from a `retry-after` hint, or null.
 *
 * @param nowMs injected rather than read from the clock, so the caller stamps
 *   once and the value is testable — same contract as `parseQuotaResetMs`.
 */
export function parseEngineRetryAfterMs(text: string, nowMs: number): number | null {
  if (!text || typeof text !== 'string' || !Number.isFinite(nowMs)) return null;
  const match = RETRY_AFTER_SECONDS_PATTERN.exec(text);
  if (!match) return null;
  const durationMs = Number(match[1]) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_RESET_MS) return null;
  return nowMs + durationMs;
}

/**
 * Classifies an engine-driven run's failure.
 *
 * Order matters: an exhaustion phrase WINS over a 429 status, because a spent
 * allowance and a per-second throttle both answer 429 and only the sentence
 * tells them apart. A bare 429 with no vocabulary is read as throttling — the
 * conservative reading, since telling a user their quota is finished when it is
 * not would send them to buy capacity they already have.
 *
 * Returns `other` for everything else, including auth and network faults, so
 * this never widens into a general error mapper (`mapSpawnError` owns that).
 */
export function classifyEngineFailure(error: unknown, nowMs: number): EngineFailureVerdict {
  const { text, status } = flattenError(error);
  const quotaResetsAtMs = parseEngineRetryAfterMs(text, nowMs);

  if (QUOTA_EXHAUSTED_PATTERN.test(text)) {
    return { kind: 'quota_exhausted', quotaResetsAtMs };
  }
  if (status === 429 || RATE_LIMIT_PATTERN.test(text)) {
    return { kind: 'rate_limited', quotaResetsAtMs };
  }
  return { kind: 'other', quotaResetsAtMs: null };
}

/**
 * The user-facing sentence for a classified engine failure.
 *
 * Names the ENGINE, not "Claude": the run was refused by the vendor the user
 * pinned this chat to, and a message that said Claude would send them looking at
 * the wrong account entirely.
 */
export function engineFailureMessage(
  verdict: EngineFailureVerdict,
  engineLabel: string,
): string | null {
  if (verdict.kind === 'quota_exhausted') {
    return `The ${engineLabel} engine has no quota left on the key stored for this chat. `
      + `Add credit with ${engineLabel}, switch this chat to another engine, or wait for the allowance to reset.`;
  }
  if (verdict.kind === 'rate_limited') {
    return `The ${engineLabel} engine is refusing requests for now because they arrived too fast `
      + `(its free tier allows roughly one per second). Retry in a moment, or run fewer agents at once.`;
  }
  return null;
}
