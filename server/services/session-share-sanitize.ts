/**
 * Pure text sanitizer for public session share snapshots (ADR-196, T-1970).
 *
 * Turns one transcript string into viewer parts: governance injections and
 * harness tags are cut, images become markers, run-button fences become plain
 * code, and what is left goes through the shared secret/path redactor. Every
 * scanner here is linear in the input: fixed tag names, bounded lookaheads and
 * no backtracking regex over unbounded runs.
 */
import { DOCUMENT_SHARING_INSTRUCTIONS, stripRuntimeInstructionsPrefix } from '../../shared/documentSharingInstructions.js';
import { PUBLIC_PAGE_TAG } from '../../shared/publicPageGuidance.js';

import { redactForShare } from './secret-patterns.js';

export type ShareRedactionCategory = 'system' | 'image' | 'secret' | 'path' | 'network';
export type SharePart =
  | { t: 'text'; text: string }
  | { t: 'redacted'; cat: ShareRedactionCategory; text?: string };
export type ShareTextCounts = Record<ShareRedactionCategory, number>;
export type ShareTextContext = { projectRoot?: string | null; home?: string | null };

/** Harness/governance tags removed with their whole body (matched case-insensitively). */
const STRIPPED_TAGS = new Set([
  'system-reminder', 'command-name', 'command-message', 'command-args', 'command-contents',
  'local-command-stdout', 'local-command-stderr', 'local-command-caveat', 'user-prompt-submit-hook',
  'bash-input', 'bash-stdout', 'bash-stderr', 'task-notification', 'subagent_notification',
  'nassaj_document_sharing', PUBLIC_PAGE_TAG, 'coordination', 'environment_context',
  'recommended_plugins', 'instructions', 'user_instructions', 'permissions', 'plugins_instructions',
  'multi_agent_role', 'multi_agent_mode', 'turn_aborted', 'system_message', 'additional_metadata',
]);
const SUFFIX_TAG = /^[a-z][a-z0-9_-]{0,48}(?:-hook|[_-]instructions|[_-]context|[_-]reminder|[_-]notification)$/;
const TAG_NAME_CHAR = /[A-Za-z0-9_-]/;
const MAX_TAG_NAME = 64;
const MAX_TAG_ATTRS = 256;

function isStrippedTag(name: string): boolean {
  return STRIPPED_TAGS.has(name) || SUFFIX_TAG.test(name);
}

/** Reads `<name …>` or `</name>` at `at`; returns null when it is not a well-formed tag. */
function readTag(text: string, at: number): { name: string; end: number; closing: boolean } | null {
  let i = at + 1;
  const closing = text[i] === '/';
  if (closing) i += 1;
  const nameStart = i;
  while (i < text.length && i - nameStart < MAX_TAG_NAME && TAG_NAME_CHAR.test(text[i])) i += 1;
  if (i === nameStart) return null;
  const name = text.slice(nameStart, i).toLowerCase();
  const limit = Math.min(text.length, i + MAX_TAG_ATTRS);
  for (let j = i; j < limit; j += 1) {
    if (text[j] === '>') return { name, end: j + 1, closing };
    if (text[j] === '\n' || text[j] === '<') return null;
  }
  return null;
}

/**
 * Closing tag for `name` at/after `from` (case-insensitive, attributes such as
 * `</permissions instructions>` allowed): returns its end index, or -1. A name
 * whose closer is absent is memoized so repeated openers stay linear.
 */
function findCloseEnd(text: string, lower: string, name: string, from: number, missing: Set<string>): number {
  if (missing.has(name)) return -1;
  for (let at = lower.indexOf(`</${name}`, from); at !== -1; at = lower.indexOf(`</${name}`, at + 1)) {
    const tag = readTag(text, at);
    if (tag?.closing && tag.name === name) return tag.end;
  }
  missing.add(name);
  return -1;
}

/**
 * Removes stripped tags in one forward pass. A closed tag goes with its body;
 * an unclosed opener (or a stray closer) loses only its own marker, so user
 * text after it survives. Each removal leaves one `system` marker.
 */
