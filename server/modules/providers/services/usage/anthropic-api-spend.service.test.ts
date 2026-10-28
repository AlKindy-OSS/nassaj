/**
 * ADR-214 / T-2066 — `anthropicApiSpendService`: month-to-date Anthropic API
 * spend from the Admin API cost report.
 *
 * Payloads follow the documented cost_report shape: `data[]` daily buckets,
 * each with `results[]` of `{ amount: "<cents decimal>", currency: "USD" }`,
 * plus `has_more` / `next_page`. Pinned: exact decimal sum across pages, UTC
 * month window, cache + single-flight, failure codes (never a zero), 429
 * Retry-After respected, and "no rows" distinct from a real $0.
 *
 * RUNNER: node:test via `npm run test:server`.
 */
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  anthropicApiSpendService,
  ApiSpendError,
  cacheExpiry,
  MAX_RETRY_AFTER_MS,
  InvalidAdminKeyError,
  monthStartUtc,
  nextDayStartUtc,
  normalizeAdminKey,
  parseRetryAfterMs,
  parseScaledDecimal,
  roundScaled,
} from '@/modules/providers/services/usage/anthropic-api-spend.service.js';

const KEY = 'sk-ant-admin01-' + 'FakeKeyForTestsOnly_abc-123';
const NOW = new Date('2026-10-21T12:00:00.000Z');

type Reply = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> };

const bucket = (...amounts: string[]) => ({
  starting_at: '2026-10-01T00:00:00Z',
  ending_at: '2026-10-02T00:00:00Z',
  results: amounts.map(amount => ({ amount, currency: 'USD' })),
});

function scriptedFetch(replies: Reply[]) {
  const state = { calls: 0, urls: [] as string[], headers: [] as Record<string, string>[] };
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const reply = replies[Math.min(state.calls, replies.length - 1)];
    state.calls += 1;
    state.urls.push(String(url));
    state.headers.push((init?.headers ?? {}) as Record<string, string>);
    const status = reply.status ?? 200;
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status, headers: reply.headers });
  }) as unknown as typeof fetch;
  return { impl, state };
}

const read = (impl: typeof fetch, now = NOW, userId: string | number = 'u1') =>
  anthropicApiSpendService.getSpend(userId, { fetchImpl: impl, credential: KEY, now: () => now });

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof ApiSpendError && error.code === code);
}

beforeEach(() => anthropicApiSpendService.__resetCache());

test('sums across two pages, request shape and headers as documented', async () => {
  const { impl, state } = scriptedFetch([
    { body: { data: [bucket('100.25', '50')], has_more: true, next_page: 'page_2' } },
    { body: { data: [bucket('49.75')], has_more: false, next_page: null } },
  ]);
  const spend = await read(impl);
  assert.ok(spend);
  assert.equal(spend.spendCents, 200);
  assert.equal(spend.currency, 'USD');
  assert.equal(spend.hasData, true);
  assert.equal(spend.excludesPriorityTier, true);
  assert.equal(spend.periodStart, '2026-10-01T00:00:00.000Z');
  assert.equal(spend.periodEnd, NOW.toISOString());
  assert.equal(spend.observedAt, NOW.toISOString());
  assert.equal(state.calls, 2);
  const first = new URL(state.urls[0]);
  assert.equal(first.origin + first.pathname, 'https://api.anthropic.com/v1/organizations/cost_report');
  assert.equal(first.searchParams.get('starting_at'), '2026-10-01T00:00:00.000Z');
  assert.equal(first.searchParams.get('ending_at'), '2026-10-22T00:00:00.000Z', 'includes today');
  assert.equal(first.searchParams.get('bucket_width'), '1d');
  assert.equal(first.searchParams.get('limit'), '31');
  assert.equal(first.searchParams.get('page'), null);
  assert.equal(new URL(state.urls[1]).searchParams.get('page'), 'page_2');
  assert.equal(state.headers[0]['x-api-key'], KEY);
  assert.equal(state.headers[0]['anthropic-version'], '2023-06-01');
});

test('fractional cents are summed exactly and rounded once', async () => {
  // Float addition of 0.1 + 0.2 + … drifts; ten × 0.05 = 0.5 → rounds to 1 cent.
  const amounts = Array.from({ length: 10 }, () => '0.05');
  const { impl } = scriptedFetch([{ body: { data: [bucket(...amounts), bucket('123.78912')], has_more: false } }]);
  const spend = await read(impl);
  assert.equal(spend?.spendCents, 124); // 0.5 + 123.78912 = 124.28912 → 124
  assert.equal(roundScaled(parseScaledDecimal('0.4999999')!), 0);
  assert.equal(roundScaled(parseScaledDecimal('0.5')!), 1);
  assert.equal(roundScaled(parseScaledDecimal('-0.5')!), -1);
  assert.equal(parseScaledDecimal('1e3'), null);
  assert.equal(parseScaledDecimal(12), null);
});

