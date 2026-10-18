/**
 * B-1666 #8 — locate the rendered message a conversation-search snippet points
 * at. The server snippet is raw transcript text: `...` at a cut edge, newlines
 * folded to spaces, Markdown symbols still present. The rendered message is
 * Markdown output (`**x**` shows as `x`, and adjacent blocks such as list
 * items concatenate in `textContent` with no space), so whole-text equality
 * never holds; a short core segment is matched with whitespace and Markdown
 * symbols removed on both sides.
 */

/** Characters Markdown renders away (emphasis, code, headings, quotes, links, tables). */
const MARKDOWN_SYMBOLS = /[*_`~#>|[\]()]/g;
/** Shorter phrases match too many messages to be a useful anchor. */
const MIN_PHRASE_LENGTH = 10;
const CORE_LENGTH = 32;

/** Lower-cases and drops Markdown symbols and all whitespace. */
export function normalizeSearchText(text: string): string {
  return text.replace(MARKDOWN_SYMBOLS, '').replace(/\s+/g, '').toLowerCase();
}

/**
 * Candidate phrases, most specific first: the snippet's centre (the server
 * centres it on the match), then its start and end — so a masked or
 * differently rendered edge does not defeat the whole lookup.
 */
export function searchPhrases(snippet: string): string[] {
  const core = normalizeSearchText(snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, ''));
  if (core.length < MIN_PHRASE_LENGTH) return [];
  if (core.length <= CORE_LENGTH) return [core];
  const middle = Math.floor((core.length - CORE_LENGTH) / 2);
  const phrases = [core.slice(middle, middle + CORE_LENGTH), core.slice(0, CORE_LENGTH), core.slice(-CORE_LENGTH)];
  return [...new Set(phrases)];
}

/** The first rendered `.chat-message` whose normalised text holds a snippet phrase. */
export function findSearchTargetElement(container: ParentNode, snippet: string): Element | null {
  const phrases = searchPhrases(snippet);
  if (phrases.length === 0) return null;
  const messages = [...container.querySelectorAll('.chat-message')]
    .map((element) => ({ element, text: normalizeSearchText(element.textContent || '') }));
  for (const phrase of phrases) {
    const hit = messages.find((message) => message.text.includes(phrase));
    if (hit) return hit.element;
  }
  return null;
}
