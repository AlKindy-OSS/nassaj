import type { LiveMessage } from './types';

/** Messages are held oldest to newest and unique by `k`. */
export function mergeNewer(current: LiveMessage[], incoming: LiveMessage[]): LiveMessage[] {
  if (!incoming.length) return current;
  const seen = new Set(current.map((m) => m.k));
  const fresh = incoming.filter((m) => !seen.has(m.k));
  return fresh.length ? [...current, ...fresh] : current;
}

export function mergeOlder(current: LiveMessage[], incoming: LiveMessage[]): LiveMessage[] {
  if (!incoming.length) return current;
  const seen = new Set(current.map((m) => m.k));
  const fresh = incoming.filter((m) => !seen.has(m.k));
  return fresh.length ? [...fresh, ...current] : current;
}

/**
 * CURSOR_STALE recovery: the freshly loaded tail replaces the list, except that
 * already-held older messages remain when the tail overlaps them (same `k` seen),
 * so the reader's scroll position survives; otherwise the tail stands alone.
 */
export function reconcileTail(current: LiveMessage[], tail: LiveMessage[]): LiveMessage[] {
  if (!tail.length) return [];
  const heldAt = new Map(current.map((m, i) => [m.k, i]));
  const overlap = tail.find((m) => heldAt.has(m.k));
  if (!overlap) return tail;
  return [...current.slice(0, heldAt.get(overlap.k)), ...tail];
}
