/**
 * Anthropic API month-to-date spend (ADR-214 / T-2066), read from the official
 * Admin API cost report — never estimated locally.
 *
 * Source: `GET https://api.anthropic.com/v1/organizations/cost_report` with the
 * member's own Admin key (`sk-ant-admin…`). Amounts are USD decimal strings in
 * cents and may be fractional, so they are summed exactly (scaled BigInt) and
 * rounded once, at the end, to whole cents. Priority Tier costs are not part of
 * this endpoint; the response says so (`excludesPriorityTier`).
 *
 * Honesty rules (same as the quota and balance services):
 *  1. A failure is an error code, never a zero.
 *  2. The key is read server-side from the CALLER's own store and never leaves
 *     the server; no response, log, or audit row carries it.
 *  3. "No cost rows yet" (`hasData: false`) is distinct from a real $0.
 */

import {
  deleteAnthropicAdminKey,
  getAnthropicAdminKey,
  setAnthropicAdminKey,
} from '@/services/isolation/provider-secrets-store.js';
import { withProviderSecretsStore } from '@/services/isolation/provider-secrets-store.errors.js';
import { AppError } from '@/shared/utils.js';

const COST_REPORT_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const ANTHROPIC_VERSION = '2023-06-01';

/** Total budget across every page of one refresh, not per request. */
export const SPEND_TOTAL_TIMEOUT_MS = 8_000;
const SUCCESS_TTL_MS = 60 * 60_000;
const AUTH_FAILURE_TTL_MS = 10 * 60_000;
const UNAVAILABLE_TTL_MS = 2 * 60_000;
/** Upper bound on an upstream Retry-After: a hostile/buggy header can't park us for days. */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;
/** A month has at most 31 daily buckets and a page holds 31; more pages = a loop. */
const MAX_PAGES = 4;
/** Fractional digits kept for the exact sum; finer than any reported amount. */
const DECIMAL_SCALE = 18;
const SCALE = 10n ** BigInt(DECIMAL_SCALE);

const ADMIN_KEY_PATTERN = /^sk-ant-admin\d+-[A-Za-z0-9_-]+$/;
const ADMIN_KEY_MAX_LENGTH = 256;
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

export type ApiSpend = {
  spendCents: number;
  currency: 'USD';
  periodStart: string;
  /** Equal to `observedAt`: the report covers the month up to the read. */
  periodEnd: string;
  observedAt: string;
  /** False when the report holds no cost rows yet (e.g. the 1st of the month). */
  hasData: boolean;
  excludesPriorityTier: true;
};

export type ApiSpendErrorCode = 'API_SPEND_AUTH' | 'API_SPEND_UNAVAILABLE';

/** A known upstream failure. Its message is generic and safe for a client. */
export class ApiSpendError extends Error {
  readonly code: ApiSpendErrorCode;

  constructor(code: ApiSpendErrorCode) {
    super(code === 'API_SPEND_AUTH'
      ? 'The Anthropic Admin key was rejected.'
      : 'Anthropic API spend is currently unavailable.');
    this.name = 'ApiSpendError';
    this.code = code;
  }
}

/** Shape refusal for a pasted key; the message names the only accepted kind. */
export class InvalidAdminKeyError extends Error {
  readonly code = 'INVALID_ADMIN_KEY';

  constructor() {
    super('Only an Anthropic Admin key (sk-ant-admin…) works here. '
      + 'Standard API keys (sk-ant-api…) and OAuth tokens (sk-ant-oat…) are rejected.');
    this.name = 'InvalidAdminKeyError';
  }
}

export type ApiSpendDeps = {
  fetchImpl?: typeof fetch;
  /** The key ready-made; bypasses the store (tests). */
  credential?: string | null;
  now?: () => Date;
  /** Encloses only the live upstream read; cache hits need no lease. */
  runEffect?: <T>(effect: () => Promise<T>) => Promise<T>;
};

export type Outcome =
  | { kind: 'ok'; value: ApiSpend }
  | { kind: 'error'; code: ApiSpendErrorCode; retryAfterMs?: number };

type CacheEntry = { expiresAt: number; outcome: Outcome };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Outcome>>();
/** Bumped on key change so a read started with the old key is never cached. */
const generations = new Map<string, number>();

/** First instant of the UTC calendar month containing `now`. */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Parses a decimal string into a value scaled by 10^DECIMAL_SCALE, or null. */
export function parseScaledDecimal(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || raw.length > 64 || !DECIMAL_PATTERN.test(raw)) return null;
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = (negative ? raw.slice(1) : raw).split('.');
  const digits = (fraction + '0'.repeat(DECIMAL_SCALE)).slice(0, DECIMAL_SCALE);
  const scaled = BigInt(whole) * SCALE + BigInt(digits);
  return negative ? -scaled : scaled;
}

/** Rounds a scaled sum to whole units, half away from zero. */
export function roundScaled(total: bigint): number {
  const magnitude = total < 0n ? -total : total;
  const rounded = (magnitude + SCALE / 2n) / SCALE;
  return Number(total < 0n ? -rounded : rounded);
}

