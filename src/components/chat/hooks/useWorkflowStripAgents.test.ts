import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const assert = {
  equal: (actual: unknown, expected: unknown, message?: string) =>
    expect(actual, message).toBe(expected),
};

import { setActiveWorkflows } from '../../../stores/workflowStatusStore';
import { normalizeWorkflowsEnvelope } from '../../../stores/workflowStatus';
import { useWorkflowStripAgents } from './useWorkflowStripAgents';

const SESSION_ID = 'workflow-strip-agent-test';

/** The agent id and order are captured; session/workflow ids and task text are scrubbed. */

afterEach(() => {
  setActiveWorkflows({ workflows: [], eligible: 0, scanned: 0, capped: false, dormant: 0 });
});

describe('workflow strip agent names', () => {
  it('shows the short agent id and delegation ordinal', () => {
    const envelope = normalizeWorkflowsEnvelope({
      workflows: [{
        sessionId: SESSION_ID,
        wfId: 'wf_test',
        projectId: null,
        status: 'running',
        agentsDone: 0,
        agentsTotal: 1,
        updatedAt: '2026-10-15T00:00:00.000Z',
        agents: [{
          agentId: 'afd5fea2b66ee549d',
          ordinal: 2,
          status: 'done',
          callCount: 0,
          currentTool: null,
          label: '[scrubbed task]',
          model: 'model-from-agent-transcript',
          effort: 'high',
          updatedAt: '2026-10-15T00:00:00.000Z',
        }],
        agentsTruncated: false,
      dormant: false,
      }],
      eligible: 1,
      scanned: 1,
      capped: false,
      dormant: 0,
    });
    act(() => setActiveWorkflows(envelope));

    const { result } = renderHook(() => useWorkflowStripAgents(SESSION_ID));
    assert.equal(result.current[0].agentName, 'afd5fea2 · #2');
    assert.equal(result.current[0].description, '[scrubbed task]');
    assert.equal(result.current[0].model, 'model-from-agent-transcript');
    assert.equal(result.current[0].effort, 'high');
  });
});
