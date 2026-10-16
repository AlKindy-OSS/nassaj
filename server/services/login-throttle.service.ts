/**
 * Per-identifier login throttle (ADR-212, T-2035).
 *
 * Complements the per-IP authLimiter: an attacker rotating addresses still
 * meets a per-account ceiling. Policy:
 *   - 5 failures inside 15 minutes lock the key for 1 min × 2^lock_count,
 *     capped at 30 minutes (progressive, never permanent);
 *   - a row untouched for 24 hours is pruned, which also decays lock_count;
 *   - a correct password clears the row.
 *
 * Every attempt is charged BEFORE the password is verified, inside one
 * IMMEDIATE transaction, so concurrent guesses cannot overrun the limit while
 * argon2 runs; a correct password then clears the charge. Known and unknown
 * identifiers are counted alike, so a lock reveals nothing about existence.
 *
 * Keys are HMAC-SHA256 under a key derived from the JWT secret with HKDF
 * (info `login-throttle`); raw identifiers are never stored. Passkey/WebAuthn
 * and SSO sign-in are deliberately not throttled: they are the owner's
 * break-glass while a third party holds the password path locked.
 */

import crypto from 'node:crypto';

// Namespace import: route tests mock the barrel without this repository.
import * as databaseModule from '../modules/database/index.js';
import type { LoginThrottleRow } from '../modules/database/index.js';

export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
export const LOGIN_LOCK_BASE_MS = 60_000;
export const LOGIN_LOCK_MAX_MS = 30 * 60_000;
export const LOGIN_THROTTLE_DECAY_MS = 24 * 60 * 60_000;

/** Response code for a locked identifier; identical for known and unknown ones. */
export const LOGIN_LOCKED_CODE = 'login_temporarily_locked';

type ThrottleStore = Pick<typeof databaseModule.loginThrottleDb, 'get' | 'put' | 'delete' | 'pruneOlderThan' | 'inTransaction'>;

export type LoginThrottleAdmission =
  | Readonly<{ allowed: true; lockedNow: null | Readonly<{ lockSeconds: number; lockCount: number }> }>
  | Readonly<{ allowed: false; retryAfterSeconds: number }>;

export type LoginThrottle = Readonly<{
  /** Key for a login identifier (username or email), normalized trim+lowercase. */
  keyForIdentifier(identifier: string): string;
  /** Key for an authenticated user's own password check (PATCH /me/password). */
  keyForUser(userId: number): string;
  /** Refuses a locked key, otherwise charges this attempt as a failure. */
  admit(keyHash: string): LoginThrottleAdmission;
  /** Clears the key after a correct password; returns whether a row existed. */
  clear(keyHash: string): boolean;
}>;

/** Lock length for the n-th lock (0-based), capped. */
export function lockDurationMs(lockCount: number): number {
  const exponent = Math.min(Math.max(lockCount, 0), 16);
  return Math.min(LOGIN_LOCK_BASE_MS * 2 ** exponent, LOGIN_LOCK_MAX_MS);
}

/** The row after charging one failure at `now` (the caller has ruled out an active lock). */
function chargeFailure(keyHash: string, row: LoginThrottleRow | undefined, now: number): {
  next: LoginThrottleRow; lockedNow: null | { lockSeconds: number; lockCount: number };
} {
  const lockExpired = row?.locked_until != null && row.locked_until <= now;
  const windowOpen = row !== undefined && !lockExpired
    && now - row.first_failure_at < LOGIN_FAILURE_WINDOW_MS;
  const failures = windowOpen ? row.failures + 1 : 1;
  const lockCount = row?.lock_count ?? 0;
  const base = {
    key_hash: keyHash,
    failures,
    first_failure_at: windowOpen ? row.first_failure_at : now,
    locked_until: null as number | null,
    lock_count: lockCount,
    updated_at: now,
  };
  if (failures < LOGIN_FAILURE_LIMIT) return { next: base, lockedNow: null };
  const lockMs = lockDurationMs(lockCount);
  return {
    next: { ...base, locked_until: now + lockMs, lock_count: lockCount + 1 },
    lockedNow: { lockSeconds: Math.ceil(lockMs / 1000), lockCount: lockCount + 1 },
  };
}

/**
 * Builds the throttle. `secret` is the JWT secret (≥32 chars); only an HKDF
 * derivative of it is kept.
 */
