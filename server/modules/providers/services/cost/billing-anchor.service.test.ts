/**
 * اختبارات اكتشاف مرساة الفوترة.
 *
 * الأثقل هنا ليس «هل يقرأ الحقل» بل **متى يمتنع**: كل حالة امتناع أدناه هي
 * موضعٌ كان الرقم فيه سيخرج مخترَعاً لو لم نمتنع (حساب بلا اشتراك، توكن بلا
 * دعاوى دورة، مزوّد لا سجلّ له).
 *
 * الملفات تُبنى على قرص مؤقّت بنفس بنية الملفات الحقيقية المفحوصة على هذا
 * الجهاز (‏.claude.json#oauthAccount و auth.json#tokens.id_token) — لا fixtures
 * مصطنعة الشكل.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { billingAnchorService } from '@/modules/providers/services/cost/billing-anchor.service.js';

// ---------------------------------------------------------------------------
// أدوات
// ---------------------------------------------------------------------------

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'billing-anchor-'));
  billingAnchorService._resetCache();
  try {
    await run(root);
  } finally {
    billingAnchorService._resetCache();
    await rm(root, { recursive: true, force: true });
  }
}

/** بيئة محقونة: كل مزوّد على جذره داخل الدليل المؤقّت. */
const envFor = (root: string) => (_userId: unknown, provider: string): NodeJS.ProcessEnv =>
  provider === 'claude'
    ? { CLAUDE_CONFIG_DIR: path.join(root, '.claude') }
    : { CODEX_HOME: path.join(root, '.codex') };

