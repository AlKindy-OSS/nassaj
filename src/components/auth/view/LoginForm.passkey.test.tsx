import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enAuth from '../../../i18n/locales/en/auth.json';

// Wording of a failed passkey sign-in on the login form. Wallet mode
// (ADR-163 amendment 1) refuses an account under forced password rotation with
// `password_change_required`; every other refusal stays generic.

function lookup(key: string): string {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    enAuth,
  );
  return typeof value === 'string' ? value : key;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => lookup(key) }),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ login: vi.fn() }),
}));
const passkeyMock = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock('../hooks/useWebAuthn', () => ({
  useWebAuthn: () => ({ isSupported: true, loginWithPasskey: passkeyMock.login }),
}));
vi.mock('../../../contexts/BrandingContext', () => ({
  useBranding: () => ({ title: null }),
}));
vi.mock('./AuthScreenLayout', () => ({
  default: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../oidc', () => ({
  detectSsoStatus: async () => ({ loginAvailable: false, state: 'off' }),
  startOidcLogin: () => undefined,
}));

import LoginForm from './LoginForm';

async function clickPasskey() {
  render(<LoginForm />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: enAuth.passkey.loginButton }));
  });
}

beforeEach(() => {
  passkeyMock.login.mockReset();
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LoginForm passkey refusal wording', () => {
  it('tells a member under forced rotation to sign in with the password', async () => {
    passkeyMock.login.mockResolvedValue({
      success: false, kind: 'failed', error: 'server text', code: 'password_change_required',
    });
    await clickPasskey();
    expect(screen.getByText(enAuth.passkey.errors.passwordChangeRequired)).toBeTruthy();
    expect(screen.queryByText('server text')).toBeNull();
  });

  it('keeps an origin refusal generic', async () => {
    passkeyMock.login.mockResolvedValue({
      success: false, kind: 'failed', error: 'Request rejected', code: 'origin_rejected',
    });
    await clickPasskey();
    expect(screen.getByText(enAuth.passkey.errors.failed)).toBeTruthy();
  });

  it('stays silent when the member dismisses the prompt', async () => {
    passkeyMock.login.mockResolvedValue({ success: false, kind: 'cancelled' });
    await clickPasskey();
    expect(screen.queryByText(enAuth.passkey.errors.failed)).toBeNull();
    expect(screen.queryByText(enAuth.passkey.errors.passwordChangeRequired)).toBeNull();
  });
});
