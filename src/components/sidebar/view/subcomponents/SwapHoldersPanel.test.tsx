/**
 * لوحة «مَن يحمل الـswap؟» (T-1204) — عرضٌ فقط، بلا أيّ فعل.
 *
 * الحدود المختبَرة هي بالضبط ما يسهل أن ينكسر صامتاً:
 *   • البوابة بالدور من السياق لا بـ403 — لغير المالك **لا زرّ ولا طلب**.
 *   • الجلب **عند الفتح** لا مع استطلاع الخمس ثوانٍ، والمحفوظ خلال 30 ثانية.
 *   • الترتيب: ‏/tmp ثمّ الحاملون ثمّ النظام ثمّ غير المنسوب — الأهمّ أوّلاً.
 *   • `available:false` نصٌّ صريح لا أصفارٌ ملفَّقة.
 *   • الخطأ يُقال لا يُبتلع.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent, within } from '@testing-library/react';
import type { TFunction } from 'i18next';

import { authenticatedFetch } from '../../../../utils/api';
vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(),
  api: {},
}));

// بوابة الدور تُقرأ من `useOptionalAuth`؛ نُبدّلها بدل تركيب مزوّد مصادقة
// كامل — المقصود هنا سلوك الذيل لا آليّة تسجيل الدخول.
const authState: { user: { username: string; role: string } | null } = { user: null };
vi.mock('../../../auth', () => ({
  useOptionalAuth: () => authState,
}));

import { SystemStatsFooter } from './SystemStats';
import { formatAgoText, primaryTmpfs, tmpfsPercentOfSize } from './systemStatsFormat';

const tStub = ((key: string, opts?: Record<string, unknown>) => {
  const fallback = opts && typeof opts.defaultValue === 'string' ? opts.defaultValue : key;
  return opts && typeof opts.ago === 'string' ? `${fallback} ${opts.ago}` : fallback;
}) as unknown as TFunction;

const fetchMock = vi.mocked(authenticatedFetch);

const STATS = {
  cpu: { percent: 1.5 },
  memory: { usedBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, percent: 50 },
  swap: { usedMb: 813, totalMb: 1675 },
  tmpfs: [{ mount: '/tmp', usedMb: 382, sizeMb: 512 }],
};

function holdersPayload(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    measuredAt: Date.now(),
    swapUsedMb: 813,
    swapCachedMb: 75,
    holders: [
      {
        pid: 1234,
        name: 'MainThread',
        kind: 'build',
        project: 'مشروع-ب',
        swapMb: 101,
        swapSource: 'vmswap',
        ageHours: 41.2,
      },
      { pid: 77, name: 'node', kind: 'app', project: null, swapMb: 44, ageHours: 0.2 },
    ],
    system: { count: 60, swapMb: 268 },
    unattributedMb: 368,
    tmpfs: [{ mount: '/tmp', usedMb: 382, sizeMb: 512 }],
    ...overrides,
  };
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** يوجّه كل مسار إلى ردّه: الإحصاءات تُستطلَع، واللوحة تُطلَب عند الفتح. */
function routeFetch(holders: unknown, holdersOk = true) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/api/system/swap-holders')) {
      return holdersOk
        ? okResponse(holders)
        : ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    }
    return okResponse(STATS);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const holderCalls = () =>
  fetchMock.mock.calls.filter(call => String(call[0]).includes('/swap-holders')).length;

/** زرّ اللوحة: هو الزرّ الحامل نصّ SWAP (والآخر زرّ طيّ الذيل). */
const swapButtons = () => screen.getAllByRole('button').filter(b => /SWAP/.test(b.textContent ?? ''));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.setItem('nassaj.systemStats.collapsed', '0'); // الذيل مفتوح
  authState.user = { username: 'owner', role: 'owner' };
  fetchMock.mockReset();
  routeFetch(holdersPayload());
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  localStorage.clear();
});

