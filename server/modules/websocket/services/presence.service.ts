/**
 * Live presence service (B-MU-UX-PRESENCE).
 *
 * The nassaj workspace is shared by intent (a small team of "brothers", 2-4
 * people, full trust, full file access). This service answers the question
 * "what is each brother doing right now?" without adding any isolation: it is a
 * pure VISIBILITY layer.
 *
 * It tracks two things, keyed by the JWT-authenticated `userId` only (never any
 * client-supplied identity):
 *
 *  1. CONNECTED — every open chat WebSocket is registered here on connect and
 *     removed on close. A user is "connected" while at least one of their
 *     sockets is open, so multiple tabs/devices dedupe to a single presence row.
 *
 *  2. ACTIVE — while a user has at least one running provider command they show
 *     as "active" on the most recently started session, with its project path
 *     and provider. Runs are registered/unregistered from the provider session
 *     lifecycle (the process monitor for claude, and the agy spawn/teardown for
 *     the Antigravity CLI — this fork's primary provider).
 *
 * Any change (connect, disconnect, run start, run stop) coalesces a debounced
 * broadcast of the FULL presence snapshot to every connected client. Snapshots
 * are tiny for a 2-4 person team, so sending the whole list is the simplest
 * correct option (no per-delta reconciliation on the client).
 *
 * Privacy: the snapshot exposes only userId, username, avatarUrl, and the
 * active session/project ids — all already shared inside this workspace.
 * Nothing sensitive (tokens, env, message content) is ever included.
 */

import { projectsDb, userDb } from '@/modules/database/index.js';
import {
  WS_OPEN_STATE,
  connectedClients,
} from '@/modules/websocket/services/websocket-state.service.js';
import type {
  AuthenticatedWebSocketUser,
  LLMProvider,
  RealtimeClientConnection,
} from '@/shared/types.js';

/** Normalized presence user id (string for stable map keys + client colour). */
type PresenceUserId = string;

/** One running provider command attributed to a user. */
type PresenceRun = {
  sessionId: string;
  projectPath: string | null;
  provider: LLMProvider | string | null;
  since: number;
  /**
   * B-269: the child process state last reported by the process monitor.
   * 'running' until the monitor observes a SIGSTOP ('T' in /proc). Providers
   * that do not flow through the monitor (agy) simply stay 'running' for the
   * run's whole life — which is exactly what the badge needs from them.
   */
  state: PresenceProcessState;
};

/** Process state carried per run; mirrors the client's SessionProcessState. */
type PresenceProcessState = 'running' | 'frozen';

/** Per-user presence state held in memory. */
type PresenceUserState = {
  userId: PresenceUserId;
  username: string;
  sockets: Set<RealtimeClientConnection>;
  /** sessionId -> run. A user is "active" while this map is non-empty. */
  runs: Map<string, PresenceRun>;
  /** When the user first connected (oldest still-open socket). */
  connectedSince: number;
};

/** Shape of one entry in the broadcast snapshot. */
type PresenceEntry = {
  userId: PresenceUserId;
  username: string;
  // Server-relative profile picture URL (/avatars/<userId>.<ext>) or null, so
  // presence avatars render the real picture instead of the coloured initial.
  avatarUrl: string | null;
  connected: true;
  active: boolean;
  activeSessionId: string | null;
  activeProjectPath: string | null;
  provider: LLMProvider | string | null;
  since: number;
};

/**
 * Active-conversations detail broadcast alongside the presence snapshot.
 *
 * `total` is GLOBAL (every run of every user), so the badge count matches the
 * tooltip exactly. `byProject` is filtered to the recipient's visible projects
 * only; everything not surfaced there (private-project runs the recipient may
 * not see + runs with no resolved project path) is absorbed into `hiddenCount`,
 * which therefore satisfies `total === sum(byProject[*].count) + hiddenCount`.
 */
type ActiveConversations = {
  /** Sum of all runs across all users (global). */
  total: number;
  /** Per-project run counts, visible to the recipient only. */
  byProject: Array<{ projectPath: string; count: number }>;
  /** total − sum(byProject[*].count): runs in hidden/null-path projects. */
  hiddenCount: number;
};

/**
 * B-269: one entry per live run the recipient may see, carried alongside the
 * snapshot so EVERY client learns which sessions are busy — not only the ones
 * it happens to have open.
 *
 * Before this, the per-session badge was fed exclusively by the monitor's
 * `process_state` payload, which WebSocketWriter fans out to a session's primary
 * socket and its registered read-only mirrors only; a mirror is registered when
 * the client opens that session (check-session-status). So a sidebar could show
 * "5 active" in the global presence badge while painting a Running badge on the
 * single conversation the user had opened, and a project busy dot never lit for
 * a project the user was not currently viewing.
 */