test('UTC month boundary: 23:59Z keeps the old month, 00:00Z starts a new one', async () => {
  const lastMinute = new Date('2026-10-31T23:59:00.000Z');
  assert.equal(monthStartUtc(lastMinute).toISOString(), '2026-10-01T00:00:00.000Z');
  const { impl, state } = scriptedFetch([{ body: { data: [bucket('10')], has_more: false } }]);
  const october = await read(impl, lastMinute);
  assert.equal(october?.periodStart, '2026-10-01T00:00:00.000Z');
  assert.equal(new URL(state.urls[0]).searchParams.get('starting_at'), '2026-10-01T00:00:00.000Z');
  assert.equal(new URL(state.urls[0]).searchParams.get('ending_at'), '2026-11-01T00:00:00.000Z');

  anthropicApiSpendService.__resetCache();
  const firstInstant = new Date('2026-11-01T00:00:00.000Z');
  const november = await read(impl, firstInstant);
  assert.equal(november?.periodStart, '2026-11-01T00:00:00.000Z');
  assert.equal(november?.hasData, false);
  assert.equal(november?.spendCents, 0);
  assert.equal(state.calls, 1, 'an empty window does not call upstream');

  anthropicApiSpendService.__resetCache();
  const oneMinuteIn = new Date('2026-11-01T00:01:00.000Z');
  await read(impl, oneMinuteIn);
  assert.equal(new URL(state.urls[1]).searchParams.get('starting_at'), '2026-11-01T00:00:00.000Z');
  assert.equal(new URL(state.urls[1]).searchParams.get('ending_at'), '2026-11-02T00:00:00.000Z');
});

test('cache hit does not fetch; expires after 1h', async () => {
  const { impl, state } = scriptedFetch([{ body: { data: [bucket('1')], has_more: false } }]);
  await read(impl);
  await read(impl, new Date(NOW.getTime() + 59 * 60_000));
  assert.equal(state.calls, 1);
  await read(impl, new Date(NOW.getTime() + 61 * 60_000));
  assert.equal(state.calls, 2);
});

test('concurrent reads share one upstream request (single-flight)', async () => {
  const { impl, state } = scriptedFetch([{ body: { data: [bucket('7')], has_more: false } }]);
  const [a, b, c] = await Promise.all([read(impl), read(impl), read(impl)]);
  assert.equal(state.calls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('per-user cache: another member triggers their own read', async () => {
  const { impl, state } = scriptedFetch([{ body: { data: [bucket('7')], has_more: false } }]);
  await read(impl, NOW, 'u1');
  await read(impl, NOW, 'u2');
  assert.equal(state.calls, 2);
});

for (const status of [401, 403]) {
  test(`upstream ${status} → API_SPEND_AUTH, cached 10 minutes`, async () => {
    const { impl, state } = scriptedFetch([{ status, body: { error: 'nope' } }]);
    await rejectsWith(read(impl), 'API_SPEND_AUTH');
    await rejectsWith(read(impl, new Date(NOW.getTime() + 9 * 60_000)), 'API_SPEND_AUTH');
    assert.equal(state.calls, 1);
    await rejectsWith(read(impl, new Date(NOW.getTime() + 11 * 60_000)), 'API_SPEND_AUTH');
    assert.equal(state.calls, 2);
  });
}

test('429 → unavailable and no upstream call before Retry-After', async () => {
  const { impl, state } = scriptedFetch([{ status: 429, headers: { 'retry-after': '600' } }]);
  await rejectsWith(read(impl), 'API_SPEND_UNAVAILABLE');
  await rejectsWith(read(impl, new Date(NOW.getTime() + 5 * 60_000)), 'API_SPEND_UNAVAILABLE');
  assert.equal(state.calls, 1, 'retry-after (10 min) outlasts the 2-min unavailable TTL');
  await rejectsWith(read(impl, new Date(NOW.getTime() + 11 * 60_000)), 'API_SPEND_UNAVAILABLE');
  assert.equal(state.calls, 2);
  assert.equal(parseRetryAfterMs('30', 0), 30_000);
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 1970 00:01:00 GMT', 0), 60_000);
  assert.equal(parseRetryAfterMs('soon', 0), null);
  assert.equal(parseRetryAfterMs(null, 0), null);
});

test('unavailable without Retry-After is cached only 2 minutes', async () => {
  const { impl, state } = scriptedFetch([{ status: 500 }]);
  await rejectsWith(read(impl), 'API_SPEND_UNAVAILABLE');
  await rejectsWith(read(impl, new Date(NOW.getTime() + 3 * 60_000)), 'API_SPEND_UNAVAILABLE');
  assert.equal(state.calls, 2);
});

const MALFORMED: Array<[string, Reply]> = [
  ['invalid JSON', { raw: '{not json' }],
  ['missing data', { body: { has_more: false } }],
  ['non-numeric amount', { body: { data: [bucket('12abc')], has_more: false } }],
  ['numeric (non-string) amount', { body: { data: [{ results: [{ amount: 12, currency: 'USD' }] }] } }],
  ['non-USD currency', { body: { data: [{ results: [{ amount: '5', currency: 'EUR' }] }] } }],
  ['has_more without next_page', { body: { data: [bucket('1')], has_more: true } }],
];
for (const [label, reply] of MALFORMED) {
  test(`${label} → API_SPEND_UNAVAILABLE, never a zero`, async () => {
    const { impl } = scriptedFetch([reply]);
    await rejectsWith(read(impl), 'API_SPEND_UNAVAILABLE');
  });
}

test('network failure → API_SPEND_UNAVAILABLE', async () => {
  const impl = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
  await rejectsWith(read(impl), 'API_SPEND_UNAVAILABLE');
});

test('endless pagination is cut off as unavailable', async () => {
  const { impl, state } = scriptedFetch([{ body: { data: [bucket('1')], has_more: true, next_page: 'again' } }]);
  await rejectsWith(read(impl), 'API_SPEND_UNAVAILABLE');
  assert.ok(state.calls <= 4);
});

test('the 8s budget is total across pages', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW.getTime() });
  let calls = 0;
  const impl = (async (_url: string, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      t.mock.timers.tick(7_999);
      return new Response(JSON.stringify({ data: [bucket('1')], has_more: true, next_page: 'p2' }));
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }) as unknown as typeof fetch;
  const pending = read(impl);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2);
  await rejectsWith(pending, 'API_SPEND_UNAVAILABLE');
  assert.equal(calls, 2);
});

