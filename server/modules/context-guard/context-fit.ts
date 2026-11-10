/**
 * Pure fit rule of the model-switch context guard (T-2087, ADR-223).
 *
 * A conversation fits a model when its last measured fill leaves room for the
 * model's reply: `used <= window - reserve`. Anything not measured is
 * `unknown`, and `unknown` never refuses a turn.
 */

export type FitVerdict = 'fits' | 'too_small' | 'unknown';

export type FitInput = {
  usedTokens: number | null;
  windowTokens: number | null;
  /** Output room the adapter declares for the model; null → {@link defaultReserveTokens}. */
  reserveTokens?: number | null;
};

export type FitResult = {
  verdict: FitVerdict;
  used: number | null;
  budget: number | null;
  window: number | null;
};

const DEFAULT_RESERVE_CAP = 32_000;
const DEFAULT_RESERVE_SHARE = 0.1;

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/** Reply room when the adapter declares none: 10% of the window, at most 32k. */
export function defaultReserveTokens(windowTokens: number): number {
  return Math.min(DEFAULT_RESERVE_CAP, Math.floor(windowTokens * DEFAULT_RESERVE_SHARE));
}

/** Decides fits / too_small / unknown from one measured fill and one model window. */
export function evaluateFit(input: FitInput): FitResult {
  const used = count(input.usedTokens);
  const window = count(input.windowTokens);
  if (window === null || window === 0) return { verdict: 'unknown', used, budget: null, window: null };
  const declared = count(input.reserveTokens);
  const reserve = Math.min(window, declared ?? defaultReserveTokens(window));
  const budget = window - reserve;
  if (used === null) return { verdict: 'unknown', used: null, budget, window };
  return { verdict: used > budget ? 'too_small' : 'fits', used, budget, window };
}