export function stripHarnessTags(text: string, counts: ShareTextCounts): SharePart[] {
  const parts: SharePart[] = [];
  const lower = text.toLowerCase();
  const missing = new Set<string>();
  let cursor = 0;
  let at = text.indexOf('<');
  while (at !== -1) {
    const tag = readTag(text, at);
    if (!tag || !isStrippedTag(tag.name)) { at = text.indexOf('<', at + 1); continue; }
    pushText(parts, text.slice(cursor, at));
    let resume = tag.end;
    if (!tag.closing) {
      const closeEnd = findCloseEnd(text, lower, tag.name, tag.end, missing);
      if (closeEnd !== -1) resume = closeEnd;
    }
    parts.push({ t: 'redacted', cat: 'system' });
    counts.system += 1;
    cursor = resume;
    at = text.indexOf('<', resume);
  }
  pushText(parts, text.slice(cursor));
  return parts;
}

/** Codex prefixes injected repository instructions with this heading line. */
const AGENTS_HEADING = /^#[ \t]+AGENTS\.md instructions[^\n]{0,1000}\n[ \t\n]{0,16}(?=<instructions>)/gim;

/** Removes the runtime instruction prefix, injected instruction headings and literal sharing guidance. */
export function stripGovernanceText(text: string, counts: ShareTextCounts): string {
  let out = stripRuntimeInstructionsPrefix(text);
  if (out !== text) counts.system += 1;
  out = out.replace(AGENTS_HEADING, () => { counts.system += 1; return ''; });
  if (out.includes(DOCUMENT_SHARING_INSTRUCTIONS)) {
    const pieces = out.split(DOCUMENT_SHARING_INSTRUCTIONS);
    counts.system += pieces.length - 1;
    out = pieces.join('');
  }
  return out;
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Line pass over fenced blocks: an ```image fence becomes one image marker
 * (an unclosed one runs to the end, failing closed) and a ```bash nassaj-run
 * fence loses its run tag so it renders as plain code.
 */
export function rewriteFences(text: string, counts: ShareTextCounts): SharePart[] {
  const lines = text.split('\n');
  const parts: SharePart[] = [];
  let buffer: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN.exec(lines[i]);
    const info = open?.[3].trim().toLowerCase() ?? '';
    if (open && info === 'image') {
      pushText(parts, buffer.join('\n'));
      buffer = [];
      i = skipFence(lines, i, open[2]);
      parts.push({ t: 'redacted', cat: 'image' });
      counts.image += 1;
      continue;
    }
    buffer.push(open && /^bash\s+nassaj-run(?:\s|$)/.test(info) ? `${open[1]}${open[2]}bash` : lines[i]);
  }
  pushText(parts, buffer.join('\n'));
  return parts;
}

/** Index of the closing line of the fence opened at `start`, or the last line. */
function skipFence(lines: string[], start: number, fence: string): number {
  for (let j = start + 1; j < lines.length; j += 1) {
    const close = FENCE_CLOSE.exec(lines[j]);
    if (close && close[1][0] === fence[0] && close[1].length >= fence.length) return j;
  }
  return lines.length - 1;
}

const IMAGE_PATTERNS: RegExp[] = [
  /!\[[^[\]\n]{0,300}\]\([^()\s]{0,2000}(?:[ \t]+"[^"\n]{0,300}")?\)/g,
  /<img\b[^<>\n]{0,4000}>/gi,
  /data:image\/[a-z0-9.+-]{1,32};base64,[A-Za-z0-9+/=]*/gi,
];
const IMAGE_LIST_HEADER = '[Images provided at the following paths:]';
const IMAGE_LIST_ITEM = /\n\d{1,3}\. [^\n]{1,2000}/y;
const IMAGE_STORE_SEGMENTS = ['/chat-images/', '/assistant-images/'];
const URL_STOP = /[\s()<>"'`[\]]/;

/** Ranges of bare image-store URLs or paths, expanded to their delimiters (bounded). */
function imageStoreRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const segment of IMAGE_STORE_SEGMENTS) {
    let at = text.indexOf(segment);
    while (at !== -1) {
      let start = at;
      while (start > 0 && at - start < 2000 && !URL_STOP.test(text[start - 1])) start -= 1;
      let end = at + segment.length;
      while (end < text.length && end - at < 2000 && !URL_STOP.test(text[end])) end += 1;
      ranges.push([start, end]);
      at = text.indexOf(segment, end);
    }
  }
  return ranges;
}

