/**
 * T-1904 e2e (BLOCKER) — regression: a viewer joining a session during its
 * first (or any) turn, before starter identity is confirmed, must NEVER see
 * the STOP control. The old signal defaulted OPEN ("assume I'm the starter")
 * whenever `steer-turn-state.starterUserId` was still unknown; this is
 * exactly the case a late joiner hits. `isConfirmedStarter` must be an
 * explicit, fail-closed prop — ClaudeStatus/MergedCard never infer it.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

import ClaudeStatus from './ClaudeStatus';

afterEach(cleanup);

describe('ClaudeStatus — isConfirmedStarter (fail-closed)', () => {
  it('hides STOP when isConfirmedStarter is explicitly false, even with can_interrupt:true and onAbort present', () => {
    render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        onAbort={vi.fn()}
        isConfirmedStarter={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /STOP/i })).toBeNull();
  });

  it('shows STOP when isConfirmedStarter is explicitly true (the real starter, confirmed)', () => {
    render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        onAbort={vi.fn()}
        isConfirmedStarter
      />,
    );
    expect(screen.getByRole('button', { name: /STOP/i })).toBeTruthy();
  });

  it('defaults to legacy (STOP shown) only when the caller omits the prop entirely', () => {
    render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        onAbort={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /STOP/i })).toBeTruthy();
  });
});