type RunningSession = {
  sessionId: string;
  state: PresenceProcessState;
};

/** WS message type other clients/agents can rely on. */
export const PRESENCE_MESSAGE_TYPE = 'presence';

const users = new Map<PresenceUserId, PresenceUserState>();

/** Coalesce rapid changes into a single broadcast. */
const BROADCAST_DEBOUNCE_MS = 100;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

/** Coerces a raw user id into the canonical string key, or null when absent. */
function toPresenceUserId(rawUserId: string | number | null | undefined): PresenceUserId | null {
  if (rawUserId === null || rawUserId === undefined || rawUserId === '') {
    return null;
  }
  return String(rawUserId);
}

/**
 * Resolves the user's current avatar URL from the users table at snapshot time
 * (always fresh — picks up a newly uploaded picture without reconnecting).
 * Snapshots are tiny (2-4 users) and the lookup is an indexed point read, so
 * resolving here is cheaper than threading the avatar through every caller.
 * Never throws: presence must keep broadcasting even if the lookup fails.
 */
function resolveAvatarUrl(userId: PresenceUserId): string | null {
  const numericId = Number(userId);
  if (!Number.isInteger(numericId)) {
    return null;
  }
  try {
    return userDb.getUserById(numericId)?.avatar_url ?? null;
  } catch {
    return null;
  }
}

/**
 * Builds the presence snapshot for ONE recipient. The "active" run surfaced per
 * user is the most recently started one (a brother may have several runs going,
 * but the UI shows the freshest as the headline activity).
 *
 * B-PRIV: `visiblePaths` is the set of project paths the recipient may see. When
 * the freshest active run belongs to a project NOT in that set (a private
 * project the recipient is not a member of), the activity is REDACTED — the user
 * still shows as connected, but their active session/project/provider are nulled
 * so a private workspace path/session id never leaks through presence.
 */
function buildSnapshot(visiblePaths: Set<string>): PresenceEntry[] {
  const entries: PresenceEntry[] = [];
  for (const state of users.values()) {
    // B-289: a row may survive with zero sockets while it still owns live runs
    // (the browser closed/refreshed mid-run, or the run was started without a
    // socket). Such a user is NOT online, so they never enter the avatar stack —
    // but their runs keep counting in buildActiveConversations/
    // buildRunningSessions below, which is the whole point of keeping the row.
    if (state.sockets.size === 0) {
      continue;
    }
    let active: PresenceRun | null = null;
    for (const run of state.runs.values()) {
      if (!active || run.since > active.since) {
        active = run;
      }
    }

    // Redact the headline activity when its project is not visible to the
    // recipient. A null projectPath (provider without a resolved path) is left
    // visible — it carries no private path to leak.
    const activeVisible =
      active !== null &&
      (active.projectPath === null || visiblePaths.has(active.projectPath));
    const surfacedActive = activeVisible ? active : null;

    entries.push({
      userId: state.userId,
      username: state.username,
      avatarUrl: resolveAvatarUrl(state.userId),
      connected: true,
      active: Boolean(surfacedActive),
      activeSessionId: surfacedActive?.sessionId ?? null,
      activeProjectPath: surfacedActive?.projectPath ?? null,
      provider: surfacedActive?.provider ?? null,
      since: surfacedActive ? surfacedActive.since : state.connectedSince,
    });
  }
  // Stable order so clients don't see rows jump around between snapshots.
  entries.sort((a, b) => a.userId.localeCompare(b.userId));
  return entries;
}

/**
 * Builds the active-conversations detail for ONE recipient from ALL runs of ALL
 * users. Unlike buildSnapshot (which surfaces a single headline run per user),
 * this counts EVERY run so the global `total` matches the badge.
 *
 * B-PRIV: a run only contributes to `byProject` when its `projectPath` is
 * non-null AND present in `visiblePaths` (the same recipient-scoped set used by
 * buildSnapshot). Runs in projects the recipient may not see — and runs with a
 * null projectPath — never appear in `byProject`; they are absorbed into
 * `hiddenCount`, so no hidden project path can leak. The invariant
 * `total === sum(byProject[*].count) + hiddenCount` always holds.
 */
function buildActiveConversations(visiblePaths: Set<string>): ActiveConversations {
  let total = 0;
  const counts = new Map<string, number>();

  for (const state of users.values()) {
    for (const run of state.runs.values()) {
      total += 1;
      const path = run.projectPath;
      if (path !== null && visiblePaths.has(path)) {
        counts.set(path, (counts.get(path) ?? 0) + 1);
      }
    }
  }

  const byProject = [...counts.entries()]
    .map(([projectPath, count]) => ({ projectPath, count }))
    // Highest count first; tie-break by path for a stable, deterministic order.
    .sort((a, b) => b.count - a.count || a.projectPath.localeCompare(b.projectPath));

  const visibleTotal = byProject.reduce((sum, entry) => sum + entry.count, 0);
  return { total, byProject, hiddenCount: total - visibleTotal };
}

