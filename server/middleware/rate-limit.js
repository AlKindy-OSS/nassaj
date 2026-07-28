/**
 * Lightweight in-memory rate limiter middleware factory.
 *
 * Per-IP fixed-window counter. Intended for auth endpoints (login, invite
 * acceptance) to blunt brute-force attempts. Returns 429 once the window quota
 * is exceeded. Single-process only (no shared store); adequate for the single
 * PM2 process this app runs as. Stale buckets are pruned lazily.
 */

import { clientIp } from '../utils/client-ip.js';

export function createRateLimiter({ windowMs, max, message } = {}) {
  const windowSize = windowMs ?? 60_000;
  const limit = max ?? 10;
  const errorMessage = message ?? 'Too many requests, please try again later';
  const buckets = new Map();

  return function rateLimit(req, res, next) {
    // Unified IP source (T-182/ADR-040): the real client behind the tunnel, not
    // the loopback peer — so the brute-force counter keys on the actual caller.
    const ip = clientIp(req) || 'unknown';
    const now = Date.now();
    const entry = buckets.get(ip);

    if (!entry || now > entry.resetAt) {
      buckets.set(ip, { count: 1, resetAt: now + windowSize });
      pruneIfLarge(buckets, now);
      return next();
    }

    if (entry.count >= limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: errorMessage });
    }

    entry.count += 1;
    next();
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
