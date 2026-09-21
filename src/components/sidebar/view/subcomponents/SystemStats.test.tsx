/**
 * Behavioural regression guard for `useSystemStats` (B-74).
 *
 * Locks the contract of the two fixes the hook embodies:
 *   • 9ef40b8 — the resource indicator must KEEP polling (no freeze) across a
 *     React StrictMode mount → cleanup → remount.
 *   • ea9e0f6 / B-75 — that remount, while a previous request is still in
 *     flight, must NOT arm a second concurrent polling loop (no doubled rate).
 *
 * The StrictMode test (case c) is the discriminator: it passes on the current
 * effect-scoped-locals implementation and fails on the old cancelledRef one,
 * which leaked a second timer (doubled fetches) or stalled (zero fetches).
 *
 * Strategy: mock the network boundary only (`authenticatedFetch`), drive time
 * with fake timers, and assert on observable behaviour — fetch call count and
 * the value surfaced by the hook — never on internals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import type { TFunction } from 'i18next';

// Mock the network boundary. The hook imports it as
// `../../../../utils/api` → resolves to src/utils/api.js.
import { authenticatedFetch } from '../../../../utils/api';
vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(),
}));

import { useSystemStats, SystemStatsFooter, SystemStatsCollapsed } from './SystemStats';
import { heaviestTmpfs, resolveLoadLevel, swapPercentOfTotal, tmpfsPercentOfRam } from './systemStatsFormat';

/** i18n stub: echo the key (labels are not asserted, only numeric formatting). */
const tStub = ((key: string) => key) as unknown as TFunction;

/** Match the full numeric row even when its percent has a colored child span. */
const rowText = (expected: string | RegExp) => (_content: string, element: Element | null) =>
  element?.getAttribute('dir') === 'ltr' &&
  (typeof expected === 'string' ? element.textContent === expected : expected.test(element.textContent ?? ''));

const POLL_INTERVAL_MS = 5000;

const fetchMock = vi.mocked(authenticatedFetch);

/** Build a stats payload distinguishable per call so updates are observable. */
function statsPayload(cpu: number, memPercent = 50) {
  return {
    cpu: { percent: cpu },
    memory: { usedBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, percent: memPercent },
  };
}

/** A `Response`-like object the hook reads via `.ok` / `.status` / `.json()`. */
function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function statusResponse(status: number) {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

/** Flush pending microtasks (resolves an already-settled fetch promise chain). */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Advance fake time by whole poll intervals, flushing async work between ticks. */
async function advanceIntervals(count: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * count);
  });
}

