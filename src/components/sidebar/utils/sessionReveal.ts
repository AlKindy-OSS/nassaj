/**
 * One-shot "scroll this row into view" token (B-1668 item 10).
 *
 * Set when a conversation is selected by the URL — a deep link, the browser's
 * Back/Forward, a resolved `/session/:id` — and consumed by that row once it
 * is mounted and selected. A click inside the sidebar never sets it, so an
 * ordinary click never makes the list jump, and a later remount (collapsing
 * and re-expanding the project, clearing a search) finds no token.
 */

/** A token nobody consumed (the row never mounted) expires instead of lingering. */
const REVEAL_TTL_MS = 10_000;

let pending: { sessionId: string; at: number } | null = null;

export function requestSessionReveal(sessionId: string, now: number = Date.now()): void {
  pending = { sessionId, at: now };
}

/** True once for the requested row; clears the token. */
export function consumeSessionReveal(sessionId: string, now: number = Date.now()): boolean {
  if (!pending || pending.sessionId !== sessionId) return false;
  const fresh = now - pending.at <= REVEAL_TTL_MS;
  pending = null;
  return fresh;
}

/** Drops a pending token (a click selected another row first). */
export function cancelSessionReveal(): void {
  pending = null;
}
