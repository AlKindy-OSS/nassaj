/**
 * عقد التطابق بين سطح الحصة في الهيدر والشريط الجانبي المطوي.
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'providerCycle.title') return 'cycle';
      if (key === 'providerCycle.compact') return `${String(opts?.days)}d`;
      if (key === 'providerCycle.renewsIn') return `renews-${String(opts?.days)}d`;
      if (key === 'providerQuota.title') return 'quota';
      if (key === 'providerQuota.windowGeneric') return 'window';
      if (key.startsWith('providerQuota.length.')) return key.split('.').at(-1) ?? key;
      if (key.startsWith('providerQuota.horizon.')) return `${String(opts?.value)}h`;
      if (key === 'providerQuota.resetsIn') return `resets-${String(opts?.horizon)}`;
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

// qa-critic (T-1858، جولة 2): يتتبّع enabled لإثبات أن حصّة Claude معطَّلة على
// جلسة Codex في السطحين معاً (كانت مُفعَّلة أيضاً لعرض هارنس Claude بجانب
// رصيد Codex بشارة "+" غير موسومة — عطلٌ مُصلَح، والتطابق شرطُ هذا الملف A1).
//
// قابلٌ للتهيئة (‏claudeUsageMockResult) لتغطية شارة "+" الخاصة بكلود على جلسة
// claude فعلية (المُصلَح في هذه الجولة): الافتراضي `idle` يحافظ على كل
// الاختبارات الحالية (جلسة Codex لا تُفعِّل هذا الهوك إطلاقاً).
type ClaudeUsageMockResult =
  | { status: 'idle' | 'loading' }
  | { status: 'error'; code: string | null }
  | { status: 'success'; data: Record<string, unknown> };
let claudeUsageMockResult: ClaudeUsageMockResult = { status: 'idle' };
const claudeUsageEnabledCalls: boolean[] = [];
vi.mock('../../../quick-settings-panel/hooks/useClaudeUsageShared', () => ({
  useClaudeUsageShared: (enabled: boolean) => {
    claudeUsageEnabledCalls.push(enabled);
    if (!enabled) return { status: 'idle', refetch: () => {} };
    return { ...claudeUsageMockResult, refetch: () => {} };
  },
}));

// دورة التجديد — قابلة للتهيئة بين الاختبارات (إصلاح B-1290 follow-up item 4).
// المحاكي يُعكس سلوك useProviderCycles الحقيقي: الصفوف الناجحة تبقى محتجزة
// حتى عند تعطيل enabled (لا إعادة ضبط).
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
let _lastCollapsedCyclesSuccess: { rows: CycleRow[] } | null = null;
const cycleEnabledCalls: boolean[] = [];
vi.mock('../../../quick-settings-panel/hooks/useProviderCycles', () => ({
  useProviderCycles: (enabled: boolean) => {
    cycleEnabledCalls.push(enabled);
    if (enabled) {
      _lastCollapsedCyclesSuccess = { rows: cyclesRows };
      return { status: 'success', rows: cyclesRows, refetch: () => {} };
    }
    // لا إعادة ضبط — السلوك الحقيقي للـhook.
    if (_lastCollapsedCyclesSuccess !== null) {
      return { status: 'success', rows: _lastCollapsedCyclesSuccess.rows, refetch: () => {} };
    }
    return { status: 'idle', refetch: () => {} };
  },
}));

type QuotaResult = {
  status: 'loading' | 'none' | 'error' | 'anthropic' | 'success';
  windows: Array<{
    key: string;
    usedPercent: number;
    resetsAt: string;
    windowSeconds: number;
    horizon: { value: number; unit: 'hour' };
  }>;
  plan: string | null;
  isAnthropic: boolean;
  data?: { extraUsageCredits?: { balance: number | null; unlimited: boolean } };
  refetch: () => void;
};

let quotaResult: QuotaResult;
vi.mock('../../../quick-settings-panel/hooks/useProviderQuota', () => ({
  useProviderQuota: () => quotaResult,
}));

import {
  __resetSelectedProviderStore,
  setSelectedProvider,
} from '../../../../stores/selectedProviderStore';
import HeaderUsageIndicator from '../../../main-content/view/subcomponents/HeaderUsageIndicator';

import { ClaudeUsageCollapsed } from './ClaudeUsageCollapsed';

function renderBoth(sessionProvider: string | null = 'codex') {
  const header = render(<HeaderUsageIndicator sessionProvider={sessionProvider} tabsMode="full" />);
  const collapsed = render(<ClaudeUsageCollapsed sessionProvider={sessionProvider} />);
  return { header: header.container, collapsed: collapsed.container };
}

/** span[aria-hidden] whose visible text is exactly the "+" mark, in a container. */
function plusMarks(container: HTMLDocument | Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')).filter(
    (el) => el.textContent?.trim() === '+',
  );
}

afterEach(cleanup);
afterEach(() => vi.useRealTimers());

