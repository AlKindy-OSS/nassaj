/**
 * Pure row stage of the live session projection (ADR-205 D2 steps 3-8):
 * filter to public rows first, cap raw text, assign stable identities and
 * neutral authors, and sanitize one row into memoizable viewer parts.
 * Provider-neutral: only normalized fields are read.
 */
import type { NormalizedMessage } from '@/shared/types.js';

import { sanitizeLiveRow, type AttachmentLocator, type LivePart, type LiveRowContext } from './session-share-live-attachments.js';
import { createMessageIdentityAssigner } from './session-share-live-keys.js';
import { isPublicRow } from './session-share-public-row.js';
import type { ShareTextCounts } from './session-share-sanitize.js';

export const RAW_ROW_MAX_BYTES = 2 * 1024 * 1024;

export type LiveAuthor = 'owner' | 'member' | 'assistant';
/** A public row as held between a parse and its sanitization; raw text, server-only. */
export type RawLiveRow = {
  sid: string;
  role: 'user' | 'assistant';
  author: LiveAuthor;
  at?: string;
  text: string;
  truncated: boolean;
  images?: unknown;
  imagesOmitted?: unknown;
  attachmentsUnavailable?: unknown;
  bytes: number;
};
/** A sanitized, memoizable message: viewer parts plus server-only locators. */
export type LiveMemo = {
  role: 'user' | 'assistant';
  author: LiveAuthor;
  at?: string;
  parts: LivePart[];
  locators: AttachmentLocator[];
  bytes: number;
};

/** Neutral author label (M6, Q2): unknown or null never maps to owner. */
export function authorOf(message: NormalizedMessage, ownerUserId: number): LiveAuthor {
  if (message.role === 'assistant') return 'assistant';
  return Number.isInteger(message.userId) && message.userId === ownerUserId ? 'owner' : 'member';
}

/**
 * Raw cap (M1): over `RAW_ROW_MAX_BYTES`, cut at the last newline before the
 * cap and drop the trailing partial line. Cutting at a newline byte keeps the
 * UTF-8 valid.
 */
export function capRawText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= RAW_ROW_MAX_BYTES) return { text, truncated: false };
  const head = Buffer.from(text, 'utf8').subarray(0, RAW_ROW_MAX_BYTES);
  const newline = head.lastIndexOf(0x0a);
  return { text: newline > 0 ? head.subarray(0, newline).toString('utf8') : '', truncated: true };
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/**
 * Filters a full normalized history to public rows and builds their raw
 * records in source order. Dropped rows are never serialized or sanitized.
 */
export function buildRawRows(sessionId: string, ownerUserId: number, messages: NormalizedMessage[]): RawLiveRow[] {
  const assign = createMessageIdentityAssigner(sessionId);
  const rows: RawLiveRow[] = [];
  for (const message of messages) {
    if (!isPublicRow(message)) continue;
    const source = typeof message.content === 'string' ? message.content : '';
    const role = message.role as 'user' | 'assistant';
    const capped = capRawText(source);
    rows.push({
      sid: assign(role, source), role, author: authorOf(message, ownerUserId), at: isoOrUndefined(message.timestamp),
      text: capped.text, truncated: capped.truncated, images: message.images, imagesOmitted: message.imagesOmitted,
      attachmentsUnavailable: message.attachmentsUnavailable,
      bytes: Buffer.byteLength(capped.text, 'utf8'),
    });
  }
  return rows;
}

function emptyCounts(): ShareTextCounts {
  return { system: 0, image: 0, secret: 0, path: 0, network: 0 };
}

/** Approximate retained bytes of a memo: its parts as JSON plus inline locator data. */
function memoBytes(parts: LivePart[], locators: AttachmentLocator[]): number {
  let bytes = Buffer.byteLength(JSON.stringify(parts), 'utf8');
  for (const locator of locators) bytes += locator.source === 'embedded-image' ? locator.dataUri.length : 128;
  return bytes;
}

/** Sanitizes one raw row into its memo; a truncated row ends with a `truncated` marker. */
export function sanitizeRawRow(row: RawLiveRow, ctx: LiveRowContext): LiveMemo {
  const body = sanitizeLiveRow(row, ctx, emptyCounts());
  const parts = row.truncated ? [...body.parts, { t: 'redacted', cat: 'truncated' } as LivePart] : body.parts;
  return { role: row.role, author: row.author, at: row.at, parts, locators: body.locators, bytes: memoBytes(parts, body.locators) };
}
