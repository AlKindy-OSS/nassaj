/**
 * اختبارات `providerBalanceService` — قراءة الرصيد من مصدر المزوّد الرسمي.
 *
 * الحمولة أدناه مبنية على **شكل الردّ الموثَّق** لـ
 * `api.moonshot.ai/v1/users/me/balance` (بنية `{code, data:{available_balance,
 * voucher_balance, cash_balance}, status}`)، والقيم تطابق لقطة لوحة المالك
 * ‏2026-07-31: شحن 20 + قسيمة 5 − مستهلَك 7.41 = 17.58950 متاح.
 *
 * المُثبَت:
 *  1. تحويل صحيح للحقول الثلاثة، والمسار والترويسة كما يقبلهما المزوّد.
 *  2. أي فشل (‏401، شبكة، JSON تالف، شكل غير متوقّع) ⇒ `null` = «لا نعرف»،
 *     ولا يُصنَع منه صفرٌ — وصفر الرصيد يُقرأ «نَفِد» فهو كذبة مضاعفة.
 *  3. رصيدٌ سالب (دَين) يُنقَل كما هو لا يُقصَر عند صفر.
 *  4. الكاش وsingle-flight: نداءان ⇒ جلبٌ واحد.
 *  5. مورّد بلا مصدر (‏glm/anthropic) ⇒ `null` بلا أي نداء شبكي.
 *
 * RUNNER: node:test عبر `npm run test:server`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { providerBalanceService, hasBalanceSource } from '@/modules/providers/services/usage/provider-balance.service.js';

const MOONSHOT_BODY = {
  code: 0,
  data: {
    available_balance: 17.5895,
    voucher_balance: 5.0,
    cash_balance: 12.5895,
  },
  scode: '0x0',
  status: true,
};

const jsonResponse = (body: unknown, ok = true, status = 200) =>
  ({
    ok,
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

function countingFetch(body: unknown, ok = true, status = 200) {
  const state = { calls: 0, urls: [] as string[], headers: [] as Record<string, string>[] };
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    state.calls += 1;
    state.urls.push(String(url));
    state.headers.push((init?.headers ?? {}) as Record<string, string>);
    return jsonResponse(body, ok, status);
  }) as unknown as typeof fetch;
  return { impl, state };
}

test('moonshot: الحقول الثلاثة والمسار والترويسة', async () => {
  providerBalanceService.__resetCache();
  const { impl, state } = countingFetch(MOONSHOT_BODY);

  const result = await providerBalanceService.getBalance('moonshot', 'u1', {
    fetchImpl: impl,
    credential: 'fake-key',
    now: () => new Date('2026-07-31T00:00:00.000Z'),
  });

  assert.ok(result);
  assert.equal(result.provider, 'moonshot');
  assert.equal(result.availableUsd, 17.5895);
  assert.equal(result.voucherUsd, 5.0);
  assert.equal(result.cashUsd, 12.5895);
  assert.equal(result.observedAt, '2026-07-31T00:00:00.000Z');

  assert.equal(state.urls[0], 'https://api.moonshot.ai/v1/users/me/balance');
  assert.equal(state.headers[0].Authorization, 'Bearer fake-key');
});

test('رصيد سالب (دَين) يُنقَل كما هو لا يُقصَر عند صفر', async () => {
  providerBalanceService.__resetCache();
  const { impl } = countingFetch({
    code: 0,
    data: { available_balance: 0, voucher_balance: 0, cash_balance: -3.2 },
  });

  const result = await providerBalanceService.getBalance('moonshot', 'u1', {
    fetchImpl: impl,
    credential: 'k',
  });

  assert.equal(result?.availableUsd, 0);
  assert.equal(result?.cashUsd, -3.2);
});

test('‏401 (مفتاح بائت) ⇒ null لا صفر', async () => {
  providerBalanceService.__resetCache();
  const { impl } = countingFetch({ error: { type: 'auth_error' } }, false, 401);
  const result = await providerBalanceService.getBalance('moonshot', 'u1', {
    fetchImpl: impl,
    credential: 'expired',
  });
  assert.equal(result, null);
});

test('شبكة ساقطة أو JSON تالف ⇒ null', async () => {
  providerBalanceService.__resetCache();
  const throwing = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  assert.equal(
    await providerBalanceService.getBalance('moonshot', 'u1', { fetchImpl: throwing, credential: 'k' }),
    null,
  );

  providerBalanceService.__resetCache();
  const badJson = (async () =>
    ({ ok: true, status: 200, text: async () => '{not json' }) as unknown as Response) as unknown as typeof fetch;
  assert.equal(
    await providerBalanceService.getBalance('moonshot', 'u1', { fetchImpl: badJson, credential: 'k' }),
    null,
  );
});

test('شكل غير متوقّع (بلا data / بلا available_balance) ⇒ null', async () => {
  providerBalanceService.__resetCache();
  const { impl } = countingFetch({ code: 0, status: true });
  assert.equal(
    await providerBalanceService.getBalance('moonshot', 'u1', { fetchImpl: impl, credential: 'k' }),
    null,
  );

  providerBalanceService.__resetCache();
  const { impl: noAmount } = countingFetch({ code: 0, data: { voucher_balance: 5 } });
  assert.equal(
    await providerBalanceService.getBalance('moonshot', 'u1', { fetchImpl: noAmount, credential: 'k' }),
    null,
  );
});

test('الكاش: نداءان ⇒ جلبٌ واحد، والعزل لكل مستخدم', async () => {
  providerBalanceService.__resetCache();
  const { impl, state } = countingFetch(MOONSHOT_BODY);
  const deps = { fetchImpl: impl, credential: 'k' };

  await providerBalanceService.getBalance('moonshot', 'u1', deps);
  await providerBalanceService.getBalance('moonshot', 'u1', deps);
  assert.equal(state.calls, 1, 'الثاني من الكاش');

  await providerBalanceService.getBalance('moonshot', 'u2', deps);
  assert.equal(state.calls, 2, 'مستخدم آخر لا يستلم لقطة غيره');
});

test('single-flight: أربعة متزامنة ⇒ جلبٌ واحد', async () => {
  providerBalanceService.__resetCache();
  const { impl, state } = countingFetch(MOONSHOT_BODY);
  const deps = { fetchImpl: impl, credential: 'k' };
  await Promise.all([
    providerBalanceService.getBalance('moonshot', 'u1', deps),
    providerBalanceService.getBalance('moonshot', 'u1', deps),
    providerBalanceService.getBalance('moonshot', 'u1', deps),
    providerBalanceService.getBalance('moonshot', 'u1', deps),
  ]);
  assert.equal(state.calls, 1);
});

test('permission effect encloses only the live refresh, not cache hits', async () => {
  providerBalanceService.__resetCache();
  const { impl } = countingFetch(MOONSHOT_BODY);
  let effects = 0;
  const deps = {
    fetchImpl: impl,
    credential: 'k',
    runEffect: async <T>(effect: () => Promise<T>): Promise<T> => {
      effects += 1;
      return effect();
    },
  };
  await providerBalanceService.getBalance('moonshot', 'u1', deps);
  await providerBalanceService.getBalance('moonshot', 'u1', deps);
  assert.equal(effects, 1);
});

test('مورّد بلا مصدر رصيد ⇒ null بلا أي نداء شبكي', async () => {
  providerBalanceService.__resetCache();
  const { impl, state } = countingFetch(MOONSHOT_BODY);
  for (const vendor of ['glm', 'anthropic', 'openai', 'opencode-zen', 'nope']) {
    assert.equal(
      await providerBalanceService.getBalance(vendor, 'u1', { fetchImpl: impl, credential: 'k' }),
      null,
      vendor,
    );
  }
  assert.equal(state.calls, 0);
});

test('hasBalanceSource يعلن moonshot وحده اليوم', () => {
  assert.equal(hasBalanceSource('moonshot'), true);
  assert.equal(hasBalanceSource('glm'), false);
  assert.equal(hasBalanceSource('anthropic'), false);
});
