/** ADR-156 WI-6 (T-1718): the permanent degraded banner. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';

import DegradedNotice from './DegradedNotice';

const t = ((key: string, options?: { defaultValue?: string }) =>
  key === 'degraded.reasons.some_future_reason' ? options?.defaultValue ?? key : key) as unknown as TFunction;

afterEach(cleanup);

describe('DegradedNotice', () => {
  it('renders nothing while the node is healthy', () => {
    const { container } = render(<DegradedNotice reason={null} t={t} />);
    expect(container.innerHTML).toBe('');
  });

  it('announces the state and names the reason', () => {
    render(<DegradedNotice reason="manual_recovery_required" t={t} />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('degraded.title');
    expect(banner.textContent).toContain('degraded.reasons.manual_recovery_required');
  });

  it('offers no dismiss control — it clears only when the condition does', () => {
    render(<DegradedNotice reason="source_update_maintenance" t={t} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('gives source_state_unreconciled its governed operator command, LTR and copyable', () => {
    render(<DegradedNotice reason="source_state_unreconciled" t={t} />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('degraded.reasons.source_state_unreconciled');
    expect(banner.textContent).toContain('degraded.operatorAction');
    const command = screen.getByText('npm run doctor -- --reopen-gate --complete-source-rollback --yes');
    expect(command.tagName).toBe('CODE');
    expect(command.getAttribute('dir')).toBe('ltr');
    // The only control is the copy action — still no dismiss.
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('degraded.copyCommandAria');
  });

  it('shows no operator command for reasons without a governed one', () => {
    render(<DegradedNotice reason="manual_recovery_required" t={t} />);
    expect(screen.queryByText(/--reopen-gate/)).toBeNull();
  });

  it('uses logical inset properties so the accent edge follows reading direction', () => {
    render(<DegradedNotice reason="source_update_maintenance" t={t} />);
    const className = screen.getByRole('status').className;
    expect(className).toContain('border-s-4');
    expect(className).not.toMatch(/\b(border-l-|border-r-|text-left|text-right)/);
  });
});
