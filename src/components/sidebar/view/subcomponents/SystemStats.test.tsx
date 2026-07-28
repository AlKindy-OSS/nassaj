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
import { renderHook, render, screen, act, cleanup } from '@testing-library/react';
import type { TFunction } from 'i18next';

// Mock the network boundary. The hook imports it as
// `../../../../utils/api` → resolves to src/utils/api.js.
import { authenticatedFetch } from '../../../../utils/api';
vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(),
}));

import { useSystemStats, SystemStatsFooter, SystemStatsCollapsed } from './SystemStats';

/** i18n stub: echo the key (labels are not asserted, only numeric formatting). */
const tStub = ((key: string) => key) as unknown as TFunction;

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
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okResponse(fixedStats()));
  });

  it('footer keeps the memory tenth and isolates every value span as dir=ltr', async () => {
    render(<SystemStatsFooter t={tStub} />);
    await flushMicrotasks();

    // B-77: 63.4% survives — it is NOT collapsed to an integer 63%.
    const ramSpans = screen.getAllByText(/^RAM .*\(63\.4%\)$/);
    expect(ramSpans.length).toBeGreaterThan(0);
    for (const el of ramSpans) {
      expect(el.textContent).toContain('63.4%');
      expect(el.textContent).not.toContain('(63%)');
      expect(el.getAttribute('dir')).toBe('ltr'); // B-79
    }

    // CPU value spans render (2 decimals) and are likewise isolated.
    const cpuSpans = screen.getAllByText(/^CPU 1\.50%$/);
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
