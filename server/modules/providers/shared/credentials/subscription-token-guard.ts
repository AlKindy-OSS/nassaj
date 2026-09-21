/**
 * subscription-token-guard — B-1252: a personal Claude subscription token may
 * only ever be stored where Claude Code itself reads it.
 *
 * `claude setup-token` prints a long-lived OAuth token whose prefix is
 * `sk-ant-oat01-`. It is NOT an API key: it is the bearer of a personal Max /
 * Pro subscription, bound to the person it was minted for and to Anthropic's
 * own client. Pasting it into any OTHER credential surface is never a working
 * configuration and is always a harm:
 *
 *   • toward the vendor — routing a personal subscription through a third-party
 *     harness (opencode's `anthropic` target, a vendor key field, a `codex
 *     login`) is exactly the use Anthropic's terms forbid;
 *   • toward the member — the token is written verbatim into a file whose
 *     purpose is to be handed to a DIFFERENT vendor's client, so the secret
 *     leaves the boundary its owner believed it stayed inside;
 *   • toward the operator — the save reports success and the harness then fails
 *     to authenticate, which reads as a nassaj bug rather than a wrong paste.
 *
 * Commit 102f68298 stated this rule, but only the catalog/UI enforced it — the
 * server writers accepted the token from any client that skipped the UI. This
 * guard is the server-side enforcement and lives in exactly ONE place so a
 * writer added later can adopt it with a single call rather than a copy.
 *
 * The Claude writer deliberately does NOT call it: `CLAUDE_CODE_OAUTH_TOKEN` in
 * that user's own settings.json is the token's one legitimate home.
 *
 * The refusal NEVER echoes the value, not even a prefix or a length — an error
 * message is logged, returned over the wire, and often shown on screen.
 */

import { AppError } from '@/shared/utils.js';

import { SUBSCRIPTION_TOKEN_PREFIX, isClaudeSubscriptionToken } from '../../../../../shared/claudeSubscriptionToken.js';

export { SUBSCRIPTION_TOKEN_PREFIX, isClaudeSubscriptionToken };

/**
 * Refuses to store a Claude subscription token anywhere but Claude's own
 * settings.json. No-op for every other value.
 *
 * @param value the raw credential the caller wants stored
 * @param destination human-readable name of the surface being written, for the
 *   message only — must never be derived from the secret
 * @throws {AppError} 400 `SUBSCRIPTION_TOKEN_FORBIDDEN_TARGET`
 */
export function assertNotClaudeSubscriptionToken(value: unknown, destination: string): void {
  if (!isClaudeSubscriptionToken(value)) {
    return;
  }
  throw new AppError(
    `That value is a Claude subscription token (from "claude setup-token"), not an API key, `
    + `and it cannot be stored for ${destination}. A personal Claude subscription runs only `
    + 'through Claude itself — link it under the Claude agent. Paste a normal API key here.',
    { code: 'SUBSCRIPTION_TOKEN_FORBIDDEN_TARGET', statusCode: 400 },
  );
}
