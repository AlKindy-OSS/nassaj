/**
 * اختبارات إعداد الاشتراكات ودورة الفوترة.
 *
 * الثقل هنا على **حساب الدورة**: هو الموضع الوحيد في هذه الطبقة الذي يُنتج
 * الخطأ فيه رقماً خاطئاً يبدو سليماً. كل حالة أدناه شهرٌ حقيقي بتقويمه (فبراير
 * ‏28 و29، والشهور ذوات الثلاثين، ورأس السنة) لا حالة مصطنعة.
 *
 * التواريخ تُبنى بمُنشئ `Date` المحلّي لا بنصّ ISO، والتأكيدات على مكوّنات
 * التاريخ لا على سلسلة نصّية — الدورة حدودها منتصف ليل محلّي، فاختبارٌ يقارن
 * ISO ينجح في منطقة ويسقط في أخرى.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appConfigDb, closeConnection, initializeDatabase } from '@/modules/database/index.js';
import type {
  BillingAnchorDiscovery,
  BillingAnchorProbe,
} from '@/modules/providers/services/cost/billing-anchor.service.js';
import {
  resolveBillingCycle,
  subscriptionConfigService,
  SUBSCRIPTION_PROVIDERS,
  type ProviderAuthProbe,
} from '@/modules/providers/services/cost/subscription-config.service.js';
import { AppError } from '@/shared/utils.js';

// ---------------------------------------------------------------------------
// أدوات
// ---------------------------------------------------------------------------

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'subscription-config-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  subscriptionConfigService._resetCaches();

  try {
    await runTest();
  } finally {
    subscriptionConfigService._resetCaches();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** فحص مصادقة مزيّف: المذكورون مُصادَقون، وما عداهم غير مثبَّت. */
const probeFor = (authenticated: Record<string, string>): ProviderAuthProbe => async (provider) =>
  authenticated[provider]
    ? { installed: true, authenticated: true, method: authenticated[provider] }
    : { installed: false, authenticated: false, method: null };

/**
 * اكتشاف مرساة مزيّف. **يُحقن في كل اختبار قائمة بلا استثناء**: الاكتشاف
 * الحقيقي يقرأ قرص الجهاز الذي يشغّل الاختبار، فبدون الحقن تتعلّق النتيجة
 * باشتراك المطوّر وتتغيّر بتغيّره.
 */
const discoverNothing: BillingAnchorProbe = async () => null;

const discoveryFor = (
  discoveries: Record<string, BillingAnchorDiscovery>,
): BillingAnchorProbe => async (provider) => discoveries[provider] ?? null;

const day = (date: Date): [number, number, number] => [date.getFullYear(), date.getMonth() + 1, date.getDate()];

// ---------------------------------------------------------------------------
// دورة الفوترة
// ---------------------------------------------------------------------------

test('الدورة الافتراضية (يوم 1) هي الشهر الميلادي نفسه', () => {
  const cycle = resolveBillingCycle(1, new Date(2026, 2, 15, 13, 45));
  assert.deepEqual(day(cycle.start), [2026, 3, 1]);
  assert.deepEqual(day(cycle.end), [2026, 4, 1]);
  // الحدّ منتصف ليل محلّي تماماً، لا لحظة الاستدعاء.
  assert.equal(cycle.start.getHours(), 0);
  assert.equal(cycle.start.getMinutes(), 0);
  assert.equal(cycle.start.getMilliseconds(), 0);
});

test('قبل يوم البداية نكون في دورة بدأت الشهر الماضي', () => {
  const cycle = resolveBillingCycle(9, new Date(2026, 2, 5));
  assert.deepEqual(day(cycle.start), [2026, 2, 9]);
  assert.deepEqual(day(cycle.end), [2026, 3, 9]);
});

test('يوم البداية نفسه يفتح دورة جديدة (الحدّ ضامّ من الأسفل)', () => {
  const cycle = resolveBillingCycle(9, new Date(2026, 2, 9, 0, 0, 0));
  assert.deepEqual(day(cycle.start), [2026, 3, 9]);
  assert.deepEqual(day(cycle.end), [2026, 4, 9]);
});

