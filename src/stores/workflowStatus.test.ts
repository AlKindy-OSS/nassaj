/**
 * Unit tests for deriveWorkflowUiState (B-103, ADR-053 M2).
 *
 * الدالة خالصة (pure + side-effect-free) — تُختبر بالحالات الست المُعرَّفة
 * مع edge cases: مُدخلات فارغة، تجاوز المجموع، وحالة غير معروفة.
 *
 * التوكيدات على مفاتيح i18n (labelKey/hintKey) لا على نصوص الترجمة،
 * بما يتوافق مع مواصفة M2 وتحرُّر الاختبارات من تغيُّر الترجمة.
 *
 * Run: npm run test:client -- src/stores/workflowStatus.test.ts
 */

import { describe, it, expect } from 'vitest';

import { deriveWorkflowUiState } from './workflowStatus';

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------
describe('deriveWorkflowUiState — running', () => {
  it('no progress: pulse=true, progress=null', () => {
    const d = deriveWorkflowUiState('running', 0, 0);
    expect(d.state).toBe('running');
    expect(d.labelKey).toBe('workflowStatus.running');
    expect(d.hintKey).toBe('workflowStatus.runningHint');
    expect(d.pulse).toBe(true);
    expect(d.progress).toBeNull();
  });

  it('with progress: returns { done, total }', () => {
    const d = deriveWorkflowUiState('running', 3, 5);
    expect(d.state).toBe('running');
    expect(d.pulse).toBe(true);
    expect(d.progress).toEqual({ done: 3, total: 5 });
  });

  it('denominator clamps to numerator when total < done', () => {
    const d = deriveWorkflowUiState('running', 7, 4);
    // safeCount(4)=4, then Math.max(4, 7)=7 — total coerced up.
    expect(d.progress).toEqual({ done: 7, total: 7 });
  });
});

// ---------------------------------------------------------------------------
// frozen
// ---------------------------------------------------------------------------
describe('deriveWorkflowUiState — frozen', () => {
  it('returns frozen state, no pulse, no progress regardless of counters', () => {
    const d = deriveWorkflowUiState('frozen', 5, 10);
    expect(d.state).toBe('frozen');
    expect(d.labelKey).toBe('workflowStatus.frozen');
    expect(d.hintKey).toBe('workflowStatus.frozenHint');
    expect(d.pulse).toBe(false);
    expect(d.progress).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// orphan — three sub-states
// ---------------------------------------------------------------------------
describe('deriveWorkflowUiState — orphan_empty', () => {
  it('done=0, total=0 => orphan_empty, no progress', () => {
    const d = deriveWorkflowUiState('orphan', 0, 0);
    expect(d.state).toBe('orphan_empty');
    expect(d.labelKey).toBe('workflowStatus.orphanEmpty');
    expect(d.hintKey).toBe('workflowStatus.orphanEmptyHint');
    expect(d.pulse).toBe(false);
    expect(d.progress).toBeNull();
  });

  it('negative done coerces to 0 => orphan_empty', () => {
    const d = deriveWorkflowUiState('orphan', -3, 5);
    expect(d.state).toBe('orphan_empty');
  });
});

describe('deriveWorkflowUiState — orphan_partial (started={A,B} + result={A})', () => {
  it('0 < done < total => orphan_partial with progress', () => {
    // Real endpoint shape: agentsDone=1, agentsTotal=2 (one agent finished, one did not)
    const d = deriveWorkflowUiState('orphan', 1, 2);
    expect(d.state).toBe('orphan_partial');
    expect(d.labelKey).toBe('workflowStatus.orphanPartial');
    expect(d.hintKey).toBe('workflowStatus.orphanPartialHint');
    expect(d.pulse).toBe(false);
    expect(d.progress).toEqual({ done: 1, total: 2 });
  });

  it('incident journal shape: agentsDone=15, agentsTotal=16 => orphan_partial', () => {
    const d = deriveWorkflowUiState('orphan', 15, 16);
    expect(d.state).toBe('orphan_partial');
    expect(d.labelKey).toBe('workflowStatus.orphanPartial');
    expect(d.progress).toEqual({ done: 15, total: 16 });
  });
});

describe('deriveWorkflowUiState — orphan_incomplete (started={A,B} + result={A,B})', () => {
  it('done === total (> 0) => orphan_incomplete, NEVER progress (no n/n lie)', () => {
    const d = deriveWorkflowUiState('orphan', 2, 2);
    expect(d.state).toBe('orphan_incomplete');
    expect(d.labelKey).toBe('workflowStatus.orphanIncomplete');
    expect(d.hintKey).toBe('workflowStatus.orphanIncompleteHint');
    expect(d.pulse).toBe(false);
    expect(d.progress).toBeNull(); // M2: NEVER emit n/n for a dead run
  });

  it('done > total (over-counted denominator): coerces total up => orphan_incomplete, no progress', () => {
    const d = deriveWorkflowUiState('orphan', 5, 3);
    expect(d.state).toBe('orphan_incomplete');
    expect(d.progress).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// unknown — M1: known:false must NOT surface as orphan
// ---------------------------------------------------------------------------
describe('deriveWorkflowUiState — unknown', () => {
  it('status=unknown: neutral state, no pulse, no progress', () => {
    const d = deriveWorkflowUiState('unknown', 0, 0);
    expect(d.state).toBe('unknown');
    expect(d.labelKey).toBe('workflowStatus.unknown');
    expect(d.hintKey).toBe('workflowStatus.unknownHint');
    expect(d.pulse).toBe(false);
    expect(d.progress).toBeNull();
  });

  it('unknown with non-zero counters (restart survivor) is still unknown, never orphan', () => {
    // This is the M1 invariant: a workflow with known:false arriving as 'unknown'
    // must NOT be mis-rendered as an orphan even if it has progress counters.
    const d = deriveWorkflowUiState('unknown', 15, 16);
    expect(d.state).toBe('unknown');
    expect(d.labelKey).toBe('workflowStatus.unknown');
    expect(d.progress).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// total function: unrecognised status collapses to unknown (no throw)
// ---------------------------------------------------------------------------
describe('deriveWorkflowUiState — unrecognised status', () => {
  it('future / unknown status string collapses to unknown state', () => {
    const d = deriveWorkflowUiState('something_future', 3, 5);
    expect(d.state).toBe('unknown');
    expect(d.labelKey).toBe('workflowStatus.unknown');
    expect(d.pulse).toBe(false);
    expect(d.progress).toBeNull();
  });

  it('empty string status collapses to unknown', () => {
    const d = deriveWorkflowUiState('', 0, 0);
    expect(d.state).toBe('unknown');
  });
});
