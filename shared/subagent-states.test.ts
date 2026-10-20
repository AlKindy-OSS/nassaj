import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isInferredTerminal,
  isSubagentState,
  isTerminalSubagentState,
  preferSubagentRecord,
  SUBAGENT_SESSION_TIMEOUT_MS,
  SUBAGENT_STATES,
  validInferredCause,
  type SubagentInferredCause,
  type SubagentState,
} from './subagent-states.js';

type Rec = { state: SubagentState; inferredCause?: SubagentInferredCause };

describe('subagent states (agent-progress P0)', () => {
  it('one vocabulary with stopped and unknown; only the four ends are terminal', () => {
    assert.deepEqual([...SUBAGENT_STATES], ['started', 'running', 'completed', 'failed', 'stopped', 'unknown']);
    assert.equal(isSubagentState('stopped'), true);
    assert.equal(isSubagentState('killed'), false);
    assert.deepEqual(SUBAGENT_STATES.filter(isTerminalSubagentState), ['completed', 'failed', 'stopped', 'unknown']);
  });

  it('keeps an inferred cause only where it can apply', () => {
    assert.equal(validInferredCause('stopped', 'owner'), 'owner');
    assert.equal(validInferredCause('stopped', 'timeout'), undefined);
    assert.equal(validInferredCause('unknown', 'process-exit'), 'process-exit');
    assert.equal(validInferredCause('unknown', 'timeout'), 'timeout');
    assert.equal(validInferredCause('unknown', 'owner'), undefined);
    assert.equal(validInferredCause('failed', 'owner'), undefined);
    assert.equal(validInferredCause('unknown', 'bogus'), undefined);
  });

  it('unknown and an owner stop are inferred; a reported stop is measured', () => {
    assert.equal(isInferredTerminal({ state: 'unknown', inferredCause: 'process-exit' }), true);
    assert.equal(isInferredTerminal({ state: 'stopped', inferredCause: 'owner' }), true);
    assert.equal(isInferredTerminal({ state: 'stopped' }), false);
    assert.equal(isInferredTerminal({ state: 'failed' }), false);
  });

  it('a late measured end overrides unknown; inferred never replaces measured; ends never reopen', () => {
    const unknown: Rec = { state: 'unknown', inferredCause: 'process-exit' };
    const completed: Rec = { state: 'completed' };
    const running: Rec = { state: 'running' };
    const ownerStop: Rec = { state: 'stopped', inferredCause: 'owner' };
    assert.equal(preferSubagentRecord(unknown, completed), completed);
    assert.equal(preferSubagentRecord(ownerStop, completed), completed);
    assert.equal(preferSubagentRecord(completed, unknown), completed);
    assert.equal(preferSubagentRecord(completed, running), completed);
    assert.equal(preferSubagentRecord(unknown, running), unknown);
    assert.equal(preferSubagentRecord(undefined, running), running);
    assert.equal(preferSubagentRecord(running, unknown), unknown);
    const failed: Rec = { state: 'failed' };
    assert.equal(preferSubagentRecord(completed, failed), failed, 'two measured ends: the later wins');
  });

  it('session timeout is 6 h (calibrated; above the longest real completion of 2.7 h)', () => {
    assert.equal(SUBAGENT_SESSION_TIMEOUT_MS, 21_600_000);
  });
});