/** Set tab visibility and (optionally) emit the visibilitychange event. */
function setHidden(hidden: boolean, emit = true) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  if (emit) {
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  // Default: every poll succeeds with a fresh, identifiable payload.
  let n = 0;
  fetchMock.mockImplementation(async () => okResponse(statsPayload(10 + n++)));
  setHidden(false, false);
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('useSystemStats', () => {
  // (a) First fetch populates stats with the returned value.
  it('populates stats from the first fetch', async () => {
    const { result } = renderHook(() => useSystemStats());

    expect(result.current).toBeNull(); // nothing resolved yet
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/system/stats', expect.any(Object));
    expect(result.current).toEqual(statsPayload(10));
  });

  // (b) Freeze guard (9ef40b8): polling continues over multiple intervals and
  //     the surfaced value keeps updating.
  it('keeps polling across intervals and updates the value', async () => {
    const { result } = renderHook(() => useSystemStats());
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual(statsPayload(10));

    await advanceIntervals(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual(statsPayload(11));

    await advanceIntervals(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual(statsPayload(12));
  });

  // (c) StrictMode discriminator (9ef40b8 + B-75): mount → cleanup → remount
  //     with a request still in flight must neither freeze nor double the rate.
  //     Fails on the old cancelledRef impl; passes on effect-scoped locals.
  it('survives a StrictMode remount mid-flight without freezing or doubling the poll rate', async () => {
    // Make the FIRST request hang so it is still in flight when StrictMode
    // tears the first mount down and remounts. Later requests resolve normally.
    let releaseFirst!: () => void;
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let call = 0;
    fetchMock.mockImplementation(async () => {
      const i = call++;
      if (i === 0) {
        await firstInFlight; // pending across the remount
      }
      return okResponse(statsPayload(20 + i));
    });

    const { result } = renderHook(() => useSystemStats(), { wrapper: StrictMode });

    // StrictMode has now run mount → cleanup → remount. The first mount's
    // request is parked on `firstInFlight`; release it (it belongs to an
    // aborted closure and must NOT re-arm the live mount's timer).
    releaseFirst();
    await flushMicrotasks();

    // Capture the call count established by mounting, then measure the cadence
    // over several intervals. A single live loop adds exactly one fetch each.
    const afterMount = fetchMock.mock.calls.length;

    await advanceIntervals(1);
    const afterOne = fetchMock.mock.calls.length;
    await advanceIntervals(1);
    const afterTwo = fetchMock.mock.calls.length;
    await advanceIntervals(1);
    const afterThree = fetchMock.mock.calls.length;

    const perInterval1 = afterOne - afterMount;
    const perInterval2 = afterTwo - afterOne;
    const perInterval3 = afterThree - afterTwo;

    // Not frozen: each interval performs at least one fetch.
    expect(perInterval1).toBeGreaterThanOrEqual(1);
    // Single rate, not doubled: exactly one fetch per interval on the live loop.
    expect(perInterval1).toBe(1);
    expect(perInterval2).toBe(1);
    expect(perInterval3).toBe(1);

    // And the hook is live — it surfaces a fresh value.
    expect(result.current).not.toBeNull();
  });

  // (d) A 404 stops polling permanently — no fetch fires afterwards.
  it('stops polling permanently after a 404', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(statusResponse(404));

    const { result } = renderHook(() => useSystemStats());
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull(); // 404 leaves stats untouched

    await advanceIntervals(5);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never polled again
  });

  // (e) Hidden tab performs no fetch on its scheduled tick; returning resumes
  //     immediately.
  it('skips fetching while hidden and resumes on return', async () => {
    const { result } = renderHook(() => useSystemStats());
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Hide WITHOUT emitting the event, so only the scheduled tick observes it.
    setHidden(true, false);
    await advanceIntervals(1);
    // The tick saw document.hidden → it reschedules without fetching.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advanceIntervals(2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still parked while hidden

    // Return to foreground and emit visibilitychange → immediate fetch.
    setHidden(false, true);
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current).not.toBeNull();
  });

  // (f) Unmount aborts and cleans up: no fetch afterwards, no act/setState noise.
  it('aborts and stops on unmount with no further fetches', async () => {
    const { unmount } = renderHook(() => useSystemStats());
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();

    await advanceIntervals(5);
    expect(fetchMock).toHaveBeenCalledTimes(1); // dead after unmount

    // The signal passed to fetch must have been aborted by cleanup.
    const passedOptions = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(passedOptions.signal?.aborted).toBe(true);
  });
});

/**
 * Display contract for the two rendered variants:
 *   • B-77 — memory percent is shown verbatim at the one decimal the API ships
 *     (round1); the old `Math.round` that flattened it to an integer is gone.
 *   • B-79 — every numeric value span carries dir="ltr", so under `<html dir=
 *     "rtl">` the Latin/number/paren string ("RAM x/yGB (z%)") is never visually
 *     reordered by the bidi algorithm (isolation via the index.css safety net).
 */
describe('SystemStats display (B-77 precision + B-79 bidi isolation)', () => {
  /** Fixed payload: memory percent with a non-zero tenth so rounding is visible. */
  function fixedStats() {
    return {
      cpu: { percent: 1.5 },
      memory: { usedBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, percent: 63.4 },
    };
  }

  beforeEach(() => {
    // الذيل صار مطوياً افتراضياً (طلب المالك)؛ هذه الاختبارات تخصّ الصفوف
    // المفتوحة، فتفتحه صراحةً بدل الاعتماد على الافتراضي.
    localStorage.setItem('nassaj.systemStats.collapsed', '0');
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okResponse(fixedStats()));
  });

  it('footer keeps the memory tenth and isolates every value span as dir=ltr', async () => {
    render(<SystemStatsFooter t={tStub} />);
    await flushMicrotasks();

    // B-77: 63.4% survives — it is NOT collapsed to an integer 63%.
    const ramSpans = screen.getAllByText(rowText(/^RAM .*\(63\.4%\)$/));
    expect(ramSpans.length).toBeGreaterThan(0);
    for (const el of ramSpans) {
      expect(el.textContent).toContain('63.4%');
      expect(el.textContent).not.toContain('(63%)');
      expect(el.getAttribute('dir')).toBe('ltr'); // B-79
    }

    // CPU value spans render (2 decimals) and are likewise isolated.
    const cpuSpans = screen.getAllByText(rowText(/^CPU 1\.50%$/));
    expect(cpuSpans.length).toBeGreaterThan(0);
    for (const el of cpuSpans) {
      expect(el.getAttribute('dir')).toBe('ltr'); // B-79
    }
  });

  it('collapsed rail shows one-decimal memory with dir=ltr value spans', async () => {
    render(<SystemStatsCollapsed t={tStub} />);
    await flushMicrotasks();

    const ram = screen.getByText('63.4%'); // B-77: one decimal, not "63%"
    expect(ram.getAttribute('dir')).toBe('ltr'); // B-79

    const cpu = screen.getByText('1.50%');
    expect(cpu.getAttribute('dir')).toBe('ltr'); // B-79
  });
});