test('يوم 31 في فبراير: يُقصَّ إلى 28 ولا يُزحف إلى مارس', () => {
  // منتصف فبراير: الدورة بدأت 31 يناير وتنتهي بآخر أيام فبراير.
  const midFebruary = resolveBillingCycle(31, new Date(2026, 1, 15));
  assert.deepEqual(day(midFebruary.start), [2026, 1, 31]);
  assert.deepEqual(day(midFebruary.end), [2026, 2, 28]);

  // في اليوم المقصوص نفسه تبدأ الدورة التالية، ونهايتها 31 مارس (مارس طويل).
  const onClampedAnchor = resolveBillingCycle(31, new Date(2026, 1, 28));
  assert.deepEqual(day(onClampedAnchor.start), [2026, 2, 28]);
  assert.deepEqual(day(onClampedAnchor.end), [2026, 3, 31]);

  // وفي مارس قبل يوم 31 نكون في الدورة التي بدأت 28 فبراير — لا 31 فبراير.
  const earlyMarch = resolveBillingCycle(31, new Date(2026, 2, 5));
  assert.deepEqual(day(earlyMarch.start), [2026, 2, 28]);
  assert.deepEqual(day(earlyMarch.end), [2026, 3, 31]);
});

test('سنة كبيسة: 29 فبراير يوم حقيقي فلا يُقصّ إلى 28', () => {
  const cycle = resolveBillingCycle(31, new Date(2024, 1, 29));
  assert.deepEqual(day(cycle.start), [2024, 2, 29]);
  assert.deepEqual(day(cycle.end), [2024, 3, 31]);

  const thirtieth = resolveBillingCycle(30, new Date(2024, 1, 29));
  assert.deepEqual(day(thirtieth.start), [2024, 2, 29]);
  assert.deepEqual(day(thirtieth.end), [2024, 3, 30]);
});

test('يوم 31 في شهر من ثلاثين: يُقصّ إلى 30', () => {
  const cycle = resolveBillingCycle(31, new Date(2026, 3, 15)); // أبريل
  assert.deepEqual(day(cycle.start), [2026, 3, 31]);
  assert.deepEqual(day(cycle.end), [2026, 4, 30]);
});

test('رأس السنة يعبر في الاتجاهين', () => {
  const backward = resolveBillingCycle(15, new Date(2026, 0, 10));
  assert.deepEqual(day(backward.start), [2025, 12, 15]);
  assert.deepEqual(day(backward.end), [2026, 1, 15]);

  const forward = resolveBillingCycle(15, new Date(2026, 11, 20));
  assert.deepEqual(day(forward.start), [2026, 12, 15]);
  assert.deepEqual(day(forward.end), [2027, 1, 15]);
});

test('يوم بداية خارج المدى يُقصّ بدل أن يُنتج دورة فاسدة', () => {
  // 99 ⇒ 31، ونحن في 15 أبريل قبل يوم البداية ⇒ الدورة بدأت 31 مارس.
  const tooBig = resolveBillingCycle(99, new Date(2026, 3, 15));
  assert.deepEqual(day(tooBig.start), [2026, 3, 31]);
  assert.deepEqual(day(tooBig.end), [2026, 4, 30]);

  const tooSmall = resolveBillingCycle(0, new Date(2026, 3, 15));
  assert.deepEqual(day(tooSmall.start), [2026, 4, 1]);
});

// ---------------------------------------------------------------------------
// الاكتشاف والإعداد
// ---------------------------------------------------------------------------

test('مزوّد غير مُصادَق ليس اشتراكاً ولا يظهر', async () => {
  await withIsolatedDatabase(async () => {
    const entries = await subscriptionConfigService.list(1, {
      probeAuth: probeFor({ claude: 'credentials_file' }),
      discoverAnchor: discoverNothing,
    });

    assert.deepEqual(entries.map((entry) => entry.provider), ['claude']);
    assert.equal(entries[0].displayName, 'Claude');
    // بلا إعداد ولا اكتشاف: أوّل الشهر مفترَضاً — و«مجهول» صراحةً لا «مكتشَف».
    assert.equal(entries[0].anchorDay, 1);
    assert.equal(entries[0].anchorSource, 'unknown');
    assert.equal(entries[0].anchorEvidence, null);
    assert.equal(entries[0].anchorDayOverride, null);
    assert.equal(entries[0].plan, null);
    assert.equal(entries[0].planSource, 'unknown');
    assert.equal(entries[0].hidden, false);
  });
});