/**
 * Ranges of `[Images provided…]` headers with their numbered path lines. A
 * sticky per-line loop, not a `(?:…)*` group: a regexp group repeated per line
 * overflows the backtrack stack on a multi-MiB list.
 */
function imageListRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let at = text.indexOf(IMAGE_LIST_HEADER); at !== -1; at = text.indexOf(IMAGE_LIST_HEADER, at + 1)) {
    let end = at + IMAGE_LIST_HEADER.length;
    IMAGE_LIST_ITEM.lastIndex = end;
    for (let item = IMAGE_LIST_ITEM.exec(text); item; item = IMAGE_LIST_ITEM.exec(text)) end = IMAGE_LIST_ITEM.lastIndex;
    ranges.push([at, end]);
    at = end - 1;
  }
  return ranges;
}

/** Replaces inline images, image URLs and attachment path lists with image markers. */
export function redactImages(text: string, counts: ShareTextCounts): SharePart[] {
  const ranges = [...imageStoreRanges(text), ...imageListRanges(text)];
  for (const pattern of IMAGE_PATTERNS) {
    for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const parts: SharePart[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    if (start >= cursor) {
      pushText(parts, text.slice(cursor, start));
      parts.push({ t: 'redacted', cat: 'image' });
      counts.image += 1;
    }
    cursor = end;
  }
  pushText(parts, text.slice(cursor));
  return parts;
}

/** Applies the shared secret/path/network redactor to one text run. */
function redactSecrets(text: string, ctx: ShareTextContext, counts: ShareTextCounts): SharePart[] {
  const result = redactForShare(text, {
    projectRoot: ctx.projectRoot ?? undefined,
    home: ctx.home ?? undefined,
  });
  for (const cat of ['secret', 'path', 'network'] as const) counts[cat] += result.counts[cat] ?? 0;
  return result.segments.map((segment: { t: string; cat?: string; text?: string }): SharePart => {
    if (segment.t === 'text') return { t: 'text', text: segment.text ?? '' };
    const cat = (segment.cat ?? 'secret') as ShareRedactionCategory;
    return cat === 'path' && segment.text ? { t: 'redacted', cat, text: segment.text } : { t: 'redacted', cat };
  });
}

function pushText(parts: SharePart[], text: string): void {
  if (text.length > 0) parts.push({ t: 'text', text });
}

/** Runs `step` over every text part, keeping markers in place. */
function flatMapText(parts: SharePart[], step: (text: string) => SharePart[]): SharePart[] {
  return parts.flatMap((part) => (part.t === 'text' ? step(part.text) : [part]));
}

/** Joins adjacent text, collapses repeated identical markers, trims blank edges. */
export function normalizeParts(parts: SharePart[]): SharePart[] {
  const out: SharePart[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (part.t === 'text' && last?.t === 'text') last.text += part.text;
    else if (part.t === 'redacted' && last?.t === 'redacted' && last.cat === part.cat && last.text === part.text) continue;
    else out.push({ ...part });
  }
  const first = out[0];
  // trimStart/trimEnd, not /\s+$/: that regex retries every blank run and is quadratic.
  if (first?.t === 'text') first.text = first.text.trimStart();
  const tail = out.at(-1);
  if (tail?.t === 'text') tail.text = tail.text.trimEnd();
  return out.filter((part) => part.t !== 'text' || part.text.length > 0);
}

/**
 * Full sanitization of one message body.
 * @returns viewer parts; an empty array when nothing shareable remains.
 */
export function sanitizeShareText(text: string, ctx: ShareTextContext, counts: ShareTextCounts): SharePart[] {
  const governed = stripGovernanceText(text, counts);
  let parts = stripHarnessTags(governed, counts);
  parts = flatMapText(parts, (chunk) => rewriteFences(chunk, counts));
  parts = flatMapText(parts, (chunk) => redactImages(chunk, counts));
  parts = flatMapText(parts, (chunk) => redactSecrets(chunk, ctx, counts));
  const normalized = normalizeParts(parts);
  return normalized.some((part) => part.t === 'text' && part.text.trim().length > 0) ? normalized : [];
}
