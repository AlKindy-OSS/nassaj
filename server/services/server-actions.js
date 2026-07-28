/**
 * server-actions — STATIC, server-side allowlist of privileged host actions an
 * owner may trigger from the web UI (ADR-066, T-944).
 *
 * WHY THIS EXISTS
 *   The Claude Code client guard intercepts restart-class commands (pm2 restart,
 *   …) ONLY when they originate from a Claude process. When the SAME command is
 *   spawned by THIS node server (a plain child process, not a Claude session) the
 *   guard does not fire. So: a coordinator records a "pending server action", the
 *   owner clicks a button in the UI, and the server executes the fixed command via
 *   spawn — bypassing the guard legitimately because it is not a Claude command.
 *
 * SECURITY CONTRACT (ADR-066, owner decision — do not weaken)
 *   The real command is FIXED IN CODE, keyed by a symbolic action type. A pending
 *   request stores ONLY: { actionType (a key of this allowlist), sessionId,
 *   reason, … } — never a shell string. At execution the actionType is looked up
 *   here and the corresponding STATIC argv is spawned WITHOUT a shell. An unknown
 *   actionType is rejected (never executed). No field from the client or the DB is
 *   ever interpolated into a command. Extend by adding a FROZEN key below + a
 *   qa-critic review — never by accepting a command string from a request. The
 *   raw `pm2 restart` action is DELIBERATELY absent (it re-opens B-95/502); the
 *   only restart path is safe-restart.
 *
 * This module is PURE: no DB, no spawn. It is imported by both the server route
 * (persistence via the pending_server_actions repository) and the coordinator CLI
 * (persistence via a direct sqlite handle), so the allowlist and the request
 * shape have a single source of truth. Keep it dependency-light (only crypto +
 * runtime-paths) so it loads under both `tsx`/dist (server) and plain `node`
 * (the .mjs CLI).
 */

import crypto from 'crypto';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

const __dirname = getModuleDir(import.meta.url);

/**
 * Repo/app root — the cwd for every allowlisted action (scripts/ lives here).
 * Resolved once via the nearest /server folder so it is stable across both the
 * /server source layout and the /dist-server/server compiled output.
 */
export const APP_ROOT = findAppRoot(__dirname);

/**
 * STATIC allowlist: symbolic actionType -> fixed action definition. This is the
 * ONLY place an actionType becomes an executable command. Each entry is spawned
 * as `spawn(cmd, args, { cwd })` WITHOUT a shell, so there is no interpolation
 * surface. `args`/`gateArgs` are frozen arrays of literal tokens.
 *
 *   labelKey       — i18n key the client uses to render the button/banner label.
 *   minRole        — the LEAST-privileged role permitted to EXECUTE this action
 *                    (owner ⊇ admin ⊇ user). Frozen; defaults to 'owner'. The
 *                    coarse route floor (requireRole) is a first gate; the route
 *                    then narrows per-action via roleSatisfies(role, minRole).
 *                    Widening a specific action to 'admin' is a one-line change
 *                    here — gated on a qa-critic veto, not done for convenience.
 *   cmd/args       — the literal execution argv (no shell).
 *   gateArgs       — the literal read-only pre-flight gate argv (no shell), or
 *                    undefined when an action has no gate. For safe-restart this
 *                    is the `--json` gate that reports whether a restart is safe.
 *   detachExec     — true when the execution must be spawned detached+unref
 *                    (it restarts THIS process, so it has to outlive the response).
 *   cwd            — working directory (repo root).
 *   commandPreview — human-readable preview shown in the UI (never used to build
 *                    a command).
 *   description    — server-side note (never used to build a command).
 *
 * Only `safe-restart` is seeded. A future action is added by appending a frozen
 * key here (+ qa-critic) — never by accepting a command from the request.
 */
export const SERVER_ACTIONS = Object.freeze({
  'safe-restart': Object.freeze({
    labelKey: 'safeRestart',
    // Owner-only for now (a restart runs as the server owner). Widening to
    // 'admin' awaits a qa-critic veto and is a one-line change (T-947).
    minRole: 'owner',
    cmd: 'bash',
    args: Object.freeze(['scripts/safe-restart.sh', '--exec']),
    gateArgs: Object.freeze(['scripts/safe-restart.sh', '--json']),
    detachExec: true,
    cwd: APP_ROOT,
    commandPreview: 'bash scripts/safe-restart.sh --exec',
    description: 'Drain-safe restart (B-95).',
    // A restart is GLOBAL and idempotent: one run satisfies every request that
    // was waiting for it, whichever conversation asked. Without this flag the
    // queue deduped on (action_type, session_id), so N conversations each asking
    // for a deploy produced N rows — and pressing them in sequence produced N
    // real restarts. Measured 2026-07-26: three triggers 21s apart (15:35:34/44/55)
    // and two 14s apart (01:03:37/51), each one a drain that cuts live sockets,
    // orphans in-flight tool approvals and shows up as a "brief disconnect".
    // The queue is a to-do list, not a command log: the same pending work must
    // collapse to one row, and running it must clear every row asking for it.
    globalIdempotent: true,
  }),
});

/**
 * True when one execution of `type` satisfies EVERY pending request for it,
 * regardless of which session asked. Such actions dedupe on action_type alone
 * and clear their siblings on success.
 */
export function isGlobalIdempotentAction(type) {
  const action = getAction(type);
  return action?.globalIdempotent === true;
}