test('مثبَّت بلا مصادقة لا يظهر أيضاً — الاثنان شرطان لا أحدهما', async () => {
  await withIsolatedDatabase(async () => {
    const entries = await subscriptionConfigService.list(1, {
      probeAuth: async (provider) => ({
        installed: true,
        authenticated: provider === 'codex',
        method: provider === 'codex' ? 'credentials_file' : null,
      }),
      discoverAnchor: discoverNothing,
    });

    assert.deepEqual(entries.map((entry) => entry.provider), ['codex']);
  });
});

test('المخزَّن يعلو على الافتراضي، والمخفيّ يظهر في القائمة لا في النشط', async () => {
  await withIsolatedDatabase(async () => {
    subscriptionConfigService.update('claude', { anchorDay: 9, plan: 'Max 20x' });
    subscriptionConfigService.update('codex', { hidden: true });

    const probeAuth = probeFor({ claude: 'credentials_file', codex: 'credentials_file' });
    const deps = { probeAuth, discoverAnchor: discoverNothing };
    const all = await subscriptionConfigService.list(1, deps);
    assert.deepEqual(all.map((entry) => entry.provider), ['claude', 'codex']);
    assert.equal(all[0].anchorDay, 9);
    assert.equal(all[0].anchorSource, 'manual');
    assert.equal(all[0].anchorDayOverride, 9);
    assert.equal(all[0].plan, 'Max 20x');
    assert.equal(all[0].planSource, 'manual');
    assert.equal(all[1].hidden, true);

    const active = await subscriptionConfigService.listActive(1, deps);
    assert.deepEqual(active.map((entry) => entry.provider), ['claude']);
  });
});

test('كتابة مزوّد لا تمحو جيرانه (قراءة-دمج-كتابة على مفتاح واحد)', async () => {
  await withIsolatedDatabase(async () => {
    subscriptionConfigService.update('claude', { anchorDay: 9 });
    subscriptionConfigService.update('codex', { anchorDay: 21, plan: 'Plus' });
    subscriptionConfigService.update('claude', { plan: 'Max 20x' });

    // من قاعدة البيانات نفسها لا من الكاش: الكاش قد يخفي فقداً حدث في التخزين.
    subscriptionConfigService._resetCaches();
    const stored = subscriptionConfigService.getStored();

    assert.deepEqual(stored.claude, { anchorDay: 9, plan: 'Max 20x', hidden: false });
    assert.deepEqual(stored.codex, { anchorDay: 21, plan: 'Plus', hidden: false });
  });
});

test('التحقّق يرفض ما يُفسد الحساب بدل أن يُطبّعه صامتاً', async () => {
  await withIsolatedDatabase(() => {
    const rejects = (run: () => unknown, code: string) => {
      assert.throws(run, (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, code);
        assert.equal(error.statusCode, 400);
        return true;
      });
    };

    rejects(() => subscriptionConfigService.update('nope', { anchorDay: 1 }), 'UNKNOWN_SUBSCRIPTION_PROVIDER');
    rejects(() => subscriptionConfigService.update('claude', { anchorDay: 0 }), 'INVALID_ANCHOR_DAY');
    rejects(() => subscriptionConfigService.update('claude', { anchorDay: 32 }), 'INVALID_ANCHOR_DAY');
    rejects(() => subscriptionConfigService.update('claude', { anchorDay: 9.5 }), 'INVALID_ANCHOR_DAY');
    rejects(() => subscriptionConfigService.update('claude', { anchorDay: '9' }), 'INVALID_ANCHOR_DAY');
    rejects(() => subscriptionConfigService.update('claude', { plan: 'x'.repeat(65) }), 'INVALID_SUBSCRIPTION_PLAN');
    rejects(() => subscriptionConfigService.update('claude', { plan: 7 }), 'INVALID_SUBSCRIPTION_PLAN');
    rejects(() => subscriptionConfigService.update('claude', { hidden: 'yes' }), 'INVALID_SUBSCRIPTION_HIDDEN');

    // لا شيء من الرفض تسرّب إلى التخزين.
    assert.deepEqual(subscriptionConfigService.getStored(), {});
  });
});

