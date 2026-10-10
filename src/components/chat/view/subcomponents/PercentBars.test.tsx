/**
 * Live completion percent on the main status bar (ClaudeStatus) and the
 * sub-agent card (AgentStatusCard). Rules under test:
 *  - TodoWrite fraction -> percent rides in the Tasks chip (computed, not "declared")
 *  - no todos -> coordinator's declared line, in its own chip marked as declared
 *  - nothing known -> nothing rendered (never a fabricated 0%)
 *  - agent rows: running = declared pill; done = 100; running without prose = hidden
 *
 * Only primitives are compared (see the note in AgentStatusCard.displayTruth.test.tsx).
 * RUNNER: vitest — jsdom.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = (opts?.defaultValue as string) ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));

import type { RunAgent, RunProgress } from '../../hooks/useRunProgress';

import AgentStatusCard from './AgentStatusCard';
import ClaudeStatus from './ClaudeStatus';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const noAgents: RunProgress = {
  done: 0, total: 0, inProgress: 0, agentsTotal: 0, agentsDone: 0,
  activeSubagent: null, agents: [], declaredPercent: null,
};

function agent(overrides: Partial<RunAgent>): RunAgent {
  return {
    id: 'a1', type: 'frontend-dev', description: 'build', status: 'running',
    callCount: 0, startedAt: 1, ...overrides,
  };
}

function renderMain(progress: RunProgress) {
  return render(<ClaudeStatus status={{ text: 'Working' }} isLoading provider="claude" progress={progress} />);
}

function renderCard(progress: RunProgress) {
  return render(
    <AgentStatusCard
      agents={progress.agents}
      status={{ text: 'Working' }}
      isLoading
      provider="claude"
      progress={progress}
    />,
  );
}

describe('main bar (ClaudeStatus)', () => {
  it('shows the computed percent inside the Tasks chip', () => {
    renderMain({ ...noAgents, done: 1, total: 4 });
    expect(screen.getByTestId('tasks-percent').textContent).toBe('25%');
    // narrow-screen twin is computed, not declared
    expect(screen.getByTestId('overall-percent').getAttribute('data-declared')).toBe('false');
  });

  it('falls back to the declared coordinator percent, marked as declared', () => {
    renderMain({ ...noAgents, declaredPercent: 60 });
    const chip = screen.getByTestId('overall-percent');
    expect(chip.getAttribute('data-declared')).toBe('true');
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('60');
    expect((bar.getAttribute('aria-label') ?? '').includes('Reported by the agent')).toBe(true);
  });

  it('keeps the declared wording in the DOM for screen readers when the bar is hidden', () => {
    renderMain({ ...noAgents, declaredPercent: 60 });
    const chip = screen.getByTestId('overall-percent');
    expect(chip.querySelector('.sr-only')?.textContent).toBe('Reported by the agent');
  });

  it('renders nothing when no percent is known (no fabricated 0%)', () => {
    renderMain(noAgents);
    expect(screen.queryByTestId('overall-percent')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('sub-agent card (AgentStatusCard)', () => {
  it('shows a declared pill for a running agent and the done/next note when expanded', () => {
    const agents = [agent({ progress: { percent: 40, done: 'schema', next: 'UI', left: 7 } })];
    renderCard({ ...noAgents, agents, agentsTotal: 1 });
    const pill = screen.getByTestId('agent-percent');
    expect(pill.textContent).toContain('40%');
    expect(pill.getAttribute('data-declared')).toBe('true');
    expect(screen.getByTestId('overall-percent').textContent).toContain('40%');
    fireEvent.click(screen.getAllByRole('button').find(b => (b.getAttribute('aria-label') ?? '').startsWith('frontend-dev'))!);
    const note = screen.getByTestId('agent-declared-note');
    expect(note.textContent).toContain('schema');
    expect(note.textContent).toContain('UI');
    expect(note.textContent).toContain('~7 min left');
  });

  it('hides percent for a running agent without prose (page refresh), header included', () => {
    renderCard({ ...noAgents, agents: [agent({})], agentsTotal: 1 });
    expect(screen.queryByTestId('agent-percent')).toBeNull();
    expect(screen.queryByTestId('overall-percent')).toBeNull();
  });

  it('a done agent shows 100% computed (not declared)', () => {
    localStorage.setItem('nassaj:agentStatusCard:hideCompleted', '0');
    renderCard({ ...noAgents, agents: [agent({ status: 'done' })], agentsTotal: 1, agentsDone: 1 });
    const pill = screen.getByTestId('agent-percent');
    expect(pill.textContent).toContain('100%');
    expect(pill.getAttribute('data-declared')).toBe('false');
  });

  it('header prefers the TodoWrite percent over agent averages', () => {
    const agents = [agent({ progress: { percent: 10 } })];
    renderCard({ ...noAgents, agents, agentsTotal: 1, done: 2, total: 4 });
    expect(screen.getByTestId('tasks-percent').textContent).toBe('50%');
  });
});