/**
 * Returns the frozen action definition for `type`, or null if `type` is not an
 * allowlisted actionType. Null MUST be treated as "reject" by callers.
 */
export function getAction(type) {
  if (typeof type !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(SERVER_ACTIONS, type)) return null;
  return SERVER_ACTIONS[type];
}

/** True only for an allowlisted actionType. */
export const isAllowedAction = (type) => getAction(type) !== null;

/** The list of allowlisted actionType keys (for help text / diagnostics). */
export const listActionTypes = () => Object.keys(SERVER_ACTIONS);

// A sessionId is written by the coordinator; it must never reach a shell or a
// path, so it is validated defensively as an opaque, bounded token regardless.
const SAFE_SESSION_ID = /^[\w.-]{1,128}$/;

/** Hard cap on a stored reason string (defensive; the UI shows it verbatim). */
const MAX_REASON_LEN = 300;

/**
 * Builds and validates a pending-action record for CREATION (the coordinator CLI
 * and the create endpoint). Pure — generates a random id. Rejects (fail-closed)
 * any actionType outside the allowlist and any unsafe sessionId. Trims reason to
 * MAX_REASON_LEN. `requested_at`/`status` are supplied by the DB defaults, not
 * here.
 *
 * The set of accepted actionTypes is injectable via `options.isAllowed` so the
 * server can extend it to owner-defined custom commands (T-948 Phase 2) WITHOUT
 * making this pure module depend on the DB — the coordinator CLI keeps the
 * default static-only allowlist. The validator MUST be fail-closed.
 *
 * @param {{ actionType?: unknown, sessionId?: unknown, reason?: unknown,
 *           requestedBy?: unknown }} input
 * @param {{ isAllowed?: (type: unknown) => boolean }} [options]
 * @returns {{ ok: true, value: {
 *             id: string, actionType: string, sessionId: string|null,
 *             reason: string|null, requestedBy: string|null
 *           } } | { ok: false, error: string }}
 */
export function buildPendingAction(input, options = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const { actionType } = src;
  const isAllowed =
    options && typeof options.isAllowed === 'function' ? options.isAllowed : isAllowedAction;

  if (!isAllowed(actionType)) {
    const shown = typeof actionType === 'string' ? actionType : '<non-string>';
    return { ok: false, error: `Unknown action type: ${shown}` };
  }

  let sessionId = null;
  if (src.sessionId !== undefined && src.sessionId !== null) {
    if (typeof src.sessionId !== 'string' || !SAFE_SESSION_ID.test(src.sessionId)) {
      return { ok: false, error: 'Invalid sessionId (must match ^[\\w.-]{1,128}$)' };
    }
    sessionId = src.sessionId;
  }

  const reason =
    typeof src.reason === 'string' && src.reason.trim().length > 0
      ? src.reason.trim().slice(0, MAX_REASON_LEN)
      : null;

  const requestedBy =
    typeof src.requestedBy === 'string' && src.requestedBy.trim().length > 0
      ? src.requestedBy.trim().slice(0, 200)
      : null;

  return {
    ok: true,
    value: {
      id: crypto.randomUUID(),
      actionType,
      sessionId,
      reason,
      requestedBy,
    },
  };
}

/**
 * Client-safe projection of a stored/actionable row: symbolic + display fields
 * only. NEVER exposes cmd/args/gateArgs. `label` and `commandPreview` are pulled
 * from the allowlist definition (falling back gracefully if the row references a
 * type no longer allowlisted). `requestedBy`/`executedAt` are intentionally
 * omitted from the public shape.
 *
 * `resolve` defaults to the static allowlist lookup; the server passes a unified
 * resolver so a custom-command row (T-948 Phase 2) surfaces its label/preview too.
 * It is only ever used for DISPLAY fields — never to build a command.
 *
 * @param {{ id: string, actionType: string, sessionId: string|null,
 *           reason: string|null, status: string, error: string|null,
 *           requestedAt: string }} row
 * @param {(type: string) => ({labelKey: string, commandPreview: string}|null)} [resolve]
 */
export function toPublic(row, resolve = getAction) {
  if (!row || typeof row !== 'object') return null;
  const resolver = typeof resolve === 'function' ? resolve : getAction;
  const action = resolver(row.actionType);
  return {
    id: row.id,
    actionType: row.actionType,
    label: action ? action.labelKey : row.actionType,
    commandPreview: action ? action.commandPreview : null,
    reason: row.reason ?? null,
    sessionId: row.sessionId ?? null,
    status: row.status,
    error: row.error ?? null,
    requestedAt: row.requestedAt,
  };
}

/**
 * Client-safe CATALOG of every allowlisted action, for the UI to render the
 * inline run button (T-947). PURE (no DB). Each entry is symbolic + display
 * only: { actionType, label (labelKey), commandPreview, minRole }. It NEVER
 * exposes cmd/args/gateArgs — the executable argv stays server-side. Listing
 * the catalog is a READ (≠ executing), so it is open to any authenticated
 * session; the per-action minRole is advisory for the client and is enforced
 * server-side at execution time.
 *
 * @returns {Array<{ actionType: string, label: string, commandPreview: string,
 *                   minRole: string }>}
 */
export function toPublicCatalog() {
  return Object.entries(SERVER_ACTIONS).map(([actionType, def]) => ({
    actionType,
    label: def.labelKey,
    commandPreview: def.commandPreview,
    minRole: def.minRole,
  }));
}
