/**
 * known-providers — the providers the credential-isolation seam governs.
 *
 * Being listed is what makes a provider runnable for a member at all (ADR-105):
 * resolveProviderEnv refuses any id absent from this list instead of handing it
 * the operator's environment. Every listed provider is ALWAYS isolated per user
 * (ADR-152 amendment 1): there is no install-wide sharing policy, and another
 * member's credential is reachable only through a grant its owner made
 * (credential-principal.js).
 *
 * A deleted body (hermes, T-1953) is absent on purpose. Qwen stays listed while
 * its body is globally disabled (ADR-101): an omitted provider would reach the
 * operator environment on first wiring.
 */

/** @type {ReadonlyArray<'claude'|'codex'|'agy'|'cursor'|'opencode'|'kimi'|'deepseek'|'glm'|'qwen'|'dsh'>} */
export const KNOWN_PROVIDERS = Object.freeze([
  'claude',
  'codex',
  'agy',
  'cursor',
  'opencode',
  'kimi',
  'deepseek',
  'glm',
  'qwen',
  // T-2086/ADR-224: the DeepSeek Harness body, on the member's OWN deepseek key.
  'dsh',
]);
