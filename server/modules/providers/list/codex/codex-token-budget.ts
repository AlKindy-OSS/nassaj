/**
 * Real per-model context-window budgets for Codex (T-911).
 *
 * `codex exec --experimental-json` does not emit `model_context_window` on the
 * live `turn.completed` event (verified empirically under T-905), so the token
 * counter previously fell back to a hardcoded `200000` for EVERY model —
 * showing a fabricated "0/200K" for models whose real window is 400K or 1M.
 *
 * This module supplies the real published window per model so the fallback is
 * model-aware instead of a single constant. Priority order used by
 * `extractCodexTokenBudget`:
 *   1. `model_context_window` on the event itself, if a future SDK version ever
 *      starts emitting it (still honored, never overridden).
 *   2. This table, keyed by the (normalized) model id that was actually passed
 *      to `codex.startThread`/`resumeThread`.
 *   3. `200000` as an absolute last resort for a model this table has never
 *      heard of.
 */

/**
 * Exact-match anchors: real windows OpenAI has published for shipped models.
 * Sources (OpenAI model docs, as of this table's last review):
 *   - gpt-5 family (gpt-5, gpt-5-codex, gpt-5-mini, gpt-5-nano): 400,000 tokens.
 *   - gpt-4.1 family (gpt-4.1, gpt-4.1-mini, gpt-4.1-nano): 1,047,576 tokens
 *     (rounded to 1,000,000 here — matches how nassaj's Claude 1M-context
 *     entries are already rounded in providerModelFallbacks.ts).
 *   - o-series reasoning models (o3, o3-mini, o4-mini, o1, o1-pro): 200,000.
 *   - o1-mini: 128,000 (smaller than the rest of the o1 line).
 *   - codex-mini-latest (o4-mini fine-tune shipped for the Codex CLI): 200,000.
 *   - gpt-4o / gpt-4o-mini: 128,000.
 */
export const CODEX_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5': 400000,
  'gpt-5-codex': 400000,
  'gpt-5-mini': 400000,
  'gpt-5-nano': 400000,
  'gpt-4.1': 1000000,
  'gpt-4.1-mini': 1000000,
  'gpt-4.1-nano': 1000000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'o3': 200000,
  'o3-mini': 200000,
  'o4-mini': 200000,
  'o1': 200000,
  'o1-pro': 200000,
  'o1-mini': 128000,
  'codex-mini-latest': 200000,
};

/** Last-resort window for a model nobody has ever mapped. */
const UNKNOWN_MODEL_FALLBACK_WINDOW = 200000;

/**
 * Strips suffixes nassaj's own catalogs are known to append/vary that do NOT
 * change the underlying context window:
 *   - reasoning-effort / speed tags (`-low`, `-high-fast`, `-xhigh`, `-none`, …),
 *     which can stack (e.g. `-high-fast`) so the strip runs to a fixpoint.
 *   - a trailing dated snapshot (`-2025-04-14`).
 * This lets a catalog entry like `gpt-5.3-codex-xhigh-fast` normalize down to
 * `gpt-5.3-codex` before the family match below runs.
 */
function normalizeCodexModelId(model: unknown): string {
  if (typeof model !== 'string') {
    return '';
  }

  let id = model.trim().toLowerCase();
  if (!id) {
    return '';
  }

  const effortOrSpeedSuffix = /-(none|low|medium|high|xhigh|fast)$/;
  while (effortOrSpeedSuffix.test(id)) {
    id = id.replace(effortOrSpeedSuffix, '');
  }

  id = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');

  return id;
}

/**
 * Family fallbacks for dot-release model ids nassaj's fallback catalog carries
 * (e.g. `gpt-5.2`, `gpt-5.3-codex`, `gpt-5.4-mini`, `gpt-5.1-codex-max`) that
 * are not — and can never exhaustively be — individual entries in the exact
 * table above. OpenAI's shipped precedent is that the context window is a
 * property of the base generation, not the dot release or size variant (every
 * gpt-5.x / gpt-4.1.x size variant published so far has shared its
 * generation's window), so a same-generation dot release is matched to its
 * generation's published window rather than falling through to the 200K
 * unknown-model floor.
 */
const FAMILY_WINDOWS: Array<{ pattern: RegExp; window: number }> = [
  { pattern: /^gpt-4\.1(-mini|-nano)?$/, window: 1000000 },
  { pattern: /^gpt-5(\.\d+)?(-codex(-mini|-max)?|-mini|-nano)?$/, window: 400000 },
  { pattern: /^gpt-4o(-mini)?$/, window: 128000 },
  { pattern: /^o[134](-mini|-pro)?$/, window: 200000 },
  { pattern: /^codex-mini/, window: 200000 },
];

/**
 * Resolves the real published context window for a Codex model id, or
 * `undefined` if nothing in the exact table or family list matches — callers
 * decide their own last-resort default (see `extractCodexTokenBudget`).
 */
export function windowForModel(model: unknown): number | undefined {
  const normalized = normalizeCodexModelId(model);
  if (!normalized) {
    return undefined;
  }

  const exact = CODEX_MODEL_CONTEXT_WINDOWS[normalized];
  if (exact) {
    return exact;
  }

  const family = FAMILY_WINDOWS.find(({ pattern }) => pattern.test(normalized));
  return family?.window;
}

function readUsageNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type CodexTokenBudget = {
  used: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  breakdown: {
    input: number;
    output: number;
  };
};

/**
 * Extracts the token-usage budget from a Codex `turn.completed` event.
 * `model` is the id actually handed to `codex.startThread`/`resumeThread` for
 * this turn (nassaj's `resolvedModel`), used to look up the real window when
 * the event itself doesn't carry `model_context_window` (the live
 * `codex exec --experimental-json` case, per T-905).
 */
export function extractCodexTokenBudget(event: any, model?: unknown): CodexTokenBudget | null {
  const info = event?.info || event?.payload?.info || event?.usage?.info;
  const usage = info?.total_token_usage || event?.usage?.total_token_usage || event?.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }

  const inputTokens = readUsageNumber(usage.input_tokens);
  const outputTokens = readUsageNumber(usage.output_tokens);
  const used = readUsageNumber(usage.total_tokens) || inputTokens + outputTokens;

  const eventWindow = readUsageNumber(info?.model_context_window || event?.usage?.model_context_window);

  return {
    used,
    total: eventWindow || windowForModel(model) || UNKNOWN_MODEL_FALLBACK_WINDOW,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}
