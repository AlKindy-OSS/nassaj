/**
 * Unit tests for `useSurfacedSessionsSignature` (B-1431/T-1949 follow-up, T-1951).
 *
 * `useSurfacedSessionsRenderTick` bumped on EVERY emit of the four stores it
 * read — including a workflow's `callCount` ticking up with no visible-row
 * impact — forcing the whole sidebar controller (and every project's
 * `computeSurfacedSessionsForProject` + sort, including collapsed projects) to
 * re-render on a change nothing on screen ever shows. This file proves the
 * replacement signature:
 *   1. stays byte-identical (no re-render) across a callCount-only workflow
 *      update for an already-tracked row;
 *   2. changes (and re-renders) when a surfaced id enters or leaves the row set.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/stores/useSurfacedSessionsSignature.test.tsx
 */
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

import { applyOutcomeDelta, resetSessionCompletionStore } from './sessionCompletionStore';
import { resetSessionProcessStates } from './sessionProcessStateStore';
import { resetWorkflowStatusStore, setActiveWorkflows } from './workflowStatusStore';
import type { ActiveWorkflow, ActiveWorkflowsEnvelope } from './workflowStatus';
import {
  applySurfacedSessionContexts,
  getSurfacedSessionsIdentityEpoch,
  useSurfacedSessionsSignature,
  __resetSurfacedSessionsStoreForTests,
} from './surfacedSessionsStore';

function workflowAgent(callCount: number) {
  return {
    agentId: 'a1',
    ordinal: 1,
    status: 'running' as const,
    callCount,
    currentTool: 'Bash',
    label: null,
    updatedAt: null,
  };
}

function runningWorkflow(sessionId: string, projectId: string, callCount: number): ActiveWorkflow {
  return {
    sessionId,
    wfId: `wf_${sessionId}`,
    projectId,
    status: 'running',
    agentsDone: 0,
    agentsTotal: 1,
    updatedAt: '2026-07-04T10:00:00.000Z',
    agents: [workflowAgent(callCount)],
    agentsTruncated: false,
    dormant: false,
  };
}

function envelope(workflows: ActiveWorkflow[]): ActiveWorkflowsEnvelope {
  return { workflows, eligible: workflows.length, scanned: workflows.length, capped: false, dormant: 0 };
}

function context(id: string, projectId: string) {
  return {
    projectId,
    provider: 'claude' as const,
    session: { id, summary: id, createdAt: '2026-01-01T00:00:00.000Z' } as never,
  };
}

/** Wraps the hook with a render counter so an unwanted re-render is observable. */
function useSignatureProbe(expandedProjectIds: ReadonlySet<string>) {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const signature = useSurfacedSessionsSignature(expandedProjectIds);
  return { signature, renderCount: renderCountRef.current };
}

beforeEach(() => {
  __resetSurfacedSessionsStoreForTests();
  resetSessionProcessStates();
  resetSessionCompletionStore();
  resetWorkflowStatusStore();
});

afterEach(() => {
  cleanup();
  __resetSurfacedSessionsStoreForTests();
  resetSessionProcessStates();
  resetSessionCompletionStore();
  resetWorkflowStatusStore();
});

