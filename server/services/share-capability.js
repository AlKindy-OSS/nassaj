import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Share capability primitives shared by document shares and session shares
 * (ADR-196). A share is addressed by a public 128-bit hex id and, for public
 * audiences, unlocked by a 256-bit bearer token that the server stores only as
 * its SHA-256 digest. Rate limiting is deliberately NOT part of this module.
 */

/** 128-bit share identifier: 32 lowercase hex characters. */
export const SHARE_ID_PATTERN = /^[a-f0-9]{32}$/;
/** 256-bit bearer token in unpadded base64url: 43 characters. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Stored SHA-256 token digest: 64 lowercase hex characters. */
export const SHARE_TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * True when `value` is a well-formed share id.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isShareId(value) {
  return typeof value === 'string' && SHARE_ID_PATTERN.test(value);
}

/**
 * True when `value` is a well-formed share token.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isShareToken(value) {
  return typeof value === 'string' && SHARE_TOKEN_PATTERN.test(value);
}

/** @returns {string} a fresh 128-bit hex share id. */
export function createShareId() {
  return randomBytes(16).toString('hex');
}

/** @returns {string} a fresh 256-bit base64url bearer token. */
export function createShareToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hex digest of a token; the only form ever persisted.
 * @param {string} token
 * @returns {string}
 */
export function hashShareToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time check of a presented token against a stored digest. Any
 * malformed input (missing, wrong shape) fails closed before the comparison.
 * @param {unknown} token presented by the client
 * @param {unknown} storedHash persisted SHA-256 hex digest
 * @returns {boolean}
 */
export function verifyShareToken(token, storedHash) {
  if (!isShareToken(token)) return false;
  if (typeof storedHash !== 'string' || !SHARE_TOKEN_HASH_PATTERN.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(hashShareToken(token), 'hex'), Buffer.from(storedHash, 'hex'));
}
