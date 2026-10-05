/**
 * T-1904 (ADR-190) — the merged card (sub-agents present) must apply the same
 * viewer behaviour as ClaudeStatus: starter name instead of the provider
 * label, no STOP for a viewer under any circumstance, and a Steer pill only
 * when steerable. Both surfaces share RunStatusViewerActions.tsx, so this
 * guards that MergedCard actually wires it (not just ClaudeStatus).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = (opts?.defaultValue as string) ?? key;
      return typeof template === 'string'
        ? template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''))
        : template;
    },
    i18n: { language: 'en' },
  }),
}));

import type { RunAgent } from '../../hooks/useRunProgress';

import AgentStatusCard from './AgentStatusCard';

afterEach(cleanup);

const AGENT: RunAgent = {
  id: 'toolu_1',
  type: 'frontend-dev',
  description: 'fix the card',
  status: 'running',
  callCount: 3,
  startedAt: Date.now(),
};

describe('AgentStatusCard (MergedCard) — starter vs viewer', () => {
  it("the starter's own merged card is unchanged: STOP button present", () => {
    render(
      <AgentStatusCard
        agents={[AGENT]}
        status={{ text: 'Working', can_interrupt: true }}
        onAbort={vi.fn()}
        isLoading
        provider="claude"
        runStartedAt={null}
        progress={null}
      />,
    );
    expect(screen.getByRole('button', { name: /STOP/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Steer/i })).toBeNull();
  });

  it('a viewer of a merged card sees the starter name, never a STOP button', () => {
    render(
      <AgentStatusCard
        agents={[AGENT]}
        status={{ text: 'Working', can_interrupt: true }}
        onAbort={vi.fn()}
        isLoading
        provider="claude"
        runStartedAt={null}
        progress={null}
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable={false}
      />,
    );
    expect(screen.getByText('سارة')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /STOP/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Steer/i })).toBeNull();
  });

  it('a steerable viewer of a merged card gets the Steer pill, still never STOP', () => {
    const onSteerClick = vi.fn();
    render(
      <AgentStatusCard
        agents={[AGENT]}
        status={{ text: 'Working', can_interrupt: true }}
        onAbort={vi.fn()}
        isLoading
        provider="claude"
        runStartedAt={null}
        progress={null}
        viewerStarterName="محمد"
        isConfirmedStarter={false}
        steerable
        onSteerClick={onSteerClick}
      />,
    );
    expect(screen.queryByRole('button', { name: /STOP/i })).toBeNull();
    const steerButton = screen.getByRole('button', { name: /Steer/i });
    steerButton.click();
    expect(onSteerClick).toHaveBeenCalledTimes(1);
  });

  /**
   * T-1904 e2e (BLOCKER) — same fail-closed guard as ClaudeStatus: a late
   * joiner during the first turn must not see STOP on the merged (sub-agents)
   * card either, even with can_interrupt:true and onAbort present.
   */
  it('hides STOP when isConfirmedStarter is explicitly false', () => {
    render(
      <AgentStatusCard
        agents={[AGENT]}
        status={{ text: 'Working', can_interrupt: true }}
        onAbort={vi.fn()}
        isLoading
        provider="claude"
        runStartedAt={null}
        progress={null}
        isConfirmedStarter={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /STOP/i })).toBeNull();
  });
});

describe('AgentStatusCard (MergedCard) — /steer hint indicator (T-1956)', () => {
  it("shows the hint on the starter's own merged card; a click calls onSteerClick without toggling the card", () => {
    const onSteerClick = vi.fn();
    render(
      <AgentStatusCard
        agents={[AGENT]}
        status={{ text: 'Working', can_interrupt: true }}
        onAbort={vi.fn()}
        isLoading
        provider="claude"
        runStartedAt={null}
        progress={null}
        showSteerHint
        onSteerClick={onSteerClick}
      />,
    );
    const indicator = screen.getByTestId('run-status-steer-hint');
    const expandedBefore = document.querySelectorAll('[aria-expanded="true"]').length;
    fireEvent.click(indicator);
    expect(onSteerClick).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[aria-expanded="true"]').length).toBe(expandedBefore);
  });

  it('renders no hint indicator for a viewer', () => {
    render(
      <AgentStatusCard
        agents={[AGENT]}
        status={{ text: 'Working', can_interrupt: true }}
        onAbort={vi.fn()}
        isLoading
        provider="claude"
        runStartedAt={null}
        progress={null}
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable
        onSteerClick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('run-status-steer-hint')).toBeNull();
  });
});
