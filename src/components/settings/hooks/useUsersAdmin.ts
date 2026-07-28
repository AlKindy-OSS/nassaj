import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../utils/api';

export type ManagedUserRole = 'owner' | 'admin' | 'user';
export type ManagedUserStatus = 'active' | 'disabled';

export type ManagedUser = {
  id: number;
  username: string;
  role: ManagedUserRole;
  status: ManagedUserStatus;
  created_at?: string;
  last_login?: string | null;
};

export type ManagedInvite = {
  id: number;
  role: ManagedUserRole;
  email: string | null;
  status: 'pending' | 'accepted' | 'revoked';
  expires_at: string;
  created_at: string;
};

export type CreatedInvite = {
  token: string;
  role: ManagedUserRole;
  expiresAt: string;
};

type MutationResult = { success: true } | { success: false; error: string };

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string; message?: string };
    return payload?.error ?? payload?.message ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Data + mutations for the Users admin tab (C-UI-2 / C-UI-3).
 *
 * Reads the user and pending-invite lists, and exposes owner-only mutations
 * (role change, suspend/activate), invite creation and revocation. Role/status
 * authorization is enforced server-side; this hook surfaces server errors.
 */
export function useUsersAdmin(enabled: boolean) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [invites, setInvites] = useState<ManagedInvite[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [usersRes, invitesRes] = await Promise.all([
        api.auth.listUsers(),
        api.auth.listInvites(),
      ]);

      if (usersRes.ok) {
        const payload = (await usersRes.json()) as { users?: ManagedUser[] };
        setUsers(payload.users ?? []);
      } else {
        setLoadError(await readError(usersRes, 'Failed to load users'));
      }

      if (invitesRes.ok) {
        const payload = (await invitesRes.json()) as { invites?: ManagedInvite[] };
        setInvites(payload.invites ?? []);
      }
    } catch (error) {
      console.error('Failed to load users/invites:', error);
      setLoadError('Failed to load users');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      void refresh();
    }
  }, [enabled, refresh]);

  const updateRole = useCallback(
    async (id: number, role: ManagedUserRole): Promise<MutationResult> => {
      try {
        const res = await api.auth.updateUserRole(id, role);
        if (!res.ok) {
          return { success: false, error: await readError(res, 'Failed to update role') };
        }
        await refresh();
        return { success: true };
      } catch {
        return { success: false, error: 'Network error' };
      }
    },
    [refresh],
  );

  const updateStatus = useCallback(
    async (id: number, status: ManagedUserStatus): Promise<MutationResult> => {
      try {
        const res = await api.auth.updateUserStatus(id, status);
        if (!res.ok) {
          return { success: false, error: await readError(res, 'Failed to update status') };
        }
        await refresh();
        return { success: true };
      } catch {
        return { success: false, error: 'Network error' };
      }
    },
    [refresh],
  );

  const createInvite = useCallback(
    async (role: ManagedUserRole): Promise<{ success: true; invite: CreatedInvite } | { success: false; error: string }> => {
      try {
        const res = await api.auth.createInvite({ role });
        if (!res.ok) {
          return { success: false, error: await readError(res, 'Failed to create invite') };
        }
        const payload = (await res.json()) as { invite?: CreatedInvite };
        if (!payload.invite) {
          return { success: false, error: 'Failed to create invite' };
        }
        await refresh();
        return { success: true, invite: payload.invite };
      } catch {
        return { success: false, error: 'Network error' };
      }
    },
    [refresh],
  );

  const resetPassword = useCallback(
    async (
      id: number,
    ): Promise<{ success: true; tempPassword: string } | { success: false; error: string }> => {
      try {
        const res = await api.auth.resetUserPassword(id);
        if (!res.ok) {
          return { success: false, error: await readError(res, 'Failed to reset password') };
        }
        const payload = (await res.json()) as { tempPassword?: string };
        if (!payload.tempPassword) {
          return { success: false, error: 'Failed to reset password' };
        }
        return { success: true, tempPassword: payload.tempPassword };
      } catch {
        return { success: false, error: 'Network error' };
      }
    },
    [],
  );

  const revokeInvite = useCallback(
    async (id: number): Promise<MutationResult> => {
      try {
        const res = await api.auth.revokeInvite(id);
        if (!res.ok) {
          return { success: false, error: await readError(res, 'Failed to revoke invite') };
        }
        await refresh();
        return { success: true };
      } catch {
        return { success: false, error: 'Network error' };
      }
    },
    [refresh],
  );

  const deleteUser = useCallback(
    async (id: number): Promise<MutationResult> => {
      try {
        const res = await api.auth.deleteUser(id);
        if (!res.ok) {
          return { success: false, error: await readError(res, 'Failed to delete user') };
        }
        await refresh();
        return { success: true };
      } catch {
        return { success: false, error: 'Network error' };
      }
    },
    [refresh],
  );

  return {
    users,
    invites,
    isLoading,
    loadError,
    refresh,
    updateRole,
    updateStatus,
    createInvite,
    revokeInvite,
    resetPassword,
    deleteUser,
  };
}
