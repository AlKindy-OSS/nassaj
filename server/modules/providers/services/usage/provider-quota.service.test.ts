/**
 * اختبارات `providerQuotaService` — قراءة الحصّة من مصدر المزوّد الرسمي.
 *
 * الحمولتان أدناه **منسوختان من الردّ الحيّ** المقروء 2026-07-30 (بمفتاح/توكن
 * حقيقيين، بلا طبع سرّ)، لا مُلفَّقتان: هذا هو الفرق بين اختبارٍ يُثبت العمل على
 * بيانات الإنتاج وآخر يُثبت أن المُحلِّل يوافق خيالَ كاتبه.
 *
 * المُثبَت:
 *  1. تحويل صحيح لشكل كودكس (‏`reset_at` ثوانٍ ⇒ ISO) وglm (‏`nextResetTime`
 *     ملّي، و`percentage` = المستهلك).
 *  2. **لا هوية ولا مال يعبران**: ردّ كودكس يحمل `email` و`user_id` و`credits`
 *     ولا يظهر أيٌّ منها في المخرج.
 *  3. أي فشل (‏401 توكن بائت، شبكة، JSON تالف، شكل غير متوقّع) ⇒ `null` = «لا
 *     نعرف»، ولا يُصنَع منه صفر ولا نسبة.
 *  4. الكاش وsingle-flight: نداءان ⇒ جلبٌ واحد، وأربعة متزامنة ⇒ جلبٌ واحد.
 *  5. مزوّد بلا مصدر (‏kimi/claude) ⇒ `null` بلا أي نداء شبكي.
 *
 * RUNNER: node:test عبر `npm run test:server`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  validateInProcessReadDescriptor,
  type InProcessReadDescriptor,
  type InProcessReadResult,
} from '@/modules/execution-permissions/index.js';
import { providerQuotaService } from '@/modules/providers/services/usage/provider-quota.service.js';

// ردّ كودكس الحيّ (مقتطعٌ بأمانة: الحقول كلها كما وصلت، والقيم كما هي).
const CODEX_LIVE_BODY = {
  user_id: 'user-EXAMPLE',
  account_id: 'user-EXAMPLE',
  email: 'owner@example.com',
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 0,
      limit_window_seconds: 604800,
      reset_after_seconds: 604800,
      reset_at: 1785974455,
    },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  credits: { has_credits: false, unlimited: false, balance: '0' },
};

// ردّ z.ai الحيّ.
const GLM_LIVE_BODY = {
  code: 200,
  msg: 'Operation successful',
  data: {
    limits: [
      {
        type: 'TIME_LIMIT',
        unit: 5,
        number: 1,
        usage: 100,
        currentValue: 2,
        remaining: 98,
        percentage: 2,
        nextResetTime: 1786295422998,
        usageDetails: [{ modelCode: 'search-prime', usage: 2 }],
      },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 100, nextResetTime: 1785377327699 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 29, nextResetTime: 1785431422998 },
    ],
    level: 'lite',
  },
  success: true,
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

test('codex: تحويل النافذة الأساسية وتمرير رصيد الاستخدام الإضافي الآمن فقط', async () => {
  providerQuotaService.__resetCache();
  const { impl, state } = countingFetch(CODEX_LIVE_BODY);

  const result = await providerQuotaService.getWindows('codex', 'u1', {
    fetchImpl: impl,
    credential: 'fake-access-token',
    now: () => new Date('2026-07-30T00:00:00.000Z'),
  });

  assert.ok(result);
  assert.equal(result.provider, 'codex');
  assert.equal(result.plan, 'plus');
  assert.equal(result.windows.length, 1);
  assert.deepEqual(result.windows[0], {
    key: 'primary',
    usedPercent: 0,
    resetsAt: new Date(1785974455 * 1000).toISOString(),
    windowSeconds: 604800,
  });

  // الترويسة صحيحة والمسار هو wham لا codex (‏الأخير يرد 403 حيّاً).
  assert.equal(state.urls[0], 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(state.headers[0].Authorization, 'Bearer fake-access-token');

  // الردّ الحيّ لخطة بلا رصيد: has_credits=false مع balance="0" ⇒ لا رصيد (يُخفى)،
  // لا صفرٌ مُلفَّق. ولا هوية ولا كائن credits الخام في المخرج.
  assert.equal(result.extraUsageCredits, undefined);
  assert.equal('extraUsageCredits' in result, false);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['email', 'user_id', 'account_id', 'has_credits']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} يجب ألا يعبر العقد`);
  }
});

test('codex: رصيد إضافي صالح يمرّ، والرصيد الناقص أو السالب لا يُلفَّق', async () => {
  providerQuotaService.__resetCache();
  const withCredits = {
    ...CODEX_LIVE_BODY,
    credits: { has_credits: true, unlimited: false, balance: '17.25', internal_note: 'never expose' },
  };
  const { impl } = countingFetch(withCredits);
  const result = await providerQuotaService.getWindows('codex', 'u1', {
    fetchImpl: impl,
    credential: 'fake-access-token',
  });
  assert.deepEqual(result?.extraUsageCredits, { balance: 17.25, unlimited: false });
  assert.equal(JSON.stringify(result).includes('internal_note'), false);

  providerQuotaService.__resetCache();
  const { impl: invalidImpl } = countingFetch({
    ...CODEX_LIVE_BODY,
    credits: { has_credits: true, unlimited: false, balance: '-1' },
  });
  const invalid = await providerQuotaService.getWindows('codex', 'u1', {
    fetchImpl: invalidImpl,
    credential: 'fake-access-token',
  });
  assert.equal(invalid?.extraUsageCredits, undefined);
});

test('codex: balance يقبل الرقم finite غير السالب مع بقاء السلسلة العشرية', async () => {
  for (const balance of [17.25, '17.25']) {
    providerQuotaService.__resetCache();
    const { impl } = countingFetch({
      ...CODEX_LIVE_BODY,
      credits: { has_credits: true, unlimited: false, balance },
    });
    const result = await providerQuotaService.getWindows('codex', 'u1', {
      fetchImpl: impl,
      credential: 'fake-access-token',
    });
    assert.deepEqual(result?.extraUsageCredits, { balance: 17.25, unlimited: false });
  }
});

test('codex: balance رقمياً يُقرَّب لأقرب سنت لا يُرفَض لذيل فاصلة عائمة', async () => {
  // 0.1 + 0.2 نفسه ينتج 0.30000000000000004 في IEEE-754 — هذا ذيلٌ حسابي لا
  // رقماً حقيقياً من Codex، والتقريب لسنتَين يُصحّحه بدل رفضه «كثير الأرقام».
  for (const [balance, expected] of [
    [0.1 + 0.2, 0.3],
    [17.999999999999996, 18],
    [0.30000000000000004, 0.3],
  ] as const) {
    providerQuotaService.__resetCache();
    const { impl } = countingFetch({
      ...CODEX_LIVE_BODY,
      credits: { has_credits: true, unlimited: false, balance },
    });
    const result = await providerQuotaService.getWindows('codex', 'u1', {
      fetchImpl: impl,
      credential: 'fake-access-token',
    });
    assert.deepEqual(result?.extraUsageCredits, { balance: expected, unlimited: false });
  }
});

test('codex: يمرّر الرصيد حتى عند غياب نافذة حصّة صالحة', async () => {
  providerQuotaService.__resetCache();
  const { impl } = countingFetch({
    ...CODEX_LIVE_BODY,
    rate_limit: { primary_window: null, secondary_window: null },
    credits: { has_credits: true, unlimited: false, balance: '12.5' },
  });

  const result = await providerQuotaService.getWindows('codex', 'u1', {
    fetchImpl: impl,
    credential: 'fake-access-token',
  });

  assert.deepEqual(result?.windows, []);
  assert.deepEqual(result?.extraUsageCredits, { balance: 12.5, unlimited: false });
});

test('codex: يمرّر الرصيد حتى عند غياب rate_limit بالكامل', async () => {
  providerQuotaService.__resetCache();
  const { impl } = countingFetch({
    plan_type: 'plus',
    credits: { has_credits: true, unlimited: false, balance: '8.50' },
  });

  const result = await providerQuotaService.getWindows('codex', 'u1', {
    fetchImpl: impl,
    credential: 'fake-access-token',
  });

  assert.deepEqual(result?.windows, []);
  assert.deepEqual(result?.extraUsageCredits, { balance: 8.5, unlimited: false });
});

test('codex: balance يقبل عشرياً صريحاً فقط ودقةً آمنة', async () => {
  for (const balance of [
    '0x10',
    '1e3',
    'NaN',
    'Infinity',
    '-1',
    ' 1',
    '1 ',
    '9007199254740992',
    '1.1234567890123456',
  ]) {
    providerQuotaService.__resetCache();
    const { impl } = countingFetch({
      ...CODEX_LIVE_BODY,
      credits: { has_credits: true, unlimited: false, balance },
    });
    const result = await providerQuotaService.getWindows('codex', 'u1', {
      fetchImpl: impl,
      credential: 'fake-access-token',
    });
    assert.equal(result?.extraUsageCredits, undefined, `${balance} يجب رفضه`);
  }

  providerQuotaService.__resetCache();
  const { impl } = countingFetch({
    ...CODEX_LIVE_BODY,
    credits: { has_credits: true, unlimited: true, balance: '9007199254740991' },
  });
  const result = await providerQuotaService.getWindows('codex', 'u1', {
    fetchImpl: impl,
    credential: 'fake-access-token',
  });
  assert.deepEqual(result?.extraUsageCredits, { balance: Number.MAX_SAFE_INTEGER, unlimited: true });
});

async function codexCreditsFor(credits: unknown, extra: Record<string, unknown> = {}) {
  providerQuotaService.__resetCache();
  const { impl } = countingFetch({ ...CODEX_LIVE_BODY, ...extra, credits });
  return providerQuotaService.getWindows('codex', 'u1', {
    fetchImpl: impl,
    credential: 'fake-access-token',
  });
}

test('codex credits rule: plan without a credit pool is hidden, never zero', async () => {
  for (const credits of [
    { has_credits: false, unlimited: false, balance: '0' },
    { has_credits: false, unlimited: false, balance: '5' },
    { has_credits: false, unlimited: true, balance: null },
  ]) {
    const result = await codexCreditsFor(credits);
    assert.ok(result, 'windows still returned');
    assert.equal(result.extraUsageCredits, undefined, JSON.stringify(credits));
  }
});

test('codex credits rule: confirmed pool at zero is reported as zero', async () => {
  const result = await codexCreditsFor({ has_credits: true, unlimited: false, balance: '0' });
  assert.deepEqual(result?.extraUsageCredits, { balance: 0, unlimited: false });
});

test('codex credits rule: positive balance is shown', async () => {
  const result = await codexCreditsFor({ has_credits: true, unlimited: false, balance: '3.40' });
  assert.deepEqual(result?.extraUsageCredits, { balance: 3.4, unlimited: false });
});

test('codex credits rule: confirmed unlimited is shown even without a balance', async () => {
  const noBalance = await codexCreditsFor({ has_credits: true, unlimited: true, balance: null });
  assert.deepEqual(noBalance?.extraUsageCredits, { balance: null, unlimited: true });
  const legacy = await codexCreditsFor({ unlimited: true });
  assert.deepEqual(legacy?.extraUsageCredits, { balance: null, unlimited: true });
});

test('codex credits rule: missing or malformed credits are hidden', async () => {
  for (const credits of [
    undefined,
    null,
    'x',
    [],
    {},
    { has_credits: true, balance: '4' },
    { has_credits: true, unlimited: false },
    { has_credits: true, unlimited: false, balance: null },
    { has_credits: 'yes', unlimited: false, balance: '4' },
  ]) {
    const result = await codexCreditsFor(credits);
    assert.equal(result?.extraUsageCredits, undefined, JSON.stringify(credits));
  }
});

test('codex credits rule: without has_credits only an unambiguous value is shown', async () => {
  const zero = await codexCreditsFor({ unlimited: false, balance: '0' });
  assert.equal(zero?.extraUsageCredits, undefined, 'bare zero may mean no pool');
  const positive = await codexCreditsFor({ unlimited: false, balance: '2' });
  assert.deepEqual(positive?.extraUsageCredits, { balance: 2, unlimited: false });
});

test('codex credits rule: fetch error yields no credits and no payload', async () => {
  providerQuotaService.__resetCache();
  const { impl } = countingFetch({ credits: { has_credits: true, unlimited: false, balance: '9' } }, false, 500);
  const result = await providerQuotaService.getWindows('codex', 'u1', {
    fetchImpl: impl,
    credential: 'fake-access-token',
  });
  assert.equal(result, null);
});

test('codex credits rule: no windows and no pool yields null', async () => {
  const result = await codexCreditsFor(
    { has_credits: false, unlimited: false, balance: '0' },
    { rate_limit: null },
  );
  assert.equal(result, null);
});

test('glm: ثلاث نوافذ، والنسبة هي المستهلك، والترويسة بلا Bearer', async () => {
  providerQuotaService.__resetCache();
  const { impl, state } = countingFetch(GLM_LIVE_BODY);

  const result = await providerQuotaService.getWindows('glm', 'u1', {
    fetchImpl: impl,
    credential: 'fake-glm-key',
    now: () => new Date('2026-07-30T00:00:00.000Z'),
  });

  assert.ok(result);
  assert.equal(result.plan, 'lite');
  assert.deepEqual(
    result.windows.map((w) => [w.key, w.usedPercent]),
    [
      ['tools', 2],
      ['tokens1', 100],
      ['tokens2', 29],
    ],
  );
  assert.equal(result.windows[1].resetsAt, new Date(1785377327699).toISOString());
  // بلا بادئة Bearer — هكذا يقبله z.ai حرفياً.
  assert.equal(state.headers[0].Authorization, 'fake-glm-key');
});

test('glm: طول النافذة يُشتقّ من unit/number مطابقاً للتوثيق', async () => {
  providerQuotaService.__resetCache();
  const { impl } = countingFetch(GLM_LIVE_BODY);

  const result = await providerQuotaService.getWindows('glm', 'u1', {
    fetchImpl: impl,
    credential: 'fake-glm-key',
  });

  const byKey = Object.fromEntries((result?.windows ?? []).map((w) => [w.key, w.windowSeconds]));
  // (3,5)=خمس ساعات، (6,1)=أسبوع، (5,1)=شهر — وهي نوافذ التوثيق الثلاث حرفياً.
  assert.equal(byKey.tokens1, 18_000);
  assert.equal(byKey.tokens2, 604_800);
  assert.equal(byKey.tools, 2_592_000);
});

test('glm: وحدة غير معروفة ⇒ نافذة بلا طول (لا طولٌ مختلق)', async () => {
  providerQuotaService.__resetCache();
  const { impl } = countingFetch({
    data: {
      level: 'pro',
      limits: [{ type: 'TOKENS_LIMIT', unit: 99, number: 4, percentage: 12, nextResetTime: 1786295422998 }],
    },
  });
  const result = await providerQuotaService.getWindows('glm', 'u1', {
    fetchImpl: impl,
    credential: 'k',
  });
  assert.equal(result?.windows.length, 1);
  assert.equal(result?.windows[0].windowSeconds, undefined);
});

test('‏401 (توكن بائت) ⇒ null لا صفر', async () => {
  providerQuotaService.__resetCache();
  const { impl } = countingFetch({ detail: 'unauthorized' }, false, 401);
  const result = await providerQuotaService.getWindows('codex', 'u1', {
    fetchImpl: impl,
    credential: 'expired',
  });
  assert.equal(result, null);
});

test('شبكة ساقطة أو JSON تالف ⇒ null', async () => {
  providerQuotaService.__resetCache();
  const throwing = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  assert.equal(
    await providerQuotaService.getWindows('glm', 'u1', { fetchImpl: throwing, credential: 'k' }),
    null,
  );

  providerQuotaService.__resetCache();
  const badJson = (async () =>
    ({ ok: true, status: 200, text: async () => '{not json' }) as unknown as Response) as unknown as typeof fetch;
  assert.equal(
    await providerQuotaService.getWindows('glm', 'u1', { fetchImpl: badJson, credential: 'k' }),
    null,
  );
});

test('شكل غير متوقّع (بلا rate_limit / بلا limits) ⇒ null', async () => {
  providerQuotaService.__resetCache();
  const { impl } = countingFetch({ plan_type: 'plus' });
  assert.equal(
    await providerQuotaService.getWindows('codex', 'u1', { fetchImpl: impl, credential: 'x' }),
    null,
  );

  providerQuotaService.__resetCache();
  const { impl: glmImpl } = countingFetch({ data: { level: 'lite' } });
  assert.equal(
    await providerQuotaService.getWindows('glm', 'u1', { fetchImpl: glmImpl, credential: 'x' }),
    null,
  );
});

test('نوافذ بلا نسبة رقمية تُحذَف، وحين تُحذَف كلها ⇒ null', async () => {
  providerQuotaService.__resetCache();
  const { impl } = countingFetch({
    data: { level: 'lite', limits: [{ type: 'TOKENS_LIMIT', percentage: null, nextResetTime: 1 }] },
  });
  assert.equal(
    await providerQuotaService.getWindows('glm', 'u1', { fetchImpl: impl, credential: 'x' }),
    null,
  );
});

test('الكاش: نداءان ⇒ جلبٌ واحد', async () => {
  providerQuotaService.__resetCache();
  const { impl, state } = countingFetch(GLM_LIVE_BODY);
  const deps = { fetchImpl: impl, credential: 'k' };

  const first = await providerQuotaService.getWindows('glm', 'u1', deps);
  const second = await providerQuotaService.getWindows('glm', 'u1', deps);

  assert.equal(state.calls, 1);
  assert.equal(first, second);
});

test('single-flight: أربعة متزامنة ⇒ جلبٌ واحد', async () => {
  providerQuotaService.__resetCache();
  const { impl, state } = countingFetch(GLM_LIVE_BODY);
  const deps = { fetchImpl: impl, credential: 'k' };

  const results = await Promise.all([
    providerQuotaService.getWindows('glm', 'u1', deps),
    providerQuotaService.getWindows('glm', 'u1', deps),
    providerQuotaService.getWindows('glm', 'u1', deps),
    providerQuotaService.getWindows('glm', 'u1', deps),
  ]);

  assert.equal(state.calls, 1);
  assert.equal(
    results.every((r) => r === results[0]),
    true,
  );
});

test('T-1910: each live read is one admitted GET descriptor; cache hits need no lease', async () => {
  providerQuotaService.__resetCache();
  const descriptors: InProcessReadDescriptor[] = [];
  const deps = {
    credential: 'k',
    read: async (descriptor: InProcessReadDescriptor): Promise<InProcessReadResult> => {
      descriptors.push(descriptor);
      return { kind: 'response', status: 200, body: JSON.stringify(GLM_LIVE_BODY) };
    },
  };
  assert.equal((await providerQuotaService.getWindows('glm', 'u1', deps))?.provider, 'glm');
  await providerQuotaService.getWindows('glm', 'u1', deps);
  assert.equal(descriptors.length, 1);
});

test('T-1910: codex, glm and kimi readers send only valid GET descriptors to allowlisted origins', async () => {
  const home = mkdtempSync(path.join('/var/tmp', 'quota-kimi-home-'));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const credentials = path.join(home, '.kimi-code', 'credentials');
    mkdirSync(credentials, { recursive: true });
    const writeKimi = (secondsLeft: number) => writeFileSync(path.join(credentials, 'kimi-code.json'),
      JSON.stringify({ access_token: 'kimi-token', expires_at: Math.floor(Date.now() / 1000) + secondsLeft }));
    const descriptors: InProcessReadDescriptor[] = [];
    const read = async (descriptor: InProcessReadDescriptor): Promise<InProcessReadResult> => {
      descriptors.push(validateInProcessReadDescriptor(descriptor));
      return { kind: 'response', status: 200, body: '{}' };
    };
    for (const provider of ['codex', 'glm']) {
      providerQuotaService.__resetCache();
      await providerQuotaService.getWindows(provider, 'u1', { credential: 'k', read });
    }
    // Kimi refuses a near-expiry token instead of refreshing it: nothing is sent.
    writeKimi(30);
    providerQuotaService.__resetCache();
    await providerQuotaService.getWindows('kimi', null, { read });
    assert.equal(descriptors.length, 2);
    writeKimi(3_600);
    providerQuotaService.__resetCache();
    await providerQuotaService.getWindows('kimi', null, { read });
    assert.deepEqual(descriptors.map(descriptor => [descriptor.method, new URL(descriptor.url).origin]), [
      ['GET', 'https://chatgpt.com'], ['GET', 'https://api.z.ai'], ['GET', 'https://api.kimi.com'],
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('T-1910: a failed or non-2xx in-process read is "unknown", never a number', async () => {
  for (const result of [
    { kind: 'failed', reason: 'timeout' }, { kind: 'failed', reason: 'redirect' },
    { kind: 'response', status: 401, body: '{}' }, { kind: 'response', status: 200, body: '' },
    { kind: 'response', status: 200, body: 'not json' },
  ] as InProcessReadResult[]) {
    providerQuotaService.__resetCache();
    assert.equal(await providerQuotaService.getWindows('glm', 'u1', { credential: 'k', read: async () => result }), null);
  }
  providerQuotaService.__resetCache();
  await assert.rejects(providerQuotaService.getWindows('glm', 'u1', { credential: 'k' }),
    /QUOTA_AUTHENTICATED_EFFECT_RUNNER_REQUIRED/);
});

test('B-1289: a refusal thrown by the admitted read propagates, is not cached, and is not "no source"', async () => {
  for (const provider of ['codex', 'glm']) {
    providerQuotaService.__resetCache();
    const refusal = Object.assign(new Error('EFFECT_SCOPE_FENCED'), { code: 'EFFECT_SCOPE_FENCED' });
    let calls = 0;
    const read = async (): Promise<InProcessReadResult> => { calls += 1; throw refusal; };
    await assert.rejects(providerQuotaService.getWindows(provider, 'u1', { credential: 'k', read }),
      (error: unknown) => error === refusal, provider);
    // Not cached: the next request asks the gate again instead of serving a stale null.
    await assert.rejects(providerQuotaService.getWindows(provider, 'u1', { credential: 'k', read }));
    assert.equal(calls, 2, provider);
  }
});

test('الفشل يُكاش أيضاً: سطحٌ يُركَّب كثيراً لا يُعيد المحاولة كل مرّة', async () => {
  providerQuotaService.__resetCache();
  const { impl, state } = countingFetch({}, false, 401);
  const deps = { fetchImpl: impl, credential: 'expired' };

  assert.equal(await providerQuotaService.getWindows('codex', 'u1', deps), null);
  assert.equal(await providerQuotaService.getWindows('codex', 'u1', deps), null);
  assert.equal(state.calls, 1);
});

test('الكاش معزول لكل مستخدم ولكل مزوّد', async () => {
  providerQuotaService.__resetCache();
  const { impl, state } = countingFetch(GLM_LIVE_BODY);
  const deps = { fetchImpl: impl, credential: 'k' };

  await providerQuotaService.getWindows('glm', 'u1', deps);
  await providerQuotaService.getWindows('glm', 'u2', deps);
  assert.equal(state.calls, 2, 'مستخدم آخر لا يستلم لقطة غيره');
});

test('مزوّد بلا مصدر (deepseek/claude/مجهول) ⇒ null بلا أي نداء شبكي', async () => {
  providerQuotaService.__resetCache();
  const { impl, state } = countingFetch(GLM_LIVE_BODY);
  for (const provider of ['deepseek', 'claude', 'cursor', 'nope']) {
    assert.equal(
      await providerQuotaService.getWindows(provider, 'u1', { fetchImpl: impl, credential: 'k' }),
      null,
      provider,
    );
  }
  assert.equal(state.calls, 0);
});

test('kimi API key ⇒ null بلا نداء شبكي (لا حصة، رصيد فقط)', async () => {
  providerQuotaService.__resetCache();
  const { impl, state } = countingFetch(GLM_LIVE_BODY);
  // API key mode has no quota endpoint — only balance. The quota service
  // should not attempt a network call for it.
  const result = await providerQuotaService.getWindows('kimi', 'u1', {
    fetchImpl: impl,
    credential: 'k',
  });
  // The subscription path requires a valid OAuth token from the credentials
  // file; an API key alone yields null here (balance is a separate concern).
  assert.equal(result, null);
  assert.equal(state.calls, 0);
});
