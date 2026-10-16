/**
 * free-form-shell-gate.js — admission policy for the composer shell one-shot
 * (T-2037, ADR-213 proposed).
 *
 * A FREE-FORM `initialCommand` on the /shell WebSocket (anything that is not one
 * of the fixed provider-login commands) runs as `bash -c <verbatim>` on the HOST
 * under the service account. That is exactly the command board's raw exec, so it
 * passes the SAME brakes, read live on every decision:
 *
 *   1. role ∈ FREE_SHELL_ALLOWED_ROLES (owner/admin)          → forbidden
 *   2. payload shape: isPlainShell === true, hasSession === false and a UUID
 *      runId                                                  → oneshot_shape_invalid
 *   3. rawExecEnvironmentBlockers() is empty                  → raw_exec_blocked
 *   4. getCommandBoardConfig().rawExecEnabled                 → raw_exec_disabled
 *   5. canRoleRunRawExec(role)                                → config_denied
 *   6. validateRawCommand(command).ok                         → its own code
 *      (denied_command:<rule>, forbidden_control_char, carriage_return_forbidden,
 *      command_too_long, too_many_lines)
 *
 * It also owns the per-user caps. The consumed-runId ledger that stops an
 * unrequested re-execution (a reconnect, a replayed init, a restart) is durable:
 * shell_oneshot_runs, via shellOneShotRunsDb in the database module.
 *
 * HONEST SCOPE. Like the command board, this is governance around arbitrary
 * shell, not a sandbox: an admitted command can detach a child (`nohup`,
 * `setsid`, `disown`, a double fork) that outlives the PTY kill at the lifetime
 * cap, and the denylist is a string matcher an intentional user can evade. The
 * guarantees are: no spawn without every brake above, no spawn without a
 * verified audit row, and no second spawn for the same runId.
 */

import { canRoleRunRawExec, getCommandBoardConfig, rawExecEnvironmentBlockers } from './command-board-config.js';
import { validateRawCommand } from './command-board-raw.js';

/** Roles that may run any free-form shell command at all (SEC-SHELL-ROLE). */
export const FREE_SHELL_ALLOWED_ROLES = Object.freeze(['owner', 'admin']);

/** Live (reserved or running) one-shots a single user may hold at once. */
export const ONESHOT_MAX_LIVE_PER_USER = 3;
/** One-shot starts a single user may reserve in any rolling minute. */
export const ONESHOT_MAX_STARTS_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60_000;
/** Default PTY lifetime of a one-shot; NASSAJ_ONESHOT_LIFETIME_MS overrides it. */
export const DEFAULT_ONESHOT_LIFETIME_MS = 30 * 60 * 1000;

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validation errors passed through to the client verbatim as refusal codes. */
const PASSTHROUGH_VALIDATION_CODES = new Set([
  'forbidden_control_char',
  'carriage_return_forbidden',
  'command_too_long',
  'too_many_lines',
]);

/**
 * The one-shot lifetime in ms: NASSAJ_ONESHOT_LIFETIME_MS when it is a positive
 * integer, else the 30-minute default. Read on every start (no restart needed).
 * @returns {number}
 */
