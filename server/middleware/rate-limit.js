/**
 * Lightweight in-memory rate limiter middleware factory.
 *
 * Per-IP fixed-window counter. Intended for auth endpoints (login, invite
 * acceptance) to blunt brute-force attempts. Returns 429 once the window quota
 * is exceeded. Single-process only (no shared store); adequate for the single
 * PM2 process this app runs as. Stale buckets are pruned lazily.
 */

import { clientIp } from '../utils/client-ip.js';

import { createKeyedLimiter } from './keyed-limiter.js';

export function createRateLimiter({ windowMs, max, message, key, code } = {}) {
  const errorMessage = message ?? 'Too many requests, please try again later';
  const limiter = createKeyedLimiter({ windowMs, max });

  return function rateLimit(req, res, next) {
    // Unified IP source (T-182/ADR-040): the real client behind the tunnel, not
    // the loopback peer — so the brute-force counter keys on the actual caller.
    const bucketKey = typeof key === 'function'
      ? String(key(req))
      : (clientIp(req) || 'unknown');
    const verdict = limiter.hit(bucketKey);
    if (verdict.allowed) {
      return next();
    }
    res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
    return res.status(429).json({
      error: errorMessage,
      ...(typeof code === 'string' && code ? { code } : {}),
    });
  };
}
