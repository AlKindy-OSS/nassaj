/**
 * ADR-199 P2: the progress hooks read only the neutral `plan` / `subagent`
 * fields. Fixtures are excerpts of the real server captures (see
 * __fixtures__/claude-progress-normalized.real.ts).
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { describe, it } from 'vitest';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { FIXTURE_IDS, HISTORY_ROWS, LIVE_STREAM_ROWS } from './__fixtures__/claude-progress-normalized.real';
import { resolveOverallPercent } from './declaredProgress';
import { normalizedToChatMessages } from './useChatMessages';
import { countPlan, gateComputedProgress, useRunProgress } from './useRunProgress';

function progressOf(rows: NormalizedMessage[]) {
  const chat = normalizedToChatMessages(rows);
  return renderHook(() => useRunProgress(chat, true)).result.current;
}

/** Live stream cut after the first `count` rows (the run as seen mid-flight). */
const liveUpTo = (count: number) => LIVE_STREAM_ROWS.slice(0, count);

type PlanItem = NonNullable<NormalizedMessage['plan']>['items'][number];
const planRow = (id: string, statuses: string[], at: string): NormalizedMessage => ({
  sessionId: 's', provider: 'claude', id, kind: 'tool_use', role: 'assistant', toolName: 'x', toolId: id,
  timestamp: at,
  plan: {
    source: 'tool',
    items: statuses.map((status, i) => ({ id: String(i), label: `item ${i}`, status } as unknown as PlanItem)),
  },
} as NormalizedMessage);
const PROMPT = LIVE_STREAM_ROWS[0];

describe('ADR-199 neutral plan', () => {
  it('first live snapshot: 0 done, 1 in progress of 2', () => {
    const progress = progressOf(liveUpTo(3));
    assert.deepEqual([progress.done, progress.inProgress, progress.total], [0, 1, 2]);
    assert.deepEqual(resolveOverallPercent(progress), { percent: 25, source: 'tasks' });
  });

  it('the latest snapshot inside the reply wins', () => {
    const progress = progressOf(LIVE_STREAM_ROWS);
    assert.deepEqual([progress.done, progress.inProgress, progress.total], [2, 0, 2]);
  });

  it('reads the plan, not the tool name', () => {
    const renamed = LIVE_STREAM_ROWS.map((m) => (m.toolName ? { ...m, toolName: 'renamed' } : m));
    const progress = progressOf(renamed);
    assert.equal(progress.total, 2);
    assert.equal(progress.agentsTotal, 1, 'the sub-agent is found by its neutral field');
  });

  it('a call without a plan field gives no number, whatever its tool name', () => {
    const stripped = LIVE_STREAM_ROWS.map(({ plan: _plan, ...m }) => m as NormalizedMessage);
    assert.equal(progressOf(stripped).total, 0);
  });

  it('a snapshot on the result row wins over the call (Addendum A)', () => {
    const rows: NormalizedMessage[] = [
      PROMPT,
      { ...planRow('t1', ['pending'], '2026-10-09T06:26:30.000Z') },
      { ...planRow('t1', ['completed', 'pending'], '2026-10-09T06:26:30.100Z'), kind: 'tool_result', role: 'user', id: 't1r' },
    ];
    const progress = progressOf(rows);
    assert.deepEqual([progress.done, progress.total], [1, 2]);
  });

  it('cancelled / canceled / skipped / deleted leave numerator and denominator', () => {
    assert.deepEqual(countPlan({ source: 'tool', items: [
      { id: '0', label: 'a', status: 'completed' },
      ...['cancelled', 'canceled', 'skipped', 'deleted'].map((status, i) =>
        ({ id: String(i + 1), label: 'x', status } as unknown as PlanItem)),
      { id: '5', label: 'b', status: 'pending' },
    ] }), { done: 1, total: 2, inProgress: 0 });
  });

  it('unknown statuses count as pending: 1 completed + 3 unknown = 25%, not 100%', () => {
    const rows = [PROMPT, planRow('p', ['completed', 'blocked', 'waiting', 'mystery'], '2026-10-09T06:26:30.000Z')];
    const progress = progressOf(rows);
    assert.deepEqual([progress.done, progress.total], [1, 4]);
    assert.deepEqual(resolveOverallPercent(progress), { percent: 25, source: 'tasks' });
  });

  it('a snapshot with only excluded items shows no number (never 0%)', () => {
    const rows = [PROMPT, planRow('p', ['deleted', 'skipped'], '2026-10-09T06:26:30.000Z')];
    const progress = progressOf(rows);
    assert.equal(progress.total, 0);
    assert.equal(resolveOverallPercent(progress), null);
  });

  it('a newer all-excluded snapshot replaces an older counted one', () => {
    const rows = [
      PROMPT,
      planRow('p1', ['completed', 'pending'], '2026-10-09T06:26:30.000Z'),
      planRow('p2', ['deleted'], '2026-10-09T06:26:31.000Z'),
    ];
    assert.equal(resolveOverallPercent(progressOf(rows)), null);
  });

  it('a sub-agent child plan reaches the counter through its parent', () => {
    const rows: NormalizedMessage[] = [
      ...liveUpTo(5),
      { ...planRow('child', ['completed', 'in_progress', 'pending'], '2026-10-09T06:26:33.000Z'), parentToolUseId: FIXTURE_IDS.AGENT_LIVE },
    ];
    const progress = progressOf(rows);
    assert.deepEqual([progress.done, progress.inProgress, progress.total], [1, 1, 3]);
  });
});