export function oneShotLifetimeMs() {
  const raw = Number(process.env.NASSAJ_ONESHOT_LIFETIME_MS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_ONESHOT_LIFETIME_MS;
}

/**
 * True for a client-generated RFC 4122 UUID (the only accepted runId form).
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidRunId(value) {
  return typeof value === 'string' && RUN_ID_RE.test(value);
}

/**
 * The live brakes for a run's owner, from the CURRENT role (read from the
 * database by the caller, never the role the socket opened with): the
 * free-shell role set, then the raw-exec brakes.
 * @param {string | null | undefined} currentRole
 * @returns {string | null} refusal code, or null when the run may go on.
 */
export function oneShotBrakeFor(currentRole) {
  if (typeof currentRole !== 'string' || !FREE_SHELL_ALLOWED_ROLES.includes(currentRole)) return 'forbidden';
  return rawExecBrakeFor(currentRole);
}

/**
 * The live raw-exec brakes (3–5 above) for `role`, re-evaluated from storage.
 * Used at admission and again immediately before spawn.
 * @param {string | null | undefined} role
 * @returns {string | null} refusal code, or null when raw exec is allowed now.
 */
export function rawExecBrakeFor(role) {
  if (rawExecEnvironmentBlockers().length > 0) return 'raw_exec_blocked';
  const config = getCommandBoardConfig();
  if (!config.rawExecEnabled) return 'raw_exec_disabled';
  if (!canRoleRunRawExec(role, config)) return 'config_denied';
  return null;
}

/**
 * Maps a validateRawCommand failure onto the refusal code sent to the client.
 * @param {{ error: string }} result
 * @returns {string}
 */
function validationRefusalCode(result) {
  if (result.error.startsWith('denied_command:')) return result.error;
  if (PASSTHROUGH_VALIDATION_CODES.has(result.error)) return result.error;
  return 'invalid_command';
}

/**
 * The full admission decision for a free-form one-shot. Pure apart from the
 * live config reads; it never spawns, writes or audits.
 * @param {{ role: string | null | undefined, command: string, isPlainShell: unknown,
 *           hasSession: unknown, runId: unknown }} input
 * @returns {{ ok: true, value: { command: string, digest: string, runId: string } }
 *          | { ok: false, code: string }}
 */
export function evaluateFreeFormShellAdmission({ role, command, isPlainShell, hasSession, runId }) {
  if (typeof role !== 'string' || !FREE_SHELL_ALLOWED_ROLES.includes(role)) {
    return { ok: false, code: 'forbidden' };
  }
  if (isPlainShell !== true || hasSession !== false || !isValidRunId(runId)) {
    return { ok: false, code: 'oneshot_shape_invalid' };
  }
  const brake = rawExecBrakeFor(role);
  if (brake) return { ok: false, code: brake };
  const validation = validateRawCommand(command);
  if (!validation.ok) return { ok: false, code: validationRefusalCode(validation) };
  return { ok: true, value: { ...validation.value, runId: runId.toLowerCase() } };
}

/**
 * Admission of an ATTACH-ONLY init (`attachOnly: true`): it may reattach to a
 * live run or report how a run ended, and can never spawn, so it needs the
 * free-shell role and the one-shot shape but not the raw-exec brakes (a live
 * run is ended by the brake sweep when those close). The command is ignored.
 * @param {{ role: string | null | undefined, isPlainShell: unknown, hasSession: unknown, runId: unknown }} input
 * @returns {{ ok: true, value: { runId: string } } | { ok: false, code: string }}
 */
export function evaluateOneShotAttach({ role, isPlainShell, hasSession, runId }) {
  if (typeof role !== 'string' || !FREE_SHELL_ALLOWED_ROLES.includes(role)) {
    return { ok: false, code: 'forbidden' };
  }
  if (isPlainShell !== true || hasSession !== false || !isValidRunId(runId)) {
    return { ok: false, code: 'oneshot_shape_invalid' };
  }
  return { ok: true, value: { runId: runId.toLowerCase() } };
}

/**
 * Per-user one-shot limiter: at most `maxLive` live one-shots and `maxPerMinute`
 * starts in a rolling minute. `reserve` is synchronous so a burst of concurrent
 * inits cannot all pass before the first one is counted. A start counts against
 * the rate even when it later fails (no refund): the rate bounds attempts.
 * @param {{ maxLive?: number, maxPerMinute?: number, now?: () => number }} [options]
 */
export function createOneShotLimiter({
  maxLive = ONESHOT_MAX_LIVE_PER_USER,
  maxPerMinute = ONESHOT_MAX_STARTS_PER_MINUTE,
  now = Date.now,
} = {}) {
  /** @type {Map<string, { live: number, starts: number[] }>} */
  const byUser = new Map();

  const stateFor = (userKey) => {
    let state = byUser.get(userKey);
    if (!state) {
      state = { live: 0, starts: [] };
      byUser.set(userKey, state);
    }
    return state;
  };

  return {
    /**
     * Reserves one live slot. The returned `release` is idempotent.
     * @param {string | number} userId
     * @returns {{ ok: true, release: () => void } | { ok: false, code: 'oneshot_limit' }}
     */
    reserve(userId) {
      const userKey = String(userId);
      const state = stateFor(userKey);
      const cutoff = now() - RATE_WINDOW_MS;
      state.starts = state.starts.filter((at) => at > cutoff);
      if (state.live >= maxLive || state.starts.length >= maxPerMinute) {
        return { ok: false, code: 'oneshot_limit' };
      }
      state.live += 1;
      state.starts.push(now());
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          state.live = Math.max(0, state.live - 1);
        },
      };
    },
    /** Live slots currently held by `userId` (tests and diagnostics). */
    liveCount(userId) {
      return byUser.get(String(userId))?.live ?? 0;
    },
    reset() {
      byUser.clear();
    },
  };
}