export function createLoginThrottle({
  secret,
  store,
  now = () => Date.now(),
}: { secret: string; store?: ThrottleStore; now?: () => number }): LoginThrottle {
  if (typeof secret !== 'string' || secret.length === 0) throw new Error('login_throttle_secret_missing');
  // Resolved per use, so building the throttle never needs the database.
  const backing = (): ThrottleStore => {
    const resolved = store ?? databaseModule.loginThrottleDb;
    if (!resolved) throw new Error('login_throttle_store_missing');
    return resolved;
  };
  const hmacKey = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'login-throttle', 32));
  const digest = (material: string) => crypto.createHmac('sha256', hmacKey).update(material).digest('hex');

  return Object.freeze({
    keyForIdentifier: (identifier: string) => digest(`id:${String(identifier).trim().toLowerCase()}`),
    keyForUser: (userId: number) => digest(`user:${userId}`),
    admit(keyHash: string): LoginThrottleAdmission {
      const at = now();
      const store = backing();
      return store.inTransaction(() => {
        store.pruneOlderThan(at - LOGIN_THROTTLE_DECAY_MS);
        const row = store.get(keyHash);
        if (row?.locked_until != null && row.locked_until > at) {
          return Object.freeze({ allowed: false as const, retryAfterSeconds: Math.max(1, Math.ceil((row.locked_until - at) / 1000)) });
        }
        const { next, lockedNow } = chargeFailure(keyHash, row, at);
        store.put(next);
        return Object.freeze({ allowed: true as const, lockedNow });
      });
    },
    clear(keyHash: string): boolean {
      return backing().delete(keyHash) > 0;
    },
  });
}

// ---------------------------------------------------------------------------
// Process-wide instance and the shared password-check gate
// ---------------------------------------------------------------------------

let sharedThrottle: LoginThrottle | null = null;
let sharedSecret: string | null = null;

/**
 * Sets the process-wide throttle's secret. The auth middleware calls it at
 * load with the resolved JWT secret, before any route can check a password.
 * `store` is for tests that mock the database barrel.
 */
export function configureLoginThrottle(secret: string, store?: ThrottleStore): void {
  if (secret === sharedSecret && sharedThrottle && !store) return;
  sharedThrottle = createLoginThrottle({ secret, store });
  sharedSecret = secret;
}

/** The process-wide throttle; fails closed when the secret was never configured. */
export function sharedLoginThrottle(): LoginThrottle {
  if (!sharedThrottle) throw new Error('login_throttle_not_configured');
  return sharedThrottle;
}

export type PasswordCheckContext = Readonly<{
  /** Names the account in the audit only when it exists (never the identifier). */
  userId?: number | (() => number | undefined);
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Which password check started the lock, e.g. `login`, `self_link`. */
  context: string;
}>;

/**
 * Charges one password attempt against `keyHash` before the password is
 * verified, and audits a lock this attempt starts (`login_lockout`).
 */
export function admitPasswordCheck(
  throttle: LoginThrottle,
  keyHash: string,
  { userId, ipAddress = null, userAgent = null, context }: PasswordCheckContext,
): LoginThrottleAdmission {
  const admission = throttle.admit(keyHash);
  if (admission.allowed && admission.lockedNow) {
    // Best-effort: the lock is already stored; a failed audit never unlocks it.
    try {
      const resolvedUserId = typeof userId === 'function' ? userId() : userId;
      databaseModule.auditLogDb.record('login_lockout', {
        ...(Number.isSafeInteger(resolvedUserId) ? { userId: resolvedUserId } : {}),
        metadata: { ...admission.lockedNow, context },
        ipAddress,
        userAgent,
      });
    } catch (error) {
      console.error('[auth] login_lockout audit failed', {
        context,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return admission;
}

/**
 * Owner break-glass (ADR-212): clears every throttle row of one account — each
 * login identifier it signs in with, and its own per-user key. Returns how
 * many rows existed. The caller audits.
 */
export function unlockAccountLogin(
  throttle: LoginThrottle,
  { userId, identifiers }: { userId: number; identifiers: readonly string[] },
): number {
  const keys = new Set([throttle.keyForUser(userId), ...identifiers.map((id) => throttle.keyForIdentifier(id))]);
  let cleared = 0;
  for (const key of keys) if (throttle.clear(key)) cleared += 1;
  return cleared;
}

/** Answer for a locked key: same status and body wherever a password is checked. */
export function lockedPasswordRefusal(retryAfterSeconds: number) {
  return Object.freeze({
    status: 429,
    retryAfterSeconds,
    body: Object.freeze({
      error: 'Too many failed sign-in attempts. Try again later.',
      code: LOGIN_LOCKED_CODE,
      retryAfterSeconds,
    }),
  });
}