/**
 * B-269: builds the per-session running list for ONE recipient.
 *
 * B-PRIV: applies the SAME visibility rule buildSnapshot uses for the headline
 * activity — a run is surfaced when its project is visible to the recipient, or
 * when it has no resolved project path (nothing private to leak; the session id
 * alone carries no workspace path). Runs inside a private project the recipient
 * is not a member of are omitted entirely, so a hidden session id never reaches
 * a client that may not see it. The count badge is unaffected: those runs still
 * contribute to `activeConversations.total` via `hiddenCount`.
 *
 * Sorted by sessionId so the payload is stable between snapshots.
 */
function buildRunningSessions(visiblePaths: Set<string>): RunningSession[] {
  const entries: RunningSession[] = [];
  for (const state of users.values()) {
    for (const run of state.runs.values()) {
      if (run.projectPath !== null && !visiblePaths.has(run.projectPath)) {
        continue;
      }
      entries.push({ sessionId: run.sessionId, state: run.state });
    }
  }
  entries.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return entries;
}

/** Coerces a stamped socket userId into a DB user id, or null. */
function toRecipientUserId(rawUserId: string | number | null | undefined): number | null {
  if (typeof rawUserId === 'number') {
    return Number.isInteger(rawUserId) ? rawUserId : null;
  }
  if (typeof rawUserId === 'string' && rawUserId.trim() !== '') {
    const parsed = Number.parseInt(rawUserId, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Sends the snapshot to every open chat client immediately. B-PRIV: the snapshot
 * is built per-recipient and cached per distinct userId, so each client only
 * ever sees activity in projects it is allowed to see (private-project runs of
 * other users are redacted). Unauthenticated sockets get the public-only view.
 */
function broadcastNow(): void {
  broadcastTimer = null;
  const timestamp = new Date().toISOString();

  const payloadByUserId = new Map<number, string>();
  let publicPayload: string | null = null;

  const resolvePayload = (rawUserId: string | number | null | undefined): string => {
    const recipientId = toRecipientUserId(rawUserId);
    if (recipientId === null) {
      if (publicPayload === null) {
        const publicPaths = new Set(projectsDb.getVisibleProjectPaths(null));
        publicPayload = JSON.stringify({
          type: PRESENCE_MESSAGE_TYPE,
          users: buildSnapshot(publicPaths),
          activeConversations: buildActiveConversations(publicPaths),
          runningSessions: buildRunningSessions(publicPaths),
          timestamp,
        });
      }
      return publicPayload;
    }

    let payload = payloadByUserId.get(recipientId);
    if (!payload) {
      const visiblePaths = new Set(projectsDb.getVisibleProjectPaths(recipientId));
      payload = JSON.stringify({
        type: PRESENCE_MESSAGE_TYPE,
        users: buildSnapshot(visiblePaths),
        activeConversations: buildActiveConversations(visiblePaths),
        runningSessions: buildRunningSessions(visiblePaths),
        timestamp,
      });
      payloadByUserId.set(recipientId, payload);
    }
    return payload;
  };

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      try {
        client.send(resolvePayload(client.userId));
      } catch {
        // A failing socket will be cleaned up by its own close handler.
      }
    }
  });
}

/** Coalesces a broadcast so a burst of changes emits a single snapshot. */
function scheduleBroadcast(): void {
  if (broadcastTimer) {
    return;
  }
  broadcastTimer = setTimeout(broadcastNow, BROADCAST_DEBOUNCE_MS);
  if (typeof broadcastTimer.unref === 'function') {
    broadcastTimer.unref();
  }
}

/**
 * Registers an authenticated socket as connected. Multiple sockets for the same
 * user dedupe into one presence row (multi-tab/device). Returns silently for
 * unauthenticated sockets (no userId) so single-user/anonymous runs are ignored.
 */
export function presenceConnect(
  ws: RealtimeClientConnection,
  user: AuthenticatedWebSocketUser | undefined,
  rawUserId: string | number | null | undefined,
): void {
  const userId = toPresenceUserId(rawUserId);
  if (!userId || !ws) {
    return;
  }
  const username =
    typeof user?.username === 'string' && user.username.trim().length > 0
      ? user.username
      : userId;

  let state = users.get(userId);
  if (!state) {
    state = {
      userId,
      username,
      sockets: new Set(),
      runs: new Map(),
      connectedSince: Date.now(),
    };
    users.set(userId, state);
  } else {
    // Keep the freshest known username.
    state.username = username;
  }
  state.sockets.add(ws);
  scheduleBroadcast();
}

