/**
 * ADR-199 Decision 18: a provider whose sub-agents arrive only once settled
 * (capability `subagents: 'turn'`, e.g. OpenCode) shows finished rows only,
 * says "Shown when finished", and shows no running indicator for them.
 *
 * Rule from AgentStatusCard.displayTruth.test.tsx: never pass a DOM node to
 * `node:assert` — compare primitives only.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = (opts?.defaultValue as string) ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));

import { gateTurnSubagents, type RunProgress } from '../../hooks/useRunProgress';

import AgentStatusCard from './AgentStatusCard';

beforeEach(() => {
  // Show completed rows so the finished agent itself is rendered.
  localStorage.setItem('nassaj:agentStatusCard:hideCompleted', '0');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const SCANNED: RunProgress = {
  done: 0,
  total: 0,
  inProgress: 0,
  agentsTotal: 2,
  agentsDone: 1,
  activeSubagent: { callCount: 0 },
  agents: [
    { id: 'call_done', type: 'general', description: 'Read a.txt content', status: 'done', callCount: 0, startedAt: 1 },
    { id: 'call_live', type: 'general', description: 'still going', status: 'running', callCount: 0, startedAt: 2 },
  ],
  declaredPercent: null,
};

function renderCard(progress: RunProgress) {
  return render(
    <AgentStatusCard
      agents={progress.agents}
      status={{ text: 'Working', can_interrupt: true }}
      onAbort={() => {}}
      isLoading
      provider="opencode"
      runStartedAt={null}
      progress={progress}
    />,
  );
}

describe('turn sub-agents on the card', () => {
  it('shows the finished row with the finished label and no running indicator', () => {
    renderCard(gateTurnSubagents(SCANNED, 'turn'));
    const caption = screen.getByTestId('agents-shown-when-finished');
    assert.equal(caption.textContent, 'Shown when finished');
    const rows = caption.parentElement as HTMLElement;
    assert.equal(rows.querySelectorAll('.animate-pulse').length, 0);
    assert.equal((rows.textContent ?? '').includes('Read a.txt content'), true);
    assert.equal((rows.textContent ?? '').includes('still going'), false);
    assert.equal(screen.queryByText(/running$/), null);
    assert.equal(screen.getAllByRole('button', { name: /general — Done/ }).length, 1);
  });

  it('a live provider keeps its running row and shows no finished label', () => {
    renderCard(gateTurnSubagents(SCANNED, 'live'));
    assert.equal(screen.queryByTestId('agents-shown-when-finished'), null);
    assert.equal(screen.getAllByRole('button', { name: /general — Running/ }).length, 1);
  });
});
