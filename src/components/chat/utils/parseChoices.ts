/**
 * T-2027 (ADR-209) — trailing ```choices fence → quick-reply options.
 *
 * Single source of truth for BOTH hiding the fence and rendering the buttons:
 * when this returns non-null the caller renders `body` as Markdown and the
 * options as buttons; when it returns null the message renders untouched, so
 * an invalid fence simply shows as an ordinary code block.
 */

/** Upper bound on offered options; more than this is treated as plain code. */
export const MAX_CHOICES = 5;
/** Upper bound (in code points) on a single option's length. */
export const MAX_CHOICE_LEN = 60;

const MIN_CHOICES = 2;

export type ParsedChoices = {
  /** Cleaned, de-duplicated option labels (plain text, never Markdown). */
  choices: string[];
  /** The message text with the trailing fence cut off. */
  body: string;
};

/** Any CommonMark fence opener (0–3 spaces of indent). Group 1 = the fence run. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** The only opener that counts: column 0, exactly three backticks, info `choices`. */
const CHOICES_OPEN = /^```choices[ \t]*$/;
/** The only closer that counts: column 0, exactly three backticks. */
const CHOICES_CLOSE = /^```[ \t]*$/;
/**
 * Invisible or format characters: controls (Cc), format chars (Cf: bidi marks,
 * zero-width, U+061C, U+2060-2064, soft hyphen, Unicode Tags), line/paragraph
 * separators, plus fillers (U+034F, U+115F, U+1160, U+3164, U+FFA0) and
 * variation selectors. Not \p{Mn}: that would strip Arabic harakat such as shadda.
 */
// Variation selectors are listed on purpose so they are stripped, not combined.
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
/** A leading list marker: `- `, `* `, `1. ` or `1) `. */
const LIST_PREFIX = /^(?:[-*]|\d{1,3}[.)])\s+/;

type ClosedFence = { start: number; end: number; opener: string };

/**
 * Walk the document as CommonMark would at top level and return the last
 * *closed* fence. Scanning from the top (rather than matching the tail) is
 * what makes a ```choices line inside a 4-backtick example, or inside an
 * earlier unclosed fence, never count.
 */
function findLastClosedFence(lines: string[]): ClosedFence | null {
  let open: { start: number; closer: RegExp } | null = null;
  let last: ClosedFence | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!open) {
      const match = FENCE_OPEN.exec(line);
      // A backtick fence's info string may not itself contain a backtick.
      if (match && !(match[1][0] === '`' && match[2].includes('`'))) {
        // Built once per opened fence, not once per scanned line.
        const closer = new RegExp(`^ {0,3}\\${match[1][0]}{${match[1].length},}[ \\t]*$`);
        open = { start: i, closer };
      }
      continue;
    }
    if (open.closer.test(line)) {
      last = { start: open.start, end: i, opener: lines[open.start] };
      open = null;
    }
  }
  return open ? null : last;
}

function cleanOption(raw: string): string {
  return raw.replace(INVISIBLE_CHARS, '').trim().replace(LIST_PREFIX, '').trim();
}

/** `/x` would become a slash command and bare `help` is the /help alias on send. */
function isCommandLike(option: string): boolean {
  return option.startsWith('/') || option.toLowerCase() === 'help';
}

/**
 * Parse a trailing ```choices fence. Returns null unless the fence is the last
 * top-level block and every validation rule holds.
 */
export function parseChoices(content: string): ParsedChoices | null {
  if (typeof content !== 'string' || !content.includes('```choices')) return null;
  const lines = content.replace(/\r\n?/g, '\n').trimEnd().split('\n');
  const fence = findLastClosedFence(lines);
  if (!fence || fence.end !== lines.length - 1) return null;
  if (!CHOICES_OPEN.test(fence.opener) || !CHOICES_CLOSE.test(lines[fence.end])) return null;

  const choices: string[] = [];
  for (const raw of lines.slice(fence.start + 1, fence.end)) {
    const option = cleanOption(raw);
    if (!option || choices.includes(option)) continue;
    if (Array.from(option).length > MAX_CHOICE_LEN || isCommandLike(option)) return null;
    choices.push(option);
  }
  if (choices.length < MIN_CHOICES || choices.length > MAX_CHOICES) return null;

  return { choices, body: lines.slice(0, fence.start).join('\n').trimEnd() };
}