describe('SystemStats storage display', () => {
  const withStorage = {
    cpu: { percent: 1.5 },
    memory: { usedBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, percent: 50 },
    storage: { usedBytes: 40 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, percent: 40.2 },
  };

  beforeEach(() => {
    localStorage.setItem('nassaj.systemStats.collapsed', '0');
    fetchMock.mockReset();
  });

  it('يعرض سطر DISK بعد RAM مع عزل اتجاه القيمة', async () => {
    fetchMock.mockResolvedValue(okResponse(withStorage));
    const { container } = render(<SystemStatsFooter t={tStub} />);
    await flushMicrotasks();

    const ram = screen.getByText(rowText(/^RAM /));
    const disk = screen.getByText(rowText('DISK 40.0/100.0GB (40.2%)'));
    expect(disk.getAttribute('dir')).toBe('ltr');
    expect(ram.compareDocumentPosition(disk) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    const sparkTitles = Array.from(container.querySelectorAll('title')).map(node => node.textContent);
    expect(sparkTitles).toContain('systemStats.storageUsage: 40.0/100.0GB (40.2%)');
  });

  it('يعرض النسبة في السكة المطوية وتفاصيل السعة في التلميح', async () => {
    fetchMock.mockResolvedValue(okResponse(withStorage));
    render(<SystemStatsCollapsed t={tStub} />);
    await flushMicrotasks();

    const percent = screen.getByText('40.2%');
    expect(percent.getAttribute('dir')).toBe('ltr');
    expect(percent.parentElement?.getAttribute('title')).toBe(
      'systemStats.storageUsage: 40.0/100.0GB (40.2%)',
    );
    expect(percent.parentElement?.getAttribute('aria-label')).toBe(
      'systemStats.storageUsage: 40.0/100.0GB (40.2%)',
    );
  });

  it('يخفي السطر والمسرب وأيقونة السكة حين يغيب storage', async () => {
    fetchMock.mockResolvedValue(okResponse(statsPayload(1.5)));
    const footer = render(<SystemStatsFooter t={tStub} />);
    await flushMicrotasks();
    expect(screen.queryByText(rowText(/^DISK /))).toBeNull();
    expect(Array.from(footer.container.querySelectorAll('title')).map(node => node.textContent))
      .not.toContain(expect.stringContaining('systemStats.storageUsage'));
    footer.unmount();

    render(<SystemStatsCollapsed t={tStub} />);
    await flushMicrotasks();
    expect(screen.queryByLabelText('systemStats.storageUsage')).toBeNull();
  });
});

/**
 * ‏swap والمسارات التي تعيش في الذاكرة (T-1134).
 *
 * أُضيفا بعد حادثة 29–31 يوليو 2026: بقي `/tmp` حاملاً 3.3GB من الذاكرة خمساً
 * وأربعين ساعة، وswap ممتلئاً منذ 36 ساعة، والذيل يعرض CPU وRAM وحدهما — فسقط
 * الجهاز بلا إنذار مرئي. الحدّ المختبَر: يظهران حين يرسلهما الخادم، **ويختفيان
 * بلا أصفار ملفَّقة** حين لا يرسلهما (خادم أقدم من المسار الموسَّع).
 */
describe('SystemStatsFooter — swap و tmpfs', () => {
  const withHost = (extra: Record<string, unknown>) => ({
    cpu: { percent: 1.5 },
    memory: { usedBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, percent: 50 },
    ...extra,
  });

  beforeEach(() => {
    localStorage.setItem('nassaj.systemStats.collapsed', '0');
    fetchMock.mockReset();
  });

  it('heaviestTmpfs يختار الأثقل لا الأول — الصفّ موجود ليُنذر', () => {
    expect(
      heaviestTmpfs([
        { mount: '/dev/shm', usedMb: 2, sizeMb: 5120 },
        { mount: '/tmp', usedMb: 3300, sizeMb: 5120 },
      ])?.mount,
    ).toBe('/tmp');
    expect(heaviestTmpfs([])).toBeNull();
    expect(heaviestTmpfs(undefined)).toBeNull();
  });

  it('tmpfsPercentOfRam ينسب إلى ذاكرة الجهاز لا إلى سعة المسار', () => {
    // 3.3GB من صندوق بعشرة غيغابايت = ثلث الجهاز، لا «64% من سعة 5.1GB».
    expect(tmpfsPercentOfRam(3300, 10332)).toBeCloseTo(31.9, 1);
    expect(tmpfsPercentOfRam(102, 10332)).toBeCloseTo(1.0, 1);
    expect(tmpfsPercentOfRam(100, 0)).toBeNull();
    expect(tmpfsPercentOfRam(Number.NaN, 10332)).toBeNull();
  });

  it('يعرض swap و/tmp حين يرسلهما الخادم', async () => {
    fetchMock.mockResolvedValue(
      okResponse(
        withHost({
          swap: { usedMb: 1670, totalMb: 1675 },
          tmpfs: [{ mount: '/tmp', usedMb: 3300, sizeMb: 5120 }],
        }),
      ),
    );
    render(<SystemStatsFooter t={tStub} />);
    await flushMicrotasks();

    expect(screen.getAllByText(rowText(/^SWAP 1\.6GB\/1\.6GB \(99\.7%\)$/)).length).toBeGreaterThan(0);
    // المقام ظاهر: 3.2GB من ذاكرة 8GB في هذه العيّنة = 40.3%
    expect(screen.getAllByText(rowText(/^\/tmp 3\.2GB \(40\.3%\)$/)).length).toBeGreaterThan(0);
  });

  it('يُخفي الصفّين حين لا يرسلهما الخادم — لا أصفار ملفَّقة', async () => {
    fetchMock.mockResolvedValue(okResponse(withHost({})));
    render(<SystemStatsFooter t={tStub} />);
    await flushMicrotasks();

    expect(screen.queryByText(rowText(/^SWAP/))).toBeNull();
    expect(screen.queryByText(rowText(/^\/tmp/))).toBeNull();
    // ‏CPU وRAM يبقيان كما هما
    expect(screen.getAllByText(rowText(/^CPU /)).length).toBeGreaterThan(0);
  });
});

/**
 * حالة العتاد الثلاثية والطيّ (طلب المالك 2026-07-31).
 *
 * الحدّ المختبَر: **أسوأ مقياس يحكم**. متوسّطُ المقاييس يُخفي الحرج تماماً —
 * جهازٌ معالجه خامل وذاكرته على وشك النفاد ليس «متوسّطاً».
 */
describe('resolveLoadLevel', () => {
  const base = {
    cpuPercent: 1,
    memPercent: 20,
    swapUsedMb: 0,
    swapTotalMb: 1675,
    tmpfsPercent: 1,
    storagePercent: 10,
  };

  it('كل شيء هادئ ⇒ منخفض', () => {
    expect(resolveLoadLevel(base)).toBe('low');
  });

  it('مقياس واحد حرج يرفع الحالة إلى عالٍ ولو كان الباقي خاملاً', () => {
    expect(resolveLoadLevel({ ...base, memPercent: 86 })).toBe('high');
    expect(resolveLoadLevel({ ...base, cpuPercent: 95 })).toBe('high');
    expect(resolveLoadLevel({ ...base, swapUsedMb: 1590 })).toBe('high'); // 94.9% كما قيس قبل السقوط
    expect(resolveLoadLevel({ ...base, tmpfsPercent: 31.9 })).toBe('high'); // حجم الحادثة
    expect(resolveLoadLevel({ ...base, storagePercent: 90 })).toBe('high');
  });

  it('المنطقة الوسطى تُصنَّف متوسطاً', () => {
    expect(resolveLoadLevel({ ...base, memPercent: 70 })).toBe('medium');
    expect(resolveLoadLevel({ ...base, cpuPercent: 65 })).toBe('medium');
    expect(resolveLoadLevel({ ...base, tmpfsPercent: 6 })).toBe('medium');
    expect(resolveLoadLevel({ ...base, storagePercent: 80 })).toBe('medium');
    expect(resolveLoadLevel({ ...base, storagePercent: 89.9 })).toBe('medium');
    expect(resolveLoadLevel({ ...base, storagePercent: 79.9 })).toBe('low');
  });

  it('القيم الغائبة لا تُصنَّف حرجاً ولا تُسقط الدالّة', () => {
    expect(
      resolveLoadLevel({
        cpuPercent: null,
        memPercent: null,
        tmpfsPercent: null,
        storagePercent: null,
      }),
    ).toBe('low');
  });
});

describe('SystemStatsFooter — الطيّ', () => {
  const payload = {
    cpu: { percent: 1.5 },
    memory: { usedBytes: 4 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, percent: 50 },
    swap: { usedMb: 100, totalMb: 1675 },
    tmpfs: [{ mount: '/tmp', usedMb: 100, sizeMb: 5120 }],
  };

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okResponse(payload));
  });

  it('يبدأ مطوياً فيعرض الحالة وحدها لا الصفوف', async () => {
    render(<SystemStatsFooter t={tStub} />);
    await flushMicrotasks();
    expect(screen.getAllByText(/systemStats\.loadLabel/).length).toBeGreaterThan(0);
    expect(screen.queryByText(rowText(/^CPU /))).toBeNull();
    expect(screen.queryByText(rowText(/^SWAP/))).toBeNull();
  });

  it('الضغط يفتحه فتظهر الصفوف الأربعة', async () => {
    render(<SystemStatsFooter t={tStub} />);
    await flushMicrotasks();
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.getAllByText(rowText(/^CPU /)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(rowText(/^RAM /)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(rowText(/^SWAP /)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(rowText(/^\/tmp /)).length).toBeGreaterThan(0);
  });

  it('يتذكّر حالة الطيّ بعد إعادة التركيب', async () => {
    const first = render(<SystemStatsFooter t={tStub} />);
    await flushMicrotasks();
    fireEvent.click(screen.getAllByRole('button')[0]); // فتح
    first.unmount();

    render(<SystemStatsFooter t={tStub} />);
    await flushMicrotasks();
    expect(screen.getAllByText(rowText(/^CPU /)).length).toBeGreaterThan(0);
  });
});