describe('صيغ اللوحة', () => {
  it('primaryTmpfs يقدّم /tmp لا الأثقل — وهو جذر حادثة يوليو', () => {
    expect(
      primaryTmpfs([
        { mount: '/dev/shm', usedMb: 900, sizeMb: 5120 },
        { mount: '/tmp', usedMb: 382, sizeMb: 512 },
      ])?.mount,
    ).toBe('/tmp');
    // غاب /tmp ⇒ الأثقل صفٌّ صادق خيرٌ من لا صفّ
    expect(primaryTmpfs([{ mount: '/dev/shm', usedMb: 900, sizeMb: 5120 }])?.mount).toBe('/dev/shm');
    expect(primaryTmpfs([])).toBeNull();
    expect(primaryTmpfs(undefined)).toBeNull();
  });

  it('tmpfsPercentOfSize ينسب إلى سعة المسار — سؤال «كم بقي قبل الامتلاء»', () => {
    expect(tmpfsPercentOfSize(382, 512)).toBeCloseTo(74.6, 1);
    expect(tmpfsPercentOfSize(1, 0)).toBeNull();
  });

  it('formatAgoText يختار الوحدة ويصون جمع العربية', () => {
    expect(formatAgoText(41.2 * 3600_000, 'ar')).toContain('41');
    expect(formatAgoText(12 * 60_000, 'ar')).toContain('12');
    expect(formatAgoText(4000, 'en')).toBe('4 seconds ago');
    expect(formatAgoText(2 * 3600_000, 'en')).toBe('2 hours ago');
    expect(formatAgoText(72 * 3600_000, 'en')).toBe('3 days ago');
    // ساعة الخادم قد تسبق ساعة المتصفّح — «قبل -3 ثوانٍ» كذبة مربكة
    expect(formatAgoText(-3000, 'en')).toBe('now');
  });
});

describe('بوابة الدور', () => {
  it('صفّ SWAP يصير زرّاً للمالك', async () => {
    render(<SystemStatsFooter t={tStub} />);
    await flush();

    const buttons = swapButtons();
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0].getAttribute('aria-expanded')).toBe('false');
    // مغلقاً لا لوحة ⇒ لا `aria-controls` معلّقاً على معرّفٍ غير موجود
    expect(buttons[0].getAttribute('aria-controls')).toBeNull();

    fireEvent.click(buttons[0]);
    await flush();
    const opened = swapButtons()[0];
    expect(opened.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(opened.getAttribute('aria-controls') ?? '')).toBeTruthy();
  });

  it('لغير المالك يبقى نصّاً — ولا يُطلق طلبٌ يُردّ بـ403', async () => {
    authState.user = { username: 'someone', role: 'user' };
    render(<SystemStatsFooter t={tStub} />);
    await flush();

    expect(swapButtons()).toHaveLength(0);
    expect(screen.getAllByText(/^SWAP /).length).toBeGreaterThan(0); // الصفّ باقٍ نصّاً
    expect(holderCalls()).toBe(0);
  });

  it('بلا سياق مصادقة أصلاً: نصّ ولا طلب', async () => {
    authState.user = null;
    render(<SystemStatsFooter t={tStub} />);
    await flush();

    expect(swapButtons()).toHaveLength(0);
    expect(holderCalls()).toBe(0);
  });
});

describe('الجلب عند الفتح وحده', () => {
  it('لا طلب قبل الفتح، وطلبٌ واحد عنده', async () => {
    render(<SystemStatsFooter t={tStub} />);
    await flush();
    expect(holderCalls()).toBe(0);

    // خمس دورات استطلاع كاملة: اللوحة لا تُلحَق بها
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 * 5);
    });
    expect(holderCalls()).toBe(0);

    fireEvent.click(swapButtons()[0]);
    await flush();
    expect(holderCalls()).toBe(1);
  });

  it('إعادة الفتح خلال 30 ثانية تعرض المحفوظ، وبعدها تُعيد الجلب', async () => {
    render(<SystemStatsFooter t={tStub} />);
    await flush();

    fireEvent.click(swapButtons()[0]);
    await flush();
    expect(holderCalls()).toBe(1);

    fireEvent.click(swapButtons()[0]); // إغلاق
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    fireEvent.click(swapButtons()[0]); // فتحٌ ثانٍ — ما زال طازجاً
    await flush();
    expect(holderCalls()).toBe(1);

    fireEvent.click(swapButtons()[0]); // إغلاق
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    fireEvent.click(swapButtons()[0]); // بعد بوار القياس
    await flush();
    expect(holderCalls()).toBe(2);
  });
});

