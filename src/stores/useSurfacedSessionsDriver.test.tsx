/**
 * Unit tests for `useSurfacedSessionsDriver` (B-1431 / T-1949).
 *
 * Covers the network boundary the store-level tests
 * (surfacedSessionsStore.test.ts) deliberately stay pure of:
 *   1. a response that lands after `auth:identity-changing` never populates
 *      the store (epoch mismatch);
 *   2. 60 wanted ids split into a 50 + 10 batch pair;
 *   3. a 429/non-OK response creates no negative-cache entry and does not
 *      tight-loop retry — a cooldown parks further batches;
 *   4. re-arming the effect (props identity change) aborts the still
 *      in-flight request from the previous arming;
 *   5. repeated identical `projects_updated` broadcasts (same project-id set)
 *      do not clear — and therefore do not cause a re-fetch of — a
 *      persistent negative-cache entry.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/stores/useSurfacedSessionsDriver.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock the network boundary before importing the store — the store imports
// `api` from '../utils/api'.
vi.mock('../utils/api', () => ({
  api: { sessionContexts: vi.fn() },
  authenticatedFetch: vi.fn(),
}));

import { api } from '../utils/api';
import type { Project } from '../types/app';

import { applyOutcomeDelta, resetSessionCompletionStore } from './sessionCompletionStore';
import { resetSessionProcessStates } from './sessionProcessStateStore';
import { resetWorkflowStatusStore } from './workflowStatusStore';
import {
  useSurfacedSessionsDriver,
  computeSurfacedSessionsForProject,
  isSurfacedSessionNegativeCached,
  pruneSurfacedContextsToProjects,
  resetSurfacedSessionsStore,
  __resetSurfacedSessionsStoreForTests,
  RATE_LIMIT_COOLDOWN_MS,
} from './surfacedSessionsStore';

const sessionContextsMock = vi.mocked(
  (api as unknown as { sessionContexts: (...args: unknown[]) => Promise<Response> }).sessionContexts,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const project = (projectId: string): Project => ({ projectId, sessions: [] } as unknown as Project);

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function sessionContext(id: string, projectId: string) {
  return {
    projectId,
    provider: 'claude',
    session: { id, summary: id, createdAt: '2026-01-01T00:00:00.000Z' },
  };
}

/** Flush the microtask queue enough to settle one fetch().then().then() chain. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceMs(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  sessionContextsMock.mockReset();
  __resetSurfacedSessionsStoreForTests();
  resetSessionProcessStates();
  resetSessionCompletionStore();
  resetWorkflowStatusStore();
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  __resetSurfacedSessionsStoreForTests();
  resetSessionProcessStates();
  resetSessionCompletionStore();
  resetWorkflowStatusStore();
});

// ---------------------------------------------------------------------------

describe('useSurfacedSessionsDriver — identity race', () => {
  it('drops a response that resolves after auth:identity-changing', async () => {
    let resolveFirst!: (response: Response) => void;
    sessionContextsMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveFirst = resolve; }),
    );

    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');
    renderHook(() => useSurfacedSessionsDriver([project('p1')], new Set(['p1']), ['sessions']));

    await advanceMs(250);
    expect(sessionContextsMock).toHaveBeenCalledTimes(1);

    // Real account switch mid-flight — same reset `auth:identity-changing` fires.
    resetSurfacedSessionsStore();

    await act(async () => {
      resolveFirst(jsonResponse({ contexts: [sessionContext('s1', 'p1')] }));
    });
    await flushMicrotasks();

    // The response carried a real context, but its epoch is stale — must be dropped.
    expect(computeSurfacedSessionsForProject('p1', new Set(), null).sessions).toEqual([]);
  });
});

describe('useSurfacedSessionsDriver — batching', () => {
  it('splits 60 wanted ids into a 50 + 10 batch pair', async () => {
    sessionContextsMock.mockResolvedValue(jsonResponse({ contexts: [] }));
    for (let i = 0; i < 60; i += 1) {
      applyOutcomeDelta(`s${i}`, 'error', null, 'visible', 'p1');
    }

    renderHook(() => useSurfacedSessionsDriver([project('p1')], new Set(['p1']), ['sessions']));

    await advanceMs(250);
    await flushMicrotasks();

    expect(sessionContextsMock).toHaveBeenCalledTimes(2);
    const sizes = sessionContextsMock.mock.calls
      .map(([ids]) => (ids as string[]).length)
      .sort((a, b) => b - a);
    expect(sizes).toEqual([50, 10]);
  });
});

describe('useSurfacedSessionsDriver — 429 backoff', () => {
  it('creates no negative-cache entry and does not tight-loop retry on a 429', async () => {
    sessionContextsMock.mockResolvedValue(jsonResponse({}, false, 429));
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');

    renderHook(() => useSurfacedSessionsDriver([project('p1')], new Set(['p1']), ['sessions']));

    await advanceMs(250);
    await flushMicrotasks();

    expect(sessionContextsMock).toHaveBeenCalledTimes(1);
    expect(isSurfacedSessionNegativeCached('s1')).toBe(false);

    // A fresh indicator event during the cooldown window still schedules a
    // debounced cycle, but runFetch's cooldown gate must skip the network call.
    applyOutcomeDelta('s2', 'error', null, 'visible', 'p1');
    await advanceMs(250);
    await flushMicrotasks();
    expect(sessionContextsMock).toHaveBeenCalledTimes(1);

    // Once the cooldown elapses, the next event retries normally.
    await advanceMs(RATE_LIMIT_COOLDOWN_MS);
    applyOutcomeDelta('s3', 'error', null, 'visible', 'p1');
    await advanceMs(250);
    await flushMicrotasks();
    expect(sessionContextsMock).toHaveBeenCalledTimes(2);
  });
});

describe('useSurfacedSessionsDriver — re-arm aborts in-flight request', () => {
  it('aborts the previous batch request when the effect re-arms', async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveFirst!: (response: Response) => void;
    sessionContextsMock.mockImplementationOnce((..._args: unknown[]) => {
      const options = _args[1] as { signal?: AbortSignal } | undefined;
      capturedSignal = options?.signal;
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    });

    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');
    const { rerender } = renderHook(
      ({ expanded }: { expanded: ReadonlySet<string> }) =>
        useSurfacedSessionsDriver([project('p1')], expanded, ['sessions']),
      { initialProps: { expanded: new Set(['p1']) } },
    );

    await advanceMs(250);
    expect(sessionContextsMock).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    sessionContextsMock.mockResolvedValueOnce(jsonResponse({ contexts: [] }));
    // A new Set identity forces the effect to tear down and re-run — the
    // cleanup path must abort the request captured above.
    rerender({ expanded: new Set(['p1']) });

    expect(capturedSignal?.aborted).toBe(true);

    // The stale response resolving afterwards must not populate the store.
    await act(async () => {
      resolveFirst(jsonResponse({ contexts: [sessionContext('s1', 'p1')] }));
    });
    await flushMicrotasks();

    expect(computeSurfacedSessionsForProject('p1', new Set(), null).sessions).toEqual([]);
  });
});

describe('useSurfacedSessionsDriver — negative-cache stability', () => {
  it('repeated identical projects_updated broadcasts do not re-fetch a negative-cached id', async () => {
    sessionContextsMock.mockResolvedValue(jsonResponse({ contexts: [] }));
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');

    renderHook(() => useSurfacedSessionsDriver([project('p1')], new Set(['p1']), ['sessions']));

    await advanceMs(250);
    await flushMicrotasks();

    expect(sessionContextsMock).toHaveBeenCalledTimes(1);
    expect(isSurfacedSessionNegativeCached('s1')).toBe(true);

    // Two more broadcasts naming the SAME project set (the ~500ms live-run
    // cadence) must neither wipe the negative cache nor trigger a re-fetch.
    pruneSurfacedContextsToProjects(new Set(['p1']));
    pruneSurfacedContextsToProjects(new Set(['p1']));
    await advanceMs(1000);
    await flushMicrotasks();

    expect(isSurfacedSessionNegativeCached('s1')).toBe(true);
    expect(sessionContextsMock).toHaveBeenCalledTimes(1);
  });
});

describe('useSurfacedSessionsDriver — 429 identity race (T-1951)', () => {
  it('a 429 resolving after an identity change does not throttle the new identity', async () => {
    let resolveFirst!: (response: Response) => void;
    sessionContextsMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveFirst = resolve; }),
    );

    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');
    renderHook(() => useSurfacedSessionsDriver([project('p1')], new Set(['p1']), ['sessions']));

    await advanceMs(250);
    expect(sessionContextsMock).toHaveBeenCalledTimes(1);

    // Real account switch mid-flight — same reset `auth:identity-changing` fires.
    resetSurfacedSessionsStore();

    sessionContextsMock.mockResolvedValue(jsonResponse({ contexts: [] }));
    await act(async () => {
      resolveFirst(jsonResponse({}, false, 429));
    });
    await flushMicrotasks();

    // Without the epoch guard the stale 429 would have parked every batch for
    // RATE_LIMIT_COOLDOWN_MS — the very next debounced cycle (well inside that
    // window) must still reach the network for the new identity.
    applyOutcomeDelta('s2', 'error', null, 'visible', 'p1');
    await advanceMs(250);
    await flushMicrotasks();
    expect(sessionContextsMock).toHaveBeenCalledTimes(2);
  });
});

describe('useSurfacedSessionsDriver — cooldown recovery timer (T-1951)', () => {
  it('schedules exactly one fetch for when the cooldown elapses, with no new indicator event', async () => {
    sessionContextsMock.mockResolvedValueOnce(jsonResponse({}, false, 429));
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');

    renderHook(() => useSurfacedSessionsDriver([project('p1')], new Set(['p1']), ['sessions']));

    await advanceMs(250);
    await flushMicrotasks();
    expect(sessionContextsMock).toHaveBeenCalledTimes(1);

    sessionContextsMock.mockResolvedValue(jsonResponse({ contexts: [] }));
    // No new applyOutcomeDelta/pruneSurfacedContextsToProjects at all — recovery
    // must not depend on unrelated activity elsewhere.
    await advanceMs(RATE_LIMIT_COOLDOWN_MS);
    await flushMicrotasks();
    expect(sessionContextsMock).toHaveBeenCalledTimes(2);

    // The recovery timer fires exactly once per cooldown — it must not free-run.
    await advanceMs(RATE_LIMIT_COOLDOWN_MS);
    await flushMicrotasks();
    expect(sessionContextsMock).toHaveBeenCalledTimes(2);
  });
});

describe('useSurfacedSessionsDriver — cooldown survives effect re-init', () => {
  it('a 429 cooldown is not reset by fresh `projects` arrays re-arming the effect', async () => {
    sessionContextsMock.mockResolvedValueOnce(jsonResponse({}, false, 429));
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');

    const { rerender } = renderHook(
      ({ projects }: { projects: Project[] }) =>
        useSurfacedSessionsDriver(projects, new Set(['p1']), ['sessions']),
      { initialProps: { projects: [project('p1')] } },
    );

    await advanceMs(250);
    await flushMicrotasks();
    expect(sessionContextsMock).toHaveBeenCalledTimes(1);

    // `projects_updated` cadence during a live run (~500ms): each rerender
    // hands the driver a brand-new `projects` array reference, which is also
    // this hook's own effect dependency — every one of the four rerenders
    // below tears down and re-runs the effect exactly like the real event
    // does. A cooldown living inside that effect gets reset to 0 on each
    // re-init; the fix keeps it at module scope so it survives.
    sessionContextsMock.mockResolvedValue(jsonResponse({ contexts: [] }));
    for (let i = 0; i < 4; i += 1) {
      applyOutcomeDelta(`s${i + 2}`, 'error', null, 'visible', 'p1');
      rerender({ projects: [project('p1')] });
      await advanceMs(500);
      await flushMicrotasks();
    }

    // Still just the one (429) call — every rerender above landed inside the
    // 15s cooldown window, so none of them may have reached the network.
    expect(sessionContextsMock).toHaveBeenCalledTimes(1);

    // Once the cooldown fully elapses, the module-level recovery timer (kept
    // alive across every re-init above) fires on its own — no new indicator
    // event required (qa-critic fix, see the dedicated test below).
    await advanceMs(RATE_LIMIT_COOLDOWN_MS);
    await flushMicrotasks();
    expect(sessionContextsMock).toHaveBeenCalledTimes(2);

    // A further event after that is a perfectly normal, un-throttled cycle.
    applyOutcomeDelta('s6', 'error', null, 'visible', 'p1');
    rerender({ projects: [project('p1')] });
    await advanceMs(250);
    await flushMicrotasks();

    expect(sessionContextsMock).toHaveBeenCalledTimes(3);
  });

  it('re-arms cooldown recovery on a plain re-init with no new indicator event (qa-critic regression)', async () => {
    // The probe from the qa-critic finding itself: 429 -> ONE rerender with a
    // new `projects` array (no fresh indicator event at all) -> waiting out
    // the full cooldown must still recover exactly once. Before the fix,
    // `runFetch`'s cooldown-gate early return did not re-arm
    // `scheduleCooldownRecovery`, and the OLD effect's own recovery timer had
    // already been cleared by its cleanup on that same rerender — so nothing
    // was left armed to ever retry.
    sessionContextsMock.mockResolvedValueOnce(jsonResponse({}, false, 429));
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');

    const { rerender } = renderHook(
      ({ projects }: { projects: Project[] }) =>
        useSurfacedSessionsDriver(projects, new Set(['p1']), ['sessions']),
      { initialProps: { projects: [project('p1')] } },
    );

    await advanceMs(250);
    await flushMicrotasks();
    expect(sessionContextsMock).toHaveBeenCalledTimes(1);

    sessionContextsMock.mockResolvedValue(jsonResponse({ contexts: [] }));
    // A single re-init, mid-cooldown, with no new indicator event afterwards.
    rerender({ projects: [project('p1')] });

    await advanceMs(RATE_LIMIT_COOLDOWN_MS + 1_000);
    await flushMicrotasks();

    expect(sessionContextsMock).toHaveBeenCalledTimes(2);
  });
});
