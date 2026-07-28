import { useCallback, useMemo, useState } from 'react';
import { KeyRound, Loader2, Trash2, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, Button } from '../../../../../shared/view/ui';
import { useAuth } from '../../../../auth';
import { useUsersAdmin } from '../../../hooks/useUsersAdmin';
import type { ManagedUser, ManagedUserRole } from '../../../hooks/useUsersAdmin';
import InviteUserModal from './InviteUserModal';
import ProviderSharingSettings from './ProviderSharingSettings';
import ResetPasswordModal from './ResetPasswordModal';

const ROLE_OPTIONS: ManagedUserRole[] = ['user', 'admin', 'owner'];

/**
 * Users management tab (C-UI-2 + C-UI-3).
 *
 * - owner/admin: see the user list and pending invites, and send invites.
 * - owner only: change roles and suspend/activate users (mutations are
 *   additionally enforced server-side; the UI mirrors the same rules).
 */
export default function UsersSettingsTab() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const role = user?.role;
  const currentUserId = typeof user?.id === 'number' ? user.id : Number(user?.id);
  const isOwner = role === 'owner';
  const isAdmin = role === 'admin';

  const {
    users,
    invites,
    isLoading,
    loadError,
    updateRole,
    updateStatus,
    createInvite,
    revokeInvite,
    resetPassword,
    deleteUser,
  } = useUsersAdmin(true);

  const [actionError, setActionError] = useState('');
  const [isInviteOpen, setInviteOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<ManagedUser | null>(null);
  // Two-click confirmation: store the id of the user pending deletion.
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  // Reset visibility: owner may reset anyone (but self), admin may reset only
  // non-owners (but self). Mirrors the server-side authorization.
  const canResetPassword = useCallback(
    (target: ManagedUser) => {
      if (target.id === currentUserId) {
        return false;
      }
      if (isOwner) {
        return true;
      }
      if (isAdmin) {
        return target.role !== 'owner';
      }
      return false;
    },
    [currentUserId, isAdmin, isOwner],
  );

  const pendingInvites = useMemo(
    () => invites.filter((invite) => invite.status === 'pending'),
    [invites],
  );

  const handleRoleChange = useCallback(
    async (id: number, nextRole: ManagedUserRole) => {
      setActionError('');
      const result = await updateRole(id, nextRole);
      if (!result.success) {
        setActionError(result.error);
      }
    },
    [updateRole],
  );

  const handleStatusToggle = useCallback(
    async (id: number, nextStatus: 'active' | 'disabled') => {
      setActionError('');
      const result = await updateStatus(id, nextStatus);
      if (!result.success) {
        setActionError(result.error);
      }
    },
    [updateStatus],
  );

  const handleRevoke = useCallback(
    async (id: number) => {
      setActionError('');
      const result = await revokeInvite(id);
      if (!result.success) {
        setActionError(result.error);
      }
    },
    [revokeInvite],
  );

  const handleDeleteUser = useCallback(
    async (id: number) => {
      if (deleteConfirmId !== id) {
        // First click: ask for confirmation.
        setDeleteConfirmId(id);
        return;
      }
      // Second click: proceed.
      setDeleteConfirmId(null);
      setActionError('');
      const result = await deleteUser(id);
      if (!result.success) {
        setActionError(result.error);
      }
    },
    [deleteConfirmId, deleteUser],
  );

  const roleBadgeVariant = (r: ManagedUserRole) =>
    r === 'owner' ? 'default' : r === 'admin' ? 'secondary' : 'outline';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('users.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('users.subtitle')}</p>
        </div>
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlus className="h-4 w-4" />
          <span className="ms-1.5">{t('users.inviteButton')}</span>
        </Button>
      </div>

      {actionError && (
        <div className="rounded-md border border-red-300 bg-red-100 p-3 dark:border-red-800 dark:bg-red-900/20">
          <p className="text-sm text-red-700 dark:text-red-400">{actionError}</p>
        </div>
      )}

      {loadError && (
        <div className="rounded-md border border-red-300 bg-red-100 p-3 dark:border-red-800 dark:bg-red-900/20">
          <p className="text-sm text-red-700 dark:text-red-400">{loadError}</p>
        </div>
      )}

      {/* Users list */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">{t('users.listHeading')}</h3>

        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('users.loading')}
          </div>
        ) : users.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">{t('users.empty')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {users.map((managedUser) => {
              const isSelf = managedUser.id === currentUserId;
              const isDisabled = managedUser.status === 'disabled';
              return (
                <li
                  key={managedUser.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground">
                        {managedUser.username}
                      </span>
                      {isSelf && (
                        <span className="text-xs text-muted-foreground">({t('users.you')})</span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant={roleBadgeVariant(managedUser.role)}>
                        {t(`users.roles.${managedUser.role}`)}
                      </Badge>
                      <Badge variant={isDisabled ? 'destructive' : 'outline'}>
                        {t(`users.statuses.${managedUser.status}`)}
                      </Badge>
                    </div>
                  </div>

                  {/* Management controls. Role + status are owner-only; the
                      password reset is available to owner/admin per RBAC. */}
                  {!isSelf && (isOwner || canResetPassword(managedUser)) && (
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {isOwner && (
                        <>
                          <label className="sr-only" htmlFor={`role-${managedUser.id}`}>
                            {t('users.changeRole')}
                          </label>
                          <select
                            id={`role-${managedUser.id}`}
                            value={managedUser.role}
                            onChange={(event) =>
                              handleRoleChange(managedUser.id, event.target.value as ManagedUserRole)
                            }
                            className="min-w-[7rem] rounded-md border border-border bg-background ps-2 pe-7 py-1.5 text-sm text-foreground focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring"
                          >
                            {ROLE_OPTIONS.map((r) => (
                              <option key={r} value={r}>
                                {t(`users.roles.${r}`)}
                              </option>
                            ))}
                          </select>
                          <Button
                            variant={isDisabled ? 'outline' : 'destructive'}
                            size="sm"
                            onClick={() =>
                              handleStatusToggle(managedUser.id, isDisabled ? 'active' : 'disabled')
                            }
                          >
                            {isDisabled ? t('users.activate') : t('users.suspend')}
                          </Button>
                        </>
                      )}

                      {canResetPassword(managedUser) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setResetTarget(managedUser)}
                        >
                          <KeyRound className="h-4 w-4" />
                          <span className="ms-1.5">{t('users.resetPassword')}</span>
                        </Button>
                      )}

                      {/* Delete user: owner-only, not on self. Two-click confirmation. */}
                      {isOwner && (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => void handleDeleteUser(managedUser.id)}
                          aria-label={
                            deleteConfirmId === managedUser.id
                              ? t('users.deleteUserConfirm', { username: managedUser.username, defaultValue: 'Permanently delete {{username}}? This cannot be undone.' })
                              : t('users.deleteUser', 'Delete user')
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                          {deleteConfirmId === managedUser.id && (
                            <span className="ms-1.5">
                              {t('users.deleteUserConfirm', { username: managedUser.username, defaultValue: 'Permanently delete {{username}}? This cannot be undone.' })}
                            </span>
                          )}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Pending invites */}
      <section>
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">
          {t('users.pendingInvites')}
        </h3>
        {pendingInvites.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('users.noPendingInvites')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {pendingInvites.map((invite) => (
              <li
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{t(`users.roles.${invite.role}`)}</Badge>
                  {invite.email && (
                    <span className="text-sm text-muted-foreground" dir="ltr">
                      {invite.email}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {t('users.expiresAt', { date: invite.expires_at })}
                  </span>
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleRevoke(invite.id)}>
                  {t('users.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Provider credential sharing (admin/owner only; the section
          self-hides for other roles). */}
      <div className="border-t border-border pt-6">
        <ProviderSharingSettings role={role} />
      </div>

      {isInviteOpen && (
        <InviteUserModal
          canInviteAdmin={isOwner}
          onClose={() => setInviteOpen(false)}
          onCreate={createInvite}
        />
      )}

      {resetTarget && (
        <ResetPasswordModal
          username={resetTarget.username}
          onClose={() => setResetTarget(null)}
          onReset={() => resetPassword(resetTarget.id)}
        />
      )}
    </div>
  );
}
