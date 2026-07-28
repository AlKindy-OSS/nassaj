/**
 * Unit tests for useActiveWorkflows (B-103, ADR-053 M4).
 *
 * يُثبت ثلاثة ضمانات سلوكية حرجة في driver hook الخلفي:
 *
 *   1. single-flight — نداءات متزامنة على fetchNow لا تتراكب أبداً؛
 *      جميع إشارات scheduleRefetch() الواردة أثناء رحلة طلب تتدمج في
 *      طلب واحد لاحق عند الاستقرار (pendingWake boolean dedup).
 *
 *   2. quiesce — بعد استجابة فارغة + غير-capped تتوقف دورة الـpoll تماماً
 *      (quiet=true ⇒ schedulePoll ترجع فوراً) دون مزيد من الطلبات.
 *
 *   3. stop when hidden — عندما document.hidden=true لا يُجرى أي طلب في
 *      الإعداد الأوّلي؛ عودة الـvisibility تُشغّل wake → fetch فوراً.
 *
 * أشكال البيانات مطابقة لعقد الـendpoint الفعلي لا fixtures ملفّقة.
 * يتبع نمط SystemStats.test.tsx الثابت (fake timers + renderHook + act).
 *
 * Run: npm run test:client -- src/stores/useActiveWorkflows.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock the network boundary before importing the hook.
// The hook imports `api` from '../utils/api'.
vi.mock('../utils/api', () => ({
  api: {
    providers: {
      activeWorkflows: vi.fn(),
    },
  },
}));

import { api } from '../utils/api';
import { useActiveWorkflows, WORKFLOW_POLL_INTERVAL_MS, WORKFLOW_REFETCH_DEBOUNCE_MS } from './useActiveWorkflows';
import { __resetWorkflowStatusStore } from './workflowStatusStore';
import type { ActiveWorkflowsEnvelope } from './workflowStatus';

// ---------------------------------------------------------------------------
// Typed mock reference
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeWorkflowsMock = vi.mocked((api as any).providers.activeWorkflows as (...args: unknown[]) => Promise<Response>);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a real endpoint envelope. */
function makeEnvelope(
  workflows: ActiveWorkflowsEnvelope['workflows'] = [],
  scanned = 1,
  capped = false,
): ActiveWorkflowsEnvelope {
  return { workflows, eligible: scanned, scanned, capped };
}

/** Response-like mock for a successful non-empty result. */
function okResponse(body: ActiveWorkflowsEnvelope) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Flush microtasks enough to settle a fetch + json() chain. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve(); // extra tick for the pendingWake path
  });
}

/** Advance fake time and flush async work between ticks. */
async function advanceMs(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Stamp document.hidden and optionally emit visibilitychange. */
function setHidden(hidden: boolean, emit = true) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  if (emit) {
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const emptyEnvelope = makeEnvelope([], 0, false);

beforeEach(() => {
  vi.useFakeTimers();
  activeWorkflowsMock.mockReset();
  __resetWorkflowStatusStore();
  setHidden(false, false);
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  setHidden(false, false);
  __resetWorkflowStatusStore();
});

// ---------------------------------------------------------------------------
// Test 1 — single-flight: concurrent refetch signals collapse into one request
// ---------------------------------------------------------------------------

describe('useActiveWorkflows — single-flight', () => {
  it('multiple scheduleRefetch() calls while a fetch is in-flight produce at most one additional fetch', async () => {
    // Phase 1: First fetch hangs (in-flight).
    let resolveFirst!: (r: Response) => void;
    const firstPending = new Promise<Response>((r) => {
      resolveFirst = r;
    });

    let callCount = 0;
    activeWorkflowsMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return firstPending; // stays in flight
      }
      return Promise.resolve(okResponse(emptyEnvelope));
    });

    const { result } = renderHook(() => useActiveWorkflows(true));
    // Initial fetchNow fired synchronously in effect.
    await flushMicrotasks();
    expect(callCount).toBe(1); // first fetch in flight

    // Phase 2: three scheduleRefetch() calls — each resets the debounce timer,
    // so only ONE debounced wake fires after WORKFLOW_REFETCH_DEBOUNCE_MS.
    result.current.scheduleRefetch();
    result.current.scheduleRefetch();
    result.current.scheduleRefetch();

    // Advance past debounce — wake() fires once, inFlight=true => pendingWake=true.
    await advanceMs(WORKFLOW_REFETCH_DEBOUNCE_MS + 50);

    // Still only 1 fetch (wake was parked on pendingWake, not double-fired).
    expect(callCount).toBe(1);

    // Phase 3: resolve the first fetch — pendingWake fires exactly one more fetch.
    resolveFirst(okResponse(emptyEnvelope));
    await flushMicrotasks();

    // Total: 2 (initial + one coalesced), NOT 4 (initial + 3 concurrent).
    expect(callCount).toBe(2);
  });

  it('a second immediate scheduleRefetch while in-flight does not bypass the guard', async () => {
    let callCount = 0;
    let resolveFirst!: (r: Response) => void;

    activeWorkflowsMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise<Response>((r) => { resolveFirst = r; });
      }
      return Promise.resolve(okResponse(emptyEnvelope));
    });

    const { result } = renderHook(() => useActiveWorkflows(true));
    await flushMicrotasks();
    expect(callCount).toBe(1);

    // Trigger debounced refetch and let it fire — still in-flight.
    result.current.scheduleRefetch();
    await advanceMs(WORKFLOW_REFETCH_DEBOUNCE_MS + 50);

    // pendingWake is set, but NO new fetch yet.
    expect(callCount).toBe(1);

    // Trigger again — pendingWake is already true; still no new fetch.
    result.current.scheduleRefetch();
    await advanceMs(WORKFLOW_REFETCH_DEBOUNCE_MS + 50);
    expect(callCount).toBe(1);

    resolveFirst(okResponse(emptyEnvelope));
    await flushMicrotasks();
    // Exactly one follow-up fetch (pendingWake deduplicated).
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — quiesce: poll stops when envelope is empty and not capped
// ---------------------------------------------------------------------------

