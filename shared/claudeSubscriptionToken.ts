/**
 * The one definition of what a Claude subscription token looks like. Server
 * guards, the Claude credential writer and the settings UI all read it from
 * here, so a new prefix from Anthropic is a one-line change, not three.
 */

/** Prefix Anthropic gives a `claude setup-token` subscription OAuth token. */
export const SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat01-';

/** True when `value` is a Claude subscription token (prefix test on the trimmed form). */
export function isClaudeSubscriptionToken(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith(SUBSCRIPTION_TOKEN_PREFIX);
}
