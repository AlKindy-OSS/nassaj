/**
 * Throttles and concurrency slots for guest share reads (ADR-205 D1 step 3/5, D7).
 *
 * Design rules:
 * - Failure buckets are charged only after a failed token verification, so a
 *   valid token is never refused by them.
 * - A bucket map that is full after evicting expired keys does NOT pool new
 *   keys into a shared overflow bucket: the attempt is simply not tracked
 *   ('untracked'), so an attacker can never push live viewers into its bucket.
 * - Admission after liveness runs per-share bucket → per-share concurrency →
 *   per-IP slots → global slots; attachments use a separate pool.
 */

export const GUEST_LIMITS = Object.freeze({
  unverified: { limit: 120, windowMs: 60_000, maxKeys: 16_384 },
  failures: { limit: 20, windowMs: 10 * 60_000, maxKeys: 16_384 },
  perShare: { limit: 240, windowMs: 60_000, maxKeys: 16_384 },
  shareConcurrency: 4,
  ipSlots: 2,
  globalSlots: 24,
  attachmentPerShare: 2,
  attachmentGlobal: 4,
});

export type GuestLimits = typeof GUEST_LIMITS;
export type WindowVerdict = 'ok' | 'limited' | 'untracked';
type WindowOptions = { limit: number; windowMs: number; maxKeys: number; now: () => number };
type Bucket = { until: number; count: number };

/**
 * Fixed-window counter with a bounded key map and no overflow bucket.
 * @returns `hit(key)` → 'ok' | 'limited' | 'untracked'; `retryAfterSec(key)`
 */
export function createStrictWindowLimiter({ limit, windowMs, maxKeys, now }: WindowOptions) {
  const buckets = new Map<string, Bucket>();
  let lastEvict = 0;
  const evictExpired = (at: number) => {
    if (at - lastEvict < 1000) return;
    lastEvict = at;
    for (const [key, bucket] of buckets) if (bucket.until <= at) buckets.delete(key);
  };
  function hit(key: string): WindowVerdict {
    const at = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= at) {
      if (!bucket && buckets.size >= maxKeys) evictExpired(at);
      if (!buckets.has(key) && buckets.size >= maxKeys) return 'untracked';
      bucket = { until: at + windowMs, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit ? 'ok' : 'limited';
  }
  /** Whole seconds until `key`'s window resets (at least 1). */
  function retryAfterSec(key: string): number {
    const bucket = buckets.get(key);
    return Math.max(1, Math.ceil(((bucket?.until ?? now()) - now()) / 1000));
  }
  return { hit, retryAfterSec, size: () => buckets.size };
}

/** Per-key concurrency counter; entries exist only while a slot is held. */
export function createKeyedSlots(limit: number) {
  const held = new Map<string, number>();
  /** A one-shot release, or null when `key` already holds `limit` slots. */
  function tryAcquire(key: string): (() => void) | null {
    const count = held.get(key) ?? 0;
    if (count >= limit) return null;
    held.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (held.get(key) ?? 1) - 1;
      if (left <= 0) held.delete(key);
      else held.set(key, left);
    };
  }
  return { tryAcquire, count: (key: string) => held.get(key) ?? 0 };
}

export type Admission = { release: () => void } | { refused: true; retryAfterSec: number };

/** Acquires every step in order; on the first refusal releases what was taken. */
function acquireAll(steps: Array<() => (() => void) | null>): (() => void) | null {
  const taken: Array<() => void> = [];
  for (const step of steps) {
    const release = step();
    if (!release) { taken.forEach((undo) => undo()); return null; }
    taken.push(release);
  }
  return () => taken.reverse().forEach((undo) => undo());
}

/**
 * The guest guard set shared by one reader. `failedVerification` is called
 * only after a token failed; the admit functions only after liveness.
 * @param options.now clock; options.limits overrides for tests
 */
export function createGuestGuards({ now = Date.now, limits = GUEST_LIMITS }: { now?: () => number; limits?: GuestLimits } = {}) {
  const unverified = createStrictWindowLimiter({ ...limits.unverified, now });
  const failures = createStrictWindowLimiter({ ...limits.failures, now });
  const perShare = createStrictWindowLimiter({ ...limits.perShare, now });
  const shareSlots = createKeyedSlots(limits.shareConcurrency);
  const ipSlots = createKeyedSlots(limits.ipSlots);
  const globalSlots = createKeyedSlots(limits.globalSlots);
  const attachmentShare = createKeyedSlots(limits.attachmentPerShare);
  const attachmentGlobal = createKeyedSlots(limits.attachmentGlobal);

  /** Charges both failure buckets of `ipKey`; true when either is over its limit (answer 429). */
  function failedVerification(ipKey: string): boolean {
    const a = unverified.hit(ipKey);
    const b = failures.hit(ipKey);
    return a === 'limited' || b === 'limited';
  }
  function admit(shareId: string, slots: Array<() => (() => void) | null>): Admission {
    if (perShare.hit(shareId) === 'limited') return { refused: true, retryAfterSec: perShare.retryAfterSec(shareId) };
    const release = acquireAll(slots);
    return release ? { release } : { refused: true, retryAfterSec: 1 };
  }
  /** meta and messages: per-share bucket → per-share concurrency → per-IP slots → global slots. */
  function admitReader(shareId: string, ipKey: string): Admission {
    return admit(shareId, [() => shareSlots.tryAcquire(shareId), () => ipSlots.tryAcquire(ipKey),
      () => globalSlots.tryAcquire('global')]);
  }
  /** attachments: per-share bucket → attachment slots per share → global attachment slots. */
  function admitAttachment(shareId: string): Admission {
    return admit(shareId, [() => attachmentShare.tryAcquire(shareId), () => attachmentGlobal.tryAcquire('global')]);
  }
  return {
    failedVerification, admitReader, admitAttachment,
    /** Diagnostics for tests. */
    stats: () => ({ unverifiedKeys: unverified.size(), globalReaders: globalSlots.count('global'),
      attachments: attachmentGlobal.count('global') }),
  };
}

export type GuestGuards = ReturnType<typeof createGuestGuards>;
