import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enAuth from '../../../i18n/locales/en/auth.json';

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
vi.mock('../hooks/useWebAuthn', () => ({
  useWebAuthn: () => ({ isSupported: false, loginWithPasskey: vi.fn() }),
}));
vi.mock('../../../contexts/BrandingContext', () => ({
  useBranding: () => ({ title: null }),
}));
vi.mock('./AuthScreenLayout', () => ({
  default: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

const oidcMock = vi.hoisted(() => ({
  detect: vi.fn<() => Promise<boolean>>(),
  start: vi.fn(),
}));
vi.mock('../oidc', () => ({
  detectOidcAvailability: () => oidcMock.detect(),
  startOidcLogin: () => oidcMock.start(),
}));

import LoginForm from './LoginForm';

const ssoButton = () => screen.queryByRole('button', { name: enAuth.sso.loginButton });

async function renderForm(isEnabled: boolean) {
  oidcMock.detect.mockResolvedValue(isEnabled);
  render(<LoginForm />);
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  oidcMock.detect.mockReset();
  oidcMock.start.mockReset();
  // Secure context keeps the (unsupported) passkey button hidden entirely.
  vi.stubGlobal('isSecureContext', true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LoginForm SSO entry', () => {
  it('shows no SSO button when the server has OIDC off', async () => {
    await renderForm(false);
    expect(ssoButton()).toBeNull();
    expect(screen.queryByText(enAuth.passkey.divider)).toBeNull();
    expect(screen.getByRole('button', { name: enAuth.login.submit })).toBeTruthy();
  });

  it('offers SSO next to the always-available password form when OIDC is on', async () => {
    await renderForm(true);
    expect(ssoButton()).toBeTruthy();
    expect(screen.getByLabelText(enAuth.login.password)).toBeTruthy();
    expect(screen.getByRole('button', { name: enAuth.login.submit })).toBeTruthy();
  });

  it('hands the page to the server redirect and locks the form while leaving', async () => {
    await renderForm(true);
    fireEvent.click(ssoButton()!);

    expect(oidcMock.start).toHaveBeenCalledTimes(1);
    const redirecting = screen.getByRole('button', { name: enAuth.sso.redirecting });
    expect((redirecting as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: enAuth.login.submit }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('unlocks again when the page is restored from the back/forward cache', async () => {
    await renderForm(true);
    fireEvent.click(ssoButton()!);

    const restored = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(restored, 'persisted', { value: true });
    act(() => {
      window.dispatchEvent(restored);
    });

    expect((ssoButton() as HTMLButtonElement).disabled).toBe(false);
  });
});