describe('SystemStats resource percentage colors (T-1781)', () => {
  const payload = {
    cpu: { percent: 0.87 },
    memory: { usedBytes: 3276 * 1024 ** 2, totalBytes: 10342 * 1024 ** 2, percent: 31.9 },
    storage: { usedBytes: 150.4 * 1024 ** 3, totalBytes: 166.6 * 1024 ** 3, percent: 90.3 },
    swap: { usedMb: 2662, totalMb: 4198 },
    tmpfs: [{ mount: '/tmp', usedMb: 96, sizeMb: 5120 }],
  };

  beforeEach(() => {
    localStorage.setItem('nassaj.systemStats.collapsed', '0');
    fetchMock.mockResolvedValue(okResponse(payload));
  });

  it('colors each percentage like its own bar and keeps capacities and punctuation neutral', async () => {
    const { container } = render(<SystemStatsFooter t={tStub} />);
    await flushMicrotasks();
    for (const [text, color] of [
      ['0.87%', 'emerald'], ['31.9%', 'emerald'], ['90.3%', 'red'],
      ['63.4%', 'amber'], ['0.9%', 'emerald'],
    ]) {
      const percent = screen.getByText(text);
      expect(percent.classList.contains(`text-${color}-500`)).toBe(true);
      expect(percent.parentElement?.className).toBe('text-[11px] tabular-nums');
      expect(percent.parentElement?.getAttribute('dir')).toBe('ltr');
    }
    expect(screen.getByText(rowText('SWAP 2.6GB/4.1GB (63.4%)'))).toBeTruthy();
    expect(Array.from(container.querySelectorAll('title')).map(node => node.textContent))
      .toContain('systemStats.swapUsage: 2.6GB/4.1GB (63.4%)');
    expect(container.querySelector('.text-amber-600')).toBeNull();
  });

  it('colors the existing collapsed rail percentages by resource', async () => {
    render(<SystemStatsCollapsed t={tStub} />);
    await flushMicrotasks();
    expect(screen.getByText('0.87%').classList.contains('text-emerald-500')).toBe(true);
    expect(screen.getByText('31.9%').classList.contains('text-emerald-500')).toBe(true);
    expect(screen.getByText('90.3%').classList.contains('text-red-500')).toBe(true);
  });

  it.each([[0, 0], [1, -1], [Number.NaN, 100], [1, Number.POSITIVE_INFINITY], [-1, 100]])(
    'omits unavailable swap percentages (%s / %s)', async (usedMb, totalMb) => {
      fetchMock.mockResolvedValue(okResponse({ ...payload, swap: { usedMb, totalMb } }));
      const { container } = render(<SystemStatsFooter t={tStub} />);
      await flushMicrotasks();
      expect(screen.getByText(rowText(/^SWAP /)).textContent).not.toContain('%');
      expect(container.textContent).not.toMatch(/NaN|Infinity/);
      const swapTitle = Array.from(container.querySelectorAll('title'))
        .find(node => node.textContent?.startsWith('systemStats.swapUsage:'));
      expect(swapTitle).toBeUndefined();
    },
  );

  it('uses raw swap units and preserves valid zero use', () => {
    expect(swapPercentOfTotal(2662, 4198)?.toFixed(1)).toBe('63.4');
    expect(swapPercentOfTotal(0, 4198)).toBe(0);
    expect(swapPercentOfTotal(Number.MAX_VALUE, Number.MIN_VALUE)).toBeNull();
  });
});