/** Retry-After as delta-seconds or an HTTP date; null when absent/invalid. */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.min(Math.max(0, at - nowMs), MAX_RETRY_AFTER_MS);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type PageSum = { total: bigint; rows: number; nextPage: string | null };

/** Sums one page. Null = malformed or non-USD (never mixed, never guessed). */
export function sumCostPage(body: unknown): PageSum | null {
  const page = asRecord(body);
  if (!page || !Array.isArray(page.data)) return null;
  let total = 0n;
  let rows = 0;
  for (const bucket of page.data) {
    const results = asRecord(bucket)?.results;
    if (!Array.isArray(results)) return null;
    for (const result of results) {
      const row = asRecord(result);
      if (!row || row.currency !== 'USD') return null;
      const amount = parseScaledDecimal(row.amount);
      if (amount === null) return null;
      total += amount;
      rows += 1;
    }
  }
  const nextPage = page.has_more === true ? page.next_page : null;
  if (page.has_more === true && (typeof nextPage !== 'string' || nextPage === '')) return null;
  return { total, rows, nextPage: nextPage as string | null };
}

function pageUrl(start: Date, end: Date, page: string | null): string {
  const params = new URLSearchParams({
    starting_at: start.toISOString(),
    ending_at: end.toISOString(),
    bucket_width: '1d',
    limit: '31',
  });
  if (page) params.set('page', page);
  return `${COST_REPORT_URL}?${params.toString()}`;
}

type FetchResult =
  | { kind: 'body'; body: unknown }
  /** 400/422: the request itself was refused (e.g. a future `ending_at`). */
  | { kind: 'rejected' }
  | Extract<Outcome, { kind: 'error' }>;

/** One request inside the remaining total budget. Never throws. */
async function fetchPage(
  url: string,
  key: string,
  deadline: number,
  fetchImpl: typeof fetch,
): Promise<FetchResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { kind: 'error', code: 'API_SPEND_UNAVAILABLE' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetchImpl(url, {
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return { kind: 'error', code: 'API_SPEND_AUTH' };
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after') ?? null, Date.now());
      return { kind: 'error', code: 'API_SPEND_UNAVAILABLE', retryAfterMs: retryAfterMs ?? undefined };
    }
    if (response.status === 400 || response.status === 422) return { kind: 'rejected' };
    if (!response.ok) return { kind: 'error', code: 'API_SPEND_UNAVAILABLE' };
    return { kind: 'body', body: JSON.parse(await response.text()) as unknown };
  } catch {
    return { kind: 'error', code: 'API_SPEND_UNAVAILABLE' };
  } finally {
    clearTimeout(timer);
  }
}

/** First instant of the UTC day after `now`. */
export function nextDayStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

type WindowSum = { kind: 'sum'; total: bigint; rows: number } | { kind: 'rejected' } | Extract<Outcome, { kind: 'error' }>;

/** Reads every page of one [start, end) window. Never throws. */
async function sumWindow(
  start: Date,
  end: Date,
  key: string,
  deadline: number,
  fetchImpl: typeof fetch,
): Promise<WindowSum> {
  let total = 0n;
  let rows = 0;
  let page: string | null = null;
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const fetched = await fetchPage(pageUrl(start, end, page), key, deadline, fetchImpl);
    if (fetched.kind !== 'body') return index === 0 || fetched.kind !== 'rejected'
      ? fetched
      : { kind: 'error', code: 'API_SPEND_UNAVAILABLE' };
    const sum = sumCostPage(fetched.body);
    if (!sum) return { kind: 'error', code: 'API_SPEND_UNAVAILABLE' };
    total += sum.total;
    rows += sum.rows;
    if (!sum.nextPage) return { kind: 'sum', total, rows };
    page = sum.nextPage;
  }
  return { kind: 'error', code: 'API_SPEND_UNAVAILABLE' };
}

/**
 * Month-to-date spend, exact. The window ends at the start of the NEXT UTC day
 * so today's still-open bucket is included (buckets are returned only when they
 * end before `ending_at`). If upstream refuses that future `ending_at` (400/422)
 * it is retried once with `ending_at = now`, never guessed further.
 */
async function readMonthToDate(key: string, now: Date, fetchImpl: typeof fetch): Promise<Outcome> {
  const start = monthStartUtc(now);
  const stamp = now.toISOString();
  // The very first instant of a month: an empty window has nothing to report.
  if (now.getTime() <= start.getTime()) {
    return { kind: 'ok', value: spendValue(0n, 0, start, stamp) };
  }
  const deadline = Date.now() + SPEND_TOTAL_TIMEOUT_MS;
  let result = await sumWindow(start, nextDayStartUtc(now), key, deadline, fetchImpl);
  if (result.kind === 'rejected') result = await sumWindow(start, now, key, deadline, fetchImpl);
  if (result.kind === 'rejected') return { kind: 'error', code: 'API_SPEND_UNAVAILABLE' };
  if (result.kind === 'error') return result;
  return { kind: 'ok', value: spendValue(result.total, result.rows, start, stamp) };
}

