import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mirrors i18next: a key with no translation falls back to `defaultValue`.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'contextRot.empty') return 'No token usage yet';
      return (options?.defaultValue as string) ?? key;
    },
    i18n: { language: 'en' },
  }),
}));

import TokenUsageSummary from './TokenUsageSummary';

afterEach(cleanup);

/**
 * B-823: a failed usage lookup and a brand-new session both arrive without a
 * context window, but they mean opposite things. Rendering the failure as "No
 * token usage yet" is what hid a server-side 404 for weeks.
 */
describe('Context usage — failed lookup vs. genuine zero', () => {
  it('says usage is unavailable when the lookup failed', () => {
    render(<TokenUsageSummary usage={{ unavailable: true, reason: 'transcript_unavailable', status: 404 }} />);

    const trigger = screen.getByRole('button', { name: 'Context usage unavailable' });
    expect(trigger.textContent).toContain('?');
    expect(trigger.textContent).not.toContain('—');
    expect(trigger.querySelector('svg')?.getAttribute('class')).toContain('text-warning');
  });

  it('still says "no token usage yet" for a session that has simply not run', () => {
    render(<TokenUsageSummary usage={null} />);

    const trigger = screen.getByRole('button', { name: 'No token usage yet' });
    expect(trigger.textContent).toContain('—');
    expect(trigger.querySelector('svg')?.getAttribute('class')).toContain('text-success');
  });
});
