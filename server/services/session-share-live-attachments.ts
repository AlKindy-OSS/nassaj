/**
 * Attachment extraction for live session read links (ADR-205 D2 step 7, D9).
 *
 * Attachment sources are data (`ATTACHMENT_SOURCES`), not provider branches:
 * a server-appended path note at the end of a user message, an image fence in
 * assistant text, embedded image data on the normalized row, or a normalized
 * count of attachments the history no longer holds. Each item becomes a viewer
 * part plus a server-only locator; the locator is never serialized. Loading
 * and serving live in `session-share-live-serve.ts`.
 */
import path from 'node:path';

import { isSecretLocation } from './session-share-live-files.js';
import { sanitizeShareText, type SharePart, type ShareTextContext, type ShareTextCounts } from './session-share-sanitize.js';

export type AttachmentKind = 'image' | 'file';
/** Server-only pointer to an attachment's bytes; never leaves the process. */
export type AttachmentLocator =
  | { source: 'chat-image'; bucket: string; name: string }
  | { source: 'inbox-file'; path: string }
  | { source: 'assistant-image'; path: string }
  | { source: 'embedded-image'; dataUri: string };
export type LivePart =
  | SharePart
  | { t: 'redacted'; cat: 'truncated' }
  | { t: 'image' }
  | { t: 'file'; name: string }
  | { t: 'attachment-unavailable'; kind: AttachmentKind };
/** One message body after extraction: viewer parts and the locators of its image/file parts, in order. */
export type ExtractedBody = { parts: LivePart[]; locators: AttachmentLocator[] };
/** The normalized fields extraction reads. */
export type AttachmentSourceRow = {
  role: 'user' | 'assistant'; text: string; images?: unknown; imagesOmitted?: unknown; attachmentsUnavailable?: unknown;
};
/**
 * Sanitizer context for one row. `isTextFile` is the projection-time policy (a)
 * check (N2); without it every file attachment is withheld (fail closed).
 */
export type LiveRowContext = ShareTextContext & { isTextFile?: (locator: AttachmentLocator) => boolean };

type Item = { kind: AttachmentKind; locator: AttachmentLocator | null; name?: string; secretPath?: string };
type Segment = { text: string } | { item: Item };

const CHAT_IMAGE_BUCKET = /^[0-9a-f]{32}$/;
const CHAT_IMAGE_NAME = /^image_\d+(?:\.orig)?\.[a-z0-9]+$/;
const INBOX_PREFIX = `${path.join('.nassaj-uploads', 'inbox')}${path.sep}`;
const EMBEDDED_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const EMBEDDED_MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_OMITTED = 64;
const MAX_NAME_CHARS = 120;
// C0/C1 controls and bidi controls (U+061C, U+200E/F, U+202A-E, U+2066-9).
const NAME_CONTROLS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/** Chat-image store path (`…/chat-images/<bucket>/<name>`) → locator, or null. */
function locateChatImage(entry: string): Item {
  const [bucket, name] = entry.split('/').slice(-2);
  const valid = entry.includes('/chat-images/') && CHAT_IMAGE_BUCKET.test(bucket ?? '') && CHAT_IMAGE_NAME.test(name ?? '');
  return { kind: 'image', locator: valid ? { source: 'chat-image', bucket, name } : null };
}

/** Project-inbox path (cwd-relative as recorded) → locator; anything outside the inbox is unavailable. */
function locateInboxFile(entry: string, ctx: ShareTextContext): Item {
  const relative = path.normalize(entry);
  const inside = !path.isAbsolute(relative) && relative.startsWith(INBOX_PREFIX);
  const resolved = path.resolve(ctx.projectRoot ?? path.sep, relative);
  return { kind: 'file', name: path.basename(relative), secretPath: resolved,
    locator: inside ? { source: 'inbox-file', path: relative } : null };
}

/** ADR-157 image fence: its first non-empty line is an absolute local path. */
function locateAssistantImage(entry: string): Item {
  const valid = path.isAbsolute(entry);
  return { kind: 'image', secretPath: valid ? entry : undefined,
    locator: valid ? { source: 'assistant-image', path: entry } : null };
}

