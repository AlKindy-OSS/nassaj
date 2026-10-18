/**
 * Transcript text that the harness wrote, not the human: shared by the
 * conversation search and the session title derivation (B-1668), so a prompt
 * that search hides can never become a conversation's name either.
 */

export const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  'Invalid API key',
  '[Request interrupted',
] as const;

/**
 * Codex includes extra internal metadata tags that should not surface as
 * user-facing searchable conversation content.
 */
export const CODEX_INTERNAL_CONTENT_PREFIXES = [
  '<environment_context>',
  '<cwd>',
] as const;

/** Claude's resume summary opens the continued conversation as a user turn. */
const CLAUDE_CONTINUATION_PREFIX = 'This session is being continued from a previous conversation';

export function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

export function isInternalCodexContent(content: string): boolean {
  const normalized = content.trimStart();
  return CODEX_INTERNAL_CONTENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** True when a user-role text is harness output and must not name a conversation. */
export function isInternalUserText(content: string): boolean {
  const normalized = content.trimStart();
  return isInternalContent(normalized)
    || isInternalCodexContent(normalized)
    || normalized.startsWith(CLAUDE_CONTINUATION_PREFIX);
}
