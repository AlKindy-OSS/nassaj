/**
 * proseFence — which fenced blocks hold prose rather than code (B-1674).
 *
 * A fence with no language, or one tagged as plain text or Markdown, carries
 * human sentences (often Arabic mixed with Latin terms). Those resolve bidi per
 * line. Every other fence (a programming language, `diff`, shell) is code and
 * stays a strict LTR box so indentation and markers (`//`, `#`, `+`, `-`) keep
 * the left edge even when a line opens with an Arabic comment.
 */

/** Fence languages rendered as prose. `text` is also what an untagged fence reports. */
export const PROSE_FENCE_LANGUAGES: ReadonlySet<string> = new Set([
  'text',
  'plaintext',
  'markdown',
  'md',
]);

/**
 * True when a fence language (from `language-<x>`, or `undefined` when the fence
 * has none) should render as per-line prose.
 */
export function isProseFenceLanguage(language: string | null | undefined): boolean {
  if (!language) return true;
  return PROSE_FENCE_LANGUAGES.has(language.toLowerCase());
}

/** Splits the fence body into lines, dropping the single trailing newline a fence carries. */
export function proseFenceLines(source: string): string[] {
  return source.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
}
