/**
 * InviteUserModal.test.tsx — covers invite duration selection (owner picks
 * how long the link stays valid), that the chosen ttlHours reaches onCreate,
 * and that the expiry shown after creation is locale-formatted.
 */
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import arSettings from '../../../../../i18n/locales/ar/settings.json';
import enSettings from '../../../../../i18n/locales/en/settings.json';
import type { CreatedInvite, ManagedUserRole } from '../../../hooks/useUsersAdmin';

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

import InviteUserModal from './InviteUserModal';

const invite = enSettings.users.invite;

afterEach(() => {
  cleanup();
});

describe('InviteUserModal duration', () => {
  it('sends the default 72h ttl when the owner does not change it', async () => {
    const onCreate = vi.fn<(role: ManagedUserRole, ttlHours: number) => Promise<
      { success: true; invite: CreatedInvite } | { success: false; error: string }
    >>(async (role, ttlHours) => ({
      success: true,
      invite: { token: 'tok', role, expiresAt: '2026-10-02 12:00:00' },
    }));
    render(<InviteUserModal canInviteAdmin={false} onClose={vi.fn()} onCreate={onCreate} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: invite.submit }));
    });

    expect(onCreate).toHaveBeenCalledWith('user', 72);
  });

  it('sends the ttl the owner picks', async () => {
    const onCreate = vi.fn<(role: ManagedUserRole, ttlHours: number) => Promise<
      { success: true; invite: CreatedInvite } | { success: false; error: string }
    >>(async (role, ttlHours) => ({
      success: true,
      invite: { token: 'tok', role, expiresAt: '2026-10-06 12:00:00' },
    }));
    render(<InviteUserModal canInviteAdmin={false} onClose={vi.fn()} onCreate={onCreate} />);

    fireEvent.change(screen.getByLabelText(invite.durationLabel), { target: { value: '168' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: invite.submit }));
    });

    expect(onCreate).toHaveBeenCalledWith('user', 168);
  });

  it('shows the created invite expiry formatted for the locale', async () => {
    const onCreate = vi.fn<(role: ManagedUserRole, ttlHours: number) => Promise<
      { success: true; invite: CreatedInvite } | { success: false; error: string }
    >>(async (role) => ({
      success: true,
      // UTC "space" timestamp as sent by the server (no trailing Z).
      invite: { token: 'tok', role, expiresAt: '2026-10-02 12:00:00' },
    }));
    render(<InviteUserModal canInviteAdmin={false} onClose={vi.fn()} onCreate={onCreate} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: invite.submit }));
    });

    const expected = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date('2026-10-02T12:00:00Z'),
    );
    expect(screen.getByText(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
  });
});

describe('Invite modal locale parity', () => {
  it('ships every users.invite string in Arabic and English', () => {
    const keysOf = (node: unknown, prefix = ''): string[] =>
      Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
        value && typeof value === 'object' ? keysOf(value, `${prefix}${key}.`) : [`${prefix}${key}`],
      );
    expect(keysOf(arSettings.users.invite).sort()).toEqual(keysOf(invite).sort());
  });
});
