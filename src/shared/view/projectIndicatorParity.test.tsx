/**
 * B-1431 / T-1949 — project-indicator parity & cross-page reach.
 *
 * Two things are asserted here that nothing else in the suite covers:
 *
 *   1. `deriveProjectIndicatorState` (the project rollup) never disagrees with
 *      `deriveSessionRowIndicatorState` (the per-row derivation) about what a
 *      set of sessions is doing: it is non-idle iff some row is, it never
 *      invents a state absent from its inputs, and it honours the owner-
 *      approved cross-session priority `question > running > frozen > error >
 *      done > orphan`.
 *   2. `ProjectBusyDot` reaches a session the sidebar never loaded a row for —
 *      the defect this stage exists to close (the dot used to see only
 *      `sessions.map((s) => s.id)`, the loaded/paginated page).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyOutcomeDelta,
  resetSessionCompletionStore,
} from '../../stores/sessionCompletionStore';
import {
  reconcilePresenceProcessStates,
  resetSessionProcessStates,
  getProcessStateSessionIdsForProject,
} from '../../stores/sessionProcessStateStore';
import { setActiveWorkflows, resetWorkflowStatusStore } from '../../stores/workflowStatusStore';
import {
  deriveProjectIndicatorState,
  deriveSessionRowIndicatorState,
  type SessionRowIndicatorState,
} from '../../components/sidebar/view/subcomponents/sessionRowIndicatorState';

import ProjectBusyDot from './ProjectBusyDot';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  resetSessionProcessStates();
  resetSessionCompletionStore();
  resetWorkflowStatusStore();
});

// ---------------------------------------------------------------------------
// 1) deriveProjectIndicatorState — parity + priority (pure, exhaustive)
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: readonly SessionRowIndicatorState[] = [
  'question', 'running', 'frozen', 'error', 'done', 'orphan',
];
const ALL_ROW_STATES: ReadonlyArray<SessionRowIndicatorState | null> = [...PRIORITY_ORDER, null];

describe('deriveProjectIndicatorState — parity with row states', () => {
  it('never returns a state absent from the given rows', () => {
    for (const a of ALL_ROW_STATES) {
      for (const b of ALL_ROW_STATES) {
        const result = deriveProjectIndicatorState([a, b]);
        if (result === null) continue;
        expect([a, b]).toContain(result);
      }
    }
  });

  it('is non-idle iff some given row is non-idle', () => {
    for (const a of ALL_ROW_STATES) {
      for (const b of ALL_ROW_STATES) {
        const result = deriveProjectIndicatorState([a, b]);
        const anyNonIdle = a !== null || b !== null;
        expect(result !== null).toBe(anyNonIdle);
      }
    }
  });

  it('returns null for an empty or all-idle row set', () => {
    expect(deriveProjectIndicatorState([])).toBeNull();
    expect(deriveProjectIndicatorState([null, null, null])).toBeNull();
  });

  it.each(PRIORITY_ORDER.map((state, index) => [state, index] as const))(
    'honours question > running > frozen > error > done > orphan (%s)',
    (state, index) => {
      for (let j = 0; j < PRIORITY_ORDER.length; j += 1) {
        const other = PRIORITY_ORDER[j]!;
        const expected = PRIORITY_ORDER[Math.min(index, j)];
        expect(deriveProjectIndicatorState([state, other])).toBe(expected);
        // Order of the input array must not matter.
        expect(deriveProjectIndicatorState([other, state])).toBe(expected);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 2) ProjectBusyDot reaches a session outside the loaded page, per state
// ---------------------------------------------------------------------------

const PROJECT_ID = 'project-far';
const LOADED_ONLY = ['loaded-session'];
const FAR_SESSION = 'far-away-session';

function dotTitle(hintKey: string): HTMLElement {
  return screen.getByTitle(`sessionProcessState.${hintKey}`);
}

/** Attributes `FAR_SESSION` to `PROJECT_ID` in whichever store owns `state`. */
function attributeFarSessionToProject(state: SessionRowIndicatorState): void {
  switch (state) {
    case 'question':
      applyOutcomeDelta(FAR_SESSION, 'question', '2026-09-30T00:00:00.000Z', 'visible', PROJECT_ID);
      return;
    case 'error':
      applyOutcomeDelta(FAR_SESSION, 'error', '2026-09-30T00:00:00.000Z', 'visible', PROJECT_ID);
      return;
    case 'done':
      applyOutcomeDelta(FAR_SESSION, 'done', '2026-09-30T00:00:00.000Z', 'visible', PROJECT_ID);
      return;
    case 'running':
      reconcilePresenceProcessStates([{ sessionId: FAR_SESSION, state: 'running', projectId: PROJECT_ID }]);
      return;
    case 'frozen':
      reconcilePresenceProcessStates([{ sessionId: FAR_SESSION, state: 'frozen', projectId: PROJECT_ID }]);
      return;
    case 'orphan':
      setActiveWorkflows({
        workflows: [{
          sessionId: FAR_SESSION, wfId: 'wf-far', projectId: PROJECT_ID, status: 'orphan',
          agentsDone: 0, agentsTotal: 0, updatedAt: null, agents: [], agentsTruncated: false, dormant: false,
        }],
        eligible: 1, scanned: 1, capped: false, dormant: 0,
      });
      return;
  }
}

