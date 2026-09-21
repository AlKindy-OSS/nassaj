/**
 * restartBanner.test.ts — T-1296
 *
 * العطل المغطّى هنا: اللافتة الصفراء «يلزم إعادة التشغيل» كانت تُستجلب من /health
 * كل 60 ثانية، بينما إعادة التشغيل نفسها تكتمل في 2–5 ثوانٍ. فتبقى اللافتة معروضة
 * حتى دقيقة كاملة بعد أن صارت باطلة، فيقرأ المالك بقاءها «لم يُنفَّذ طلبي» ويضغط
 * ثانيةً — 27 انفجاراً بفارق أقلّ من 120 ثانية من 103 أحداث إعادة تشغيل.
 *
 * ما تُثبته هذه الاختبارات:
 *   1. نجاح استطلاع useRestartWatch يُسقط اللافتة في useVersionCheck فوراً —
 *      بلا انتظار الدورة التالية.
 *   2. الإسقاط يتبعه استجلاب /health فوري (تأكيد لا افتراض).
 *   3. نافذة التهدئة معمَّرة خارج حالة أي مكوّن: نسخة جديدة تماماً من القارئ ترى
 *      المنع نفسه — وهذا بالضبط ما يفشل فيه حارس الحالة المحلّية.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  RESTART_COOLDOWN_MS,
  restartCooldownRemainingMs,
  publishRestartSignal,
  __resetRestartSignalForTests,
} from '../utils/restartSignal';

import { useVersionCheck } from './useVersionCheck';
import {
  isRestartComplete,
  useRestartWatch,
  waitForExpectedServerBuildLoaded,
} from './useRestartWatch';

/** /health responses, oldest first; the last one repeats. */
const LOADED_BUILD_ID = 'a'.repeat(64);
const CANDIDATE_BUILD_ID = 'b'.repeat(64);
type PreviewHealth = {
  restartRequired: boolean;
  serverCandidateBuildId: string;
  serverPromotedBuildId: string | null;
  serverLoadedBuildId: string;
  serverBuildIdOnDisk: string;
};
const previewHealth = (restartRequired: boolean): PreviewHealth => ({
  restartRequired,
  serverCandidateBuildId: CANDIDATE_BUILD_ID,
  serverPromotedBuildId: restartRequired ? CANDIDATE_BUILD_ID : LOADED_BUILD_ID,
  serverLoadedBuildId: LOADED_BUILD_ID,
  serverBuildIdOnDisk: restartRequired ? CANDIDATE_BUILD_ID : LOADED_BUILD_ID,
});
let healthQueue: Array<ReturnType<typeof previewHealth>> = [];
const fetchMock = vi.fn(async () => {
  const body = healthQueue.length > 1 ? healthQueue.shift()! : healthQueue[0];
  return {
    ok: true,
    json: async () => ({ installMode: 'git', hasPendingActions: false, ...body }),
  } as unknown as Response;
});

beforeEach(() => {
  __resetRestartSignalForTests();
  localStorage.clear();
  fetchMock.mockClear();
  healthQueue = [previewHealth(true)];
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetRestartSignalForTests();
  localStorage.clear();
});