beforeEach(() => {
  __resetSelectedProviderStore();
  setSelectedProvider('codex');
  cycleEnabledCalls.length = 0;
  claudeUsageEnabledCalls.length = 0;
  claudeUsageMockResult = { status: 'idle' };
  _lastCollapsedCyclesSuccess = null;
  // الصف الافتراضي: codex بمرساة مُكتشَفة.
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
  quotaResult = {
    status: 'loading',
    windows: [],
    plan: null,
    isAnthropic: false,
    refetch: () => {},
  };
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

describe('ClaudeUsageCollapsed — تطابق حالة حصة Codex مع الهيدر', () => {
  it('loading يبقى صامتاً في السطحين ولا يشغّل fallback', () => {
    const { header, collapsed } = renderBoth();

    expect(header.textContent).toBe('');
    expect(collapsed.textContent).toBe('');
    expect(cycleEnabledCalls).not.toContain(true);
  });

  // none وanthropic يسقطان إلى شارة الدورة (السلوك الصحيح القائم).
  it.each(['none', 'anthropic'] as const)('%s يسقط إلى الدورة في السطحين', (status) => {
    quotaResult = { ...quotaResult, status };
    const { header, collapsed } = renderBoth();

    expect(header.textContent).toContain('↻');
    expect(collapsed.textContent).toContain('↻');
    expect(header.querySelector('[aria-label^="cycle:"]')).not.toBeNull();
    expect(collapsed.querySelector('[aria-label^="cycle:"]')).not.toBeNull();
  });

  // B-1290: error يعرض شارة تعذّر في السطحين — لا شارة الدورة كشارة أساسية.
  it('error يعرض شارة تعذّر في السطحين بدل شارة الدورة', () => {
    quotaResult = { ...quotaResult, status: 'error' };
    const { header, collapsed } = renderBoth();

    // شارة التعذّر حاضرة.
    expect(header.querySelector('[data-testid="provider-quota-error-badge"]')).not.toBeNull();
    expect(collapsed.querySelector('[data-testid="provider-quota-error-badge"]')).not.toBeNull();
    // شارة الدورة غائبة كشارة أساسية.
    expect(header.querySelector('[data-testid="provider-cycle-badge"]')).toBeNull();
    expect(header.textContent).not.toContain('↻');
    expect(collapsed.textContent).not.toContain('↻');
  });

  // B-1290 بند الحدّة: error + لا دورة ⇒ شارة تعذّر لا صمت.
  // (إصلاح follow-up item 4: cyclesRows=[] فعلاً بدل الاعتماد على mock ثابت)
  it('error بلا دورة ⇒ شارة تعذّر في السطحين لا صمت', () => {
    quotaResult = { ...quotaResult, status: 'error' };
    cyclesRows = []; // لا صفّ لأي مزوّد — يختبر المسار الحدّي فعلاً.

    const { header, collapsed } = renderBoth();

    expect(header.querySelector('[data-testid="provider-quota-error-badge"]')).not.toBeNull();
    expect(collapsed.querySelector('[data-testid="provider-quota-error-badge"]')).not.toBeNull();
    expect(header.textContent).not.toContain('↻');
    expect(collapsed.textContent).not.toContain('↻');
  });

  // B-1290 follow-up: error → loading (إعادة محاولة بعد TTL) لا يُظهر وميض الدورة.
  it('error → loading: لا وميض دورة في السطحين حتى مع صفوف محتجزة', () => {
    // المرحلة 1: none ⇒ يُفعّل useProviderCycles ⇒ تُخزَّن صفوف codex.
    quotaResult = { ...quotaResult, status: 'none' };
    renderBoth();
    cleanup();

    // المرحلة 2: إعادة محاولة ⇒ status=loading.
    quotaResult = { ...quotaResult, status: 'loading' };
    const { header, collapsed } = renderBoth();

    // كلا السطحين يصمتان — لا وميض لـ↻.
    expect(header.querySelector('[data-testid="provider-quota-error-badge"]')).toBeNull();
    expect(collapsed.querySelector('[data-testid="provider-quota-error-badge"]')).toBeNull();
    expect(header.querySelector('[data-testid="provider-cycle-badge"]')).toBeNull();
    expect(header.textContent).toBe('');
    expect(collapsed.textContent).toBe('');
  });

  it('success بنوافذ صالحة يعرض النسبة في السطحين ولا يشغّل الدورة', () => {
    quotaResult = {
      ...quotaResult,
      status: 'success',
      plan: 'plus',
      windows: [
        {
          key: 'primary',
          usedPercent: 12,
          resetsAt: '2026-08-01T05:00:00.000Z',
          windowSeconds: 18_000,
          horizon: { value: 5, unit: 'hour' },
        },
      ],
    };
    const { header, collapsed } = renderBoth();

    expect(header.textContent).toContain('12%');
    expect(collapsed.textContent).toContain('12%');
    expect(header.textContent).not.toContain('↻');
    expect(collapsed.textContent).not.toContain('↻');
    expect(cycleEnabledCalls).not.toContain(true);
  });

  it('حصّة Claude معطَّلة في السطحين على جلسة Codex (qa-critic T-1858 ج2)', () => {
    quotaResult = {
      ...quotaResult,
      status: 'success',
      plan: 'plus',
      windows: [
        {
          key: 'primary',
          usedPercent: 12,
          resetsAt: '2026-08-01T05:00:00.000Z',
          windowSeconds: 18_000,
          horizon: { value: 5, unit: 'hour' },
        },
      ],
    };
    renderBoth();
    expect(claudeUsageEnabledCalls.length).toBeGreaterThan(0);
    expect(claudeUsageEnabledCalls).not.toContain(true);
  });
});

// ── رصيد هارنس Claude الإضافي — قاعدة العرض الواحدة على السطحين ─────────────
//
// جلسة claude فعلية (لا Codex): تُشغِّل مسار نوافذ كلود (useClaudeUsageShared)
// لا مسار provider-windows، فـ`quotaResult` أعلاه لا يتدخّل هنا (‏activeModel
// فارغ ⇒ claudeWindowsAllowed يحسمها بلا انتظار حكم الخادم).
const CLAUDE_SUCCESS_DATA = {
  plan: 'max',
  session: { utilization: 4, resetsAt: '2026-08-04T00:00:00.000Z' },
  weeklyAllModels: { utilization: 10, resetsAt: '2026-08-08T00:00:00.000Z' },
  weeklySonnet: null,
  weeklyOpus: null,
  fetchedAt: '2026-08-01T00:00:00.000Z',
  stale: false,
};

describe('رصيد هارنس Claude الإضافي — مكتوم عند الصفر، مخفيّ حين لا يُعرف', () => {
  beforeEach(() => {
    setSelectedProvider('claude');
  });

  it('لا رصيد إضافي (‏extraUsage: null) ⇒ إخفاء تام في السطحين — لا "+"', () => {
    claudeUsageMockResult = {
      status: 'success',
      data: { ...CLAUDE_SUCCESS_DATA, extraUsage: null },
    };

    const { header, collapsed } = renderBoth('claude');

    expect(header.textContent).not.toContain('+');
    expect(collapsed.textContent).not.toContain('+');
  });

  it('نافد فعلاً بالمساواة (‏used === limit) ⇒ شارة صفر مكتومة في السطحين', () => {
    claudeUsageMockResult = {
      status: 'success',
      data: {
        ...CLAUDE_SUCCESS_DATA,
        extraUsage: { enabled: true, usedCredits: 8_000, monthlyLimit: 8_000, utilization: 100, currency: 'USD' },
      },
    };

    const { header, collapsed } = renderBoth('claude');

    for (const container of [header, collapsed]) {
      const plus = plusMarks(container);
      expect(plus.length).toBe(1);
      expect(plus[0].className).toContain('text-muted-foreground');
      expect(plus[0].className).not.toContain('text-primary');
    }
    expect(header.textContent).toContain('$0.00');
    expect(collapsed.textContent).toContain('$0.00');
  });

  it('تجاوز الحدّ (‏used > limit، بلا عملة معروفة) ⇒ صفر مكتوم أيضاً لا إخفاء', () => {
    // الخادم يرسل utilization/currency كـnull على حساب مُفعَّل متجاوز الحدّ —
    // القرار "0" لا يحتاج أياً منهما.
    claudeUsageMockResult = {
      status: 'success',
      data: {
        ...CLAUDE_SUCCESS_DATA,
        extraUsage: { enabled: true, usedCredits: 9_000, monthlyLimit: 8_000, utilization: null, currency: null },
      },
    };

    const { header, collapsed } = renderBoth('claude');

    for (const container of [header, collapsed]) {
      const plus = plusMarks(container);
      expect(plus.length).toBe(1);
      expect(plus[0].className).toContain('text-muted-foreground');
      expect(plus[0].className).not.toContain('text-primary');
      // لا عملة معروفة ⇒ "0" مجرَّدة لا مبلغاً مُختلَقاً.
      const value = plus[0].nextElementSibling as HTMLElement | null;
      expect(value?.textContent).toBe('0');
    }
  });

  it('loading ⇒ صمت كامل في السطحين (لا شارة صفر مؤقّتة)', () => {
    claudeUsageMockResult = { status: 'loading' };

    const { header, collapsed } = renderBoth('claude');

    expect(header.textContent).toBe('');
    expect(collapsed.textContent).toBe('');
  });

  it('error ⇒ صمت كامل في السطحين (لا شارة صفر مؤقّتة)', () => {
    claudeUsageMockResult = { status: 'error', code: null };

    const { header, collapsed } = renderBoth('claude');

    expect(header.textContent).toBe('');
    expect(collapsed.textContent).toBe('');
  });
});
