// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const value = String(options?.defaultValue ?? key);
      return value.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(options?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));

import fixture from './__fixtures__/claude-agent-card-three-tools.real.json';
import type { NormalizedMessage } from '../../../../stores/useSessionStore';
import AgentStatusCard from './AgentStatusCard';
import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import { computeRunProgress } from '../../hooks/useRunProgress';

const claudeProgress = await vi.importActual<{
  claudeToolUseProgress: (...args: any[]) => Record<string, unknown>;
  createClaudeSubagentTracker: () => {
    observe: (raw: Record<string, unknown>, rows: NormalizedMessage[]) => unknown[];
    settle: (toolUseId: string, state: string) => unknown;
  };
}>(
  '../../../../../server/modules/providers/list/claude/claude-progress.js',
);
const { claudeToolUseProgress, createClaudeSubagentTracker } = claudeProgress;

const sessionId = 'claude-agent-card-fixture';
const agentId = fixture.meta.toolUseId;
const toolIds = fixture.events.flatMap((event) => event.message.content
  .filter((part: Record<string, any>) => part.type === 'tool_use')
  .map((part: Record<string, any>) => part.id));

function launchRows(tracker: ReturnType<typeof createClaudeSubagentTracker>): NormalizedMessage[] {
  const timestamp = '2026-10-13T21:10:00.000Z';
  const input = {
    subagent_type: fixture.meta.agentType,
    description: 'Scrubbed real child tool run',
  };
  const progress = claudeToolUseProgress('Agent', agentId, input, null);
  const raw = { type: 'assistant', uuid: 'fixture-parent-launch' };
  const rows = [{ id: raw.uuid, sessionId, provider: 'claude' as const, timestamp,
    kind: 'tool_use' as const, role: 'assistant' as const, toolName: 'Agent', toolId: agentId,
    toolInput: input, ...progress } as NormalizedMessage];
  tracker.observe(raw, rows);
  return rows;
}

function normalizeChildEvent(event: Record<string, any>): NormalizedMessage[] {
  const block = event.message.content[0];
  const common = { id: event.uuid, sessionId, provider: 'claude' as const,
    timestamp: event.timestamp, parentToolUseId: agentId };
  return event.message.role === 'assistant'
    ? [{ ...common, kind: 'tool_use', role: 'assistant', toolId: block.id,
      toolName: block.name, toolInput: block.input } as NormalizedMessage]
    : [{ ...common, kind: 'tool_result', role: 'user', toolId: block.tool_use_id,
      content: block.content, isError: Boolean(block.is_error) } as NormalizedMessage];
}

/** Output shape emitted by `parseAgentTools`: each real child use pairs with its result. */
function parseAgentTools(events: Array<Record<string, any>>) {
  const tools: Array<Record<string, any>> = [];
  for (const event of events) {
    for (const part of event.message.content) {
      if (event.message.role === 'assistant' && part.type === 'tool_use') {
        tools.push({ toolId: part.id, toolName: part.name, toolInput: part.input,
          timestamp: event.timestamp });
      } else if (event.message.role === 'user' && part.type === 'tool_result') {
        const tool = tools.find((item) => item.toolId === part.tool_use_id);
        if (tool) tool.toolResult = { content: part.content, isError: Boolean(part.is_error) };
      }
    }
  }
  return tools;
}

function liveRows(completed: boolean): NormalizedMessage[] {
  const tracker = createClaudeSubagentTracker();
  const rows = launchRows(tracker);
  for (const event of fixture.events) {
    const raw = { ...event, sessionId, parent_tool_use_id: agentId };
    const normalized = normalizeChildEvent(event);
    const updates = tracker.observe(raw, normalized);
    rows.push(...normalized, ...updates.map((subagent, index) => ({
      id: `${event.uuid}-progress-${index}`, sessionId, provider: 'claude' as const,
      timestamp: event.timestamp, kind: 'status' as const, subagent,
    } as NormalizedMessage)));
  }
  if (completed) {
    const settlement = tracker.settle(agentId, 'completed');
    expect(settlement).toBeTruthy();
    rows.push({ id: 'fixture-settled', sessionId, provider: 'claude', kind: 'status',
      timestamp: '2026-10-13T21:11:00.000Z', subagent: settlement } as NormalizedMessage);
  }
  return rows;
}

function historyRows(): NormalizedMessage[] {
  const tracker = createClaudeSubagentTracker();
  const rows = launchRows(tracker);
  const raw = {
    type: 'user', uuid: 'fixture-parent-result', sessionId,
    timestamp: '2026-10-13T21:11:00.000Z',
    toolUseResult: { status: 'completed', agentId: 'fixture-agent-id' },
    subagentTools: parseAgentTools(fixture.events),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: agentId,
      content: '[scrubbed result]', is_error: false }] },
  };
  const normalized = [{ id: raw.uuid, sessionId, provider: 'claude' as const,
    timestamp: raw.timestamp, kind: 'tool_result' as const, role: 'user' as const,
    toolId: agentId, content: '[scrubbed result]', toolUseResult: raw.toolUseResult,
    subagentTools: raw.subagentTools } as NormalizedMessage];
  tracker.observe(raw, normalized);
  rows.push(...normalized);
  return rows;
}

function cardToolIds(rows: NormalizedMessage[]): string[] {
  const clientRows = rows as unknown as NormalizedMessage[];
  const progress = computeRunProgress(normalizedToChatMessages(clientRows), true);
  expect(progress.agents).toHaveLength(1);
  return progress.agents[0].tools?.map((tool) => tool.id ?? '') ?? [];
}

function renderCard(rows: NormalizedMessage[]) {
  const clientRows = rows as unknown as NormalizedMessage[];
  const progress = computeRunProgress(normalizedToChatMessages(clientRows), true);
  localStorage.setItem('nassaj:agentStatusCard:hideCompleted', '0');
  const rendered = render(
    <AgentStatusCard agents={progress.agents} status={{ text: 'Working', can_interrupt: true }}
    onAbort={() => {}} isLoading={progress.agents.some((agent) => agent.status === 'running')}
    provider="claude" runStartedAt={null} progress={progress} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /qa-critic — (Running|Done)/ }));
  return { progress, container: rendered.container };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it('keeps exactly the three real child tools live, settled, and after history reload', () => {
  expect(toolIds).toHaveLength(3);
  expect(new Set(toolIds).size).toBe(3);

  for (const [label, rows] of [
    ['running', liveRows(false)],
    ['completed', liveRows(true)],
    ['history reload', historyRows()],
  ] as const) {
    const ids = cardToolIds(rows);
    expect(ids, `${label}: preserve the three original child tool ids once`).toEqual(toolIds);
    const { progress, container } = renderCard(rows);
    expect(progress.agents[0].tools).toHaveLength(3);
    expect(container.querySelectorAll('ul li')).toHaveLength(3);
    cleanup();
  }
});