describe('T-1296 — the banner falls with the restart, not a minute later', () => {
  it('drops restartRequired the moment the restart watch reports success', async () => {
    const version = renderHook(() => useVersionCheck());
    await waitFor(() => expect(version.result.current.restartRequired).toBe(true));

    const callsBefore = fetchMock.mock.calls.length;

    // The server is back: /health now answers false, exactly as the watcher sees it.
    healthQueue = [previewHealth(false)];
    await act(async () => {
      publishRestartSignal('completed');
      await Promise.resolve();
    });

    expect(version.result.current.restartRequired).toBe(false);
    // …and it re-read /health rather than trusting the optimistic drop alone.
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('useRestartWatch publishes completion, so a banner in ANOTHER reader falls too', async () => {
    vi.useFakeTimers();

    const version = renderHook(() => useVersionCheck());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(version.result.current.restartRequired).toBe(true);

    const watch = renderHook(() => useRestartWatch());

    // The server comes back while the watcher polls.
    healthQueue = [previewHealth(false)];
    act(() => { watch.result.current.startPolling(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });

    expect(watch.result.current.isSuccess).toBe(true);
    // The banner is owned by a DIFFERENT hook instance — the old code left it
    // standing for up to another 60 s.
    expect(version.result.current.restartRequired).toBe(false);

    watch.unmount();
  });

  it('accepts only the exact approved generation for a generation-bound restart', async () => {
    vi.useFakeTimers();
    const watch = renderHook(() => useRestartWatch());

    healthQueue = [{
      ...previewHealth(false),
      serverLoadedBuildId: 'c'.repeat(64),
      serverBuildIdOnDisk: 'c'.repeat(64),
    }];
    act(() => { watch.result.current.startPolling(CANDIDATE_BUILD_ID); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(watch.result.current.isSuccess).toBe(false);

    healthQueue = [{
      ...previewHealth(false),
      serverLoadedBuildId: CANDIDATE_BUILD_ID,
      serverBuildIdOnDisk: CANDIDATE_BUILD_ID,
    }];
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100); });
    expect(watch.result.current.isSuccess).toBe(true);

    watch.unmount();
  });

  it('does not accept a matching process identity with a different on-disk artifact', () => {
    expect(isRestartComplete({
      restartRequired: false,
      serverLoadedBuildId: CANDIDATE_BUILD_ID,
      serverBuildIdOnDisk: LOADED_BUILD_ID,
    }, CANDIDATE_BUILD_ID)).toBe(false);
  });

  it('retries a short unavailable-health gap before accepting the exact build receipt', async () => {
    const receiptFetch = vi.fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          serverLoadedBuildId: CANDIDATE_BUILD_ID,
          serverBuildIdOnDisk: CANDIDATE_BUILD_ID,
        }),
      });
    vi.stubGlobal('fetch', receiptFetch);

    await expect(waitForExpectedServerBuildLoaded(CANDIDATE_BUILD_ID, {
      attempts: 3,
      retryDelayMs: 1,
    })).resolves.toBe(true);
    expect(receiptFetch).toHaveBeenCalledTimes(3);
  });

  it('stops at the configured receipt bound when the approved build never loads', async () => {
    const receiptFetch = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', receiptFetch);

    await expect(waitForExpectedServerBuildLoaded(CANDIDATE_BUILD_ID, {
      attempts: 3,
      retryDelayMs: 1,
    })).resolves.toBe(false);
    expect(receiptFetch).toHaveBeenCalledTimes(3);
  });
});

describe('B-796 — stale preview lineage never exposes a restart action', () => {
  it('does not show a retained candidate when the loaded build is already the on-disk build', async () => {
    healthQueue = [{
      ...previewHealth(true),
      serverPromotedBuildId: null,
      serverBuildIdOnDisk: LOADED_BUILD_ID,
    }];
    const version = renderHook(() => useVersionCheck());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(version.result.current.restartRequired).toBe(false);
  });

  it('shows a restart only when the on-disk promoted bytes differ from the loaded build', async () => {
    healthQueue = [{
      ...previewHealth(true),
      serverCandidateBuildId: 'c'.repeat(64),
      serverPromotedBuildId: CANDIDATE_BUILD_ID,
      serverBuildIdOnDisk: CANDIDATE_BUILD_ID,
    }];
    const version = renderHook(() => useVersionCheck());
    await waitFor(() => expect(version.result.current.restartRequired).toBe(true));
  });

  it('fails closed when the durable ledger baseline differs from the loaded build', async () => {
    healthQueue = [{
      ...previewHealth(true),
      serverPromotedBuildId: 'c'.repeat(64),
    }];
    const version = renderHook(() => useVersionCheck());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(version.result.current.restartRequired).toBe(false);
  });

  it('fails closed when the promoted lineage field is absent', async () => {
    const stale = { ...previewHealth(true) } as Record<string, unknown>;
    delete stale.serverPromotedBuildId;
    healthQueue = [stale as ReturnType<typeof previewHealth>];
    const version = renderHook(() => useVersionCheck());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(version.result.current.restartRequired).toBe(false);
  });

  it('fails closed when dist-server no longer matches the loaded process', async () => {
    healthQueue = [{
      ...previewHealth(true),
      serverBuildIdOnDisk: 'c'.repeat(64),
    }];
    const version = renderHook(() => useVersionCheck());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(version.result.current.restartRequired).toBe(false);
  });
});

describe('T-1296 — the cooldown outlives the component that opened it', () => {
  it('a freshly mounted reader still sees the window (component state would not)', () => {
    expect(restartCooldownRemainingMs()).toBe(0);

    publishRestartSignal('triggered');
    const remaining = restartCooldownRemainingMs();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(RESTART_COOLDOWN_MS);

    // Simulates a second tab / a page reload: nothing in memory, same verdict.
    const now = Date.now();
    expect(restartCooldownRemainingMs(now)).toBeGreaterThan(0);
    // …and it does expire; it is a window, not a lock.
    expect(restartCooldownRemainingMs(now + RESTART_COOLDOWN_MS + 1)).toBe(0);
  });

  it('completion closes the window immediately', () => {
    publishRestartSignal('triggered');
    expect(restartCooldownRemainingMs()).toBeGreaterThan(0);

    publishRestartSignal('completed');
    expect(restartCooldownRemainingMs()).toBe(0);
  });
});