const PROJECT_HINT_KEY: Record<SessionRowIndicatorState, string> = {
  question: 'projectQuestionHint',
  running: 'projectBusyHint',
  frozen: 'projectFrozenHint',
  error: 'projectErrorHint',
  done: 'projectDoneHint',
  orphan: 'projectOrphanHint',
};

describe('ProjectBusyDot — reaches a session outside the loaded page (B-1431)', () => {
  it.each(PRIORITY_ORDER)('lights the header for a far %s session', (state) => {
    attributeFarSessionToProject(state);

    render(<ProjectBusyDot projectId={PROJECT_ID} loadedIds={LOADED_ONLY} />);

    expect(dotTitle(PROJECT_HINT_KEY[state])).toBeTruthy();
  });

  it('renders nothing when the far session belongs to a different project', () => {
    attributeFarSessionToProject('running');

    const { container } = render(
      <ProjectBusyDot projectId="some-other-project" loadedIds={LOADED_ONLY} />,
    );

    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3) Old server (no projectId) keeps the pre-existing loaded-ids-only behaviour
// ---------------------------------------------------------------------------

describe('ProjectBusyDot — old server without projectId (B-1431 fallback)', () => {
  it('does not light a far session whose presence entry carries no projectId', () => {
    // Simulates a server predating B-1431: the field is simply absent.
    reconcilePresenceProcessStates([{ sessionId: FAR_SESSION, state: 'running' }]);

    const { container } = render(
      <ProjectBusyDot projectId={PROJECT_ID} loadedIds={LOADED_ONLY} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('still lights the header when that same session IS on the loaded page', () => {
    reconcilePresenceProcessStates([{ sessionId: FAR_SESSION, state: 'running' }]);

    render(<ProjectBusyDot projectId={PROJECT_ID} loadedIds={[FAR_SESSION]} />);

    expect(dotTitle('projectBusyHint')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4) Identity reset clears projectIdBySession
// ---------------------------------------------------------------------------

describe('resetSessionProcessStates — clears projectIdBySession (B-1431)', () => {
  it('drops the project attribution on an identity reset', () => {
    reconcilePresenceProcessStates([{ sessionId: FAR_SESSION, state: 'running', projectId: PROJECT_ID }]);
    expect(getProcessStateSessionIdsForProject(PROJECT_ID)).toEqual([FAR_SESSION]);

    resetSessionProcessStates();

    expect(getProcessStateSessionIdsForProject(PROJECT_ID)).toEqual([]);
  });
});

// Sanity: `deriveSessionRowIndicatorState` itself is exercised elsewhere
// (sessionRowIndicatorState covers each row-derivation branch); referenced
// here only to keep the import honest against an unused-import lint drift.
void deriveSessionRowIndicatorState;