/** يبني `id_token` بحمولة الدعاوى المعطاة (توقيع صوري — لا يُتحقَّق منه). */
function fakeIdToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.c2lnbmF0dXJl`;
}

const OPENAI_AUTH = 'https://api.openai.com/auth';

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// كلود
// ---------------------------------------------------------------------------

test('كلود: يوم المرساة من subscriptionCreatedAt داخل CLAUDE_CONFIG_DIR', async () => {
  await withTempRoot(async (root) => {
    await writeJson(path.join(root, '.claude', '.claude.json'), {
      oauthAccount: {
        subscriptionCreatedAt: '2026-06-09T18:39:52.135005Z',
        accountCreatedAt: '2026-06-09T18:37:48.469624Z',
        organizationType: 'claude_max',
        organizationRateLimitTier: 'default_claude_max_20x',
      },
    });

    const anchor = await billingAnchorService.discover('claude', 7, { resolveEnv: envFor(root) });
    assert.ok(anchor);
    assert.equal(anchor.source, 'detected');
    // اليوم محلّي لا UTC — نفس ما يبني به resolveBillingCycle حدوده.
    assert.equal(anchor.anchorDay, new Date('2026-06-09T18:39:52.135005Z').getDate());
    assert.equal(anchor.plan, 'Max 20x');
    assert.equal(anchor.periodEnd, null);
    assert.match(anchor.evidence, /subscriptionCreatedAt/);
  });
});

test('كلود: الملف بجوار دليل الإعداد (حالة المشغّل ~/.claude.json) يُقرأ أيضاً', async () => {
  await withTempRoot(async (root) => {
    // لا ملف داخل .claude — بل في الأب، كما يكتبه العميل بلا CLAUDE_CONFIG_DIR.
    await mkdir(path.join(root, '.claude'), { recursive: true });
    await writeJson(path.join(root, '.claude.json'), {
      oauthAccount: { subscriptionCreatedAt: '2026-03-21T04:00:00.000Z', organizationType: 'claude_pro' },
    });

    const anchor = await billingAnchorService.discover('claude', null, { resolveEnv: envFor(root) });
    assert.ok(anchor);
    assert.equal(anchor.anchorDay, new Date('2026-03-21T04:00:00.000Z').getDate());
    assert.equal(anchor.plan, 'Pro');
  });
});

test('كلود: حساب بلا اشتراك لا يُنتج مرساة مكتشَفة', async () => {
  await withTempRoot(async (root) => {
    await writeJson(path.join(root, '.claude', '.claude.json'), {
      oauthAccount: { accountCreatedAt: '2026-01-05T10:00:00Z', subscriptionCreatedAt: null },
    });

    const anchor = await billingAnchorService.discover('claude', 7, {
      resolveEnv: envFor(root),
      // لا اشتقاق: لا جذر سجلّات في هذا الاختبار.
      historyRoot: () => null,
    });
    assert.equal(anchor, null);
  });
});

// ---------------------------------------------------------------------------
// كودكس
// ---------------------------------------------------------------------------

test('كودكس: الدورة المعلَنة في id_token تُعطي المرساة والنهاية والخطة', async () => {
  await withTempRoot(async (root) => {
    await writeJson(path.join(root, '.codex', 'auth.json'), {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: fakeIdToken({
          [OPENAI_AUTH]: {
            chatgpt_plan_type: 'plus',
            chatgpt_subscription_active_start: '2026-07-11T10:24:11+00:00',
            chatgpt_subscription_active_until: '2026-08-11T10:24:11+00:00',
          },
        }),
        access_token: 'unused',
      },
    });

    const anchor = await billingAnchorService.discover('codex', 2, { resolveEnv: envFor(root) });
    assert.ok(anchor);
    assert.equal(anchor.source, 'detected');
    assert.equal(anchor.anchorDay, new Date('2026-07-11T10:24:11+00:00').getDate());
    assert.equal(anchor.plan, 'Plus');
    assert.equal(anchor.periodEnd, new Date('2026-08-11T10:24:11+00:00').toISOString());
  });
});

test('كودكس: توكن بلا دعاوى اشتراك ⇒ لا مرساة (ولا يُخترع يوم)', async () => {
  await withTempRoot(async (root) => {
    await writeJson(path.join(root, '.codex', 'auth.json'), {
      tokens: { id_token: fakeIdToken({ sub: 'x', [OPENAI_AUTH]: { chatgpt_plan_type: 'free' } }) },
    });

    const anchor = await billingAnchorService.discover('codex', 2, {
      resolveEnv: envFor(root),
      historyRoot: () => null,
    });
    assert.equal(anchor, null);
  });
});

test('كودكس: توكن مشوَّه لا يرمي ولا يُنتج رقماً', async () => {
  await withTempRoot(async (root) => {
    await writeJson(path.join(root, '.codex', 'auth.json'), { tokens: { id_token: 'not-a-jwt' } });

    const anchor = await billingAnchorService.discover('codex', 2, {
      resolveEnv: envFor(root),
      historyRoot: () => null,
    });
    assert.equal(anchor, null);
  });
});

// ---------------------------------------------------------------------------
// الاشتقاق
// ---------------------------------------------------------------------------

test('بلا مصدر: يُشتقّ يوم أقدم استهلاك ويُوسَم derived لا detected', async () => {
  await withTempRoot(async (root) => {
    const sessions = path.join(root, 'history', '2026', '02');
    await mkdir(sessions, { recursive: true });

    const oldest = path.join(sessions, 'a-first.jsonl');
    const newer = path.join(sessions, 'b-later.jsonl');
    await writeFile(oldest, '{}');
    await writeFile(newer, '{}');

    const oldestDate = new Date(2026, 1, 17, 9, 30);
    const newerDate = new Date(2026, 4, 2, 9, 30);
    await utimes(oldest, oldestDate, oldestDate);
    await utimes(newer, newerDate, newerDate);

    const anchor = await billingAnchorService.discover('gemini', 3, {
      historyRoot: () => path.join(root, 'history'),
    });

    assert.ok(anchor);
    assert.equal(anchor.source, 'derived');
    assert.equal(anchor.anchorDay, 17);
    assert.equal(anchor.evidence, 'oldest-recorded-usage');
    assert.equal(anchor.observedAt, oldestDate.toISOString());
    // الاشتقاق لا يدّعي خطةً ولا نهاية دورة — لا يعرفهما أصلاً.
    assert.equal(anchor.plan, null);
    assert.equal(anchor.periodEnd, null);
  });
});

test('المكتشَف يعلو على المشتقّ حين يتوفّر الاثنان', async () => {
  await withTempRoot(async (root) => {
    await writeJson(path.join(root, '.claude', '.claude.json'), {
      oauthAccount: { subscriptionCreatedAt: '2026-06-09T18:39:52.135005Z' },
    });
    const projects = path.join(root, '.claude', 'projects');
    await mkdir(projects, { recursive: true });
    const file = path.join(projects, 'old.jsonl');
    await writeFile(file, '{}');
    const old = new Date(2026, 0, 25, 12, 0);
    await utimes(file, old, old);

    const anchor = await billingAnchorService.discover('claude', 7, { resolveEnv: envFor(root) });
    assert.ok(anchor);
    assert.equal(anchor.source, 'detected');
    assert.notEqual(anchor.anchorDay, 25);
  });
});

test('مزوّد لا جذر سجلّات له ولا مصدر ⇒ null (لا اشتقاق مخترَع)', async () => {
  await withTempRoot(async (root) => {
    const anchor = await billingAnchorService.discover('glm', 3, { resolveEnv: envFor(root) });
    assert.equal(anchor, null);
  });
});

test('جذر سجلّات فارغ ⇒ null لا يوم افتراضي', async () => {
  await withTempRoot(async (root) => {
    await mkdir(path.join(root, 'empty'), { recursive: true });
    const anchor = await billingAnchorService.discover('kimi', 3, {
      historyRoot: () => path.join(root, 'empty'),
    });
    assert.equal(anchor, null);
  });
});

test('لا يُعاد أي توكن في نتيجة الاكتشاف', async () => {
  await withTempRoot(async (root) => {
    const secret = 'sk-super-secret-value';
    await writeJson(path.join(root, '.codex', 'auth.json'), {
      OPENAI_API_KEY: secret,
      tokens: {
        access_token: secret,
        refresh_token: secret,
        id_token: fakeIdToken({
          [OPENAI_AUTH]: {
            chatgpt_plan_type: 'pro',
            chatgpt_subscription_active_start: '2026-05-03T00:00:00Z',
          },
        }),
      },
    });

    const anchor = await billingAnchorService.discover('codex', 2, { resolveEnv: envFor(root) });
    assert.ok(anchor);
    assert.equal(JSON.stringify(anchor).includes(secret), false);
    assert.equal(JSON.stringify(anchor).includes('eyJ'), false);
  });
});
