/**
 * T-1904 (ADR-190) — the running status bar for a viewer who is NOT this
 * run's starter: the starter's name replaces the "CLAUDE" label, the Steer
 * pill shows only when steerable, and STOP never renders for a viewer.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TRANSLATIONS: Record<string, string> = { 'messageTypes.claude': 'CLAUDE' };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; name?: string }) => {
      const dv = TRANSLATIONS[key] ?? options?.defaultValue ?? key;
      return options?.name ? dv.replace('{{name}}', options.name) : dv;
    },
    i18n: { language: 'en' },
  }),
}));

import ClaudeStatus from './ClaudeStatus';

afterEach(cleanup);

describe('ClaudeStatus — starter vs viewer', () => {
  it("the starter's own bar is unchanged: CLAUDE label + STOP button", () => {
    const onAbort = vi.fn();
    render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        onAbort={onAbort}
      />,
    );
    expect(screen.getByText('CLAUDE')).toBeTruthy();
    expect(screen.getByRole('button', { name: /STOP/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Steer/i })).toBeNull();
  });

  it('a viewer sees the starter name instead of CLAUDE, and never a STOP button', () => {
    const onAbort = vi.fn();
    render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        onAbort={onAbort}
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable={false}
      />,
    );
    expect(screen.getByText('سارة')).toBeTruthy();
    expect(screen.queryByText('CLAUDE')).toBeNull();
    expect(screen.queryByRole('button', { name: /STOP/i })).toBeNull();
  });

  it('the Steer button shows only when steerable, and calls onSteerClick', () => {
    const onSteerClick = vi.fn();
    const { rerender } = render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable={false}
        onSteerClick={onSteerClick}
      />,
    );
    expect(screen.queryByRole('button', { name: /Steer/i })).toBeNull();

    rerender(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable
        onSteerClick={onSteerClick}
      />,
    );
    const steerButton = screen.getByRole('button', { name: /Steer/i });
    steerButton.click();
    expect(onSteerClick).toHaveBeenCalledTimes(1);
  });

  /**
   * T-1904 e2e (BLOCKER, bug 1) — a viewer who was already on the page before
   * the turn started never gets `isLoading:true` locally, but the arrival of
   * `steer-turn-state` (now delivered reliably, see useSessionSteer) is
   * itself proof a run is active: `runActiveOverride` must still surface the
   * bar (name + Steer button) instead of rendering nothing at all.
   */
  it('renders the bar via runActiveOverride even when isLoading is false', () => {
    const onSteerClick = vi.fn();
    const { container } = render(
      <ClaudeStatus
        status={null}
        isLoading={false}
        provider="claude"
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable
        onSteerClick={onSteerClick}
        runActiveOverride
      />,
    );
    expect(container.innerHTML).not.toBe('');
    expect(screen.getByText('سارة')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Steer/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /STOP/i })).toBeNull();
  });

  it('renders nothing when isLoading is false and there is no override (unchanged baseline)', () => {
    const { container } = render(
      <ClaudeStatus status={null} isLoading={false} provider="claude" />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('STOP is never shown for a viewer even when can_interrupt is true', () => {
    render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        onAbort={vi.fn()}
        viewerStarterName="محمد"
        isConfirmedStarter={false}
        steerable
        onSteerClick={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /STOP/i })).toBeNull();
  });
});
