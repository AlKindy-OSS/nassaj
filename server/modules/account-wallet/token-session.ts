/**
 * Per-device JWT sessions (T-2035 round 3, ADR-212; owner decision
 * 2026-10-16: a normal sign-out ends only the current device).
 *
 * Every minted JWT carries a random `sid` (128 bits, base64url). Refreshes
 * keep it, so one device holds one sid for its whole session. Signing out
 * records the sid in `revoked_token_sids` until its tokens could no longer be
 * used or renewed. Tokens minted before this release carry no sid: they stay
 * valid until they expire and only the account epoch can end them.
 *
 * `tokenSessionCurrent` is THE check every session-JWT verifier applies (the
 * epoch plus the device revocation); the guard test beside this file fails
 * when a `jwt.verify` is not paired with it (with the raw token, so a
 * pre-release token is checked under its derived sid). Revocation is read per
 * request with one primary-key lookup — a few microseconds — rather than an
 * in-process cache, so another process or connection can never serve a
 * signed-out session from a stale copy.
 */

import crypto from 'node:crypto';

// Namespace import: route tests mock the barrel without this repository.
import * as databaseModule from '@/modules/database/index.js';

import { tokenEpochCurrent } from './token-epoch.js';

type EpochCarrier = Parameters<typeof tokenEpochCurrent>[1];

/** 16 random bytes in base64url: exactly 22 characters. */
const SID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** A fresh device-session id for a new sign-in. */
export function mintTokenSid(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * The sid a refresh gives to a pre-release token that has none: derived from
 * that exact token, so a refresh burst of one device converges on one sid and
 * two devices never share one.
 */
export function legacyTokenSid(token: string): string {
  return crypto.createHash('sha256').update(`legacy-sid:${token}`).digest('base64url').slice(0, 22);
}

/** The token's own sid, or null when it predates sids (or is malformed). */
export function tokenSidOf(decoded: unknown): string | null {
  if (!decoded || typeof decoded !== 'object' || !Object.hasOwn(decoded, 'sid')) return null;
  const sid = (decoded as { sid?: unknown }).sid;
  return typeof sid === 'string' && SID_PATTERN.test(sid) ? sid : null;
}

/**
 * True while `sid` is signed out. A barrel without the repository (a mocked
 * test store) has no revocations; a read failure throws, so verifiers fail
 * closed.
 */
export function isTokenSidRevoked(sid: string, nowMs = Date.now()): boolean {
  const repository = databaseModule.revokedTokenSidsDb;
  return repository ? repository.isRevoked(sid, nowMs) : false;
}

/**
 * True when `sid` is an SSO device session whose 24 h idle clock ran out
 * (ADR-H20 N8). A password session has no row and never idles out here. A
 * barrel without the repository has none; a read failure throws (fail closed).
 */
export function isSsoSessionIdleExpired(sid: string, nowMs = Date.now()): boolean {
  const repository = databaseModule.ssoDeviceSessionsDb;
  if (!repository || typeof databaseModule.ssoDeviceSessionIdleExpired !== 'function') return false;
  return databaseModule.ssoDeviceSessionIdleExpired(repository.get(sid), nowMs);
}

/**
 * The device-session id of a verified token: its own `sid`, or for a
 * pre-release token the sid derived from the raw token. Null for a malformed
 * `sid` claim.
 */
export function sessionSidOf(decoded: unknown, token: string): string | null {
  if (decoded && typeof decoded === 'object' && Object.hasOwn(decoded, 'sid')) return tokenSidOf(decoded);
  return legacyTokenSid(token);
}

/**
 * True when a verified session JWT is still current: the account epoch
 * matches, its device session (own or derived sid) has not signed out, and an
 * SSO device session has not been idle for 24 h (ADR-H20 N8). A
 * `sid` claim that is present but malformed is refused. `token` is the raw
 * JWT the claims were verified from.
 */
export function tokenSessionCurrent(
  decoded: unknown, user: EpochCarrier, token: string, nowMs = Date.now(),
): boolean {
  if (!tokenEpochCurrent(decoded, user)) return false;
  if (typeof token !== 'string' || !token) return false;
  const sid = sessionSidOf(decoded, token);
  return sid !== null && !isTokenSidRevoked(sid, nowMs) && !isSsoSessionIdleExpired(sid, nowMs);
}

// ---------------------------------------------------------------------------
// Realtime sockets per device session
// ---------------------------------------------------------------------------

const socketClosersBySid = new Map<string, Set<() => void>>();

/** Tags a realtime socket with its token's sid; returns an idempotent untag. */
export function registerTokenSessionSocket(sid: string, close: () => void): () => void {
  let closers = socketClosersBySid.get(sid);
  if (!closers) {
    closers = new Set();
    socketClosersBySid.set(sid, closers);
  }
  closers.add(close);
  return () => {
    const current = socketClosersBySid.get(sid);
    if (!current) return;
    current.delete(close);
    if (current.size === 0) socketClosersBySid.delete(sid);
  };
}

/** Closes every socket of one device session (4401 by the registrant). */
export function closeTokenSessionSockets(sid: string): number {
  const closers = [...(socketClosersBySid.get(sid) ?? [])];
  socketClosersBySid.delete(sid);
  for (const close of closers) {
    try {
      close();
    } catch {
      // A socket that is already gone has nothing left to close.
    }
  }
  return closers.length;
}

/**
 * Signs one device session out: persists the revocation (pruning expired
 * rows), then closes that session's sockets.
 * Returns the number of sockets closed. A persistence failure throws before
 * anything is reported as signed out.
 */
export function revokeTokenSession({ sid, userId, expiresAt, nowMs = Date.now() }: {
  sid: string; userId: number; expiresAt: number; nowMs?: number;
}): number {
  const repository = databaseModule.revokedTokenSidsDb;
  if (!repository) throw new Error('revoked_token_sids_unavailable');
  repository.revoke({ sid, userId, revokedAt: nowMs, expiresAt });
  return closeTokenSessionSockets(sid);
}