test('اسم خطة فارغ أو بمسافات = «بلا خطة» لا نصّ فارغ', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(subscriptionConfigService.update('claude', { plan: '   ' }).plan, null);
    assert.equal(subscriptionConfigService.update('claude', { plan: '  Max 20x  ' }).plan, 'Max 20x');
    assert.equal(subscriptionConfigService.update('claude', { plan: null }).plan, null);
  });
});

test('قيمة مخزَّنة تالفة لا تُسقط اللوحة — يُعاد إلى الافتراضات', async () => {
  await withIsolatedDatabase(async () => {
    appConfigDb.set('provider_subscriptions', '{ this is not json');
    subscriptionConfigService._resetCaches();

    const entries = await subscriptionConfigService.list(1, {
      probeAuth: probeFor({ claude: 'credentials_file' }),
      discoverAnchor: discoverNothing,
    });
    assert.equal(entries[0].anchorDay, 1);
    assert.equal(entries[0].anchorSource, 'unknown');
    assert.equal(entries[0].hidden, false);
  });
});

test('حقل مخزَّن خارج المدى يُطبَّع عند القراءة (قيمة كُتبت بيد أو بنسخة أقدم)', async () => {
  await withIsolatedDatabase(async () => {
    appConfigDb.set(
      'provider_subscriptions',
      JSON.stringify({ claude: { anchorDay: 99, plan: 42, hidden: 'yes' }, ghost: { anchorDay: 3 } }),
    );
    subscriptionConfigService._resetCaches();

    const settings = subscriptionConfigService.getSettings('claude');
    // خارج المدى ⇒ «لم يضبطه المالك» (null) لا 1: الفرق بينهما هو ما يسمح
    // للاكتشاف بالعمل بدل أن يُحبس على أوّل الشهر إلى الأبد.
    assert.deepEqual(settings, { anchorDay: null, plan: null, hidden: false });
    // مفتاح لمزوّد غير معروف يُهمَل ولا يُعاد.
    assert.equal(Object.hasOwn(subscriptionConfigService.getStored(), 'ghost'), false);
  });
});

test('فشل فحص المصادقة لا يُنتج اشتراكاً مُدّعى', async () => {
  await withIsolatedDatabase(async () => {
    const entries = await subscriptionConfigService.list(1, {
      probeAuth: async () => {
        throw new Error('probe exploded');
      },
      discoverAnchor: discoverNothing,
    });
    assert.deepEqual(entries, []);
  });
});

// ---------------------------------------------------------------------------
// مرساة الدورة: من أين جاءت
// ---------------------------------------------------------------------------

const detected = (day: number, plan: string | null = null): BillingAnchorDiscovery => ({
  anchorDay: day,
  source: 'detected',
  evidence: 'codex/auth.json#id_token.chatgpt_subscription_active_start',
  observedAt: '2026-07-11T10:24:11.000Z',
  periodEnd: '2026-08-11T10:24:11.000Z',
  plan,
});

test('المكتشَف يملأ المرساة والخطة معاً ويُوسَم detected', async () => {
  await withIsolatedDatabase(async () => {
    const entries = await subscriptionConfigService.list(2, {
      probeAuth: probeFor({ codex: 'credentials_file' }),
      discoverAnchor: discoveryFor({ codex: detected(11, 'Plus') }),
    });

    assert.equal(entries[0].anchorDay, 11);
    assert.equal(entries[0].anchorSource, 'detected');
    assert.equal(entries[0].anchorObservedAt, '2026-07-11T10:24:11.000Z');
    assert.match(entries[0].anchorEvidence ?? '', /chatgpt_subscription_active_start/);
    assert.equal(entries[0].plan, 'Plus');
    assert.equal(entries[0].planSource, 'detected');
    // المكتشَف لا يُخزَّن: التخزين للمالك وحده، وإلا تجمّد الاكتشاف عند أول قراءة.
    assert.deepEqual(subscriptionConfigService.getStored(), {});
  });
});

