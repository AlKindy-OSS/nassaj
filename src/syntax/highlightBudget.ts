/**
 * Plain rendering for code blocks too large to syntax-highlight.
 *
 * Prism tokenizes the whole block on every render and emits one DOM span per
 * token, so a pasted log or a generated file of a few hundred KB freezes the
 * main thread (and re-freezes on every streamed chunk). Above the budget the
 * block is shown as plain preformatted text in the same frame instead.
 */

/**
 * 100,000 characters (~100 KB of ASCII). Measured in characters rather than
 * lines so a single minified line cannot slip past it; well above any block a
 * reader actually reads highlighted, well below where tokenizing costs seconds.
 */
export const MAX_HIGHLIGHT_CHARS = 100_000;

/** True when `source` is too large to be syntax-highlighted. */
export function exceedsHighlightBudget(source: string): boolean {
  return source.length > MAX_HIGHLIGHT_CHARS;
}
