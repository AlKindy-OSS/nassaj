/* eslint-disable import-x/order -- mocks must be declared before the modules that consume them */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arSettings from '../../../../../i18n/locales/ar/settings.json';
import enSettings from '../../../../../i18n/locales/en/settings.json';
import type { ManagedUser, SsoLinkResult } from '../../../hooks/useUsersAdmin';

function lookup(tree: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
  return typeof value === 'string' ? value : undefined;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (lookup(enSettings, key) ?? key).replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        opts?.[name] === undefined ? whole : String(opts[name]),
      ),
    i18n: { language: 'en' },
  }),
}));

const apiMock = vi.hoisted(() => ({
  unlink: vi.fn<(id: number) => Promise<Response>>(),
  unlinkSelf: vi.fn<(password: string) => Promise<Response>>(),
}));
vi.mock('../../../../../utils/api', () => ({
  api: {
    auth: {
      listUsers: async () => new Response(JSON.stringify({ users: tabState.users })),
      listInvites: async () => new Response(JSON.stringify({ invites: [] })),
      oidc: { unlink: apiMock.unlink, unlinkSelf: apiMock.unlinkSelf },
    },
  },
}));

// Visibility test below drives these directly.
const tabState = vi.hoisted(() => ({
  role: 'owner' as 'owner' | 'admin',
  ssoAvailable: true,
  users: [] as ManagedUser[],
}));
vi.mock('../../../../auth', () => ({
  useAuth: () => ({ user: { id: 1, role: tabState.role } }),
}));
vi.mock('../../../../auth/hooks/useOidcAvailability', () => ({
  useOidcAvailability: () => tabState.ssoAvailable,
}));

import { useUsersAdmin } from '../../../hooks/useUsersAdmin';
import SsoIdentityModal from './SsoIdentityModal';
import UsersSettingsTab from './UsersSettingsTab';

const sso = enSettings.users.sso;

beforeEach(() => {
  apiMock.unlink.mockReset();
  apiMock.unlinkSelf.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('useUsersAdmin SSO unlink calls', () => {
  it('exposes no link call (B-1410)', () => {
    const { result } = renderHook(() => useUsersAdmin(false));
    expect('linkSsoIdentity' in result.current).toBe(false);
  });

  it.each([
    [200, { success: true }],
    [401, { success: false, reason: 'wrong_password' }],
    [403, { success: false, reason: 'forbidden' }],
    [404, { success: false, reason: 'not_found' }],
    [429, { success: false, reason: 'rate_limited' }],
    [500, { success: false, reason: 'failed' }],
  ] as const)('maps DELETE /link status %s', async (status, expected) => {
    apiMock.unlink.mockResolvedValue(new Response('{}', { status }));
    apiMock.unlinkSelf.mockResolvedValue(new Response('{}', { status }));
    const { result } = renderHook(() => useUsersAdmin(false));
    await expect(result.current.unlinkSsoIdentity(7)).resolves.toEqual(expected);
    await expect(result.current.unlinkOwnSsoIdentity('pw')).resolves.toEqual(expected);
    expect(apiMock.unlink).toHaveBeenCalledWith(7);
    expect(apiMock.unlinkSelf).toHaveBeenCalledWith('pw');
  });

  it('reports a network failure on unlink', async () => {
    apiMock.unlink.mockRejectedValue(new TypeError('offline'));
    const { result } = renderHook(() => useUsersAdmin(false));
    await expect(result.current.unlinkSsoIdentity(7)).resolves.toEqual({ success: false, reason: 'network' });
  });
});

describe('SsoIdentityModal', () => {
  const setup = (isSelf = false, onUnlink = vi.fn<(pw?: string) => Promise<SsoLinkResult>>()) => {
    render(<SsoIdentityModal username="alice" isSelf={isSelf} onClose={vi.fn()} onUnlink={onUnlink} />);
    return { onUnlink };
  };

  it('shows the link control disabled, with the reason, and no subject field', () => {
    setup();
    const link = screen.getByRole('button', { name: sso.link }) as HTMLButtonElement;
    expect(link.disabled).toBe(true);
    const hintId = link.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(hintId)?.textContent).toBe(sso.linkDisabledHint);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('asks for confirmation before unlinking a member (it revokes every session)', async () => {
    const { onUnlink } = setup(false, vi.fn(async () => ({ success: true }) as const));
    expect(screen.queryByLabelText(sso.passwordLabel)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: sso.unlink }));
    expect(onUnlink).not.toHaveBeenCalled();
    expect(screen.getByText(/sign them out everywhere/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: sso.unlink }));
    });
    expect(onUnlink).toHaveBeenCalledWith(undefined);
    expect(screen.getByRole('status').textContent).toContain('SSO links removed');
  });

  it('requires the current password to unlink the owner account', async () => {
    const { onUnlink } = setup(true, vi.fn(async () => ({ success: true }) as const));
    fireEvent.click(screen.getByRole('button', { name: sso.unlink }));
    expect(onUnlink).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(sso.errors.passwordRequired);

    fireEvent.change(screen.getByLabelText(sso.passwordLabel), { target: { value: 'secret-pw' } });
    fireEvent.click(screen.getByRole('button', { name: sso.unlink }));
    expect(screen.getByText(sso.unlinkSelfConfirm)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: sso.unlink }));
    });
    expect(onUnlink).toHaveBeenCalledWith('secret-pw');
    expect(screen.getByRole('status').textContent).toContain(sso.unlinkedSelf);
  });

  it('names a wrong password', async () => {
    setup(true, vi.fn(async () => ({ success: false, reason: 'wrong_password' }) as const));
    fireEvent.change(screen.getByLabelText(sso.passwordLabel), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: sso.unlink }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: sso.unlink }));
    });
    expect(screen.getByRole('alert').textContent).toContain(sso.errors.wrongPassword);
  });
});