test('buckets with no rows → hasData false; a real $0 row → hasData true', async () => {
  const empty = scriptedFetch([{ body: { data: [bucket(), bucket()], has_more: false } }]);
  const none = await read(empty.impl);
  assert.equal(none?.hasData, false);
  assert.equal(none?.spendCents, 0);

  anthropicApiSpendService.__resetCache();
  const zero = scriptedFetch([{ body: { data: [bucket('0')], has_more: false } }]);
  const real = await read(zero.impl);
  assert.equal(real?.hasData, true);
  assert.equal(real?.spendCents, 0);
});

test('no key → null, no fetch', async () => {
  const { impl, state } = scriptedFetch([{ body: {} }]);
  const spend = await anthropicApiSpendService.getSpend('u1', { fetchImpl: impl, credential: null });
  assert.equal(spend, null);
  assert.equal(state.calls, 0);
});

test('a live read without an effect runner is refused', async () => {
  await assert.rejects(
    anthropicApiSpendService.getSpend('u1', { credential: KEY }),
    /SPEND_AUTHENTICATED_EFFECT_RUNNER_REQUIRED/,
  );
});

test('runEffect encloses only the live read', async () => {
  const { impl } = scriptedFetch([{ body: { data: [bucket('3')], has_more: false } }]);
  let leases = 0;
  const deps = {
    fetchImpl: impl, credential: KEY, now: () => NOW,
    runEffect: async <T>(effect: () => Promise<T>) => { leases += 1; return effect(); },
  };
  await anthropicApiSpendService.getSpend('u1', deps);
  await anthropicApiSpendService.getSpend('u1', deps);
  assert.equal(leases, 1);
});

test('invalidate drops the cache and a stale in-flight read is not cached', async () => {
  let release: (() => void) | null = null;
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
    return new Response(JSON.stringify({ data: [bucket(String(calls * 100))], has_more: false }));
  }) as unknown as typeof fetch;
  const stale = read(impl);
  await new Promise(resolve => setImmediate(resolve));
  anthropicApiSpendService.invalidate('u1');
  (release as unknown as () => void)();
  assert.equal((await stale)?.spendCents, 100);
  const fresh = await read(impl);
  assert.equal(fresh?.spendCents, 200, 'the read started before invalidate was not cached');
});

test('admin key shape: only sk-ant-admin keys pass', () => {
  assert.equal(normalizeAdminKey(`  ${KEY}  `), KEY);
  const rejected = [
    'sk-ant-api03-abcdef', 'sk-ant-oat01-abcdef', 'sk-ant-admin-abc', 'sk-ant-admin01-',
    `sk-ant-admin01-abc def`, 'sk-ant-admin01-abc\u0000', `sk-ant-admin01-${'a'.repeat(300)}`,
    '', 42, null,
  ];
  for (const value of rejected) {
    assert.throws(() => normalizeAdminKey(value), InvalidAdminKeyError, String(value));
  }
  const message = new InvalidAdminKeyError().message;
  assert.match(message, /Admin key/);
  assert.match(message, /sk-ant-api/);
  assert.match(message, /sk-ant-oat/);
});

