/**
 * Surfaced-sessions store (B-1431 / T-1949 client stage 2).
 *
 * RUNNER: NODE_ENV=test npx vitest run src/stores/surfacedSessionsStore.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionWithProvider } from '../components/sidebar/types/types';
import type { Project } from '../types/app';
import type { SessionRowIndicatorState } from '../components/sidebar/view/subcomponents/sessionRowIndicatorState';

import { applyOutcomeDelta, resetSessionCompletionStore } from './sessionCompletionStore';
import { resetSessionProcessStates, setSessionProcessState } from './sessionProcessStateStore';
import { resetWorkflowStatusStore } from './workflowStatusStore';
import {
  applySurfacedSessionContexts,
  collectWantedSurfacedSessionIds,
  computeSurfacedSessionsForProject,
  getSurfacedSessionsIdentityEpoch,
  isSurfacedSessionNegativeCached,
  pruneSurfacedContextsToProjects,
  resetSurfacedSessionsStore,
  __resetSurfacedSessionsStoreForTests,
  type SurfacedContext,
} from './surfacedSessionsStore';

const session = (id: string, overrides: Partial<SessionWithProvider> = {}): SessionWithProvider =>
  ({ id, summary: id, createdAt: '2026-01-01T00:00:00.000Z', ...overrides } as SessionWithProvider);

const ctx = (id: string, projectId: string, overrides: Partial<SessionWithProvider> = {}): SurfacedContext => ({
  projectId,
  provider: 'claude',
  session: session(id, overrides),
});

beforeEach(() => {
  __resetSurfacedSessionsStoreForTests();
  resetSessionProcessStates();
  resetSessionCompletionStore();
  resetWorkflowStatusStore();
});

afterEach(() => {
  __resetSurfacedSessionsStoreForTests();
  resetSessionProcessStates();
  resetSessionCompletionStore();
  resetWorkflowStatusStore();
});

describe('computeSurfacedSessionsForProject', () => {
  it('returns nothing for an id with no live indicator, even if fetched', () => {
    applySurfacedSessionContexts(['s1'], [ctx('s1', 'p1')], 0);
    const result = computeSurfacedSessionsForProject('p1', new Set(), null);
    expect(result.sessions).toEqual([]);
  });

  it('surfaces a fetched id once an indicator attributes it to the project', () => {
    applySurfacedSessionContexts(['s1'], [ctx('s1', 'p1')], 0);
    setSessionProcessState('s1', 'running');
    // reconcilePresenceProcessStates is the only path that attaches projectId;
    // the direct mirror path (setSessionProcessState) never learns one, so use
    // the outcome store instead — it accepts projectId directly.
    applyOutcomeDelta('s1', 'done', null, 'visible', 'p1');
    const result = computeSurfacedSessionsForProject('p1', new Set(), null);
    expect(result.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(result.sessions[0].__surfaced).toBe(true);
  });

  it('excludes ids already loaded — the loaded row always wins', () => {
    applySurfacedSessionContexts(['s1'], [ctx('s1', 'p1')], 0);
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');
    const result = computeSurfacedSessionsForProject('p1', new Set(['s1']), null);
    expect(result.sessions).toEqual([]);
  });

  it('drops a row once every indicator clears', () => {
    applySurfacedSessionContexts(['s1'], [ctx('s1', 'p1')], 0);
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');
    expect(computeSurfacedSessionsForProject('p1', new Set(), null).sessions).toHaveLength(1);

    applyOutcomeDelta('s1', null, null, 'absent');
    expect(computeSurfacedSessionsForProject('p1', new Set(), null).sessions).toEqual([]);
  });

  it('keeps the selected session visible even after its indicator clears', () => {
    applySurfacedSessionContexts(['s1'], [ctx('s1', 'p1')], 0);
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');
    computeSurfacedSessionsForProject('p1', new Set(), 's1'); // establish as "seen"

    applyOutcomeDelta('s1', null, null, 'absent');
    const result = computeSurfacedSessionsForProject('p1', new Set(), 's1');
    expect(result.sessions.map((s) => s.id)).toEqual(['s1']);
  });

  it('caps at 10 rows per project, prioritising question > error > running > frozen > done > orphan', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    applySurfacedSessionContexts(ids, ids.map((id) => ctx(id, 'p1')), 0);

    // 12 candidates: one question (highest priority, must survive the cap),
    // ten "done" (fills the rest of the budget), one "error" (must displace a
    // "done" out of the cap).
    applyOutcomeDelta('s0', 'question', null, 'visible', 'p1');
    applyOutcomeDelta('s11', 'error', null, 'visible', 'p1');
    for (let i = 1; i <= 10; i += 1) {
      applyOutcomeDelta(`s${i}`, 'done', null, 'visible', 'p1');
    }

    const result = computeSurfacedSessionsForProject('p1', new Set(), null);
    expect(result.sessions).toHaveLength(10);
    expect(result.hiddenCount).toBe(2);
    const ordered = result.sessions.map((s) => s.id);
    expect(ordered[0]).toBe('s0'); // question first
    expect(ordered[1]).toBe('s11'); // error next
    expect(ordered).not.toContain('s10'); // one "done" pushed out of the cap
  });

  it('never counts the selected session against its own budget', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `s${i}`);
    applySurfacedSessionContexts(ids, ids.map((id) => ctx(id, 'p1')), 0);
    for (const id of ids) applyOutcomeDelta(id, 'done', null, 'visible', 'p1');

    const result = computeSurfacedSessionsForProject('p1', new Set(), 's10');
    expect(result.sessions).toHaveLength(10);
    expect(result.sessions.map((s) => s.id)).toContain('s10');
  });

  it('ignores a context fetched for a different project', () => {
    applySurfacedSessionContexts(['s1'], [ctx('s1', 'p2')], 0);
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1'); // indicator claims p1
    // The fetched context disagrees (belongs to p2) — never surface it under p1.
    expect(computeSurfacedSessionsForProject('p1', new Set(), null).sessions).toEqual([]);
  });
});

describe('applySurfacedSessionContexts — identity race', () => {
  it('drops a response tagged with a stale epoch', () => {
    const epoch = getSurfacedSessionsIdentityEpoch();
    // Identity changes while the request is in flight — a real account switch,
    // not the test-only full reset (which would also zero the epoch back to 0).
    resetSurfacedSessionsStore();
    expect(getSurfacedSessionsIdentityEpoch()).not.toBe(epoch);
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');

    applySurfacedSessionContexts(['s1'], [ctx('s1', 'p1')], epoch); // stale epoch
    expect(computeSurfacedSessionsForProject('p1', new Set(), null).sessions).toEqual([]);
  });

  it('negative-caches an id the server did not return, for the current epoch', () => {
    const epoch = getSurfacedSessionsIdentityEpoch();
    applySurfacedSessionContexts(['missing'], [], epoch);
    expect(isSurfacedSessionNegativeCached('missing')).toBe(true);
  });
});

describe('pruneSurfacedContextsToProjects', () => {
  it('drops contexts and clears the negative cache for projects no longer listed', () => {
    const epoch = getSurfacedSessionsIdentityEpoch();
    applySurfacedSessionContexts(['s1', 'gone'], [ctx('s1', 'p1')], epoch);
    expect(isSurfacedSessionNegativeCached('gone')).toBe(true);

    pruneSurfacedContextsToProjects(new Set(['other']));

    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');
    expect(computeSurfacedSessionsForProject('p1', new Set(), null).sessions).toEqual([]);
    expect(isSurfacedSessionNegativeCached('gone')).toBe(false);
  });
});

const project = (projectId: string, sessions: SessionWithProvider[] = []): Project =>
  ({ projectId, sessions } as unknown as Project);

describe('collectWantedSurfacedSessionIds', () => {
  it('never fetches for a collapsed project', () => {
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');
    const wanted = collectWantedSurfacedSessionIds(
      [project('p1')],
      new Set(), // nothing expanded
      ['sessions'],
      new Map(),
    );
    expect(wanted).toEqual([]);
  });

  it('excludes an id already in the project’s loaded bucket', () => {
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');
    const wanted = collectWantedSurfacedSessionIds(
      [project('p1', [session('s1')])],
      new Set(['p1']),
      ['sessions'],
      new Map(),
    );
    expect(wanted).toEqual([]);
  });

  it('wants an id with a live indicator outside the loaded page', () => {
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');
    const wanted = collectWantedSurfacedSessionIds(
      [project('p1')],
      new Set(['p1']),
      ['sessions'],
      new Map(),
    );
    expect(wanted).toEqual(['s1']);
  });

  it('does not refetch an id already resolved to a context', () => {
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');
    applySurfacedSessionContexts(['s1'], [ctx('s1', 'p1')], getSurfacedSessionsIdentityEpoch());
    const wanted = collectWantedSurfacedSessionIds(
      [project('p1')],
      new Set(['p1']),
      ['sessions'],
      new Map(),
    );
    expect(wanted).toEqual([]);
  });

  it('does not refetch a negative-cached id', () => {
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');
    // `lastStateById` must persist across cycles (as the driver's ref does) so
    // the second cycle sees "state unchanged" and trusts the negative cache
    // instead of invalidating it on sight.
    const lastStateById = new Map();
    collectWantedSurfacedSessionIds([project('p1')], new Set(['p1']), ['sessions'], lastStateById);
    applySurfacedSessionContexts(['s1'], [], getSurfacedSessionsIdentityEpoch());

    const wanted = collectWantedSurfacedSessionIds(
      [project('p1')],
      new Set(['p1']),
      ['sessions'],
      lastStateById,
    );
    expect(wanted).toEqual([]);
  });

  it('re-wants a negative-cached id once its indicator state changes', () => {
    applyOutcomeDelta('s1', 'error', null, 'visible', 'p1');

    // Prior cycle — primes `lastStateById` with the CURRENT state ('error')
    // before the id is negative-cached, exactly like the driver's own ref
    // would carry state across debounced cycles.
    const lastStateById = new Map<string, SessionRowIndicatorState | null>();
    collectWantedSurfacedSessionIds([project('p1')], new Set(['p1']), ['sessions'], lastStateById);

    // Server did not return it — negative-cache it for the unchanged state.
    applySurfacedSessionContexts(['s1'], [], getSurfacedSessionsIdentityEpoch());

    const stillNegative = collectWantedSurfacedSessionIds(
      [project('p1')],
      new Set(['p1']),
      ['sessions'],
      lastStateById,
    );
    expect(stillNegative).toEqual([]); // state unchanged — negative cache still honoured

    applyOutcomeDelta('s1', 'done', null, 'visible', 'p1'); // state changed: error -> done
    const wanted = collectWantedSurfacedSessionIds(
      [project('p1')],
      new Set(['p1']),
      ['sessions'],
      lastStateById,
    );
    expect(wanted).toEqual(['s1']);
  });
});
