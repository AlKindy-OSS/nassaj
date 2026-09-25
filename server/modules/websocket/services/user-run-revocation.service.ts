/**
 * B-1327 — administrative revocation of a user's live agent work.
 *
 * Called (through the account-wallet binding) when an owner disables, deletes
 * or downgrades an account, or an SSO attestation demotes it. Runs are found by
 * the LAUNCHER's user id, read from the innermost writer behind every per-run
 * Proxy, so a run is stopped even when its socket already closed. Each stopped
 * turn gets a typed terminal frame before its provider abort bridge is called;
 * shells/terminals end when the revocation says so; then every realtime socket
 * of the user closes with 4401 so clients reconnect under the new identity.
 *
 * A run that registers only AFTER the revocation (launched before it, session
 * id captured late) is caught by the writer epoch (user-revocation-epoch) and
 * handed to abortLateRevokedRun with the same reason.
 *
 * Transport events (logout, expiry, network loss, tab close) never reach this
 * module: they leave runs alive for reattachment.
 */

import type {
  AgentRunRevocationReason,
  UserRealtimeRevocation,
  UserRealtimeRevocationResult,
} from '@/modules/account-wallet/index.js';
import {
  requestProviderAbort,
  type ChatWebSocketDependencies,
  type OwnedProviderRun,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { listRevocableRunsForUser } from '@/modules/websocket/services/websocket-writer.service.js';
import {
  connectedClients,
  trackedSocketsOfUser,
  WS_OPEN_STATE,
} from '@/modules/websocket/services/websocket-state.service.js';
import { toNumericUserId } from '@/modules/websocket/services/writer-proxy.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { recordUserRevocation } from '@/shared/user-revocation-epoch.js';
import { createNormalizedMessage } from '@/shared/utils.js';
import { unwrapWriter } from '@/shared/writer-target.js';

type SendingWriter = {
  send: (payload: unknown) => void;
  ws?: RealtimeClientConnection;
  userId?: string | number | null;
  sendWithPrimarySuppressed?: (emit: () => void) => void;
  isRevocableRunBound?: (sessionId: string, token: unknown) => boolean;
};

/** One live turn of the revoked user, with its own currency check. */
export type UserOwnedRun = OwnedProviderRun & {
  writer: unknown;
  isCurrent: () => boolean;
};

/** Enders for interactive sessions; injected by the websocket gateway. */
export type InteractiveSessionEnders = {
  terminateShells?: (userId: number) => number;
  terminateTerminals?: (userId: number) => number;
};

/** A run that registered after its user's revocation (writer epoch). */
export type LateRevokedRun = OwnedProviderRun & { writer: unknown; reason: string };

/** Text the revoked user's own socket sees; `code` carries the typed reason. */
const REVOCATION_MESSAGES: Readonly<Record<AgentRunRevocationReason, string>> = Object.freeze({
  account_disabled: 'This turn was stopped because the account was disabled.',
  account_deleted: 'This turn was stopped because the account was deleted.',
  role_changed: 'This turn was stopped because your role changed. '
    + 'The conversation is intact; your next message runs under the new role.',
});

/** What other members mirroring the session see: no account detail (T2). */
const NEUTRAL_CODE = 'turn_stopped';
const NEUTRAL_MESSAGE = 'This turn was stopped.';

/**
 * Applies one administrative identity change: records the revocation epoch,
 * stops every live turn of the user when `abortReason` is set, ends shells and
 * terminals when asked, then closes every realtime socket of the user.
 */
export function revokeUserRunsAndSockets(
  userId: number,
  revocation: UserRealtimeRevocation,
  dependencies: ChatWebSocketDependencies,
  enders: InteractiveSessionEnders = {},
): UserRealtimeRevocationResult {
  let abortedRuns = 0;
  if (revocation.abortReason) {
    // First: any run that registers from now on with an older writer is caught.
    recordUserRevocation(userId, revocation.abortReason);
    abortedRuns = stopUserRuns(userId, revocation.abortReason, dependencies);
  }
  const endedInteractiveSessions = revocation.endInteractiveSessions
    ? endInteractiveSessions(userId, enders)
    : 0;
  const closedSockets = closeUserSockets(userId);
  return Object.freeze({ abortedRuns, closedSockets, endedInteractiveSessions });
}

/** Monitor registrations plus supervised runs of the user, one per session. */
export function listUserOwnedRuns(
  userId: number,
  dependencies: ChatWebSocketDependencies,
): UserOwnedRun[] {
  const monitored: UserOwnedRun[] = (dependencies.getProviderRunsOwnedByUser?.(userId) ?? [])
    .map((run) => ({
      sessionId: run.sessionId,
      provider: run.provider,
      token: run.token,
      writer: run.writer,
      isCurrent: () => dependencies.isProviderRunRegistrationCurrent?.(run) === true,
    }));
  const supervised: UserOwnedRun[] = listRevocableRunsForUser(userId).map((run) => ({
    sessionId: run.sessionId,
    provider: run.provider,
    token: run.token,
    writer: run.writer,
    isCurrent: () => run.writer.isRevocableRunBound(run.sessionId, run.token),
  }));
  const bySession = new Map<string, UserOwnedRun>();
  for (const run of [...monitored, ...supervised]) {
    if (!bySession.has(run.sessionId)) bySession.set(run.sessionId, run);
  }
  return [...bySession.values()];
}

/**
 * Aborts a run that registered after its user's revocation (qa M2). The
 * registration is rechecked first: a run that already ended is left alone.
 */
export function abortLateRevokedRun(run: LateRevokedRun, dependencies: ChatWebSocketDependencies): boolean {
  const reason = run.reason as AgentRunRevocationReason;
  if (!Object.hasOwn(REVOCATION_MESSAGES, reason)) return false;
  const rawWriter = unwrapWriter(run.writer) as SendingWriter | null;
  const current = dependencies.isProviderRunRegistrationCurrent?.(run) === true
    || rawWriter?.isRevocableRunBound?.(run.sessionId, run.token) === true;
  if (!current) return false;
  const userId = toNumericUserId(rawWriter?.userId);
  stopRun({ ...run, isCurrent: () => true }, reason, dependencies, userId);
  return true;
}

/** Stops every current run of the user; returns how many were signalled. */
function stopUserRuns(
  userId: number,
  reason: AgentRunRevocationReason,
  dependencies: ChatWebSocketDependencies,
): number {
  let stopped = 0;
  for (const run of listUserOwnedRuns(userId, dependencies)) {
    // Recheck immediately before the side effect: a run that ended (or was
    // replaced by a newer registration) since listing is left alone.
    if (!run.isCurrent()) continue;
    stopRun(run, reason, dependencies, userId);
    stopped += 1;
  }
  return stopped;
}

/** Frame, resume hook, abort — the one sequence every stopped turn follows. */
function stopRun(
  run: UserOwnedRun,
  reason: AgentRunRevocationReason,
  dependencies: ChatWebSocketDependencies,
  userId: number | null,
): void {
  sendRevocationFrames(run, reason, userId);
  if (reason === 'role_changed') onTurnInterruptedByRoleChange(run);
  abortRun(dependencies, run, userId);
}

function terminalFrame(run: UserOwnedRun, code: string, error: string) {
  return createNormalizedMessage({
    kind: 'complete',
    provider: run.provider as never,
    sessionId: run.sessionId,
    exitCode: 1,
    success: false,
    aborted: true,
    code,
    error,
  });
}

/**
 * Typed terminal frames (T2). Mirrors of other members and the recorded
 * outcome get a neutral frame; only the revoked user's own primary socket gets
 * the specific reason. When the primary socket is not the user's (or cannot be
 * muted), everyone gets the neutral frame.
 */
function sendRevocationFrames(run: UserOwnedRun, reason: AgentRunRevocationReason, userId: number | null): void {
  const wrapped = run.writer as SendingWriter | null;
  if (!wrapped || typeof wrapped.send !== 'function') return;
  const raw = unwrapWriter(wrapped) as SendingWriter | null;
  const primary = raw?.ws;
  const primaryIsOwn = userId !== null && primary?.readyState === WS_OPEN_STATE
    && toNumericUserId(primary.userId ?? raw?.userId) === userId
    && typeof raw?.sendWithPrimarySuppressed === 'function';
  try {
    const neutral = terminalFrame(run, NEUTRAL_CODE, NEUTRAL_MESSAGE);
    if (!primaryIsOwn) {
      wrapped.send(neutral);
      return;
    }
    raw!.sendWithPrimarySuppressed!(() => wrapped.send(neutral));
    primary!.send(JSON.stringify(terminalFrame(run, reason, REVOCATION_MESSAGES[reason])));
  } catch (error) {
    console.error('[ERROR] Failed to send revocation frame', {
      sessionId: run.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Single hook point for a turn interrupted by a role downgrade. Automatic
 * resume under the new role would be added HERE; it is intentionally absent
 * because re-running a partially executed turn could repeat tool calls. The
 * conversation stays intact and the user's next message runs under the new role.
 */
export function onTurnInterruptedByRoleChange(run: UserOwnedRun): void {
  console.info('[INFO] Turn interrupted by role change; not resumed automatically', {
    sessionId: run.sessionId,
    provider: run.provider,
  });
}

/** Hands the run to its provider abort bridge; one failure never blocks the rest. */
function abortRun(dependencies: ChatWebSocketDependencies, run: UserOwnedRun, userId: number | null): void {
  const rawWriter = unwrapWriter(run.writer) as SendingWriter | null;
  const rawWs = (rawWriter?.ws ?? null) as RealtimeClientConnection;
  try {
    void Promise.resolve(requestProviderAbort(dependencies, run, userId, rawWs)).catch(() => false);
  } catch (error) {
    console.error('[ERROR] Failed to abort revoked user run', {
      sessionId: run.sessionId,
      provider: run.provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Ends /shell PTYs and standalone terminals; a failing ender never blocks the other. */
function endInteractiveSessions(userId: number, enders: InteractiveSessionEnders): number {
  let ended = 0;
  for (const end of [enders.terminateShells, enders.terminateTerminals]) {
    if (!end) continue;
    try {
      ended += end(userId);
    } catch (error) {
      console.error('[ERROR] Failed to end interactive sessions', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return ended;
}

/** Closes every realtime socket (chat, /shell, /terminal) stamped with `userId`. */
function closeUserSockets(userId: number): number {
  const sockets = new Set<RealtimeClientConnection>(trackedSocketsOfUser(userId));
  for (const socket of connectedClients) {
    if (toNumericUserId(socket.userId) === userId) sockets.add(socket);
  }
  let closed = 0;
  for (const socket of sockets) {
    try {
      socket.close?.(4401, 'identity_revoked');
      closed += 1;
    } catch {
      // Already gone; the close handler cleans the registries.
    }
  }
  return closed;
}
