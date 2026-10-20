/**
 * Agent-progress P0 on the client, from rows the server's live path really
 * emits (__fixtures__/claude-task-plan-live.real.json): the inferred
 * `unknown`/`stopped (owner)` records the server sends at process exit, and the
 * rule that a late measured end overrides them (never the reverse).
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      String((opts?.defaultValue as string) ?? key).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? '')),
    i18n: { language: 'en' },
  }),
}));

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { SubagentContainer } from '../tools/components/SubagentContainer';

import historyExit from './__fixtures__/claude-subagent-history-exit.server.json';
import capture from './__fixtures__/claude-task-plan-live.real.json';
import { resolveOverallPercent } from './declaredProgress';
import { normalizedToChatMessages } from './useChatMessages';
import { useRunProgress } from './useRunProgress';

const ROWS = capture.rows as unknown as NormalizedMessage[];
const AGENT = 'toolu_01H48H2qDEZsGjV6DhgMGGrh';
const BEFORE_SETTLEMENT = ROWS.slice(0, ROWS.findIndex((m) => m.kind === 'status'));
const REAL_SETTLEMENT = ROWS.find((m) => m.kind === 'status' && m.subagent?.id === AGENT)!;

afterEach(() => cleanup());

/** The status row the server sends for `AGENT` at process exit (ClaudeProgressFold.processExit). */
function exitRow(state: 'unknown' | 'stopped', cause: 'process-exit' | 'owner'): NormalizedMessage {
  const base = BEFORE_SETTLEMENT.find((m) => m.kind === 'tool_use' && m.toolId === AGENT)!;
  return { id: `exit_${AGENT}_${state}`, sessionId: base.sessionId, provider: 'claude', kind: 'status',
    timestamp: '2026-10-18T00:00:00.000Z', subagent: { ...base.subagent!, state, inferredCause: cause } } as NormalizedMessage;
}

function agentOf(rows: NormalizedMessage[]) {
  const chat = normalizedToChatMessages(rows);
  const progress = renderHook(() => useRunProgress(chat, true)).result.current;
  return { progress, row: progress.agents.find((a) => a.id === AGENT), container: chat.find((m) => m.toolId === AGENT) };
}

describe('sub-agent outcomes (P0)', () => {
  it('(b) an unsettled background agent stays running (turn end settles nothing)', () => {
    const { row } = agentOf(BEFORE_SETTLEMENT);
    expect(row?.status).toBe('running');
    expect(row?.outcome).toBeUndefined();
  });

  it('(c) the process-exit record ends it as unknown; it is not counted as done', () => {
    const { progress, row, container } = agentOf([...BEFORE_SETTLEMENT, exitRow('unknown', 'process-exit')]);
    expect([row?.status, row?.outcome, row?.outcomeCause]).toEqual(['done', 'unknown', 'process-exit']);
    expect(progress.agentsDone).toBe(0);
    expect(progress.agentsUnsuccessful).toBe(1);
    expect(container?.subagentState?.isComplete).toBe(true);
    expect(resolveOverallPercent({ ...progress, total: 0, declaredPercent: null })).toBeNull();
  });

  it('(d) an owner STOP record ends it as stopped (owner)', () => {
    const { row } = agentOf([...BEFORE_SETTLEMENT, exitRow('stopped', 'owner')]);
    expect([row?.outcome, row?.outcomeCause]).toEqual(['stopped', 'owner']);
  });

  it('(e) a late measured end overrides unknown, and unknown never overrides it', () => {
    const late = agentOf([...BEFORE_SETTLEMENT, exitRow('unknown', 'process-exit'), REAL_SETTLEMENT]).row;
    expect([late?.outcome, late?.outcomeCause]).toEqual(['completed', undefined]);
    const after = agentOf([...BEFORE_SETTLEMENT, REAL_SETTLEMENT, exitRow('unknown', 'process-exit')]).row;
    expect(after?.outcome).toBe('completed');
  });

  it('(c) history: the inferred end on the launch-ack row (no status row) completes the container', () => {
    const rows = historyExit.rows as unknown as NormalizedMessage[];
    const id = rows[0].toolId!;
    const container = normalizedToChatMessages(rows).find((m) => m.toolId === id)!;
    expect(container.subagentState?.isComplete).toBe(true);
    expect(container.subagent?.state).toBe('unknown');
    render(<SubagentContainer toolInput={container.toolInput} toolResult={container.toolResult}
      subagentState={container.subagentState!} subagent={container.subagent} />);
    expect(screen.getByTestId('subagent-outcome').textContent).toContain('No end signal');
    expect(screen.queryByText('subagent.currently')).toBeNull();
  });

  it('(f) a failed or unknown container never shows the success line', () => {
    const { container } = agentOf([...BEFORE_SETTLEMENT, exitRow('unknown', 'process-exit')]);
    render(<SubagentContainer toolInput={container!.toolInput} toolResult={container!.toolResult}
      subagentState={container!.subagentState!} subagent={container!.subagent} />);
    expect(screen.getByTestId('subagent-outcome').textContent).toContain('No end signal');
    expect(screen.getByTestId('subagent-outcome-cause').textContent).toMatch(/process ended/);
    expect(screen.queryByText(/^Completed/)).toBeNull();
  });
});