describe('محتوى اللوحة وترتيبه', () => {
  async function openPanel() {
    render(<SystemStatsFooter t={tStub} />);
    await flush();
    fireEvent.click(swapButtons()[0]);
    await flush();
    return screen.getAllByRole('region')[0];
  }

  it('الأهمّ أوّلاً: /tmp ثمّ الحاملون ثمّ النظام ثمّ غير المنسوب', async () => {
    const panel = await openPanel();
    const text = (panel.textContent ?? '').replace(/\s+/g, ' ');

    const iTmp = text.indexOf('/tmp');
    const iHolder = text.indexOf('MainThread');
    const iSystem = text.indexOf('نظام وخدمات');
    const iUnattributed = text.indexOf('غير منسوب');

    expect(iTmp).toBeGreaterThanOrEqual(0);
    expect(iTmp).toBeLessThan(iHolder);
    expect(iHolder).toBeLessThan(iSystem);
    expect(iSystem).toBeLessThan(iUnattributed);

    // ‏/tmp بنسبته من سعته، وتحذيرياً عند ≥70%
    expect(within(panel).getByText('382MB/512MB (75%)').className).toMatch(/amber/);
    // النظام مجمَّعاً، وغير المنسوب برقمه
    expect(text).toContain('60');
    expect(within(panel).getByText('268MB')).toBeTruthy();
    expect(within(panel).getByText('368MB')).toBeTruthy();
  });

  it('الحامل يعرض اسمه ومشروعه وحجمه وعمره', async () => {
    const panel = await openPanel();

    expect(within(panel).getByText('MainThread')).toBeTruthy();
    expect(within(panel).getByText('مشروع-ب')).toBeTruthy();
    // vmswap ⇒ علامة تقريب ظاهرة لا مخفيّة
    const size = within(panel).getByText('≈101MB');
    expect(size.getAttribute('title')).toMatch(/تقريبي/);
    expect(size.getAttribute('dir')).toBe('ltr');
    expect(size.className).toMatch(/tabular-nums/);
  });

  it('التلميح يحمل الاسم كاملاً والمعرّف، فلا عمودَ pid يزاحم الاسم', async () => {
    const panel = await openPanel();

    // العمود الضيّق يقصّ الاسم فلا يُقرأ؛ التلميح هو الذي يحمله كاملاً.
    const name = within(panel).getByText('MainThread');
    expect(name.getAttribute('title')).toContain('MainThread');
    expect(name.getAttribute('title')).toContain('#1234');
    // وصنف العملية: «‏MainThread» لا يقول شيئاً، و«بناء» يقول.
    expect(name.getAttribute('title')).toContain('بناء');
    expect(name.className).toMatch(/truncate/);
    // والمعرّف لم يعد نصّاً في الصفّ — تلك المساحة صارت للاسم.
    expect(within(panel).queryByText('#1234')).toBeNull();
  });

  it('لحظة القياس معروضة — رقمٌ بلا زمنه ادّعاء آنيّة', async () => {
    const panel = await openPanel();
    expect(panel.textContent).toMatch(/قِيس/);
  });

  it('اسم العملية يُعرض نصّاً ولا يُحقن HTML', async () => {
    routeFetch(
      holdersPayload({
        holders: [{ pid: 9, name: '<img src=x onerror=alert(1)>', swapMb: 5, ageHours: 1 }],
      }),
    );
    const panel = await openPanel();

    expect(within(panel).getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(panel.querySelector('img')).toBeNull();
  });
});

describe('الحالات غير السعيدة', () => {
  it('available:false ⇒ نصّ صريح لا أصفار', async () => {
    routeFetch({ available: false });
    render(<SystemStatsFooter t={tStub} />);
    await flush();
    fireEvent.click(swapButtons()[0]);
    await flush();

    expect(screen.getAllByText('القراءة غير متاحة على هذا النظام').length).toBeGreaterThan(0);
    expect(screen.queryByText('0MB')).toBeNull();
  });

  it('الخطأ يُقال لا يُبتلع', async () => {
    routeFetch(null, false);
    render(<SystemStatsFooter t={tStub} />);
    await flush();
    fireEvent.click(swapButtons()[0]);
    await flush();

    expect(screen.getAllByText('تعذّرت قراءة تفصيل الـswap').length).toBeGreaterThan(0);
  });

  it('قائمة حاملين فارغة تُقال صراحةً', async () => {
    routeFetch(holdersPayload({ holders: [] }));
    render(<SystemStatsFooter t={tStub} />);
    await flush();
    fireEvent.click(swapButtons()[0]);
    await flush();

    expect(screen.getAllByText('لا عملية تحمل swap يُذكر').length).toBeGreaterThan(0);
  });
});