describe('UsersSettingsTab SSO action visibility', () => {
  const me: ManagedUser = { id: 1, username: 'me', role: 'owner', status: 'active' };
  const coOwner: ManagedUser = { id: 5, username: 'boss', role: 'owner', status: 'active' };
  const member: ManagedUser = { id: 6, username: 'bob', role: 'user', status: 'active' };

  const ssoItemFor = async (username: string) => {
    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${username}` }));
    return screen.queryByRole('menuitem', { name: new RegExp(sso.menu) });
  };

  beforeEach(() => {
    tabState.users = [me, coOwner, member];
  });

  it('is absent while OIDC is off', async () => {
    tabState.role = 'owner';
    tabState.ssoAvailable = false;
    render(<UsersSettingsTab />);
    expect(await ssoItemFor('bob')).toBeNull();
  });

  it('lets the owner manage a member and their own account, not another owner', async () => {
    tabState.role = 'owner';
    tabState.ssoAvailable = true;
    render(<UsersSettingsTab />);
    expect(await ssoItemFor('bob')).toBeTruthy();
    cleanup();
    render(<UsersSettingsTab />);
    expect(await ssoItemFor('me')).toBeTruthy();
    cleanup();
    render(<UsersSettingsTab />);
    expect(await ssoItemFor('boss')).toBeNull();
  });

  it('gives an admin no SSO action', async () => {
    tabState.role = 'admin';
    tabState.ssoAvailable = true;
    render(<UsersSettingsTab />);
    expect(await ssoItemFor('bob')).toBeNull();
  });
});

describe('SSO settings locale parity', () => {
  it('ships every users.sso string in Arabic and English', () => {
    const keysOf = (node: unknown, prefix = ''): string[] =>
      Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
        value && typeof value === 'object' ? keysOf(value, `${prefix}${key}.`) : [`${prefix}${key}`],
      );
    expect(keysOf(arSettings.users.sso).sort()).toEqual(keysOf(sso).sort());
  });
});
