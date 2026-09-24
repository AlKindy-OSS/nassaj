/**
 * `HeaderUsageIndicator` — فرع نوافذ حصّة المزوّد، وترتيب السقوط إلى الدورة.
 *
 * المُثبَت:
 *  • ‏glm بمصدر رسمي ⇒ ثلاث شارات نسبة (نَفِدت 100% أولاً لأنها الأقرب تصفيراً)،
 *    **بلا أي مبلغ** (‏ADR-081 قائم: العقد لا يحمل مالاً أصلاً).
 *  • ‏codex بمصدر متعذّر (توكن بائت — وهي الحالة الحيّة المقيسة) ⇒ **يسقط إلى
 *    دورة التجديد** لا إلى الصمت.
 *  • مزوّد بلا مصدر ولا مرساة (kimi) ⇒ صمت.
 *  • claude يبقى على نوافذه ولا يُشغّل مسار حصّة المزوّد إطلاقاً.
 *  • ‏tabsMode=hidden يُخفي الفرع الجديد أيضاً.
 *
 * ⚠️ لا تُمرَّر عناصر DOM إلى `node:assert`. الوقت مثبَّت بمؤقّتات مزيّفة فعلاً.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key.startsWith('providerQuota.horizon.')) {
        return `resets-${String(opts?.value ?? '')}${key.endsWith('hour') ? 'h' : key.endsWith('day') ? 'd' : 'm'}`;
      }
      // وصف الطول للتلميح (الحرف نفسه لا يمرّ بـi18n في المكوّن: يأتي من
      // `resolveWindowLength().letter` مباشرة، فهو رمزٌ موحَّد لا نصّ مترجَم).
      if (key.startsWith('providerQuota.length.')) {
        const kind = key.slice('providerQuota.length.'.length);
        return `len-${kind}${opts?.value ? `-${String(opts.value)}` : ''}`;
      }
      if (key === 'providerQuota.windowGeneric') return 'نافذة';
      const template = (opts?.defaultValue as string) ?? key;
      const withVars = template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''));
      return withVars === key && opts && 'days' in opts ? `${key}:${String(opts.days)}` : withVars;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock('../../../quick-settings-panel/hooks/useClaudeUsageShared', () => ({
  useClaudeUsageShared: (enabled: boolean) =>
    enabled
      ? {
          status: 'success',
          data: {
            plan: 'max',
            session: { utilization: 4, resetsAt: '2026-07-30T03:29:59.842Z' },
            weeklyAllModels: { utilization: 75, resetsAt: '2026-08-04T00:00:00.842Z' },
            weeklySonnet: null,
            weeklyOpus: null,
            extraUsage: null,
            fetchedAt: '2026-07-30T00:00:00.000Z',
            stale: false,
          },
          refetch: () => {},
        }
      : { status: 'idle', refetch: () => {} },
}));

// دورة التجديد — قابل للتهيئة لاختبار «خطأ + لا دورة» (البند الحدّي).
// الصف الافتراضي هو codex، ويُعاد ضبطه في beforeEach.
//
// المحاكي يُعكس سلوك useProviderCycles الحقيقي: عند تعطيل `enabled` لا يُعاد
// ضبط الحالة (useEffect يُعيد undefined بلا setState) — فتبقى الصفوف الناجحة
// السابقة محتجزة. هذا بالضبط ما يُنتج وميض «↻ Nي» عند إعادة المحاولة بعد خطأ.
// (قبل الإصلاح كان المحاكي يُعيد 'idle' عند enabled=false مخفياً الحالة الحيّة)
const cycleEnabledCalls: boolean[] = [];
type CycleRow = {
  provider: string;
  displayName: string;
  plan: string;
  anchorDay: number;
  anchorSource: 'detected' | 'manual';
  cycleStart: string;
  cycleEnd: string;
};
let cyclesRows: CycleRow[] = [];
// حالة داخلية تُمثّل آخر حالة ناجحة محتجزة (كما يفعل useProviderCycles الحقيقي).
let _lastCyclesSuccess: { rows: CycleRow[] } | null = null;
vi.mock('../../../quick-settings-panel/hooks/useProviderCycles', () => ({
  useProviderCycles: (enabled: boolean) => {
    cycleEnabledCalls.push(enabled);
    if (enabled) {
      _lastCyclesSuccess = { rows: cyclesRows };
      return { status: 'success', rows: cyclesRows, refetch: () => {} };
    }
    // لا إعادة ضبط: الحالة الناجحة السابقة تبقى (سلوك useProviderCycles الحقيقي).
    if (_lastCyclesSuccess !== null) {
      return { status: 'success', rows: _lastCyclesSuccess.rows, refetch: () => {} };
    }
    return { status: 'idle', refetch: () => {} };
  },
}));

// نوافذ المزوّد: glm يعطي حمولته الحيّة، وcodex يتعذّر (توكن بائت ⇒ 404/none).
const quotaEnabledFor: string[] = [];
type MockQuotaResult = {
  status: 'loading' | 'none' | 'error' | 'anthropic' | 'success';
  windows: Array<{
    key: string;
    usedPercent: number;
    resetsAt: string;
    windowSeconds?: number;
    horizon: { value: number; unit: 'minute' | 'hour' | 'day' };
  }>;
  plan: string | null;
  isAnthropic: boolean;
  refetch: () => void;
};
let codexQuotaResult: MockQuotaResult;

vi.mock('../../../quick-settings-panel/hooks/useProviderQuota', () => ({
  // التوقيع الحقيقي (‏provider, activeModel, enabled): النموذج وسيطٌ ثانٍ لأن
  // الخادم هو من يحوّله إلى مورّد. مُحاكٍ بتوقيع قديم كان يقرأ النموذج مكان
  // `enabled` فيُخفي الشارات كلها — عطلٌ في المُحاكي يتنكّر عطلاً في المكوّن.
  useProviderQuota: (
    provider: string | null | undefined,
    activeModel: string | null | undefined,
    enabled: boolean,
  ) => {
    if (enabled && provider) quotaEnabledFor.push(provider);
    // المورّد كما يحسمه الخادم: نموذج glm يغلب جسم claude.
    const vendor = activeModel?.startsWith('glm-') ? 'glm' : provider;
    if (enabled && vendor === 'codex') return codexQuotaResult;
    if (!enabled || vendor !== 'glm') {
      return {
        status: 'none',
        windows: [],
        plan: null,
        isAnthropic: activeModel ? activeModel.startsWith('claude-') : false,
        refetch: () => {},
      };
    }
    return {
      status: 'success',
      plan: 'lite',
      isAnthropic: false,
      refetch: () => {},
      windows: [
        // الأطوال كما يرسلها الخادم من unit/number: خمس ساعات، أسبوع، شهر.
        {
          key: 'tokens1',
          usedPercent: 100,
          resetsAt: '2026-07-30T02:08:47.699Z',
          windowSeconds: 18_000,
          horizon: { value: 3, unit: 'hour' as const },
        },
        {
          key: 'tokens2',
          usedPercent: 29,
          resetsAt: '2026-07-30T17:10:22.998Z',
          windowSeconds: 604_800,
          horizon: { value: 18, unit: 'hour' as const },
        },
        {
          key: 'tools',
          usedPercent: 2,
          resetsAt: '2026-08-09T17:10:22.998Z',
          windowSeconds: 2_592_000,
          horizon: { value: 11, unit: 'day' as const },
        },
      ],
    };
  },
}));

import {
  setSelectedProvider,
  setSelectedEngineProvider,
  setSelectedActiveModel,
  __resetSelectedProviderStore,
} from '../../../../stores/selectedProviderStore';

import HeaderUsageIndicator from './HeaderUsageIndicator';

afterEach(cleanup);
afterEach(() => vi.useRealTimers());

beforeEach(() => {
  __resetSelectedProviderStore();
  quotaEnabledFor.length = 0;
  cycleEnabledCalls.length = 0;
  _lastCyclesSuccess = null;
  codexQuotaResult = {
    status: 'none',
    windows: [],
    plan: null,
    isAnthropic: false,
    refetch: () => {},
  };
  // الصف الافتراضي: codex بمرساة مُكتشَفة (الحمولة الحيّة 2026-07-30).
  cyclesRows = [
    {
      provider: 'codex',
      displayName: 'Codex',
      plan: 'Plus',
      anchorDay: 11,
      anchorSource: 'detected',
      cycleStart: '2026-07-10T21:00:00.000Z',
      cycleEnd: '2026-08-10T21:00:00.000Z',
    },
  ];
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-07-30T00:04:17.472Z'));
});

function renderHeader(sessionProvider?: string | null, tabsMode: 'full' | 'hidden' = 'full') {
  const { container } = render(
    <HeaderUsageIndicator tabsMode={tabsMode} sessionProvider={sessionProvider} />,
  );
  return {
    text: container.textContent ?? '',
    badges: container.querySelectorAll('span[aria-label]').length,
  };
}

describe('HeaderUsageIndicator — نوافذ حصّة المزوّد', () => {
  it('glm: ثلاث شارات بحروف C/W/M الموحَّدة لا بموعد التصفير', () => {
    setSelectedProvider('glm');
    const { text, badges } = renderHeader(null);

    assert.equal(badges, 3);
    assert.equal(text.includes('100%'), true);
    assert.equal(text.includes('29%'), true);
    // نفس حروف نوافذ كلود: الجلسة C والأسبوع W والشهر M.
    assert.equal(text.includes('C'), true);
    assert.equal(text.includes('W'), true);
    assert.equal(text.includes('M'), true);
    // **جوهر البلاغ**: لا يظهر أفق التصفير في الشارة نفسها.
    assert.equal(text.includes('resets-3h'), false);
    assert.equal(text.includes('$'), false);
    assert.equal(/\d+\.\d\d/.test(text), false);
  });

  it('codex بمصدر متعذّر يسقط إلى دورة التجديد لا إلى الصمت', () => {
    setSelectedProvider('codex');
    const { text, badges } = renderHeader(null);
    assert.equal(badges, 1);
    // «12» من عدّاد الدورة (المرساة يوم 11 ⇒ 10 أغسطس).
    assert.equal(text.includes('12'), true);
    assert.equal(quotaEnabledFor.includes('codex'), true, 'يجب أن يُحاول المصدر الرسمي أولاً');
  });

  it('codex برد anthropic غير المتوقع يسقط إلى الدورة بلا نسبة مزوّد آخر', () => {
    setSelectedProvider('codex');
    codexQuotaResult = { ...codexQuotaResult, status: 'anthropic' };

    const { text, badges } = renderHeader(null);

    assert.equal(badges, 1);
    assert.equal(text.includes('12'), true);
    assert.equal(text.includes('%'), false);
    assert.equal(cycleEnabledCalls.includes(true), true);
  });

  it('codex loading ثم success: لا تومض الدورة قبل نافذتي الحصة', () => {
    setSelectedProvider('codex');
    codexQuotaResult = { ...codexQuotaResult, status: 'loading' };

    const loading = renderHeader(null);
    assert.equal(loading.badges, 0);
    assert.equal(cycleEnabledCalls.includes(true), false, 'fallback لا يعمل أثناء loading');

    cleanup();
    cycleEnabledCalls.length = 0;
    codexQuotaResult = {
      status: 'success',
      plan: 'plus',
      isAnthropic: false,
      refetch: () => {},
      windows: [
        {
          key: 'primary',
          usedPercent: 12,
          resetsAt: '2026-07-30T05:00:00.000Z',
          windowSeconds: 18_000,
          horizon: { value: 5, unit: 'hour' },
        },
        {
          key: 'secondary',
          usedPercent: 34,
          resetsAt: '2026-08-05T00:00:00.000Z',
          windowSeconds: 604_800,
          horizon: { value: 7, unit: 'day' },
        },
      ],
    };

    const success = renderHeader(null);
    assert.equal(success.badges, 2);
    assert.equal(success.text.includes('12%'), true);
    assert.equal(success.text.includes('34%'), true);
    assert.equal(cycleEnabledCalls.includes(true), false);
  });

  it('200 بنوافذ منتهية/غير صالحة يسقط إلى الدورة بعد حسم success', () => {
    setSelectedProvider('codex');
    codexQuotaResult = { ...codexQuotaResult, status: 'success', windows: [] };

    const { badges, text } = renderHeader(null);
    assert.equal(badges, 1);
    assert.equal(text.includes('12'), true);
    assert.equal(cycleEnabledCalls.includes(true), true);
  });

  it('kimi بلا مصدر ولا مرساة ⇒ صمت', () => {
    setSelectedProvider('kimi');
    assert.equal(renderHeader(null).badges, 0);
  });

  it('claude يبقى على نوافذه ولا يُشغّل مسار حصّة المزوّد', () => {
    setSelectedProvider('glm');
    const { badges, text } = renderHeader('claude');
    assert.equal(badges, 2);
    assert.equal(text.includes('100%'), false);
    assert.equal(quotaEnabledFor.includes('claude'), false);
  });

  it('جلسة glm تتقدّم على منتقي claude', () => {
    setSelectedProvider('claude');
    const { badges, text } = renderHeader('glm');
    assert.equal(badges, 3);
    assert.equal(text.includes('100%'), true);
  });

  it('tabsMode=hidden يُخفي فرع النوافذ أيضاً', () => {
    setSelectedProvider('glm');
    assert.equal(renderHeader(null, 'hidden').badges, 0);
  });

  // ── الحالة المُبلَّغ عنها حرفياً (2026-07-30، لقطة المالك) ────────────────
  //
  // جلسة جسمها `claude` ومحرّكها `glm` (النموذج المعروض glm-5.2) كانت تُظهر
  // «C 0% W 0%» — نوافذ اشتراك Anthropic على استهلاكٍ يُفوتَر على z.ai.
  it('جلسة claude بمحرّك glm ⇒ نوافذ glm لا نوافذ كلود', () => {
    setSelectedProvider('claude');
    setSelectedEngineProvider('glm');

    const { text, badges } = renderHeader('claude');

    assert.equal(badges, 3, 'ثلاث نوافذ glm');
    assert.equal(text.includes('100%'), true, 'نافذة النَفاد تظهر');
    // نوافذ كلود في المُحاكي 4% و75%: وجود أيٍّ منهما يعني أن الجسم غلب المحرّك.
    assert.equal(text.includes('4%'), false);
    assert.equal(text.includes('75%'), false);
    assert.equal(quotaEnabledFor.includes('glm'), true);
    assert.equal(quotaEnabledFor.includes('claude'), false);
  });

  it('إزالة المحرّك تُعيد نوافذ كلود فوراً (المسار الرسمي)', () => {
    setSelectedProvider('claude');
    setSelectedEngineProvider(null);
    const { badges, text } = renderHeader('claude');
    assert.equal(badges, 2);
    assert.equal(text.includes('75%'), true);
  });

  it('محرّك kimi (بلا مصدر حصّة ولا مرساة) ⇒ صمت لا نوافذ كلود', () => {
    setSelectedProvider('claude');
    setSelectedEngineProvider('kimi');
    assert.equal(renderHeader('claude').badges, 0);
  });

  // ── جهاز آخر: لا ختم محرّك في localStorage، والنموذج وحده يحسم ────────────
  //
  // هذه هي حالة لقطة المالك فعلاً (جوّال يفتح جلسة أُنشئت على سطح المكتب):
  // ختم المحرّك محليّ لكل متصفّح ولا يُحفَظ خادمياً، فبلا اعتماد النموذج كانت
  // نوافذ Anthropic تعود للظهور على استهلاك z.ai.
  it('جسم claude + نموذج glm-5.2 بلا ختم محرّك ⇒ نوافذ glm', () => {
    setSelectedProvider('claude');
    setSelectedEngineProvider(null);
    setSelectedActiveModel('glm-5.2');

    const { text, badges } = renderHeader('claude');
    assert.equal(badges, 3);
    assert.equal(text.includes('100%'), true);
    assert.equal(text.includes('75%'), false, 'لا نوافذ Anthropic');
  });

  it('جسم claude + نموذج claude-opus-5 ⇒ نوافذ كلود (لا انحدار للمسار الشائع)', () => {
    setSelectedProvider('claude');
    setSelectedEngineProvider(null);
    setSelectedActiveModel('claude-opus-5');

    const { text, badges } = renderHeader('claude');
    assert.equal(badges, 2);
    assert.equal(text.includes('75%'), true);
  });

  it('اسم مختصر (opus) يبقى كلوداً حتى قبل حكم الخادم', () => {
    setSelectedProvider('claude');
    setSelectedActiveModel('opus');
    assert.equal(renderHeader('claude').badges, 2);
  });
});

// ── B-1290: حالة الخطأ على سطح provider-windows ──────────────────────────────
//
// الحادثة: الخادم رمى على كل قراءة حصّة codex لمدة 7 أيام، فعرض المكوّن «↻ 12ي»
// من حساب الدورة في بقعة مؤشّر الحصّة. المالك قرأه «الحصّة تُصفَّر بعد 12 يوماً»
// بينما الرقم يجيب سؤالاً آخر تماماً (تجديد الاشتراك).
//
// السلوك المطلوب بعد الإصلاح:
//  • error ⇒ شارة تعذّر (data-testid="provider-quota-error-badge") + لا شارة دورة
//  • error + لا دورة ⇒ شارة تعذّر + لا صمت (لا null بلا مؤشّر)
//  • none ⇒ شارة دورة (السلوك القديم الصحيح — لا انحدار)
//  • loading ⇒ صمت (لا وميض)
//  • success ⇒ نوافذ (مغطّى في الـdescribe أعلاه)

describe('HeaderUsageIndicator — B-1290: حالة الخطأ على provider-windows', () => {
  function renderFull(sessionProvider?: string | null) {
    const { container } = render(
      <HeaderUsageIndicator tabsMode="full" sessionProvider={sessionProvider ?? null} />,
    );
    return container;
  }

  it('error ⇒ شارة تعذّر حاضرة وشارة الدورة غائبة', () => {
    setSelectedProvider('codex');
    codexQuotaResult = { ...codexQuotaResult, status: 'error' };

    const container = renderFull(null);

    assert.notEqual(
      container.querySelector('[data-testid="provider-quota-error-badge"]'),
      null,
      'يجب أن تظهر شارة التعذّر',
    );
    assert.equal(
      container.querySelector('[data-testid="provider-cycle-badge"]'),
      null,
      'شارة الدورة لا تظهر كشارة أساسية عند الخطأ',
    );
    assert.equal(container.textContent?.includes('↻'), false, 'رمز الدورة لا يظهر في النص');
  });

  it('error + دورة متوفّرة ⇒ شارة التعذّر فحسب (الدورة ثانوية في التلميح لا في الشارة)', () => {
    setSelectedProvider('codex');
    codexQuotaResult = { ...codexQuotaResult, status: 'error' };
    // cyclesRows الافتراضية تحتوي codex — الدورة متوفّرة.

    const container = renderFull(null);

    assert.notEqual(container.querySelector('[data-testid="provider-quota-error-badge"]'), null);
    assert.equal(container.querySelector('[data-testid="provider-cycle-badge"]'), null);
    // التحقّق من أن «⚠» حاضر لا «↻».
    assert.equal(container.textContent?.includes('⚠'), true);
    assert.equal(container.textContent?.includes('↻'), false);
  });

  it('error + لا دورة ⇒ شارة تعذّر بدل الصمت (بند الحدّة: error + no cycle row)', () => {
    setSelectedProvider('codex');
    codexQuotaResult = { ...codexQuotaResult, status: 'error' };
    cyclesRows = []; // لا صفّ دورة لأي مزوّد.

    const container = renderFull(null);

    assert.notEqual(
      container.querySelector('[data-testid="provider-quota-error-badge"]'),
      null,
      'يجب أن تظهر الشارة حتى بلا دورة',
    );
    assert.equal(container.textContent?.includes('↻'), false);
  });

  it('none ⇒ شارة الدورة (السقوط الصحيح — لا تراجع)', () => {
    setSelectedProvider('codex');
    // codexQuotaResult الافتراضي = none.

    const container = renderFull(null);

    assert.equal(container.querySelector('[data-testid="provider-quota-error-badge"]'), null);
    assert.notEqual(container.querySelector('[data-testid="provider-cycle-badge"]'), null);
    assert.equal(container.textContent?.includes('↻'), true);
  });

  it('loading ⇒ صمت كامل (لا وميض)', () => {
    setSelectedProvider('codex');
    codexQuotaResult = { ...codexQuotaResult, status: 'loading' };

    const container = renderFull(null);

    assert.equal(container.querySelector('[data-testid="provider-quota-error-badge"]'), null);
    assert.equal(container.querySelector('[data-testid="provider-cycle-badge"]'), null);
    assert.equal(container.textContent, '');
  });

  it('سطح cycle خالص (kimi) لا يُشغّل مسار الخطأ أبداً', () => {
    // kimi على سطح `cycle` — لا نوافذ ولا خطأ مزوّد، فالمكوّن يصمت (لا مرساة).
    setSelectedProvider('kimi');

    const container = renderFull(null);

    assert.equal(container.querySelector('[data-testid="provider-quota-error-badge"]'), null);
    assert.equal(container.textContent, '');
  });

  it(
    'error → loading (إعادة محاولة بعد TTL): لا وميض دورة حتى مع بقاء صفوف success',
    () => {
      // تُحاكي هذه الحالة وميض B-1290 follow-up:
      // 1) أُطلق codex بـ enabled=true أولاً ⇒ _lastCyclesSuccess تحمل صفّ codex.
      // 2) useProviderQuota يُعيد 'loading' (إعادة محاولة بعد 180ث).
      // 3) cycleFallbackResolved = false ⇒ useProviderCycles(false).
      // 4) المحاكي الجديد يُعيد 'success' مع الصفوف المحتجزة — كما يفعله الحقيقي.
      // 5) cycle يصبح غير null.
      // 6) بلا shouldSuppressOnProviderWindowsLoading كانت شارة ↻ تظهر.
      setSelectedProvider('codex');

      // المرحلة 1: جلب حصّة ناجح ⇒ يُفعّل useProviderCycles فتُخزَّن الصفوف.
      codexQuotaResult = { ...codexQuotaResult, status: 'none' };
      renderFull(null);
      cleanup();

      // المرحلة 2: إعادة محاولة بعد انتهاء TTL ⇒ status=loading.
      codexQuotaResult = { ...codexQuotaResult, status: 'loading' };
      const container = renderFull(null);

      // يجب ألّا تظهر أيّ شارة (لا خطأ ولا دورة): الصمت الآمن.
      assert.equal(
        container.querySelector('[data-testid="provider-quota-error-badge"]'),
        null,
        'لا شارة خطأ أثناء loading',
      );
      assert.equal(
        container.querySelector('[data-testid="provider-cycle-badge"]'),
        null,
        'لا شارة دورة تومض أثناء loading حتى مع وجود صفوف محتجزة',
      );
      assert.equal(container.textContent, '', 'صمت كامل أثناء إعادة المحاولة');
    },
  );
});
