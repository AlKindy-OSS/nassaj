/**
 * Identities and MACs for live session read links (ADR-205 D2 N1, H7, D4 C1).
 *
 * - `sid` is a server-only message identity derived from content and position,
 *   never from parse-time timestamps or generated ids, so it is stable across
 *   re-parses and appends.
 * - `k` (message key), cursors and attachment refs are per-share HMACs keyed by
 *   the share's random `ref_key`, so two shares of one session cannot correlate
 *   messages and nulling `ref_key` invalidates every cursor and ref at once.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MESSAGE_KEY_CHARS = 22;
const CURSOR_MAC_CHARS = 22;
const REF_MAC_CHARS = 32;
const CURSOR_SHAPE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;
const REF_SHAPE = /^([A-Za-z0-9_-]{22})\.([0-9]{1,2})\.([A-Za-z0-9_-]{32})$/;

/** The per-share secret a live share row carries. */
export type ShareKeyContext = { shareId: string; refKey: Buffer };

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function mac(key: Buffer, message: string, chars: number): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('base64url').slice(0, chars);
}

/** Constant-time comparison of two equal-shape ASCII strings. */
function sameMac(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'ascii');
  const b = Buffer.from(actual, 'ascii');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Assigns `sid = sha256(sessionId | role | sha256(text) | ordinal)` to rows in
 * source order, where `ordinal` counts earlier rows with the same role and text.
 * Appends never change the identity of earlier rows.
 */
export function createMessageIdentityAssigner(sessionId: string): (role: string, text: string) => string {
  const seen = new Map<string, number>();
  return (role, text) => {
    const textHash = sha256(text);
    const group = `${role}|${textHash}`;
    const ordinal = seen.get(group) ?? 0;
    seen.set(group, ordinal + 1);
    return sha256(`${sessionId}|${role}|${textHash}|${ordinal}`);
  };
}

/** Per-share public message key `k` for a server-only `sid`. */
export function messageKey(ctx: ShareKeyContext, sid: string): string {
  return mac(ctx.refKey, `msg|${sid}`, MESSAGE_KEY_CHARS);
}

/** Opaque cursor `<k>.<mac>` naming one message of one share. */
export function mintCursor(ctx: ShareKeyContext, k: string): string {
  return `${k}.${mac(ctx.refKey, `cur|${ctx.shareId}|${k}`, CURSOR_MAC_CHARS)}`;
}

/** @returns the message key of a cursor minted for this share, or null. */
export function verifyCursor(ctx: ShareKeyContext, cursor: string): string | null {
  const match = CURSOR_SHAPE.exec(cursor);
  if (!match) return null;
  const expected = mac(ctx.refKey, `cur|${ctx.shareId}|${match[1]}`, CURSOR_MAC_CHARS);
  return sameMac(expected, match[2]) ? match[1] : null;
}

/** Opaque attachment ref `<k>.<i>.<mac>`; it carries no path, kind or locator. */
export function mintAttachmentRef(ctx: ShareKeyContext, k: string, index: number): string {
  return `${k}.${index}.${mac(ctx.refKey, `att|${ctx.shareId}|${k}|${index}`, REF_MAC_CHARS)}`;
}

/** @returns the message key and attachment index of a ref minted for this share, or null. */
export function verifyAttachmentRef(ctx: ShareKeyContext, ref: string): { k: string; index: number } | null {
  const match = REF_SHAPE.exec(ref);
  if (!match) return null;
  const index = Number(match[2]);
  const expected = mac(ctx.refKey, `att|${ctx.shareId}|${match[1]}|${index}`, REF_MAC_CHARS);
  return sameMac(expected, match[3]) ? { k: match[1], index } : null;
}
