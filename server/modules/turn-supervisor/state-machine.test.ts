import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRunTransition,
  assertTurnTransition,
  classifyDuplicateRun,
  TurnStateTransitionError,
} from '@/modules/turn-supervisor/state-machine.js';

test('run transitions enforce the one-way dispatch and terminal sequence', () => {
  assert.doesNotThrow(() => assertRunTransition({
    runId: 'run-1', expectedState: 'claimed', expectedEpoch: 0, nextState: 'dispatching',
  }));
  assert.doesNotThrow(() => assertRunTransition({
    runId: 'run-1', expectedState: 'running', expectedEpoch: 2,
    nextState: 'terminal', terminalOutcome: 'succeeded',
  }));
  assert.throws(
    () => assertRunTransition({
      runId: 'run-1', expectedState: 'terminal', expectedEpoch: 3, nextState: 'running',
    }),
    (error) => error instanceof TurnStateTransitionError && error.code === 'ILLEGAL_TRANSITION',
  );
});

test('terminal state and terminal outcome must be supplied together', () => {
  assert.throws(
    () => assertRunTransition({
      runId: 'run-1', expectedState: 'running', expectedEpoch: 2, nextState: 'terminal',
    }),
    (error) => error instanceof TurnStateTransitionError && error.code === 'INVALID_TERMINAL_OUTCOME',
  );
  assert.throws(
    () => assertTurnTransition({
      turnId: 'turn-1', expectedState: 'accepted', expectedEpoch: 0,
      nextState: 'running', terminalOutcome: 'failed',
    }),
    (error) => error instanceof TurnStateTransitionError && error.code === 'INVALID_TERMINAL_OUTCOME',
  );
});

test('the dispatch boundary classifies duplicate recovery conservatively', () => {
  assert.equal(classifyDuplicateRun('claimed'), 'resume_safe');
  assert.equal(classifyDuplicateRun('dispatching'), 'ambiguous');
  assert.equal(classifyDuplicateRun('running'), 'ambiguous');
  assert.equal(classifyDuplicateRun('terminal'), 'replay_terminal');
});
