/**
 * T-2086 (ADR-224) — the codes a dsh turn is refused with before it starts.
 *
 * Owner decision 2026-11-07: dsh stays visible and says why. Each code has its
 * own plain ar/en copy (`serverError.<code>`, via SERVER_ERROR_CODE_KEYS), so
 * the outbox card shows that copy and not the server's Arabic sentence, which
 * would leak Arabic into an English UI. CREDENTIAL_NOT_LINKED is not listed: it
 * has its own notice with the link-key action.
 */
export const DSH_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'dsh_permission_mode_unsupported',
  'dsh_permission_rule_unsupported',
  'dsh_claude_hooks_unsupported',
  'PERMISSION_EFFECTIVE_POLICY_REQUIRED',
  'dsh_coordination_unsupported',
  'dsh_shared_session_unsupported',
  'dsh_session_unknown',
  'dsh_session_id_invalid',
  'dsh_effort_unsupported',
  'session_busy',
  'governance_missing',
  'dsh_cwd_missing',
  'dsh_tree_tampered',
  'dsh_tree_unverified',
  'dsh_tree_unmanaged',
  // T-2089/ADR-225: refusals of the Claude-parity engine dsh now runs under.
  'dsh_claude_sandbox_unsupported',
  'dsh_policy_violation',
  'dsh_prompt_blocked',
  // T-2091: capability probes at launch and guard incidents mid-turn.
  'dsh_cap_channel',
  'dsh_cap_tools_api',
  'dsh_cap_gate',
  'dsh_gate_bypassed',
  'dsh_post_hook_skipped',
  'dsh_override_unverified',
]);

/**
 * dsh_prompt_blocked: the server's prompt guard blocked the message, and the
 * frame's `error` is that guard's own reason. It is kept as the detail and
 * shown in an isolated block under the localized sentence.
 */
export const DSH_GUARD_REASON_CODE = 'dsh_prompt_blocked';

/**
 * The install check had not finished verifying the dsh tree: a transient
 * start-up state, shown as "starting up, try again" rather than as a failure.
 */
export const DSH_STARTING_CODE = 'dsh_tree_unverified';

/** True for a dsh refusal whose localized copy replaces the server sentence. */
export function isLocalizedDshRefusal(provider: unknown, code: string | null): boolean {
  return provider === 'dsh' && code !== null && code !== DSH_GUARD_REASON_CODE && DSH_REFUSAL_CODES.has(code);
}