describe('useSurfacedSessionsSignature — render churn (T-1951)', () => {
  it('does not re-render on a callCount-only workflow update for an unchanged row set', () => {
    applySurfacedSessionContexts(['s1'], [context('s1', 'p1')], getSurfacedSessionsIdentityEpoch());
    act(() => setActiveWorkflows(envelope([runningWorkflow('s1', 'p1', 1)])));

    const { result } = renderHook(() => useSignatureProbe(new Set(['p1'])));
    const firstSignature = result.current.signature;
    const firstRenderCount = result.current.renderCount;
    expect(firstSignature).not.toBe('');

    // The workflow endpoint polls independently of anything a row displays —
    // callCount alone ticking up must not cost this hook's subscriber a render.
    act(() => setActiveWorkflows(envelope([runningWorkflow('s1', 'p1', 2)])));

    expect(result.current.renderCount).toBe(firstRenderCount);
    expect(result.current.signature).toBe(firstSignature);
  });

  it('changes (and re-renders) once a surfaced id enters the expanded project’s row set', () => {
    applySurfacedSessionContexts(['s1'], [context('s1', 'p1')], getSurfacedSessionsIdentityEpoch());
    act(() => setActiveWorkflows(envelope([runningWorkflow('s1', 'p1', 1)])));

    const { result } = renderHook(() => useSignatureProbe(new Set(['p1'])));
    const firstSignature = result.current.signature;
    const firstRenderCount = result.current.renderCount;

    applySurfacedSessionContexts(['s2'], [context('s2', 'p1')], getSurfacedSessionsIdentityEpoch());
    act(() => applyOutcomeDelta('s2', 'error', null, 'visible', 'p1'));

    expect(result.current.renderCount).toBeGreaterThan(firstRenderCount);
    expect(result.current.signature).not.toBe(firstSignature);
  });

  it('changes once a tracked row leaves the row set (its indicator clears)', () => {
    applySurfacedSessionContexts(['s1'], [context('s1', 'p1')], getSurfacedSessionsIdentityEpoch());
    act(() => applyOutcomeDelta('s1', 'error', null, 'visible', 'p1'));

    const { result } = renderHook(() => useSignatureProbe(new Set(['p1'])));
    const firstSignature = result.current.signature;
    expect(firstSignature).not.toBe('');

    act(() => applyOutcomeDelta('s1', null, null, 'absent'));

    expect(result.current.signature).not.toBe(firstSignature);
  });

  it('changes when a tracked row re-ranks (same id set, state running -> question)', () => {
    // qa-critic regression: `id` alone (no `state` component) would leave this
    // signature unchanged even though the row's priority in the cap/sort
    // changes — this reproduces that exact gap directly against the id set.
    applySurfacedSessionContexts(['s1'], [context('s1', 'p1')], getSurfacedSessionsIdentityEpoch());
    act(() => setActiveWorkflows(envelope([runningWorkflow('s1', 'p1', 1)])));

    const { result } = renderHook(() => useSignatureProbe(new Set(['p1'])));
    const firstSignature = result.current.signature;
    expect(firstSignature).toContain(':running');

    act(() => applyOutcomeDelta('s1', 'question', null, 'visible', 'p1'));

    expect(result.current.signature).not.toBe(firstSignature);
    expect(result.current.signature).toContain(':question');
  });

  it('includes a state-less candidate of an expanded project (qa-critic regression)', () => {
    // qa-critic regression: `computeSurfacedSessionsForProject` still shows a
    // candidate with a null derived state (e.g. the selected row) — the
    // signature used to `continue` past state-less candidates outright, so a
    // context change behind a null-state id never bumped this signature.
    // A workflow whose status is neither 'running' nor 'orphan' is tracked by
    // `getWorkflowSessionIdsForProject` (candidacy) but derives a null state.
    applySurfacedSessionContexts(['s1'], [context('s1', 'p1')], getSurfacedSessionsIdentityEpoch());
    act(() => setActiveWorkflows(envelope([{ ...runningWorkflow('s1', 'p1', 1), status: 'unknown' }])));

    const { result } = renderHook(() => useSignatureProbe(new Set(['p1'])));
    expect(result.current.signature).toBe('p1=s1:-');
  });

  it('never reflects a collapsed project’s row changes', () => {
    applySurfacedSessionContexts(['s1'], [context('s1', 'p1')], getSurfacedSessionsIdentityEpoch());

    const { result } = renderHook(() => useSignatureProbe(new Set())); // p1 collapsed
    const firstSignature = result.current.signature;
    const firstRenderCount = result.current.renderCount;

    act(() => applyOutcomeDelta('s1', 'error', null, 'visible', 'p1'));

    expect(result.current.signature).toBe(firstSignature);
    expect(result.current.renderCount).toBe(firstRenderCount);
  });
});
