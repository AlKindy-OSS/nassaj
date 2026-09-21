/**
 * اختبارات `providerCycleService` — نصف الاشتراك الرخيص (الدورة بلا مبالغ).
 *
 * المُثبَت هنا ثلاثة أشياء، كلّها كانت فيتو في المراجعة النقدية للمرحلة 2:
 *  1. **العقد لا يحمل مبلغاً** ولا `metered` ولا `available/reason`. حقلٌ واحد
 *     من هذه يصل الواجهة يفتح الباب لرقمٍ مالي في شريط لا يتّسع لتحفّظه.
 *  2. **`anchorSource` يمرّ كما هو ولا يُطبَّع** — `unknown`/`derived` هما ما
 *     تبني عليه الواجهة قرار «لا تعرض موعداً»؛ وطبعُه هنا يختلق موعداً.
 *  3. **الكاش وsingle-flight**: نداءان متتاليان ⇒ حسابٌ واحد، وأربعة متزامنة
 *     ⇒ حسابٌ واحد. هذا هو ما يجعل الوصل بسطح دائم الظهور مقبولاً أصلاً.
 *
 * الحقن إلزامي في كل حالة (‏`probeAuth`/`discoverAnchor`/`now`): الاكتشاف
 * الحقيقي يقرأ قرص الجهاز الذي يشغّل الاختبار، فبلا حقنٍ تتعلّق النتيجة
 * باشتراك المطوّر — نفس عُرف `subscription-config.service.test.ts`.
 *
 * قياس ميداني على القاعدة الحيّة (وهو سبب وجود هذه الخدمة): هذا المسار 742ms
 * بارداً و0.0ms دافئاً، و4 متوازية في عملية باردة 735ms إجمالاً بمصفوفة واحدة
 * بعينها؛ مقابل `/costs/subscriptions` بـ~14 ثانية لكل نداء و54 ثانية لكلٍّ من
 * أربعة متوازية.
 *
 * RUNNER: node:test عبر `npm run test:server`.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import type { BillingAnchorProbe } from '@/modules/providers/services/cost/billing-anchor.service.js';
import { providerCycleService } from '@/modules/providers/services/cost/provider-cycle.service.js';
import {
  subscriptionConfigService,
  type ProviderAuthProbe,
} from '@/modules/providers/services/cost/subscription-config.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-cycle-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  subscriptionConfigService._resetCaches();
  providerCycleService.__resetCache();

  try {
    await runTest();
  } finally {
    subscriptionConfigService._resetCaches();
    providerCycleService.__resetCache();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const probeFor = (authenticated: Record<string, string>): ProviderAuthProbe => async (provider) =>
  authenticated[provider]
    ? { installed: true, authenticated: true, method: authenticated[provider] }
    : { installed: false, authenticated: false, method: null };

const discoverNothing: BillingAnchorProbe = async () => null;

// مصدر مرساة حقيقي بشكل ما يقرأه كودكس فعلاً من مطالبة الاشتراك في التوكن
// المحلّي — الشكل مأخوذ من الحمولة الحيّة (‏codex: يوم 11، ‏detected، خطة Plus).
const discoverCodexAnchor: BillingAnchorProbe = async (provider) =>
  provider === 'codex'
    ? {
        anchorDay: 11,
        source: 'detected',
        evidence: 'id_token.chatgpt_subscription_active_start',
        observedAt: '2026-07-11T00:00:00.000Z',
        plan: 'Plus',
      }
    : null;

test('العقد يحمل الدورة والمرساة فقط — لا مبلغ ولا metered ولا available', async () => {
  await withIsolatedDatabase(async () => {
    const rows = await providerCycleService.list(1, {
      probeAuth: probeFor({ codex: 'oauth' }),
      discoverAnchor: discoverCodexAnchor,
      now: () => new Date(2026, 6, 30, 2, 0, 0),
    });

    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.deepEqual(Object.keys(row).sort(), [
      'anchorDay',
      'anchorSource',
      'cycleEnd',
      'cycleStart',
      'displayName',
      'plan',
      'provider',
    ]);
    // الصريح خيرٌ من الضمني: هذه أسماء الحقول التي منعتها المراجعة نصّاً.
    for (const forbidden of ['totalUsd', 'metered', 'available', 'reason', 'sessions', 'complete']) {
      assert.equal(forbidden in row, false, `${forbidden} يجب ألا يكون في عقد الدورة`);
    }
  });
});

test('المفتاح هو الجسم (provider) لا المورّد — وهو ما يقرؤه الهيدر مباشرة', async () => {
  await withIsolatedDatabase(async () => {
    const rows = await providerCycleService.list(1, {
      probeAuth: probeFor({ codex: 'oauth', glm: 'api_key' }),
      discoverAnchor: discoverCodexAnchor,
      now: () => new Date(2026, 6, 30),
    });

    const providers = rows.map((row) => row.provider).sort();
    assert.deepEqual(providers, ['codex', 'glm']);
    // لا `openai` ولا `moonshot`: تحويل الجسم إلى مورّد لا يحدث في هذا العقد،
    // ولذلك لا تحتاج الواجهة نسخةً من `model-vendor.ts`.
    assert.equal(
      rows.some((row) => row.provider === 'openai'),
      false,
    );
  });
});

test('anchorSource يمرّ كما هو: المكتشَف detected والمفترَض unknown', async () => {
  await withIsolatedDatabase(async () => {
    const rows = await providerCycleService.list(1, {
      probeAuth: probeFor({ codex: 'oauth', glm: 'api_key' }),
      discoverAnchor: discoverCodexAnchor,
      now: () => new Date(2026, 6, 30),
    });

    const codex = rows.find((row) => row.provider === 'codex');
    const glm = rows.find((row) => row.provider === 'glm');
    assert.equal(codex?.anchorSource, 'detected');
    assert.equal(codex?.anchorDay, 11);
    assert.equal(codex?.plan, 'Plus');
    // لا مصدر ⇒ الشهر التقويمي مفترَضاً، ومحمولٌ بـunknown لا بـdetected:
    // نفس الرقم، وادّعاءٌ مختلف تماماً — وعليه تبني الواجهة الإخفاء.
    assert.equal(glm?.anchorSource, 'unknown');
    assert.equal(glm?.anchorDay, 1);
  });
});

test('المخفيّ يبقى مخفيّاً: إخفاء المالك لا يُنقَض من سطح آخر', async () => {
  await withIsolatedDatabase(async () => {
    subscriptionConfigService.update('codex', { hidden: true }, 1);
    const rows = await providerCycleService.list(1, {
      probeAuth: probeFor({ codex: 'oauth', glm: 'api_key' }),
      discoverAnchor: discoverCodexAnchor,
      now: () => new Date(2026, 6, 30),
    });

    assert.deepEqual(
      rows.map((row) => row.provider),
      ['glm'],
    );
  });
});

test('غير المُصادَق عليه لا صفّ له (لا صفٌّ فارغ يُقرأ «لا دورة»)', async () => {
  await withIsolatedDatabase(async () => {
    const rows = await providerCycleService.list(1, {
      probeAuth: probeFor({}),
      discoverAnchor: discoverNothing,
      now: () => new Date(2026, 6, 30),
    });
    assert.deepEqual(rows, []);
  });
});

test('نافذة الدورة تُحسَب من اللحظة المُمرَّرة لا من ساعة المُشغِّل', async () => {
  await withIsolatedDatabase(async () => {
    // 5 يوليو ومرساة يوم 11 ⇒ نحن في دورة بدأت 11 يونيو (قبل يوم البداية).
    const rows = await providerCycleService.list(1, {
      probeAuth: probeFor({ codex: 'oauth' }),
      discoverAnchor: discoverCodexAnchor,
      now: () => new Date(2026, 6, 5, 23, 30),
    });

    const start = new Date(rows[0].cycleStart);
    const end = new Date(rows[0].cycleEnd);
    assert.deepEqual([start.getFullYear(), start.getMonth() + 1, start.getDate()], [2026, 6, 11]);
    assert.deepEqual([end.getFullYear(), end.getMonth() + 1, end.getDate()], [2026, 7, 11]);
    // الحدّ منتصف ليل محلّي — الواجهة تعتمد هذا في حساب «بعد N يوماً».
    assert.equal(start.getHours(), 0);
    assert.equal(start.getMinutes(), 0);
  });
});

test('نداءان متتاليان ⇒ حسابٌ واحد (كاش TTL)', async () => {
  await withIsolatedDatabase(async () => {
    let probeCalls = 0;
    const countingProbe: ProviderAuthProbe = async (provider) => {
      probeCalls += 1;
      return provider === 'codex'
        ? { installed: true, authenticated: true, method: 'oauth' }
        : { installed: false, authenticated: false, method: null };
    };
    const deps = {
      probeAuth: countingProbe,
      discoverAnchor: discoverCodexAnchor,
      now: () => new Date(2026, 6, 30),
    };

    const first = await providerCycleService.list('cache-user', deps);
    const afterFirst = probeCalls;
    const second = await providerCycleService.list('cache-user', deps);

    assert.ok(afterFirst > 0, 'النداء الأول يجب أن يفحص فعلاً');
    assert.equal(probeCalls, afterFirst, 'النداء الثاني لا يُعيد أي فحص');
    assert.equal(first, second, 'ونفس المصفوفة تُعاد من الكاش');
  });
});

test('أربعة نداءات متزامنة ⇒ حسابٌ واحد (single-flight)', async () => {
  await withIsolatedDatabase(async () => {
    let computeCount = 0;
    const countingProbe: ProviderAuthProbe = async (provider) => {
      // يُستدعى مرّة لكل مزوّد في كل حساب؛ عدّ claude وحده = عدّ الحسابات.
      if (provider === 'claude') {
        computeCount += 1;
      }
      return provider === 'codex'
        ? { installed: true, authenticated: true, method: 'oauth' }
        : { installed: false, authenticated: false, method: null };
    };
    const deps = {
      probeAuth: countingProbe,
      discoverAnchor: discoverCodexAnchor,
      now: () => new Date(2026, 6, 30),
    };

    const results = await Promise.all([
      providerCycleService.list('sf-user', deps),
      providerCycleService.list('sf-user', deps),
      providerCycleService.list('sf-user', deps),
      providerCycleService.list('sf-user', deps),
    ]);

    assert.equal(computeCount, 1, 'الأربعة يجب أن تتشارك حساباً واحداً لا أن تُشغّل أربعة');
    assert.equal(
      results.every((rows) => rows === results[0]),
      true,
    );
  });
});

test('الكاش مفتاحه المستخدم: لا تتسرّب دورة عضو إلى آخر', async () => {
  await withIsolatedDatabase(async () => {
    // مستخدمان، والفحص يُصادق codex للأوّل وحده: لو كان المفتاح بلا userId
    // لاستلم الثاني صفّ الأوّل — والمرساة تُقرأ من جذر اعتمادات المستخدم.
    const deps = (owner: string) => ({
      probeAuth: (async (provider: string, userId: string | number | null) =>
        provider === 'codex' && String(userId) === owner
          ? { installed: true, authenticated: true, method: 'oauth' }
          : { installed: false, authenticated: false, method: null }) as ProviderAuthProbe,
      discoverAnchor: discoverCodexAnchor,
      now: () => new Date(2026, 6, 30),
    });

    const forA = await providerCycleService.list('user-a', deps('user-a'));
    const forB = await providerCycleService.list('user-b', deps('user-a'));

    assert.deepEqual(
      forA.map((row) => row.provider),
      ['codex'],
    );
    assert.deepEqual(forB, []);
  });
});
