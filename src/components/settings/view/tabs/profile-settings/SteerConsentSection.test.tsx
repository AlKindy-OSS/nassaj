/**
 * T-1904 e2e (bug 4) — when the server-wide steer policy is `off`, the
 * personal consent toggle must show disabled with an explicit note instead
 * of silently rendering "on" with no hint that it has no effect.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => String(options?.defaultValue ?? key),
  }),
}));

const { getSteerConsent, getSteerPolicy, putSteerConsent } = vi.hoisted(() => ({
  getSteerConsent: vi.fn(),
  getSteerPolicy: vi.fn(),
  putSteerConsent: vi.fn(),
}));
vi.mock('../../../../session-steer/sessionSteerApi', () => ({
  getSteerConsent,
  getSteerPolicy,
  putSteerConsent,
}));

import SteerConsentSection from './SteerConsentSection';

afterEach(cleanup);
beforeEach(() => {
  getSteerConsent.mockReset();
  getSteerPolicy.mockReset();
  putSteerConsent.mockReset();
});

describe('SteerConsentSection — global policy off', () => {
  it('is enabled and reflects the saved value when the global policy is per_user', async () => {
    getSteerConsent.mockResolvedValue({ allowSteerOnMyRuns: true });
    getSteerPolicy.mockResolvedValue({ mode: 'per_user' });
    render(<SteerConsentSection />);

    const toggle = await waitFor(() => screen.getByRole('switch'));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText(/owner\/admin turned this feature off/i)).toBeNull();
  });

  it('shows disabled and a note when the global policy is off, even if consent was on', async () => {
    getSteerConsent.mockResolvedValue({ allowSteerOnMyRuns: true });
    getSteerPolicy.mockResolvedValue({ mode: 'off' });
    render(<SteerConsentSection />);

    await waitFor(() => expect(screen.getByText(/owner\/admin turned this feature off/i)).not.toBeNull());
    const toggle = screen.getByRole('switch');
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});
