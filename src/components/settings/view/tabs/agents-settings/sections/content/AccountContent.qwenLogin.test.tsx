/**
 * AccountContent.qwenLogin.test.tsx — Qwen keeps a visible connection action.
 *
 * The discontinued `qwen-oauth` free tier does not justify removing the only
 * action from a disconnected account. The action opens the managed Alibaba
 * setup modal for Coding Plan or Token Plan and remains available for replacing
 * an already configured credential.
 *
 * RUNNER: vitest (jsdom). `NODE_ENV=test` is mandatory in this repo.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../../../../../../../contexts/ThemeContext';
import type { AgentProvider, AuthStatus } from '../../../../../types/types';

import AccountContent from './AccountContent';

// The billing-cycle hook fetches live provider state on mount; this suite is
// about which rows render, so keep it hermetic and network-free.
vi.mock('../../../../../../quick-settings-panel/hooks/useProviderCycles', () => ({
  useProviderCycles: () => ({ status: 'idle', refetch: () => {} }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      ((opts?.defaultValue as string) ?? key).replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        opts?.[name] === undefined ? whole : String(opts[name])),
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

afterEach(cleanup);

const NOT_CONFIGURED = {
  installed: true,
  authenticated: false,
  loading: false,
  method: null,
  email: null,
  error: 'Personal Qwen Coding Plan key is not configured',
} as unknown as AuthStatus;

const CONFIGURED = {
  installed: true,
  authenticated: true,
  loading: false,
  method: 'coding_plan',
  email: 'Personal Coding Plan',
} as unknown as AuthStatus;

function renderAccount(agent: AgentProvider, authStatus: AuthStatus, onLogin = vi.fn()) {
  return render(
    <ThemeProvider>
      <AccountContent agent={agent} authStatus={authStatus} onLogin={onLogin} />
    </ThemeProvider>,
  );
}

const loginButtonText = /agents\.login\.(button|reLoginButton)/;

describe('Qwen account card — visible Coding Plan connection action', () => {
  it('offers the action when disconnected and invokes the routing callback', () => {
    const onConnect = vi.fn();
    renderAccount('qwen', NOT_CONFIGURED, onConnect);

    fireEvent.click(screen.getByText(loginButtonText));
    expect(onConnect).toHaveBeenCalledOnce();
    expect(screen.getByText('agents.authStatus.disconnected')).toBeTruthy();
  });

  it('keeps the action available after configuration so the key can be replaced', () => {
    renderAccount('qwen', CONFIGURED);
    expect(screen.getByText(loginButtonText)).toBeTruthy();
  });

  it('reflects the credential in the badge: disconnected → connected', () => {
    const { unmount } = renderAccount('qwen', NOT_CONFIGURED);
    expect(screen.getByText('agents.authStatus.disconnected')).toBeTruthy();
    expect(screen.queryByText('agents.authStatus.connected')).toBeNull();
    unmount();

    renderAccount('qwen', CONFIGURED);
    expect(screen.getByText('agents.authStatus.connected')).toBeTruthy();
    expect(screen.queryByText('agents.authStatus.disconnected')).toBeNull();
  });

  it('control: a provider with a terminal login still exposes the same account contract', () => {
    renderAccount('codex', NOT_CONFIGURED);
    expect(screen.getByText(loginButtonText)).toBeTruthy();
  });
});