/**
 * Removes a socket. The user stays "connected" while any other socket of theirs
 * remains open.
 *
 * B-289: when the LAST socket closes the row is dropped ONLY if it owns no runs.
 * A live run outlives its browser socket (page refresh, closed tab, network
 * blip, laptop asleep) — the provider child keeps working and the process
 * monitor keeps polling it. Deleting the row here used to erase those runs, so
 * `activeConversations.total` fell to 0 and `runningSessions` went empty while
 * the monitor's own `process_state` stream still painted a green "Running" badge
 * on the reopened conversation: the "0 active + Running" contradiction. The row
 * now survives socket-less (invisible in the avatar stack, see buildSnapshot)
 * until presenceRunStopped drops its last run — the same condition that
 * function already applies.
 */
export function presenceDisconnect(ws: RealtimeClientConnection): void {
  if (!ws) {
    return;
  }
  for (const [userId, state] of users) {
    if (!state.sockets.delete(ws)) {
      continue;
    }
    if (state.sockets.size === 0 && state.runs.size === 0) {
      users.delete(userId);
    }
    scheduleBroadcast();
    return;
  }
}

/**
 * Marks a user as actively running a session. Safe to call for unauthenticated
 * runs (no userId) — they are simply ignored. A run started for a user with no
 * open socket still creates a transient presence row so the activity is visible;
 * it is cleaned up when the run stops or the socket set empties.
 */
export function presenceRunStarted(details: {
  userId: string | number | null | undefined;
  sessionId: string | null | undefined;
  projectPath?: string | null;
  provider?: LLMProvider | string | null;
  username?: string | null;
}): void {
  const userId = toPresenceUserId(details.userId);
  const sessionId = typeof details.sessionId === 'string' ? details.sessionId : '';
  if (!userId || !sessionId) {
    return;
  }

  let state = users.get(userId);
  if (!state) {
    // A run can begin before/without a tracked socket (e.g. resumed via a
    // background path). Create a presence row so the work is still visible.
    state = {
      userId,
      username:
        typeof details.username === 'string' && details.username.trim().length > 0
          ? details.username
          : userId,
      sockets: new Set(),
      runs: new Map(),
      connectedSince: Date.now(),
    };
    users.set(userId, state);
  } else if (typeof details.username === 'string' && details.username.trim().length > 0) {
    state.username = details.username;
  }

  // B-269: a re-register (the second addSession once the real session_id is
  // captured, or a writer refresh) must not reset an already-observed 'frozen'
  // back to 'running' — only the process monitor may move that flag.
  const previousState = state.runs.get(sessionId)?.state;
  state.runs.set(sessionId, {
    sessionId,
    projectPath: details.projectPath ?? null,
    provider: details.provider ?? null,
    since: Date.now(),
    state: previousState ?? 'running',
  });
  scheduleBroadcast();
}

/**
 * B-269: records the child-process state the monitor observed for a live run,
 * so the running list broadcast to EVERY client distinguishes a working session
 * from one frozen with `kill -STOP`.
 *
 * Deliberately a no-op when the value is unchanged: the monitor re-broadcasts
 * every 5s tick by design, and a snapshot per tick per run would be pure noise.
 * Unknown users/sessions are ignored (the run already ended).
 */
export function presenceRunState(details: {
  userId: string | number | null | undefined;
  sessionId: string | null | undefined;
  processState: string | null | undefined;
}): void {
  const userId = toPresenceUserId(details.userId);
  const sessionId = typeof details.sessionId === 'string' ? details.sessionId : '';
  if (!userId || !sessionId) {
    return;
  }
  if (details.processState !== 'running' && details.processState !== 'frozen') {
    return;
  }
  const run = users.get(userId)?.runs.get(sessionId);
  if (!run || run.state === details.processState) {
    return;
  }
  run.state = details.processState;
  scheduleBroadcast();
}

/**
 * Clears a user's active run. The user stays connected (and present) while any
 * socket remains open; if the run row was created without a socket and now has
 * no runs and no sockets, the row is dropped.
 */
export function presenceRunStopped(details: {
  userId: string | number | null | undefined;
  sessionId: string | null | undefined;
}): void {
  const userId = toPresenceUserId(details.userId);
  const sessionId = typeof details.sessionId === 'string' ? details.sessionId : '';
  if (!userId || !sessionId) {
    return;
  }
  const state = users.get(userId);
  if (!state) {
    return;
  }
  const had = state.runs.delete(sessionId);
  if (!had) {
    return;
  }
  if (state.runs.size === 0 && state.sockets.size === 0) {
    users.delete(userId);
  }
  scheduleBroadcast();
}
