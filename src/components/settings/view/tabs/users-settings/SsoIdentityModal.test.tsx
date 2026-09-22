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
  link: vi.fn<(id: number, subject: string) => Promise<Response>>(),
  unlink: vi.fn<(id: number) => Promise<Response>>(),
}));
vi.mock('../../../../../utils/api', () => ({
  api: {
    auth: {
      listUsers: async () => new Response(JSON.stringify({ users: tabState.users })),
      listInvites: async () => new Response(JSON.stringify({ invites: [] })),
      oidc: { link: apiMock.link, unlink: apiMock.unlink },
    },
  },
}));

// Visibility test below drives these two directly.
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
  apiMock.link.mockReset();
  apiMock.unlink.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('useUsersAdmin SSO link calls', () => {
  it.each([
    [200, { success: true }],
    [400, { success: false, reason: 'invalid' }],
    [404, { success: false, reason: 'not_found' }],
    [409, { success: false, reason: 'conflict' }],
    [500, { success: false, reason: 'not_configured' }],
    [403, { success: false, reason: 'failed' }],
  ] as const)('maps POST /link status %s', async (status, expected) => {
    apiMock.link.mockResolvedValue(new Response('{}', { status }));
    const { result } = renderHook(() => useUsersAdmin(false));
    await expect(result.current.linkSsoIdentity(7, 'sub-1')).resolves.toEqual(expected);
    expect(apiMock.link).toHaveBeenCalledWith(7, 'sub-1');
  });

  it('reports a network failure on unlink', async () => {
    apiMock.unlink.mockRejectedValue(new TypeError('offline'));
    const { result } = renderHook(() => useUsersAdmin(false));
    await expect(result.current.unlinkSsoIdentity(7)).resolves.toEqual({ success: false, reason: 'network' });
  });
});

describe('SsoIdentityModal', () => {
  const setup = (onLink = vi.fn<(s: string) => Promise<SsoLinkResult>>(), onUnlink = vi.fn<() => Promise<SsoLinkResult>>()) => {
    render(<SsoIdentityModal username="alice" onClose={vi.fn()} onLink={onLink} onUnlink={onUnlink} />);
    return { onLink, onUnlink };
  };

  it('requires a subject before calling the server', async () => {
    const { onLink } = setup();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: sso.link }));
    });
    expect(onLink).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(sso.errors.required);
  });

  it('links a trimmed subject and confirms success', async () => {
    const { onLink } = setup(vi.fn(async () => ({ success: true }) as const));
    fireEvent.change(screen.getByLabelText(sso.subjectLabel), { target: { value: '  2981234  ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: sso.link }));
    });
    expect(onLink).toHaveBeenCalledWith('2981234');
    expect(screen.getByRole('status').textContent).toContain('alice can now sign in with SSO');
  });

  it('names a conflict (identity already linked elsewhere)', async () => {
    setup(vi.fn(async () => ({ success: false, reason: 'conflict' }) as const));
    fireEvent.change(screen.getByLabelText(sso.subjectLabel), { target: { value: 'taken' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: sso.link }));
    });
    expect(screen.getByRole('alert').textContent).toContain(sso.errors.conflict);
  });

  it('asks for confirmation before unlinking (it revokes every session)', async () => {
    const { onUnlink } = setup(undefined, vi.fn(async () => ({ success: true }) as const));
    fireEvent.click(screen.getByRole('button', { name: sso.unlink }));
    expect(onUnlink).not.toHaveBeenCalled();
    expect(screen.getByText(/sign them out everywhere/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: sso.unlink }));
    });
    expect(onUnlink).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('SSO links removed');
  });
});

describe('UsersSettingsTab SSO action visibility', () => {
  const owner: ManagedUser = { id: 5, username: 'boss', role: 'owner', status: 'active' };
  const member: ManagedUser = { id: 6, username: 'bob', role: 'user', status: 'active' };

  const openMenuItems = async (username: string) => {
    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${username}` }));
    return screen.queryByRole('menuitem', { name: new RegExp(sso.menu) });
  };

  beforeEach(() => {
    tabState.users = [owner, member];
  });

  it('is absent while OIDC is off', async () => {
    tabState.role = 'owner';
    tabState.ssoAvailable = false;
    render(<UsersSettingsTab />);
    expect(await openMenuItems('bob')).toBeNull();
  });

  it('lets an admin manage a member', async () => {
    tabState.role = 'admin';
    tabState.ssoAvailable = true;
    render(<UsersSettingsTab />);
    expect(await openMenuItems('bob')).toBeTruthy();
  });

  it('does not offer an admin the owner row', async () => {
    tabState.role = 'admin';
    tabState.ssoAvailable = true;
    render(<UsersSettingsTab />);
    await screen.findByRole('button', { name: 'Actions for bob' });
    expect(screen.queryByRole('button', { name: 'Actions for boss' })).toBeNull();
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