test('اختيار المالك يعلو على المكتشَف ولا يُنقَض به', async () => {
  await withIsolatedDatabase(async () => {
    subscriptionConfigService.update('codex', { anchorDay: 3 });

    const entries = await subscriptionConfigService.list(2, {
      probeAuth: probeFor({ codex: 'credentials_file' }),
      discoverAnchor: discoveryFor({ codex: detected(11, 'Plus') }),
    });

    assert.equal(entries[0].anchorDay, 3);
    assert.equal(entries[0].anchorSource, 'manual');
    // ولا يُستدعى الاكتشاف أصلاً، فلا خطة مكتشَفة تتسرّب.
    assert.equal(entries[0].plan, null);
    assert.equal(entries[0].planSource, 'unknown');
  });
});

test('المشتقّ يصل موسوماً derived — لا يُقدَّم كأنه حقيقة', async () => {
  await withIsolatedDatabase(async () => {
    const entries = await subscriptionConfigService.list(2, {
      probeAuth: probeFor({ gemini: 'credentials_file' }),
      discoverAnchor: discoveryFor({
        gemini: {
          anchorDay: 17,
          source: 'derived',
          evidence: 'oldest-recorded-usage',
          observedAt: '2026-02-17T06:30:00.000Z',
          periodEnd: null,
          plan: null,
        },
      }),
    });

    assert.equal(entries[0].anchorDay, 17);
    assert.equal(entries[0].anchorSource, 'derived');
    assert.equal(entries[0].plan, null);
  });
});

test('إرجاع اليوم إلى null يعيد الاكتشاف بعد ضبط يدوي', async () => {
  await withIsolatedDatabase(async () => {
    subscriptionConfigService.update('codex', { anchorDay: 3 });
    assert.equal(subscriptionConfigService.getSettings('codex').anchorDay, 3);

    subscriptionConfigService.update('codex', { anchorDay: null });
    assert.equal(subscriptionConfigService.getSettings('codex').anchorDay, null);

    const entries = await subscriptionConfigService.list(2, {
      probeAuth: probeFor({ codex: 'credentials_file' }),
      discoverAnchor: discoveryFor({ codex: detected(11, 'Plus') }),
    });
    assert.equal(entries[0].anchorDay, 11);
    assert.equal(entries[0].anchorSource, 'detected');
  });
});

test('اكتشاف ينفجر لا يُسقط اللوحة ولا يدّعي مصدراً', async () => {
  await withIsolatedDatabase(async () => {
    const entries = await subscriptionConfigService.list(2, {
      probeAuth: probeFor({ claude: 'credentials_file' }),
      discoverAnchor: async () => {
        throw new Error('discovery exploded');
      },
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].anchorDay, 1);
    assert.equal(entries[0].anchorSource, 'unknown');
  });
});

test('خطة المالك تعلو على خطة المصدر حتى مع مرساة مكتشَفة', async () => {
  await withIsolatedDatabase(async () => {
    subscriptionConfigService.update('codex', { plan: 'Pro (فاتورة الشركة)' });

    const entries = await subscriptionConfigService.list(2, {
      probeAuth: probeFor({ codex: 'credentials_file' }),
      discoverAnchor: discoveryFor({ codex: detected(11, 'Plus') }),
    });

    assert.equal(entries[0].plan, 'Pro (فاتورة الشركة)');
    assert.equal(entries[0].planSource, 'manual');
    // المرساة ما زالت مكتشَفة: الخطة والمرساة حقلان مستقلّان.
    assert.equal(entries[0].anchorSource, 'detected');
    assert.equal(entries[0].anchorDay, 11);
  });
});

test('قائمة المزوّدات المقبولة لا تحوي مُعرِّفاً بلا تنفيذ خلفه', () => {
  assert.equal(SUBSCRIPTION_PROVIDERS.includes('sakana'), false);
  assert.ok(SUBSCRIPTION_PROVIDERS.includes('claude'));
  assert.ok(SUBSCRIPTION_PROVIDERS.includes('codex'));
});
