import type { PeerHoldView } from './peerHoldStore';
import type { PeerMessageView } from './peerMessageStore';

/**
 * What a viewer sees for one hold. `approved` covers a promoted hold whose
 * delivery is queued or running; the linked peer message decides `delivered`
 * and `failed`.
 */
export type PeerHoldDisplayState =
  | 'held' | 'approved' | 'delivered' | 'failed' | 'rejected' | 'expired' | 'cancelled';

/** Folds the hold state and its linked message (after approval) into the display state. */
export function peerHoldDisplayState(
  hold: Pick<PeerHoldView, 'state'>, linked: Pick<PeerMessageView, 'state'> | null,
): PeerHoldDisplayState {
  if (hold.state !== 'promoted') return hold.state;
  if (linked?.state === 'delivered') return 'delivered';
  if (linked?.state === 'refused' || linked?.state === 'failed') return 'failed';
  return 'approved';
}

const MINUTE = 60_000;

/** Whole hours and minutes before `expiresAt` (rounded up to the minute), or null once it has passed. */
export function holdTimeLeft(expiresAt: number, now: number): { hours: number; minutes: number } | null {
  const left = Math.ceil((expiresAt - now) / MINUTE);
  if (!Number.isFinite(left) || left <= 0) return null;
  return { hours: Math.floor(left / 60), minutes: left % 60 };
}

/** One piece of a server-visible body: plain text, or a `⟨U+XXXX⟩` token for a hidden character. */
export type VisibleBodyPart = { token: false; text: string } | { token: true; text: string; code: string };

const TOKEN = /(⟨U\+[0-9A-F]{4,6}⟩)/;

/** Splits `bodyVisible` into text and hidden-character tokens, in order. */
export function splitVisibleBody(visible: string): VisibleBodyPart[] {
  return visible.split(TOKEN).filter((text) => text !== '').map((text) => (TOKEN.test(text)
    ? { token: true, text, code: text.slice(1, -1) }
    : { token: false, text }));
}