/** Embedded raster data URI within the inline size cap → locator, else unavailable. */
function locateEmbeddedImage(entry: unknown): Item {
  const match = typeof entry === 'string' ? EMBEDDED_IMAGE.exec(entry) : null;
  const bytes = match ? Math.floor((match[2].length * 3) / 4) : Infinity;
  return { kind: 'image', locator: match && bytes <= EMBEDDED_MAX_BYTES ? { source: 'embedded-image', dataUri: entry as string } : null };
}

/** The attachment inventory (D9) as data; extraction walks it, never a provider id. */
export const ATTACHMENT_SOURCES = Object.freeze([
  { via: 'note', role: 'user', header: '[Images provided at the following paths:]', locate: locateChatImage },
  { via: 'note', role: 'user', header: '[Files provided at the following paths:]', locate: locateInboxFile },
  { via: 'fence', role: 'assistant', info: 'image', locate: locateAssistantImage },
  { via: 'field', role: 'user', field: 'images', omittedField: 'imagesOmitted', locate: locateEmbeddedImage },
  { via: 'unavailable', role: 'user', field: 'attachmentsUnavailable' },
] as const);

type NoteSource = Extract<(typeof ATTACHMENT_SOURCES)[number], { via: 'note' }>;
type FieldSource = Extract<(typeof ATTACHMENT_SOURCES)[number], { via: 'field' }>;
type UnavailableSource = Extract<(typeof ATTACHMENT_SOURCES)[number], { via: 'unavailable' }>;

/**
 * Peels one exact server-appended note block (`\n\n<header>\n1. …\n2. …`) off
 * the end of `text` (N8: look-alike text elsewhere never matches).
 */
function peelNote(text: string, header: string): { rest: string; entries: string[] } | null {
  const at = text.lastIndexOf(header);
  if (at === -1 || (at !== 0 && !text.startsWith('\n\n', at - 2))) return null;
  const lines = text.slice(at + header.length).split('\n');
  if (lines[0] !== '' || lines.length < 2) return null;
  const entries: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const match = /^(\d{1,3})\. (.+)$/.exec(lines[i]);
    if (!match || Number(match[1]) !== i) return null;
    entries.push(match[2]);
  }
  return { rest: text.slice(0, Math.max(0, at - 2)), entries };
}

/** Peels every trailing note block, last first, and returns the items in source order. */
function peelNotes(text: string, ctx: ShareTextContext, sources: NoteSource[]): { rest: string; items: Item[] } {
  const groups: Item[][] = [];
  let rest = text.trimEnd();
  for (let peeled = true; peeled;) {
    peeled = false;
    for (const source of sources) {
      const note = peelNote(rest, source.header);
      if (!note) continue;
      groups.unshift(note.entries.map((entry) => source.locate(entry, ctx)));
      rest = note.rest.trimEnd();
      peeled = true;
    }
  }
  return { rest, items: groups.flat() };
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n]*)$/;

/** Index of the line closing a fence opened with `fence`, or the line count when unclosed (fail closed). */
function fenceEnd(lines: string[], start: number, fence: string): number {
  for (let j = start + 1; j < lines.length; j += 1) {
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
    if (close && close[1][0] === fence[0] && close[1].length >= fence.length) return j;
  }
  return lines.length;
}

/** Splits text on fences whose info string is `info`, turning each into one item. */
function splitFences(text: string, info: string, locate: (entry: string) => Item): Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let buffer: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open || open[2].trim().toLowerCase() !== info) { buffer.push(lines[i]); continue; }
    const end = fenceEnd(lines, i, open[1]);
    const entry = lines.slice(i + 1, end).find((line) => line.trim() !== '')?.trim() ?? '';
    segments.push({ text: buffer.join('\n') }, { item: locate(entry) });
    buffer = [];
    i = end;
  }
  segments.push({ text: buffer.join('\n') });
  return segments;
}

