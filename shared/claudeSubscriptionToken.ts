/**
 * The one definition of what a Claude subscription token looks like. Server
 * guards, the Claude credential writer and the settings UI all read it from
 * here, so a new prefix from Anthropic is a one-line change, not three.
 */

/** Prefix Anthropic gives a `claude setup-token` subscription OAuth token. */
export const SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat01-';

/**
 * ADR-200 S1 (L2): every OAuth-token generation, not only `oat01`. A refusal
 * keyed to one version would wave `sk-ant-oat02-…` through to a non-Claude
 * writer the day Anthropic bumps the number.
 */
export const SUBSCRIPTION_TOKEN_PATTERN = /^sk-ant-oat\d+-/;

/** True when `value` is a Claude subscription token (pattern test on the trimmed form). */
export function isClaudeSubscriptionToken(value: unknown): boolean {
  return typeof value === 'string' && SUBSCRIPTION_TOKEN_PATTERN.test(value.trim());
}
