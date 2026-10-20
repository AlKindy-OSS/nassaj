/**
 * T-2062 — the owner-only Install button on the missing-CLI banner.
 * RUNNER: vitest (jsdom).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let role: string = 'owner';
const installState = { current: { status: 'idle', percent: 0, log: [] as string[] } as Record<string, unknown> };
const start = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'ar' },
  }),
}));
vi.mock('../../../../../../auth/context/AuthContext', () => ({ useOptionalAuth: () => ({ user: { role } }) }));
vi.mock('../../../../../../../hooks/useHarnessInstall', () => ({
  useHarnessInstall: () => ({ state: installState.current, start }),
}));
vi.mock('../../../../../../quick-settings-panel/hooks/useProviderCycles', () => ({ useProviderCycles: () => ({ status: 'idle' }) }));
vi.mock('./LinkModeSection', () => ({ default: () => null }));

import type { AuthStatus } from '../../../../../types/types';

import AccountContent from './AccountContent';

const missing = { installed: false, authenticated: false, loading: false } as unknown as AuthStatus;

function mount(authStatus: AuthStatus = missing, agent: 'codex' | 'opencode' = 'codex') {
  return render(<AccountContent agent={agent} authStatus={authStatus} onLogin={() => {}} onRefreshAuthStatus={() => {}} />);
}

describe('AccountContent install button', () => {
  beforeEach(() => { role = 'owner'; installState.current = { status: 'idle', percent: 0, log: [] }; start.mockReset(); });
  afterEach(cleanup);

  it('shows the shared install command and an Install button to the owner', () => {
    mount();
    expect(screen.getByText('curl -fsSL https://chatgpt.com/codex/install.sh | sh')).toBeTruthy();
    const button = screen.getByRole('button', { name: /تثبيت/ });
    // Same row as the command and the copy button, after the copy button.
    const row = screen.getByText('curl -fsSL https://chatgpt.com/codex/install.sh | sh').parentElement!;
    const children = Array.from(row.children);
    expect(button.parentElement).toBe(row);
    expect(children.indexOf(button)).toBeGreaterThan(children.indexOf(screen.getByRole('button', { name: 'Copy to clipboard' })));
    expect(screen.queryByTestId('harness-install-progress-codex')).toBeNull();
    fireEvent.click(button);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('hides the button from a member but keeps the copyable command', () => {
    role = 'member';
    mount(missing, 'opencode');
    expect(screen.getByText('curl -fsSL https://opencode.ai/install | bash')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeTruthy();
    expect(screen.queryByTestId('harness-install-opencode')).toBeNull();
  });

  it('hides the banner and button unless installed is exactly false', () => {
    mount({ ...missing, installed: undefined } as unknown as AuthStatus);
    expect(screen.queryByTestId('harness-install-codex')).toBeNull();
    cleanup();
    mount({ ...missing, installed: true } as AuthStatus);
    expect(screen.queryByTestId('harness-install-codex')).toBeNull();
  });

  it('disables the button and shows progress + phase while running', () => {
    installState.current = { status: 'running', phase: 'installing', percent: 42, log: ['line one'] };
    mount();
    const button = screen.getByRole('button', { name: /جارٍ التثبيت/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const progress = screen.getByRole('progressbar');
    expect(progress.getAttribute('aria-valuenow')).toBe('42');
    // Feedback sits below the row, outside it.
    expect(button.parentElement!.contains(progress)).toBe(false);
    expect(screen.getByText('line one')).toBeTruthy();
  });

  it('shows the server Arabic failure message and a retry button', () => {
    installState.current = { status: 'failed', percent: 30, log: [], errorCode: 'install_failed', errorMessage: 'failed', errorMessageAr: 'فشل المثبّت الرسمي' };
    mount();
    expect(screen.getByRole('alert').textContent).toBe('فشل المثبّت الرسمي');
    fireEvent.click(screen.getByRole('button', { name: /إعادة المحاولة/ }));
    expect(start).toHaveBeenCalledTimes(1);
  });
});
