// T-2035: the login form names the lock's wait and, once, says a sign-out
// ended every device's session.
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enAuth from '../../../i18n/locales/en/auth.json';
import {
  recordSignOutIncompleteNotice,
  SIGN_OUT_INCOMPLETE_NOTICE_KEY,
  SIGNED_OUT_EVERYWHERE_NOTICE_KEY,
} from '../loginLock';

function lookup(key: string, options?: Record<string, unknown>): string {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    enAuth,
  );
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''));
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => lookup(key, options) }),
}));
const authMock = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ login: authMock.login }) }));
vi.mock('../hooks/useWebAuthn', () => ({ useWebAuthn: () => ({ isSupported: false, loginWithPasskey: vi.fn() }) }));
vi.mock('../../../contexts/BrandingContext', () => ({ useBranding: () => ({ title: null }) }));
vi.mock('./AuthScreenLayout', () => ({ default: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock('../oidc', () => ({
  detectSsoStatus: async () => ({ loginAvailable: false, state: 'off' }),
  startOidcLogin: vi.fn(),
}));

import LoginForm from './LoginForm';

async function renderForm() {
  render(<LoginForm />);
  await act(async () => { await Promise.resolve(); });
}

async function submit() {
  fireEvent.change(screen.getByLabelText(enAuth.login.username), { target: { value: 'member' } });
  fireEvent.change(screen.getByLabelText(enAuth.login.password), { target: { value: 'wrong' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: enAuth.login.submit })); });
}

beforeEach(() => {
  authMock.login.mockReset();
  sessionStorage.clear();
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe('LoginForm (T-2035)', () => {
  it('shows auth.loginLocked with the wait in minutes', async () => {
    authMock.login.mockResolvedValue({
      success: false, error: 'Too many failed sign-in attempts.', code: 'login_temporarily_locked', retryAfterSeconds: 61,
    });
    await renderForm();
    await submit();
    expect(screen.getByText(lookup('loginLocked', { minutes: 2 }))).toBeTruthy();
  });

  it('shows the signed-out-everywhere notice once', async () => {
    sessionStorage.setItem(SIGNED_OUT_EVERYWHERE_NOTICE_KEY, '1');
    await renderForm();
    expect(screen.getByRole('status').textContent).toContain(enAuth.loggedOutEverywhere);
    expect(sessionStorage.getItem(SIGNED_OUT_EVERYWHERE_NOTICE_KEY)).toBeNull();
    cleanup();
    await renderForm();
    expect(screen.queryByText(enAuth.loggedOutEverywhere)).toBeNull();
  });

  it('B-1652: shows the sign-out-incomplete warning stored before mount, once', async () => {
    sessionStorage.setItem(SIGN_OUT_INCOMPLETE_NOTICE_KEY, '1');
    await renderForm();
    expect(screen.getByRole('status').textContent).toContain(enAuth.signOutIncomplete);
    expect(sessionStorage.getItem(SIGN_OUT_INCOMPLETE_NOTICE_KEY)).toBeNull();
    cleanup();
    await renderForm();
    expect(screen.queryByText(enAuth.signOutIncomplete)).toBeNull();
  });

  it('B-1652: shows the warning when the failed answer arrives after mount', async () => {
    await renderForm();
    expect(screen.queryByText(enAuth.signOutIncomplete)).toBeNull();
    await act(async () => { recordSignOutIncompleteNotice(); });
    expect(screen.getByRole('status').textContent).toContain(enAuth.signOutIncomplete);
    expect(sessionStorage.getItem(SIGN_OUT_INCOMPLETE_NOTICE_KEY)).toBeNull();
  });
});
