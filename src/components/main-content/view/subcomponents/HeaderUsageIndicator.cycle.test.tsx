/**
 * `HeaderUsageIndicator` — فرع دورة التجديد للمزوّد غير الكلودي (المرحلة 2).
 *
 * ما يُثبته هذا الملف هو بالضبط ما منعته المراجعة النقدية أو أوجبته:
 *  • **لا مبلغ مالي أبداً** في أي فرع (‏N2): الشريط لا يتّسع للتحفّظ الذي يجعل
 *    الرقم صادقاً («قيمة مكافئة بأسعار API لا مالٌ مفوتَر») ولا لختم الأسعار.
 *  • **لا موعد من مرساة مقدَّرة** (‏N5): `unknown`/`derived` ⇒ صمت.
 *  • غياب صفّ المزوّد ⇒ صمت (لا «غير متاح» ولا صفر).
 *  • جلسة claude تبقى على نوافذ C/W/S/O، ولا يُجلب لها عقد الدورة.
 *  • **تبديل المزوّد لا يُبقي رقم المزوّد السابق** (‏M-11/A4): الحمولة واحدة
 *    لكل المزوّدات، والسطح يقرأ صفَّه بالبحث — فالتبديل لا يُطلق طلباً ولا
 *    يترك قيمةً بائتة.
 *  • **المزوّد الفعلي** يبقى `sessionProvider ?? globalProvider` في هذا الفرع
 *    أيضاً (امتداد المرحلة 1).
 *
 * الحمولة مشتقّة من الحمولة الحيّة (‏2026-07-30): codex يوم 11 detected «Plus»،
 * وglm/antigravity يوم 1 unknown، ولا صفّ لـkimi/deepseek إطلاقاً.
 *
 * ⚠️ لا تُمرَّر عناصر DOM إلى `node:assert` (تقتل عامل vitest عند الفشل) —
 * تُقارَن قيم أوّلية فقط. انظر AgentStatusCard.displayTruth.test.tsx.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = (opts?.defaultValue as string) ?? key;
      const withVars = template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''));
      // مفتاحٌ بلا defaultValue يعود كما هو؛ نُلحق به المتغيّرات كي تظهر الأرقام
      // في النصّ المُصيَّر (وهو ما تفحصه الحالات أدناه).
      return withVars === key && opts && 'days' in opts ? `${key}:${String(opts.days)}` : withVars;
    },
    i18n: { language: 'en' },
  }),
}));

// نوافذ كلود: نجيب بنجاح دائماً كي يكون «الإخفاء» في الحالات أدناه قراراً عن
// المزوّد لا نتيجةَ غياب بيانات.
const claudeUsageFixture = {
  plan: 'max',
  session: { utilization: 4, resetsAt: '2026-07-30T03:29:59.842Z' },
  weeklyAllModels: { utilization: 75, resetsAt: '2026-08-04T00:00:00.842Z' },
  weeklySonnet: { utilization: 12, resetsAt: '2026-08-04T00:00:00.842Z' },
  weeklyOpus: null,
  extraUsage: null,
  fetchedAt: '2026-07-30T00:00:00.000Z',
  stale: false,
};

vi.mock('../../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock('../../../quick-settings-panel/hooks/useClaudeUsageShared', () => ({
  useClaudeUsageShared: (enabled: boolean) =>
    enabled
      ? { status: 'success', data: claudeUsageFixture, refetch: () => {} }
      : { status: 'idle', refetch: () => {} },
}));

// صفوف `GET /costs/cycle` كما تصل حيّاً، وعدّاد تفعيلٍ لإثبات أن جلسة claude لا
// تُشغّل هذا المسار أصلاً.
const cycleRows = [
  {
    provider: 'codex',
    displayName: 'Codex',
    plan: 'Plus',
    anchorDay: 11,
    anchorSource: 'detected' as const,
    cycleStart: '2026-07-10T21:00:00.000Z',
    cycleEnd: '2026-08-10T21:00:00.000Z',
  },
  {
    provider: 'glm',
    displayName: 'GLM',
    plan: null,
    anchorDay: 1,
    anchorSource: 'unknown' as const,
    cycleStart: '2026-06-30T21:00:00.000Z',
    cycleEnd: '2026-07-31T21:00:00.000Z',
  },
  {
    provider: 'antigravity',
    displayName: 'Antigravity',
    plan: null,
    anchorDay: 1,
    anchorSource: 'derived' as const,
    cycleStart: '2026-06-30T21:00:00.000Z',
    cycleEnd: '2026-07-31T21:00:00.000Z',
  },
];

// مسار حصّة المزوّد مُعطَّل في هذا الملف عمداً: موضوعه فرع الدورة وحده. وبلا
// هذا المُحاكي يعمل الهوك الحقيقي فيحاول نداءً شبكياً فعلياً داخل jsdom — اختبارٌ
// يعتمد على الشبكة ليس اختباراً.
vi.mock('../../../quick-settings-panel/hooks/useProviderQuota', () => ({
  useProviderQuota: () => ({ status: 'none', windows: [], plan: null, refetch: () => {} }),
}));

const cycleEnabledCalls: boolean[] = [];

vi.mock('../../../quick-settings-panel/hooks/useProviderCycles', () => ({
  useProviderCycles: (enabled: boolean) => {
    cycleEnabledCalls.push(enabled);
    return enabled
      ? { status: 'success', rows: cycleRows, refetch: () => {} }
      : { status: 'idle', refetch: () => {} };
  },
}));

import { setSelectedProvider, __resetSelectedProviderStore } from '../../../../stores/selectedProviderStore';

import HeaderUsageIndicator from './HeaderUsageIndicator';

afterEach(cleanup);

beforeEach(() => {
  __resetSelectedProviderStore();
  cycleEnabledCalls.length = 0;
  // مؤقّتات مزيّفة **فعلاً** لا `setSystemTime` وحده: بلا `useFakeTimers` تبقى
  // `Date.now` حقيقية، وكان عدّاد الأيام هنا يطابق الرقم المتوقّع بالمصادفة
  // (‏12 اليوم و12 بالتثبيت) فيمرّ الاختبار بلا أن يُثبت شيئاً — راحةُ fixture
  // زائفة. الحالة الأخيرة أدناه تثبت أن التثبيت يعمل برقم مختلف تماماً.
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-07-29T23:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function renderHeader(sessionProvider?: string | null) {
  const { container } = render(
    <HeaderUsageIndicator tabsMode="full" sessionProvider={sessionProvider} />,
  );
  return {
    container,
    text: container.textContent ?? '',
    badges: container.querySelectorAll('span[aria-label]').length,
  };
}

describe('HeaderUsageIndicator — فرع الدورة', () => {
  it('codex بمرساة مُكتشَفة يعرض عدّاد الأيام (12) بلا أي مبلغ', () => {
    setSelectedProvider('codex');
    const { text, badges } = renderHeader(null);

    assert.equal(badges, 1);
    assert.equal(text.includes('12'), true);
    // لا مبلغ ولا رمز عملة في أي حال — الفيتو الأول.
    assert.equal(text.includes('$'), false);
    assert.equal(/\d+\.\d\d/.test(text), false);
  });

  it('glm بمرساة unknown ⇒ لا شيء (شهر تقويمي مفترَض ليس موعداً)', () => {
    setSelectedProvider('glm');
    assert.equal(renderHeader(null).badges, 0);
  });

  it('antigravity بمرساة derived ⇒ لا شيء (تقدير لا واقعة)', () => {
    setSelectedProvider('antigravity');
    assert.equal(renderHeader(null).badges, 0);
  });

  it('kimi بلا صفّ في الحمولة ⇒ لا شيء (لا صفر ولا «غير متاح»)', () => {
    setSelectedProvider('kimi');
    const { badges, text } = renderHeader(null);
    assert.equal(badges, 0);
    assert.equal(text, '');
  });

  it('جلسة claude تعرض النوافذ ولا تُفعّل جلب الدورة إطلاقاً', () => {
    setSelectedProvider('codex');
    const { badges, text } = renderHeader('claude');
    assert.equal(badges, 3);
    assert.equal(text.includes('$'), false);
    assert.equal(cycleEnabledCalls.includes(true), false, 'claude يجب ألا يُشغّل مسار الدورة');
  });

  it('جلسة codex تتقدّم على منتقي claude: دورة لا نوافذ', () => {
    setSelectedProvider('claude');
    const { badges, text } = renderHeader('codex');
    assert.equal(badges, 1);
    assert.equal(text.includes('12'), true);
  });

  it('تبديل المنتقي من codex إلى glm لا يُبقي رقم codex معروضاً', () => {
    setSelectedProvider('codex');
    const { container } = renderHeader(null);
    assert.equal(container.textContent?.includes('12'), true);

    // نُصيّر بمزوّد آخر: نفس الحمولة، صفٌّ آخر ⇒ صمت فوري بلا طلب جديد.
    cleanup();
    setSelectedProvider('glm');
    const after = renderHeader(null);
    assert.equal(after.badges, 0);
    assert.equal(after.text.includes('12'), false);
  });

  it('sakana (لا سطح خادمي له) ⇒ لا يُفعّل جلباً ولا يعرض شيئاً', () => {
    setSelectedProvider('sakana');
    const { badges } = renderHeader(null);
    assert.equal(badges, 0);
    assert.equal(cycleEnabledCalls.includes(true), false);
  });

  it('العدّاد يتبع اللحظة المثبَّتة لا ساعة المُشغِّل (3 أيام لا 12)', () => {
    // لو لم يكن تثبيت الوقت عاملاً لأعطى هذا 12 كبقية الحالات.
    vi.setSystemTime(new Date('2026-08-08T12:00:00.000Z'));
    setSelectedProvider('codex');
    const { text } = renderHeader(null);
    assert.equal(text.includes('3'), true, 'يجب أن يعرض 3 أيام');
    assert.equal(text.includes('12'), false);
  });

  it('tabsMode=hidden يُخفي فرع الدورة كما يُخفي النوافذ', () => {
    setSelectedProvider('codex');
    const { container } = render(<HeaderUsageIndicator tabsMode="hidden" sessionProvider={null} />);
    assert.equal(container.querySelectorAll('span[aria-label]').length, 0);
  });
});
