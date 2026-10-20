/**
 * ADR-199 P1b/P1c on the client, from rows the server's live path really emits
 * (__fixtures__/claude-task-plan-live.real.json, see its `_provenance`):
 *  - the plan rides the Task* tool_result row, which the normalizer merges into
 *    its call; the snapshot must survive that merge;
 *  - background agents settle through text-less `status` rows carrying
 *    `subagent`; those settle the agent without rendering a chat row.
 * Plus item 12: server `counts` over the full list win over the capped items.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { FOREGROUND_ROWS, FOREGROUND_AGENT } from './__fixtures__/claude-foreground-child.real';
import capture from './__fixtures__/claude-task-plan-live.real.json';
import { resolveOverallPercent } from './declaredProgress';
import { normalizedToChatMessages } from './useChatMessages';
import { computeRunProgress, countPlan, useRunProgress } from './useRunProgress';

const ROWS = capture.rows as unknown as NormalizedMessage[];
const assert = {
  equal: (actual: unknown, expected: unknown, message?: string) =>
    expect(actual, message).toBe(expected),
  deepEqual: (actual: unknown, expected: unknown, message?: string) =>
    expect(actual, message).toEqual(expected),
  ok: (actual: unknown, message?: string) => expect(actual, message).toBeTruthy(),
};
const COMPLETED_AGENT = 'toolu_01H48H2qDEZsGjV6DhgMGGrh';
const FAILED_AGENT = 'toolu_01M53A5Rb27vy4bsis9151KZ';
const isStatus = (m: NormalizedMessage) => m.kind === 'status';
const lastIndex = (pred: (m: NormalizedMessage) => boolean) => ROWS.map(pred).lastIndexOf(true);

function progressOf(rows: NormalizedMessage[]) {
  const chat = normalizedToChatMessages(rows);
  return renderHook(() => useRunProgress(chat, true)).result.current;
}

describe('plan on the result row survives the call/result merge', () => {
  it('the fixture carries the plan on result rows only', () => {
    assert.ok(ROWS.some((m) => m.kind === 'tool_result' && m.plan));
    assert.equal(ROWS.some((m) => m.kind === 'tool_use' && m.plan), false);
  });

  it('result rows are folded away, yet the latest snapshot is read', () => {
    const upToPlans = ROWS.slice(0, lastIndex((m) => Boolean(m.plan)) + 1);
    const chat = normalizedToChatMessages(upToPlans);
    assert.equal(chat.filter((m) => m.isToolUse && m.toolName === 'ToolResult').length, 0, 'no orphan result rows');
    const progress = renderHook(() => useRunProgress(chat, true)).result.current;
    assert.deepEqual([progress.done, progress.inProgress, progress.total], [0, 1, 2]);
    assert.deepEqual(resolveOverallPercent(progress), { percent: 25, source: 'tasks' });
  });

  it('mid-run (first create only) shows that snapshot', () => {
    const progress = progressOf(ROWS.slice(0, 3));
    assert.deepEqual([progress.done, progress.total], [0, 1]);
  });
});

describe('background agents settle through status rows', () => {
  it('before the notifications both agents run', () => {
    const progress = progressOf(ROWS.slice(0, ROWS.findIndex(isStatus)));
    assert.deepEqual(progress.agents.map((a) => [a.id, a.status]), [[COMPLETED_AGENT, 'running'], [FAILED_AGENT, 'running']]);
    assert.ok(progress.activeSubagent);
  });

  it('completed and failed settlements close them', () => {
    const progress = progressOf(ROWS);
    assert.deepEqual(progress.agents.map((a) => [a.id, a.status, a.outcome]),
      [[COMPLETED_AGENT, 'done', 'completed'], [FAILED_AGENT, 'done', 'failed']]);
    // P0: a failure ends the agent but is never counted as done (success).
    assert.deepEqual([progress.agentsDone, progress.agentsUnsuccessful], [1, 1]);
    assert.equal(progress.activeSubagent, null);
  });

  it('carries the settled state onto the container and renders no status row', () => {
    const chat = normalizedToChatMessages(ROWS);
    const byId = (id: string) => chat.find((m) => m.toolId === id);
    assert.equal(byId(COMPLETED_AGENT)?.subagent?.state, 'completed');
    assert.equal(byId(FAILED_AGENT)?.subagent?.state, 'failed');
    assert.equal(byId(FAILED_AGENT)?.subagentState?.isComplete, true);
    const statusIds = new Set<unknown>(ROWS.filter(isStatus).map((m) => m.id));
    assert.equal(chat.some((m) => statusIds.has(m.id)), false);
  });

  it('a settlement for an unseen agent invents nothing', () => {
    const orphan = ROWS.filter((m) => m.kind !== 'tool_use' || !m.subagent);
    assert.equal(progressOf(orphan).agentsTotal, 0);
  });
});

describe('foreground agent with a captured child tool', () => {
  it('shows child metadata while running and preserves the result settlement', () => {
    const runningChat = normalizedToChatMessages(FOREGROUND_ROWS.slice(0, 3));
    const runningProgress = computeRunProgress(runningChat, true);
    const runningAgent = runningProgress.agents.find(
      (row) => row.id === FOREGROUND_AGENT,
    )!;

    assert.equal(runningAgent.status, 'running');
    assert.equal(runningAgent.model, 'claude-opus-5-5');
    assert.equal(runningAgent.effort, 'medium');
    assert.deepEqual(runningAgent.tools, [{ name: 'Bash', status: 'done' }]);

    const chat = normalizedToChatMessages(FOREGROUND_ROWS);
    const progress = computeRunProgress(chat, true);
    const agent = progress.agents.find((row) => row.id === FOREGROUND_AGENT)!;

    assert.equal(agent.status, 'done');
    assert.equal(progress.agentsDone, 1);
    assert.equal(agent.model, 'claude-opus-5-5');
    assert.equal(agent.effort, 'medium');
    assert.deepEqual(agent.tools, [{ name: 'Bash', status: 'done' }]);
    assert.deepEqual(agent.childTools?.map((tool) => tool.toolName), ['Bash']);
  });
});

describe('plan counts over the full list (ADR-199 item 12)', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    id: String(i), label: `t${i}`, status: (i < 40 ? 'completed' : 'pending') as 'completed' | 'pending',
  }));

  it('50 shown items with counts {done:90,total:120} → 75%', () => {
    const counted = countPlan({ source: 'tool', items, counts: { done: 90, total: 120 } });
    assert.deepEqual(counted, { done: 90, total: 120, inProgress: 0 });
    assert.deepEqual(resolveOverallPercent({ ...counted, agents: [] }), { percent: 75, source: 'tasks' });
  });

  it('without counts the items are counted as before', () => {
    assert.deepEqual(countPlan({ source: 'tool', items }), { done: 40, total: 50, inProgress: 0 });
  });

  it('inconsistent counts fall back to the items', () => {
    assert.deepEqual(countPlan({ source: 'tool', items, counts: { done: 5, total: 2 } }).total, 50);
  });
});
