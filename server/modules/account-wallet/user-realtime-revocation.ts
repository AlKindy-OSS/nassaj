/**
 * B-1327: user-level revocation of live agent work, decided by account
 * administration (disable, delete, role change) — never by transport events.
 *
 * Logout, token expiry, network loss, tab close and ordinary socket closes do
 * NOT come through here: runs survive them and the user can reattach. Only an
 * explicit administrative identity change stops a user's running turns.
 *
 * The realtime layer binds the concrete handler at startup (the websocket
 * module owns provider abort bridges and sockets); this module only holds the
 * policy and the binding, so the auth routes stay free of websocket imports.
 */

/** Typed reason carried in the terminal frame of every stopped turn. */
export type AgentRunRevocationReason = 'account_disabled' | 'account_deleted' | 'role_changed';

export type UserRealtimeRevocationResult = Readonly<{
  /** Provider runs whose abort bridge was invoked. */
  abortedRuns: number;
  /** Realtime sockets (chat, shell, terminal) of the user that were closed. */
  closedSockets: number;
  /** /shell PTYs and standalone terminals that were ended. */
  endedInteractiveSessions: number;
}>;

/** What an administrative identity change does to the user's live work. */
export type UserRealtimeRevocation = Readonly<{
  /** Stop running turns with this typed reason; null = leave them running. */
  abortReason: AgentRunRevocationReason | null;
  /** End the user's /shell PTYs and standalone terminals. */
  endInteractiveSessions: boolean;
}>;

/** Handler bound by the realtime layer. Sockets are always refreshed. */
export type UserRealtimeRevocationHandler = (
  userId: number,
  revocation: UserRealtimeRevocation,
) => UserRealtimeRevocationResult;

const EMPTY_RESULT: UserRealtimeRevocationResult = Object.freeze({
  abortedRuns: 0, closedSockets: 0, endedInteractiveSessions: 0,
});

let boundHandler: UserRealtimeRevocationHandler | null = null;

/** Binds the realtime handler; returns an unbind that only removes itself. */
export function bindUserRealtimeRevocation(handler: UserRealtimeRevocationHandler): () => void {
  boundHandler = handler;
  return () => {
    if (boundHandler === handler) boundHandler = null;
  };
}

/**
 * Applies a user-level identity change to live realtime work. Without a bound
 * realtime layer (no websocket server in this process) there is nothing live
 * to stop, so the result is empty.
 */
export function revokeUserRealtimeAccess(
  userId: number,
  revocation: UserRealtimeRevocation,
): UserRealtimeRevocationResult {
  if (!Number.isInteger(userId) || userId <= 0 || !boundHandler) return EMPTY_RESULT;
  return boundHandler(userId, revocation);
}

/**
 * Privilege order of the account role model (users.role: owner > admin > user).
 * An unknown role ranks lowest, so a change into it counts as a downgrade and
 * fails closed (running turns are stopped).
 */
const ROLE_RANK: Readonly<Record<string, number>> = Object.freeze({ owner: 3, admin: 2, user: 1 });

/** Free /shell and standalone terminals require at least this rank (owner/admin). */
const INTERACTIVE_SHELL_MIN_RANK = ROLE_RANK.admin;

function roleRank(role: unknown): number {
  return typeof role === 'string' && Object.hasOwn(ROLE_RANK, role) ? ROLE_RANK[role] : 0;
}

/** True when `nextRole` carries fewer privileges than `previousRole`. */
export function isRoleDowngrade(previousRole: unknown, nextRole: unknown): boolean {
  return roleRank(nextRole) < roleRank(previousRole);
}

const NO_REVOCATION: UserRealtimeRevocation = Object.freeze({ abortReason: null, endInteractiveSessions: false });

/**
 * Role change policy: a downgrade stops running turns (launched under the old
 * role) and ends shells/terminals when the new role may no longer hold them;
 * a promotion or same-rank change only refreshes connections.
 */
export function revocationForRoleChange(previousRole: unknown, nextRole: unknown): UserRealtimeRevocation {
  if (!isRoleDowngrade(previousRole, nextRole)) return NO_REVOCATION;
  return Object.freeze({
    abortReason: 'role_changed',
    endInteractiveSessions: roleRank(previousRole) >= INTERACTIVE_SHELL_MIN_RANK
      && roleRank(nextRole) < INTERACTIVE_SHELL_MIN_RANK,
  });
}

/** Status change policy: disabling stops everything; re-enabling stops nothing. */
export function revocationForStatusChange(nextStatus: unknown): UserRealtimeRevocation {
  return nextStatus === 'disabled'
    ? Object.freeze({ abortReason: 'account_disabled', endInteractiveSessions: true })
    : NO_REVOCATION;
}

/** Deleting an account stops everything it had running. */
export const ACCOUNT_DELETED_REVOCATION: UserRealtimeRevocation = Object.freeze({
  abortReason: 'account_deleted',
  endInteractiveSessions: true,
});