describe('ADR-199 neutral subagent lifecycle', () => {
  it('live: a background launch stays running and is the active sub-agent', () => {
    const progress = progressOf(LIVE_STREAM_ROWS);
    assert.equal(progress.agents.length, 1);
    assert.equal(progress.agents[0].id, FIXTURE_IDS.AGENT_LIVE);
    assert.equal(progress.agents[0].status, 'running');
    assert.equal(progress.agents[0].type, 'general-purpose');
    assert.equal(progress.agents[0].description, 'Reply OK');
    assert.ok(progress.activeSubagent);
    assert.equal(progress.agentsDone, 0);
  });

  it('history: completed and failed both settle the sub-agent', () => {
    const progress = progressOf(HISTORY_ROWS);
    assert.deepEqual(progress.agents.map((a) => [a.id, a.status, a.outcome]), [
      [FIXTURE_IDS.AGENT_DONE, 'done', 'completed'],
      [FIXTURE_IDS.AGENT_DENIED, 'done', 'failed'],
    ]);
    assert.deepEqual([progress.agentsDone, progress.agentsUnsuccessful], [1, 1]);
    assert.equal(progress.activeSubagent, null);
  });

  it('the result row state wins over the call state', () => {
    const chat = normalizedToChatMessages(HISTORY_ROWS);
    const denied = chat.find((m) => m.toolId === FIXTURE_IDS.AGENT_DENIED);
    assert.equal(denied?.subagent?.state, 'failed');
    assert.equal(denied?.isSubagentContainer, true);
  });

  it('an inline result without its result row still settles the call', () => {
    const [prompt, call, result] = HISTORY_ROWS;
    const inline = { ...call, toolResult: { content: String(result.content), isError: false } } as NormalizedMessage;
    const chat = normalizedToChatMessages([prompt, inline]);
    assert.equal(chat[1].subagent?.state, 'completed');
  });

  it('a row with no neutral subagent field is not counted as a sub-agent', () => {
    const stripped = HISTORY_ROWS.map(({ subagent: _s, ...m }) => m as NormalizedMessage);
    assert.equal(progressOf(stripped).agentsTotal, 0);
  });

  it('without a subagent_type the type stays empty and the label is the neutral one', () => {
    const rows = HISTORY_ROWS.slice(0, 3).map((m) => (m.kind === 'tool_use' ? { ...m, toolInput: {} } : m));
    const agent = progressOf(rows as NormalizedMessage[]).agents[0];
    assert.equal(agent.type, '');
    assert.equal(agent.description, 'Diagnose send failure');
  });
});

describe('gateComputedProgress', () => {
  const live = () => progressOf(LIVE_STREAM_ROWS);

  it('keeps the computed counter when the provider emits a plan', () => {
    for (const timing of ['live', 'turn', 'history']) {
      assert.equal(gateComputedProgress(live(), timing).total, 2);
    }
  });

  it('hides only the computed counter for plan:none; declared percent and agents stay', () => {
    const base = { ...live(), declaredPercent: 40 };
    const gated = gateComputedProgress(base, 'none');
    assert.deepEqual([gated.done, gated.total, gated.inProgress], [0, 0, 0]);
    assert.equal(gated.declaredPercent, 40);
    assert.equal(gated.agents.length, 1);
    assert.deepEqual(resolveOverallPercent(gated), { percent: 40, source: 'declared' });
  });
});
