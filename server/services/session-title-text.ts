/**
 * Session title text (B-1668 item 3): what a conversation is called in the
 * sidebar, the search results, the archive and the live-session panel.
 *
 * Titles are derived from the first thing a user typed, and that text carries
 * whatever the server injected next to it: the `[Images provided…]` list,
 * `<nassaj_document_sharing>` guidance, Codex's AGENTS.md envelope, markdown.
 * The text is cleaned in two phases around display masking (ADR-210):
 *
 *  1. Before masking, whole injected blocks are removed (governance text,
 *     harness tags, image markers) — never anything INSIDE a word, so a stored
 *     secret keeps the exact spelling the masker matches literally.
 *  2. After masking, markdown markers are dropped at word boundaries only, and
 *     `[masked:<rule>]` markers are left intact.
 *
 * Every scan is linear: fixed tag names and bounded character classes, no
 * nested quantifiers over unbounded runs.
 */
import { maskDisplayLabel } from './display-secret-mask.js';
import {
  isStrippedTag,
  redactImages,
  stripGovernanceText,
  stripHarnessTags,
  type SharePart,
  type ShareTextCounts,
} from './session-share-sanitize.js';

const PLACEHOLDER_TITLES = new Set([
  'Untitled Claude Session',
  'Untitled Codex Session',
  'Untitled OpenCode Session',
  'Untitled Cursor Session',
  'New Antigravity Chat',
]);
/** OpenCode's own default title, e.g. `New session - 2026-10-16T12:35:45.123Z`. */
const OPENCODE_DEFAULT_TITLE = /^New session - \d{4}-\d{2}-\d{2}T[\d:.]{1,20}Z$/;

const TAG_OPENER = /<([A-Za-z][A-Za-z0-9_-]{0,63})(?:[ \t][^<>\n]{0,256})?>/g;

const emptyCounts = (): ShareTextCounts => ({ system: 0, image: 0, secret: 0, path: 0, network: 0 });
const textOf = (parts: SharePart[]): string =>
  parts.flatMap((part) => (part.t === 'text' ? [part.text] : [])).join(' ');

/** True for a provider's "no title yet" placeholder; the client shows its own localized label. */
export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  const trimmed = (title ?? '').trim();
  return PLACEHOLDER_TITLES.has(trimmed) || OPENCODE_DEFAULT_TITLE.test(trimmed);
}

/**
 * Cuts the text at the first injected-block opener whose closer is missing —
 * a stored title truncated inside `<nassaj_document_sharing>` would otherwise
 * surface the guidance text as the conversation name.
 */
function cutAtUnclosedBlock(text: string): string {
  const lower = text.toLowerCase();
  const lastCloser = new Map<string, number>();
  for (const match of text.matchAll(TAG_OPENER)) {
    const name = match[1].toLowerCase();
    if (!isStrippedTag(name)) continue;
    if (!lastCloser.has(name)) lastCloser.set(name, lower.lastIndexOf(`</${name}`));
    if ((lastCloser.get(name) ?? -1) < match.index) return text.slice(0, match.index);
  }
  return text;
}

/**
 * Phase 1: removes injected blocks and image markers, joining what is left
 * with single spaces at the cut points. Line breaks inside the user text are
 * kept (the markdown pass reads line starts).
 */
export function stripInjectedBlocks(raw: string, options: { cutUnclosed?: boolean } = {}): string {
  const counts = emptyCounts();
  const governed = stripGovernanceText(raw, counts);
  const bounded = options.cutUnclosed ? cutAtUnclosedBlock(governed) : governed;
  const parts = stripHarnessTags(bounded, counts)
    .flatMap((part) => (part.t === 'text' ? redactImages(part.text, counts) : [part]));
  return textOf(parts);
}

const LINE_MARKER = /^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,3}[.)][ \t]+)/gm;
const LINK = /\[([^[\]\n]{1,300})\]\([^()\s]{0,2000}\)/g;
const EMPHASIS_OPEN = /(^|[\s([{"'«])(\*\*|__)(?=[^\s*_])/gmu;
const EMPHASIS_CLOSE = /(?<=[^\s*_])(\*\*|__)(?=$|[\s.,;:!?)\]}"'»،؛؟])/gmu;
const SINGLE_STAR = /(^|\s)\*(?=[^\s*])([^*\n]{1,300}?)(?<=[^\s*])\*(?=$|[\s.,;:!?)\]])/gmu;

function stripMarkdownOnce(text: string): string {
  return text
    .replace(LINE_MARKER, '')
    .replace(LINK, (whole, label: string) => (label.startsWith('masked:') ? whole : label))
    .replace(EMPHASIS_OPEN, '$1')
    .replace(EMPHASIS_CLOSE, '')
    .replace(SINGLE_STAR, '$1$2')
    .replace(/`+/g, '')
    .replace(/~~/g, '');
}

/**
 * Phase 2: drops markdown markers (headings, quotes, list bullets, links,
 * emphasis at word boundaries, code ticks). Repeated until stable so the
 * result is idempotent — a rename round-trip must not keep changing a title.
 */
export function stripMarkdownMarkers(text: string): string {
  let current = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = stripMarkdownOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Write-side title text: phase 1 only, collapsed to one line. Synchronizers
 * store this, so a stored title keeps every character the masker may need.
 */
export function toTitleText(raw: string | null | undefined): string {
  return typeof raw === 'string' ? collapse(stripInjectedBlocks(raw, { cutUnclosed: true })) : '';
}

/**
 * Pre-mask half of the display pipeline. A rename round-trip passes the stored
 * value through this before `restoreMaskedLabel`, so the marker count matches
 * the title the user was shown.
 */
export function titleTextBeforeMask(raw: string | null | undefined): string {
  const text = toTitleText(raw);
  return isPlaceholderSessionTitle(text) ? '' : text;
}

/**
 * THE title a viewer sees: phase 1, display masking, phase 2. Placeholders map
 * to '' so the client renders its localized "new session" label.
 */
export function displaySessionTitle(raw: string | null | undefined): string {
  const text = titleTextBeforeMask(raw);
  return text ? collapse(stripMarkdownMarkers(maskDisplayLabel(text))) : '';
}

/**
 * Message text for a search snippet: injected blocks out, `mask` applied (the
 * caller's ADR-210 masker, identity when masking is off), then markdown out.
 * The SAME text must feed both the match and the snippet, so a hit can never
 * be scored on text the viewer does not see.
 */
export function displaySearchText(raw: string, mask: (text: string) => string): string {
  return stripMarkdownMarkers(mask(stripInjectedBlocks(raw)));
}
