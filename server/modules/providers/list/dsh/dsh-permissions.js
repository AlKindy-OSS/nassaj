/**
 * dsh-permissions — the member answers every dsh escalation (T-2086 S3, ADR-224).
 *
 * dsh asks `session/request_permission` (allow-once / reject-once) before an
 * operation outside its workspace sandbox. Nassaj turns each ask into a
 * `permission_request` frame on the turn's socket and holds dsh's request open
 * until ONE of:
 *   - the turn owner answers through `resolveDshPermission` (once only);
 *   - the owner's socket closes            → reject-once (permission_cancelled);
 *   - Claude's approval timeout passes     → reject-once (permission_cancelled):
 *     55 s for a tool, 30 min for an interactive question (dshPermissionTimeoutMs,
 *     the same values and env overrides as claude-sdk.js);
 *   - the run ends / is cancelled / drains → cancelled.
 * A settled question never re-opens. Nothing is ever approved without an answer.
 * Since ADR-226 the pending table is the shared one (services/permission-parity/
 * parity-permissions.js), so one resolver settles dsh and OpenCode questions alike; this file
 * keeps dsh's ACP outcome mapping and its names.
 */

import {
  cancelAllParityPermissions, cancelParityPermissionsForRun, isParityPermissionPending, parityPermissionTimeoutMs,
  PARITY_INTERACTIVE_APPROVAL_TIMEOUT_MS, PARITY_TOOL_APPROVAL_TIMEOUT_MS, requestParityPermission, resolveParityPermission,
} from '../../../../services/permission-parity/parity-permissions.js';

/** Claude's non-interactive tool approval timeout (claude-sdk.js TOOL_APPROVAL_TIMEOUT_MS). */
export const DSH_TOOL_APPROVAL_TIMEOUT_MS = PARITY_TOOL_APPROVAL_TIMEOUT_MS;
/** Claude's interactive ceiling (claude-sdk.js INTERACTIVE_APPROVAL_MAX_WAIT_MS). */
export const DSH_INTERACTIVE_APPROVAL_TIMEOUT_MS = PARITY_INTERACTIVE_APPROVAL_TIMEOUT_MS;
/** dsh tools that wait for a human answer (Claude: AskUserQuestion, ExitPlanMode). */
export const DSH_INTERACTIVE_TOOLS = Object.freeze(['ask_user_question']);

/**
 * The approval timeout Claude would use for `toolName`, with Claude's env overrides.
 * @param {string} toolName
 * @param {NodeJS.ProcessEnv} [env]
 */
export function dshPermissionTimeoutMs(toolName, env = process.env) {
  return parityPermissionTimeoutMs(DSH_INTERACTIVE_TOOLS.includes(toolName), env);
}

/** @typedef {{ outcome: 'selected', optionId: string } | { outcome: 'cancelled' }} AcpPermissionOutcome */

/** The option id of `kind` dsh offered, or null. */
function optionOfKind(options, kind) {
  const option = (Array.isArray(options) ? options : []).find((entry) => entry?.kind === kind);
  return typeof option?.optionId === 'string' ? option.optionId : null;
}

/** Maps a settlement to the ACP outcome (reject falls back to cancelled when not offered). */
function outcomeFor(how, options) {
  const optionId = how === 'allow' ? optionOfKind(options, 'allow_once')
    : how === 'cancel' ? null : optionOfKind(options, 'reject_once');
  return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
}

/**
 * Asks the member and resolves with dsh's ACP outcome.
 * @param {{ runId: string, ownerUserId: unknown, sessionId: string|null, toolName: string,
 *   input: unknown, options: unknown, writer: any, timeoutMs?: number }} ask
 * @returns {Promise<AcpPermissionOutcome>}
 */
export function requestDshPermission(ask) {
  // dsh answers keep their pre-ADR-226 shape: an answer's updatedInput is not inspected.
  return requestParityPermission({ ...ask, provider: 'dsh', interactive: DSH_INTERACTIVE_TOOLS.includes(ask.toolName),
    rejectRewrites: false }).then((how) => outcomeFor(how, ask.options));
}

/**
 * The member's answer (owner-only, once-only); true when this call settled the question.
 * @param {string} requestId
 * @param {{ allow?: boolean, requesterUserId?: unknown }} decision
 */
export function resolveDshPermission(requestId, decision = {}) {
  return resolveParityPermission(requestId, decision);
}

export {
  isParityPermissionPending as isDshPermissionPending,
  cancelParityPermissionsForRun as cancelDshPermissionsForRun,
  cancelAllParityPermissions as cancelAllDshPermissions,
};
