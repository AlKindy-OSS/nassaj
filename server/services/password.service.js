/**
 * Password hashing service (argon2id).
 *
 * Centralizes password hashing/verification so the algorithm and parameters
 * are defined in exactly one place. Uses argon2id per ADR-015.
 *
 * Legacy hashes created with bcrypt (single-user era) are still verifiable via
 * `verifyPassword`, which transparently dispatches by hash prefix so existing
 * accounts keep working after the multi-user upgrade.
 */

import argon2 from 'argon2';
import bcrypt from 'bcrypt';

// argon2id parameters: OWASP-recommended baseline (19 MiB, 2 iterations, 1 lane).
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Hashes a plaintext password with argon2id.
 * @param {string} plaintext
 * @returns {Promise<string>} encoded argon2id hash
 */
export async function hashPassword(plaintext) {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verifies a plaintext password against a stored hash.
 * Dispatches to bcrypt for legacy ($2a/$2b/$2y) hashes, argon2 otherwise.
 * @param {string} hash stored password hash
 * @param {string} plaintext candidate password
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(hash, plaintext) {
  if (typeof hash !== 'string' || hash.length === 0) {
    return false;
  }
  try {
    if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
      return await bcrypt.compare(plaintext, hash);
    }
    return await argon2.verify(hash, plaintext);
  } catch {
    // Malformed hash or verification error → treat as failed auth, never throw.
    return false;
  }
}

/**
 * Returns true if the stored hash uses a legacy (non-argon2id) algorithm and
 * should be rehashed on next successful login.
 * @param {string} hash
 * @returns {boolean}
 */
export function needsRehash(hash) {
  return typeof hash === 'string' && !hash.startsWith('$argon2id$');
}