test('ending_at is the next UTC day start, including across a month end', () => {
  assert.equal(nextDayStartUtc(NOW).toISOString(), '2026-10-22T00:00:00.000Z');
  assert.equal(nextDayStartUtc(new Date('2026-10-31T23:59:00.000Z')).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(nextDayStartUtc(new Date('2026-11-01T00:00:01.000Z')).toISOString(), '2026-11-02T00:00:00.000Z');
});

test('a refused future ending_at falls back once to ending_at=now', async () => {
  const { impl, state } = scriptedFetch([
    { status: 400, body: { error: { type: 'invalid_request_error' } } },
    { body: { data: [bucket('25')], has_more: false } },
  ]);
  const spend = await read(impl);
  assert.equal(spend?.spendCents, 25);
  assert.equal(spend?.periodEnd, NOW.toISOString());
  assert.equal(state.calls, 2);
  assert.equal(new URL(state.urls[0]).searchParams.get('ending_at'), '2026-10-22T00:00:00.000Z');
  assert.equal(new URL(state.urls[1]).searchParams.get('ending_at'), NOW.toISOString());
});

test('the fallback happens only once: a second refusal is unavailable', async () => {
  const { impl, state } = scriptedFetch([{ status: 422 }, { status: 400 }, { body: { data: [] } }]);
  await rejectsWith(read(impl), 'API_SPEND_UNAVAILABLE');
  assert.equal(state.calls, 2);
});

test('a refusal on a later page is not retried with another window', async () => {
  const { impl, state } = scriptedFetch([
    { body: { data: [bucket('1')], has_more: true, next_page: 'p2' } },
    { status: 400 },
    { body: { data: [bucket('1')], has_more: false } },
  ]);
  await rejectsWith(read(impl), 'API_SPEND_UNAVAILABLE');
  assert.equal(state.calls, 2);
});

test('a huge Retry-After is clamped to one hour', async () => {
  assert.equal(parseRetryAfterMs('99999999999', 0), MAX_RETRY_AFTER_MS);
  assert.equal(parseRetryAfterMs('Fri, 01 Jan 2100 00:00:00 GMT', 0), MAX_RETRY_AFTER_MS);
  const unavailable = { kind: 'error', code: 'API_SPEND_UNAVAILABLE', retryAfterMs: 1e15 } as const;
  assert.equal(cacheExpiry(NOW.getTime(), unavailable), NOW.getTime() + MAX_RETRY_AFTER_MS);

  const { impl, state } = scriptedFetch([{ status: 429, headers: { 'retry-after': '99999999999' } }]);
  await rejectsWith(read(impl), 'API_SPEND_UNAVAILABLE');
  await rejectsWith(read(impl, new Date(NOW.getTime() + 59 * 60_000)), 'API_SPEND_UNAVAILABLE');
  assert.equal(state.calls, 1);
  await rejectsWith(read(impl, new Date(NOW.getTime() + 61 * 60_000)), 'API_SPEND_UNAVAILABLE');
  assert.equal(state.calls, 2, 'upstream is asked again after the clamped hour');
});

test('a success cached at 23:30Z on the last day expires at the month boundary', async () => {
  const lateOctober = new Date('2026-10-31T23:30:00.000Z');
  const { impl, state } = scriptedFetch([{ body: { data: [bucket('9')], has_more: false } }]);
  const october = await read(impl, lateOctober);
  assert.equal(october?.periodStart, '2026-10-01T00:00:00.000Z');
  await read(impl, new Date('2026-10-31T23:59:59.000Z'));
  assert.equal(state.calls, 1, 'still October: cache hit');
  const november = await read(impl, new Date('2026-11-01T00:00:30.000Z'));
  assert.equal(state.calls, 2, 'the October total is not served as November');
  assert.equal(november?.periodStart, '2026-11-01T00:00:00.000Z');
});

test('a store failure becomes a coded 503, never an uncoded throw', async () => {
  anthropicApiSpendService.__setKeyReader(() => { throw new Error('disk on fire'); });
  try {
    const coded = (error: unknown) => (error as { code?: string; statusCode?: number }).code
      === 'ADMIN_KEY_STORE_UNAVAILABLE' && (error as { statusCode?: number }).statusCode === 503;
    assert.throws(() => anthropicApiSpendService.hasKey('u1'), coded);
    await assert.rejects(anthropicApiSpendService.getSpend('u1', { fetchImpl: fetch }), coded);
  } finally {
    anthropicApiSpendService.__setKeyReader(null);
  }
});
