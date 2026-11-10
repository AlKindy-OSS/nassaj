/**
 * nassaj-host-rules — the rules Nassaj adds to Claude on this host, applied by the parity
 * engine on Claude's exact terms (ADR-226 §4 B-1762).
 *
 * Today: the public-page cage (T-1804). On Claude it lives in `canUseTool`, so it binds in
 * every mode, bypass included, except when an allow rule covers the call (the SDK decides
 * an allowed call before `canUseTool`, B-171). The engine calls this after deny rules and
 * before the mode, and only when no allow rule covers the call. The logic has one source:
 * `evaluatePublicPageWrite`, the same function claude-sdk.js calls.
 * Not here: NASSAJ_PROVIDER_CAGE (not applied to Claude, so not to any mirror) and the
 * engine write fence (owner decision D1).
 */
// The cage's single source, shared with claude-sdk.js (same cross-tree seam as that call site).
// eslint-disable-next-line boundaries/no-unknown
import { evaluatePublicPageWrite } from '../public-page-agent-guidance.js';

/**
 * The host-rule denial of one Claude call, or null.
 * @param {{ tool_name: string, tool_input: object }} call
 * @param {{ cwd: string }} ctx
 * @returns {{ reason: string, rule: string }|null}
 */
export function nassajHostRuleDenial({ tool_name: toolName, tool_input: input }, { cwd }) {
  const verdict = evaluatePublicPageWrite(toolName, input, { cwd });
  return verdict.ok ? null : { reason: verdict.message, rule: 'public-page-build-output' };
}
