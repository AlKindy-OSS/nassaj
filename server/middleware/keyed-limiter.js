/**
 * Keyed fixed-window counter (in-memory, single process). Shared by the
 * per-IP route middleware (rate-limit.js) and by callers that must count per
 * principal outside a middleware chain (services/step-up.service.js).
 *
 * Kept in its own module so route tests that replace rate-limit.js with a
 * pass-through mock never strip the step-up limiter along with it.
 */

/**
 * Creates a limiter; every call to hit(key) counts one attempt for that key
 * (the step-up service calls it BEFORE any expensive verification).
 *
 * @param {{ windowMs?: number, max?: number }} [options]
 * @returns {{ hit(key: string): { allowed: boolean, retryAfterSeconds: number } }}
 */
export function createKeyedLimiter({ windowMs, max } = {}) {
  const windowSize = windowMs ?? 60_000;
  const limit = max ?? 10;
  const buckets = new Map();

  return {
    hit(bucketKey) {
      const now = Date.now();
      const entry = buckets.get(bucketKey);
      if (!entry || now > entry.resetAt) {
        buckets.set(bucketKey, { count: 1, resetAt: now + windowSize });
        pruneIfLarge(buckets, now);
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (entry.count >= limit) {
        return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
      }
      entry.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

function pruneIfLarge(buckets, now) {
  if (buckets.size < 1000) {
    return;
  }
  for (const [key, value] of buckets) {
    if (now > value.resetAt) {
      buckets.delete(key);
    }
  }
}