/** Embedded items from a normalized row field plus its omitted count (each omitted one is unavailable). */
function fieldItems(row: AttachmentSourceRow, source: FieldSource): Item[] {
  const values = row[source.field];
  const items = Array.isArray(values) ? values.map((value) => source.locate(value)) : [];
  const omitted = Number(row[source.omittedField]);
  const count = Number.isSafeInteger(omitted) && omitted > 0 ? Math.min(omitted, MAX_OMITTED) : 0;
  for (let i = 0; i < count; i += 1) items.push({ kind: 'image', locator: null });
  return items;
}

/** Bounded count of one kind in a normalized `{ image, file }` unavailable-attachments record. */
function unavailableCount(record: unknown, kind: AttachmentKind): number {
  const value = Number((record as Record<string, unknown> | null)?.[kind]);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_OMITTED) : 0;
}

/** Items for attachments the history records but no longer holds: each is unavailable. */
function unavailableItems(row: AttachmentSourceRow, source: UnavailableSource): Item[] {
  const record = row[source.field];
  if (!record || typeof record !== 'object') return [];
  const items: Item[] = [];
  for (const kind of ['image', 'file'] as const) {
    for (let i = 0; i < unavailableCount(record, kind); i += 1) items.push({ kind, locator: null });
  }
  return items;
}

/**
 * Splits one row into ordered text runs and attachment items, driven by
 * `ATTACHMENT_SOURCES` for the row's role.
 */
export function extractAttachments(row: AttachmentSourceRow, ctx: ShareTextContext): Segment[] {
  const sources = ATTACHMENT_SOURCES.filter((source) => source.role === row.role);
  const notes = peelNotes(row.text, ctx, sources.filter((s): s is NoteSource => s.via === 'note'));
  let segments: Segment[] = [{ text: notes.rest }];
  for (const source of sources) {
    if (source.via !== 'fence') continue;
    segments = segments.flatMap((segment) => ('text' in segment ? splitFences(segment.text, source.info, source.locate) : [segment]));
  }
  const trailing = [...notes.items];
  for (const source of sources) {
    if (source.via === 'field') trailing.push(...fieldItems(row, source));
    else if (source.via === 'unavailable') trailing.push(...unavailableItems(row, source));
  }
  return [...segments, ...trailing.map((item) => ({ item }))];
}

/** Basename shown for a file: controls stripped, sanitized, `file` when anything was redacted, capped. */
export function sanitizeAttachmentName(name: string, ctx: ShareTextContext, counts: ShareTextCounts): string {
  const plain = path.basename(name).replace(NAME_CONTROLS, '');
  const parts = sanitizeShareText(plain, ctx, counts);
  if (parts.length === 0 || parts.some((part) => part.t !== 'text')) return 'file';
  return parts.map((part) => (part.t === 'text' ? part.text : '')).join('').slice(0, MAX_NAME_CHARS) || 'file';
}

/**
 * One item → its viewer part, appending a locator only for a resolvable,
 * non-secret item; a file must also pass the policy (a) text check (N2).
 */
function itemPart(item: Item, ctx: LiveRowContext, counts: ShareTextCounts, locators: AttachmentLocator[]): LivePart {
  if (item.secretPath && isSecretLocation(item.secretPath)) { counts.secret += 1; return { t: 'redacted', cat: 'secret' }; }
  if (!item.locator) return { t: 'attachment-unavailable', kind: item.kind };
  if (item.kind === 'file' && ctx.isTextFile?.(item.locator) !== true) return { t: 'attachment-unavailable', kind: 'file' };
  locators.push(item.locator);
  return item.kind === 'image' ? { t: 'image' } : { t: 'file', name: sanitizeAttachmentName(item.name ?? 'file', ctx, counts) };
}

/**
 * Full live sanitization of one row: attachments extracted first, then each
 * text run through `sanitizeShareText`. Returns no parts when nothing remains.
 */
export function sanitizeLiveRow(row: AttachmentSourceRow, ctx: LiveRowContext, counts: ShareTextCounts): ExtractedBody {
  const parts: LivePart[] = [];
  const locators: AttachmentLocator[] = [];
  for (const segment of extractAttachments(row, ctx)) {
    if ('item' in segment) parts.push(itemPart(segment.item, ctx, counts, locators));
    else parts.push(...sanitizeShareText(segment.text, ctx, counts));
  }
  return { parts, locators };
}
