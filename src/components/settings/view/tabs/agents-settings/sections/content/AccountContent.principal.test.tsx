/**
 * T-2083 (ADR-152 A1 §3.9) — the account card says WHOSE credential the agent
 * runs on, in three states: your own account, shared with you by <username>
 * (from `grantedBy`), or not linked with the way to link. It never shows
 * another person's email, and an owner-role account is asked to link like
 * everyone else (D2: nobody inherits the operator's credential).
 * RUNNER: vitest (jsdom).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let role = 'user';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (
      options && 'username' in options ? `${key}:${String(options.username)}`
        : options && 'email' in options ? `${key}:${String(options.email)}`
          : key
    ),
    i18n: { language: 'ar' },
  }),
}));
vi.mock('../../../../../../auth/context/AuthContext', () => ({ useOptionalAuth: () => ({ user: { role } }) }));
vi.mock('../../../../../../../hooks/useHarnessInstall', () => ({
  useHarnessInstall: () => ({ state: { status: 'idle', percent: 0, log: [] }, start: vi.fn(), cancel: vi.fn() }),
}));
vi.mock('../../../../../../quick-settings-panel/hooks/useProviderCycles', () => ({ useProviderCycles: () => ({ status: 'idle' }) }));
vi.mock('./LinkModeSection', () => ({ default: () => null }));

import type { AuthStatus } from '../../../../../types/types';

import AccountContent, { type UserCredentialLink } from './AccountContent';

const base: AuthStatus = {
  authenticated: true, installed: true, email: 'me@example.com', method: 'oauth',
  error: null, loading: false, checkFailed: false, grantedBy: null,
};

const unlinked = (): UserCredentialLink => ({
  connected: false, loading: false, error: null,
  i18nPrefix: 'claudeConnection', command: 'claude auth login', onLink: () => {}, onRecheck: () => {},
});

function mount(authStatus: AuthStatus, userLink?: UserCredentialLink) {
  return render(
    <AccountContent agent="claude" authStatus={authStatus} onLogin={() => {}} userLink={userLink} />,
  );
}

describe('AccountContent — whose credential the agent runs on', () => {
  afterEach(() => { cleanup(); role = 'user'; });

  it('own account: says so, with the member\'s own email', () => {
    mount(base);
    expect(screen.getByText(/providerStatus\.own/)).toBeTruthy();
    expect(screen.getByText(/me@example\.com/)).toBeTruthy();
  });

  it('granted: names the grantor and never shows an email', () => {
    // A server bug that still sent the grantor's email must not reach the screen.
    mount({ ...base, email: 'grantor@example.com', grantedBy: { userId: 1, username: 'ibrahim' } });
    expect(screen.getByText(/providerStatus\.grantedBy:.*ibrahim/)).toBeTruthy();
    expect(screen.queryByText(/grantor@example\.com/)).toBeNull();
    expect(screen.queryByText(/providerStatus\.own/)).toBeNull();
  });

  it('granted on a member with no own link: no contradictory "link your account" alert', () => {
    mount({ ...base, email: null, grantedBy: { userId: 1, username: 'ibrahim' } }, unlinked());
    expect(screen.getByText(/providerStatus\.grantedBy/)).toBeTruthy();
    expect(screen.queryByText('claudeConnection.banner')).toBeNull();
  });

  it('not linked: says so and offers the link action', () => {
    mount({ ...base, authenticated: false, email: null }, unlinked());
    expect(screen.getByText('providerStatus.notLinked')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'claudeConnection.linkButton' })).toBeTruthy();
  });

  it('an owner-role account that is not linked is asked to link too', () => {
    role = 'owner';
    mount({ ...base, authenticated: false, email: null }, unlinked());
    expect(screen.getByText('claudeConnection.banner')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'claudeConnection.linkButton' })).toBeTruthy();
  });
});
