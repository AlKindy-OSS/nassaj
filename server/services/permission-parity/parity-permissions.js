/**
 * parity-permissions — the member answers every "ask" of a harness that mirrors Claude
 * (dsh: T-2086 S3, ADR-224; OpenCode: ADR-226 §3). One pending table for every harness, so
 * the shared `claude-permission-response` frame settles any of them.
 *
 * Each ask becomes a `permission_request` frame (with the harness `provider`) on the turn's
 * socket and stays open until ONE of:
 *   - the turn owner answers through `resolveParityPermission` (once only);
 *   - the owner's socket closes            → 'offline'  (permission_cancelled);
 *   - Claude's approval timeout passes     → 'timeout'  (permission_cancelled): 55 s for a
 *     tool, 30 min for an interactive question (parityPermissionTimeoutMs, the same values and
 *     env overrides as claude-sdk.js);
 *   - the run ends / is cancelled / drains → 'cancel'.
 * A settled question never re-opens. Nothing is ever approved without an answer.
 * Card answers (ADR-226 M11, `rejectRewrites`, on unless the caller opts out): an answer
 * carrying `updatedInput` is a reject (a rewritten call is not the call the engine decided);
 * "always allow" (`rememberEntry`) acts as allow-once. Stricter than Claude; documented.
 */
import crypto from 'node:crypto';

import { createNormalizedMessage } from '../../shared/utils.js';

/** Claude's non-interactive tool approval timeout (claude-sdk.js TOOL_APPROVAL_TIMEOUT_MS). */
export const PARITY_TOOL_APPROVAL_TIMEOUT_MS = 55000;
/** Claude's interactive ceiling (claude-sdk.js INTERACTIVE_APPROVAL_MAX_WAIT_MS). */
export const PARITY_INTERACTIVE_APPROVAL_TIMEOUT_MS = 1800000;

/**
 * The approval timeout Claude would use, with Claude's env overrides.
 * @param {boolean} interactive the question waits for a human answer (AskUserQuestion-like)
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parityPermissionTimeoutMs(interactive, env = process.env) {
  if (interactive) {
    return Number.parseInt(env.CLAUDE_INTERACTIVE_APPROVAL_TIMEOUT_MS ?? '', 10) || PARITY_INTERACTIVE_APPROVAL_TIMEOUT_MS;
  }
  return Number.parseInt(env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS ?? '', 10) || PARITY_TOOL_APPROVAL_TIMEOUT_MS;
}

/** @typedef {'allow'|'reject'|'offline'|'timeout'|'cancel'} ParitySettlement */

/** @type {Map<string, { runId: string, ownerUserId: unknown, provider: string, rejectRewrites: boolean, settle: (how: ParitySettlement) => void }>} */
const pending = new Map();

/**
 * Asks the member; resolves with how the question settled ('allow' only on an owner's approval).
 * @param {{ provider: string, runId: string, ownerUserId: unknown, sessionId: string|null, toolName: string,
 *   input: unknown, writer: any, timeoutMs?: number, interactive?: boolean, rejectRewrites?: boolean }} ask
 * @returns {Promise<ParitySettlement>}
 */
export function requestParityPermission(ask) {
  const provider = String(ask.provider || 'parity');
  const requestId = `${provider}-perm-${crypto.randomUUID()}`;
  const send = (fields) => {
    try {
      ask.writer?.send?.(createNormalizedMessage({ ...fields, requestId, sessionId: ask.sessionId ?? '', provider }));
    } catch {
      // the socket is gone; the close/timeout path settles the question
    }
  };
  return new Promise((resolve) => {
    const raw = ask.writer?.ws;
    let timer = null;
    const onClose = () => settle('offline');
    const settle = (how) => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      clearTimeout(timer);
      raw?.off?.('close', onClose);
      if (how !== 'allow' && how !== 'reject') send({ kind: 'permission_cancelled', reason: how });
      resolve(how);
    };
    pending.set(requestId, { runId: ask.runId, ownerUserId: ask.ownerUserId, provider, rejectRewrites: ask.rejectRewrites !== false, settle });
    if (raw && typeof raw.readyState === 'number' && raw.readyState !== 1) {
      settle('offline');
      return;
    }
    raw?.once?.('close', onClose);
    timer = setTimeout(() => settle('timeout'), ask.timeoutMs ?? parityPermissionTimeoutMs(ask.interactive === true));
    timer.unref?.();
    send({ kind: 'permission_request', toolName: ask.toolName, input: ask.input });
  });
}

/**
 * The member's answer. Only the turn owner may answer (`requesterUserId` is the
 * authenticated socket user; omitted only by in-process callers). Accepts
 * `(requestId, decision)` or one object `{ requestId, ...decision }`. Returns true when
 * this call settled the question, false when it was unknown, settled or foreign.
 * @param {string|{ requestId: string, allow?: boolean, updatedInput?: unknown, requesterUserId?: unknown }} requestOrAnswer
 * @param {{ allow?: boolean, updatedInput?: unknown, requesterUserId?: unknown }} [decision]
 */
export function resolveParityPermission(requestOrAnswer, decision = {}) {
  const answer = typeof requestOrAnswer === 'object' && requestOrAnswer !== null ? requestOrAnswer : { ...decision, requestId: requestOrAnswer };
  const entry = typeof answer.requestId === 'string' ? pending.get(answer.requestId) : undefined;
  if (!entry) return false;
  if (answer.requesterUserId !== undefined && String(answer.requesterUserId) !== String(entry.ownerUserId)) {
    console.warn('[parity] refused a permission answer from a non-owner', { requestId: answer.requestId, provider: entry.provider });
    return false;
  }
  const rewritten = entry.rejectRewrites && answer.updatedInput !== undefined && answer.updatedInput !== null;
  entry.settle(answer.allow === true && !rewritten ? 'allow' : 'reject');
  return true;
}

/** True while `requestId` waits for an answer. */
export function isParityPermissionPending(requestId) {
  return pending.has(requestId);
}

/** Cancels every question of one run (turn ended, cancelled or killed). */
export function cancelParityPermissionsForRun(runId) {
  for (const entry of [...pending.values()]) if (entry.runId === runId) entry.settle('cancel');
}

/** Cancels every pending question (drain/shutdown). Returns how many were open. */
export function cancelAllParityPermissions() {
  const open = [...pending.values()];
  for (const entry of open) entry.settle('cancel');
  return open.length;
}
