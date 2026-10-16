// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const fallback = String(options?.defaultValue ?? key);
      return fallback.replace(
        /\{\{(\w+)\}\}/g,
        (_match, name: string) => String(options?.[name] ?? ''),
      );
    },
    i18n: { language: 'en' },
  }),
}));

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import AgentStatusCard from '../view/subcomponents/AgentStatusCard';
import { normalizedToChatMessages } from './useChatMessages';
import { computeRunProgress } from './useRunProgress';

const SESSION = 'subagent-delta-test';
const AGENT_ID = 'agent-container-1';

function row(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: `row-${Math.random()}`,
    sessionId: SESSION,
    timestamp: '2026-10-16T00:00:00.000Z',
    provider: 'claude',
    kind: 'status',
    ...overrides,
  };
}

const tool = (id: string, name: string, status: string) => ({ id, name, status });

function status(id: string, state: 'running' | 'completed', tools: ReturnType<typeof tool>[]) {
  return row({
    id: `status-${id}-${state}-${tools.at(-1)?.id ?? 'none'}`,
    subagent: {
      id: AGENT_ID,
      parentId: null,
      label: 'three-tool task',
      agentName: 'general',
      state,
      tools,
    },
  });
}

function progress(rows: NormalizedMessage[]) {
  return computeRunProgress(normalizedToChatMessages(rows), true);
}

function renderAgent(rows: NormalizedMessage[]) {
  const runProgress = progress(rows);
  localStorage.setItem('nassaj:agentStatusCard:hideCompleted', '0');
  render(
    <AgentStatusCard
      agents={runProgress.agents}
      status={{ text: 'Working', can_interrupt: true }}
      onAbort={() => {}}
      isLoading={runProgress.agents.some((agent) => agent.status === 'running')}
      provider="claude"
      runStartedAt={null}
      progress={runProgress}
    />,
  );
  const button = screen.getByRole('button', { name: /general — (Running|Done)/ });
  fireEvent.click(button);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('incremental subagent tool status rows', () => {
  const deltas = [
    row({ id: 'container', kind: 'tool_use', toolId: AGENT_ID, toolName: 'Task', subagent: {
      id: AGENT_ID,
      parentId: null,
      label: 'three-tool task',
      agentName: 'general',
      state: 'running',
    } }),
    status('read', 'running', [tool('tool-read', 'Read', 'running')]),
    status('grep', 'running', [tool('tool-grep', 'Grep', 'running')]),
    status('edit', 'running', [tool('tool-edit', 'Edit', 'running')]),
  ];

  it('retains all three tools in the live card as per-event deltas arrive', () => {
    const current = progress(deltas).agents[0];
    expect(current.tools?.map(({ id, name }) => [id, name])).toEqual([
      ['tool-read', 'Read'], ['tool-grep', 'Grep'], ['tool-edit', 'Edit'],
    ]);
    renderAgent(deltas);
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('Grep')).toBeTruthy();
    expect(screen.getByText('Edit')).toBeTruthy();
  });

  it('updates tool statuses and keeps terminal state after a late running row', () => {
    const settled = [
      ...deltas,
      status('read', 'completed', [tool('tool-read', 'Read', 'completed')]),
      status('grep', 'completed', [tool('tool-grep', 'Grep', 'completed')]),
      status('edit', 'completed', [tool('tool-edit', 'Edit', 'completed')]),
      status('settled', 'completed', []),
      status('late', 'running', [tool('tool-edit', 'Edit', 'running')]),
    ];
    const agent = progress(settled).agents[0];
    expect(agent.status).toBe('done');
    expect(agent.tools?.map(({ id, status }) => [id, status])).toEqual([
      ['tool-read', 'completed'], ['tool-grep', 'completed'], ['tool-edit', 'completed'],
    ]);
    renderAgent(settled);
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('Grep')).toBeTruthy();
    expect(screen.getByText('Edit')).toBeTruthy();
  });
});
