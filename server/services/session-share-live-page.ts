/**
 * Cursor paging over a live session projection and the v2 response shape
 * (ADR-205 D2 "Paging over the projection", "Response v2"). Guests never see
 * offsets or totals: pages are anchored at per-share message keys, so rows
 * appended between requests (tool rows included, which are never in `order`)
 * cause neither gaps nor duplicates.
 */
import type { AttachmentKind, LivePart } from './session-share-live-attachments.js';
import { cursorStale } from './session-share-live-errors.js';
import { messageKey, mintAttachmentRef, mintCursor, verifyCursor, type ShareKeyContext } from './session-share-live-keys.js';
import type { LiveAuthor, LiveMemo } from './session-share-live-rows.js';

export const LIVE_PAGE_LIMITS = Object.freeze({
  pageMessages: 50,
  afterMessages: 200,
  responseBytes: 4 * 1024 * 1024,
  /** Rows sanitized ahead of an `after` walk that reached unknown rows. */
  sanitizeWindow: 1000,
});

export type LiveViewerPart =
  | Exclude<LivePart, { t: 'image' } | { t: 'file'; name: string }>
  | { t: 'image'; ref: string }
  | { t: 'file'; ref: string; name: string }
  | { t: 'attachment-unavailable'; kind: AttachmentKind };
export type LiveViewerMessage = {
  k: string;
  c: string;
  role: 'user' | 'assistant';
  author: LiveAuthor;
  at?: string;
  parts: LiveViewerPart[];
};
export type LiveMessagesResponse = {
  v: 2;
  revision: string;
  running: boolean;
  stale: boolean;
  moreBefore: boolean;
  moreAfter: boolean;
  retryAfterMs: number;
  messages: LiveViewerMessage[];
};
export type PageRequest = { share: ShareKeyContext; before?: string; after?: string; signal?: AbortSignal };
/** The fields of a projection entry paging reads. */
export type PageSource = { revision: string; running: boolean; order: string[] };
/** Memo access supplied by the projection (touches the LRU, sanitizes held raw rows). */
export type PageView = { memoize: (sid: string) => LiveMemo | null };
export type PageResult = {
  /** Set when the walk reached a row that is neither memoized nor held and nothing was collected. */
  needsParseAt: number | null;
  response: (stale: boolean, retryAfterMs: number) => LiveMessagesResponse;
};

/** Index of the message a cursor names in `order`. @throws 409 CURSOR_STALE */
function anchorIndex(source: PageSource, share: ShareKeyContext, cursor: string): number {
  const k = verifyCursor(share, cursor);
  if (k === null) throw cursorStale();
  const index = source.order.findIndex((sid) => messageKey(share, sid) === k);
  if (index === -1) throw cursorStale();
  return index;
}

/** The viewer form of one memo: refs minted per share, in locator order. */
export function serializeMessage(memo: LiveMemo, share: ShareKeyContext, sid: string): LiveViewerMessage {
  const k = messageKey(share, sid);
  let attachment = 0;
  const parts = memo.parts.map((part): LiveViewerPart => {
    if (part.t === 'image') return { t: 'image', ref: mintAttachmentRef(share, k, attachment++) };
    if (part.t === 'file') return { t: 'file', ref: mintAttachmentRef(share, k, attachment++), name: part.name };
    return part;
  });
  return { k, c: mintCursor(share, k), role: memo.role, author: memo.author, ...(memo.at ? { at: memo.at } : {}), parts };
}

type Walk = { start: number; step: 1 | -1; cap: number };

function walkFor(source: PageSource, page: PageRequest): Walk {
  if (page.after) return { start: anchorIndex(source, page.share, page.after) + 1, step: 1, cap: LIVE_PAGE_LIMITS.afterMessages };
  const anchor = page.before ? anchorIndex(source, page.share, page.before) : source.order.length;
  return { start: anchor - 1, step: -1, cap: LIVE_PAGE_LIMITS.pageMessages };
}

/** Where a parse should anchor its sanitize window so this walk makes progress. */
function parseAnchor(walk: Walk, index: number, length: number): number {
  return walk.step < 0 ? index + 1 : Math.min(length, index + LIVE_PAGE_LIMITS.sanitizeWindow);
}

/**
 * Walks from the anchor, collecting non-empty messages within the row and
 * byte caps (at least one message when one exists).
 */
export function servePage(source: PageSource, view: PageView, page: PageRequest): PageResult {
  const walk = walkFor(source, page);
  const collected: LiveViewerMessage[] = [];
  let bytes = 0;
  let next = walk.start;
  let needsParseAt: number | null = null;
  for (; next >= 0 && next < source.order.length; next += walk.step) {
    page.signal?.throwIfAborted();
    const memo = view.memoize(source.order[next]);
    if (!memo) { if (collected.length === 0) needsParseAt = parseAnchor(walk, next, source.order.length); break; }
    if (memo.parts.length === 0) continue;
    const message = serializeMessage(memo, page.share, source.order[next]);
    const size = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (collected.length > 0 && bytes + size > LIVE_PAGE_LIMITS.responseBytes) break;
    collected.push(message);
    bytes += size;
    if (collected.length >= walk.cap) { next += walk.step; break; }
  }
  const more = next >= 0 && next < source.order.length;
  if (walk.step < 0) collected.reverse();
  return {
    needsParseAt,
    response: (stale, retryAfterMs) => ({
      v: 2, revision: source.revision, running: source.running, stale,
      moreBefore: walk.step < 0 && more, moreAfter: walk.step > 0 && more,
      retryAfterMs, messages: collected,
    }),
  };
}