describe('useActiveWorkflows — quiesce at zero', () => {
  it('after empty + not-capped response no further poll fires', async () => {
    let callCount = 0;
    activeWorkflowsMock.mockImplementation(() => {
      callCount++;
      return Promise.resolve(okResponse(emptyEnvelope));
    });

    renderHook(() => useActiveWorkflows(true));
    await flushMicrotasks();

    // First fetch: empty + not capped => quiet=true, schedulePoll returns early.
    expect(callCount).toBe(1);

    // Advance several full poll intervals — no new fetch should fire.
    await advanceMs(WORKFLOW_POLL_INTERVAL_MS * 5);
    expect(callCount).toBe(1); // still only the initial fetch
  });

  it('with capped=true the poll keeps running even when workflows list is empty', async () => {
    let callCount = 0;
    activeWorkflowsMock.mockImplementation(() => {
      callCount++;
      return Promise.resolve(okResponse(makeEnvelope([], 200, true))); // capped
    });

    renderHook(() => useActiveWorkflows(true));
    await flushMicrotasks();
    expect(callCount).toBe(1);

    // Advance 2 full intervals — quiet stays false because capped=true.
    await advanceMs(WORKFLOW_POLL_INTERVAL_MS * 2 + 100);
    expect(callCount).toBeGreaterThanOrEqual(2); // still polling
  });
});

// ---------------------------------------------------------------------------
// Test 3 — stop when document.hidden
// ---------------------------------------------------------------------------

describe('useActiveWorkflows — stop when document.hidden', () => {
  it('initial fetch is skipped when tab is already hidden on mount', async () => {
    setHidden(true, false); // hidden before mount, no event

    let callCount = 0;
    activeWorkflowsMock.mockImplementation(() => {
      callCount++;
      return Promise.resolve(okResponse(emptyEnvelope));
    });

    renderHook(() => useActiveWorkflows(true));
    await flushMicrotasks();

    // fetchNow() checks document.hidden at entry and returns early.
    expect(callCount).toBe(0);
  });

  it('hidden tab does not poll on the scheduled tick; revealing the tab resumes immediately', async () => {
    let callCount = 0;
    activeWorkflowsMock.mockImplementation(() => {
      callCount++;
      return Promise.resolve(okResponse(makeEnvelope([{
        sessionId: 's1',
        wfId: 'wf_x',
        status: 'running',
        agents: [],
        agentsTruncated: false,
        agentsDone: 0,
        agentsTotal: 5,
        updatedAt: null,
      }]))); // non-empty so quiet stays false
    });

    renderHook(() => useActiveWorkflows(true));
    await flushMicrotasks();

    // First fetch happened while visible.
    expect(callCount).toBe(1);

    // Hide WITHOUT emitting event — the scheduled poll tick sees document.hidden.
    setHidden(true, false);
    await advanceMs(WORKFLOW_POLL_INTERVAL_MS * 3);
    // The poll timer still fires but fetchNow() returns early on document.hidden.
    expect(callCount).toBe(1); // no additional fetches while hidden

    // Return to foreground and emit visibilitychange → wake() → fetchNow().
    setHidden(false, true);
    await flushMicrotasks();
    expect(callCount).toBe(2); // immediate fetch on visibility return
  });
});