function spendValue(total: bigint, rows: number, start: Date, stamp: string): ApiSpend {
  return {
    spendCents: roundScaled(total), currency: 'USD', periodStart: start.toISOString(),
    periodEnd: stamp, observedAt: stamp, hasData: rows > 0, excludesPriorityTier: true,
  };
}

function ttlFor(outcome: Outcome): number {
  if (outcome.kind === 'ok') return SUCCESS_TTL_MS;
  if (outcome.code === 'API_SPEND_AUTH') return AUTH_FAILURE_TTL_MS;
  return Math.max(UNAVAILABLE_TTL_MS, Math.min(outcome.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS));
}

/** Cache expiry: never past the first instant of the next UTC month. */
export function cacheExpiry(nowMs: number, outcome: Outcome): number {
  const now = new Date(nowMs);
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.min(nowMs + ttlFor(outcome), nextMonth);
}

type KeyReader = (userId: string | number) => string | null;
let keyReader: KeyReader = getAnthropicAdminKey;

/**
 * Reads the caller's stored key. Any store failure becomes a coded 503 (the
 * unreadable-store refusal keeps its own 409) instead of an uncoded throw.
 */
function readStoredKey(userId: string | number): string | null {
  try {
    return withProviderSecretsStore(() => keyReader(userId));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('The key store is currently unavailable.', {
      code: 'ADMIN_KEY_STORE_UNAVAILABLE',
      statusCode: 503,
    });
  }
}

function settle(outcome: Outcome): ApiSpend {
  if (outcome.kind === 'ok') return outcome.value;
  throw new ApiSpendError(outcome.code);
}

const userKey = (userId: string | number): string => String(userId);

/** Throws {@link InvalidAdminKeyError} unless `raw` is a well-formed Admin key. */
export function normalizeAdminKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidAdminKeyError();
  const key = raw.trim();
  if (key.length === 0 || key.length > ADMIN_KEY_MAX_LENGTH
    || /[\s\u0000-\u001f\u007f]/.test(key) || !ADMIN_KEY_PATTERN.test(key)) {
    throw new InvalidAdminKeyError();
  }
  return key;
}

export const anthropicApiSpendService = {
  /**
   * The caller's month-to-date spend, or null when they stored no Admin key.
   * Throws {@link ApiSpendError} for an upstream failure (cached, never a zero).
   */
  async getSpend(userId: string | number, deps: ApiSpendDeps = {}): Promise<ApiSpend | null> {
    const key = deps.credential !== undefined ? deps.credential : readStoredKey(userId);
    if (!key) return null;

    const cacheId = userKey(userId);
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    const cached = cache.get(cacheId);
    if (cached && nowMs < cached.expiresAt) return settle(cached.outcome);

    let pending = inFlight.get(cacheId);
    if (!pending) {
      if (!deps.runEffect && !deps.fetchImpl) throw new Error('SPEND_AUTHENTICATED_EFFECT_RUNNER_REQUIRED');
      const generation = generations.get(cacheId) ?? 0;
      const live = () => readMonthToDate(key, new Date(nowMs), deps.fetchImpl ?? fetch);
      const started: Promise<Outcome> = (deps.runEffect ? deps.runEffect(live) : live())
        .then((outcome) => {
          if ((generations.get(cacheId) ?? 0) === generation) {
            cache.set(cacheId, { expiresAt: cacheExpiry(nowMs, outcome), outcome });
          }
          return outcome;
        })
        .finally(() => {
          if (inFlight.get(cacheId) === started) inFlight.delete(cacheId);
        });
      pending = started;
      inFlight.set(cacheId, started);
    }
    return settle(await pending);
  },

  /** Whether the caller has an Admin key stored. Never reveals it. */
  hasKey(userId: string | number): boolean {
    return readStoredKey(userId) !== null;
  },

  /** Validates and stores the caller's Admin key, dropping their cached spend. */
  setKey(userId: string | number, raw: unknown): void {
    const key = normalizeAdminKey(raw);
    withProviderSecretsStore(() => setAnthropicAdminKey(userId, key));
    this.invalidate(userId);
  },

  /** Removes the caller's Admin key and their cached spend. Idempotent. */
  deleteKey(userId: string | number): boolean {
    const { removed } = withProviderSecretsStore(() => deleteAnthropicAdminKey(userId));
    this.invalidate(userId);
    return removed;
  },

  /** Drops one member's cached spend. */
  invalidate(userId: string | number): void {
    const cacheId = userKey(userId);
    cache.delete(cacheId);
    inFlight.delete(cacheId);
    generations.set(cacheId, (generations.get(cacheId) ?? 0) + 1);
  },

  /** For tests: replaces the store reader (null restores the real one). */
  __setKeyReader(reader: KeyReader | null): void {
    keyReader = reader ?? getAnthropicAdminKey;
  },

  /** For tests. */
  __resetCache(): void {
    cache.clear();
    inFlight.clear();
    generations.clear();
  },
};
