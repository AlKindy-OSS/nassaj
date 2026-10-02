/**
 * API keys repository.
 *
 * Manages API keys used for external/programmatic access to the backend.
 * Keys are prefixed with `ck_` and tied to a user via foreign key.
 */

import crypto from 'crypto';

import {
  API_KEY_PREFIX_LENGTH,
  digestApiKey,
} from '@/modules/database/api-key-digest.js';
import { getConnection } from '@/modules/database/connection.js';
import {
  apiKeyCredentialState,
  apiKeySsoAttestationClause,
  type ApiKeyCredentialState,
} from '@/modules/database/repositories/api-key-sso-window.js';

type ApiKeyRow = {
  id: number;
  key_name: string;
  api_key: string;
  key_prefix: string;
  created_at: string;
  last_used: string | null;
  is_active: number;
};

export const MAX_API_KEYS_PER_USER = 20;
export const MAX_API_KEY_NAME_LENGTH = 80;

export class ApiKeyInputError extends Error {
  constructor(public readonly code: 'invalid_name' | 'limit_reached') {
    super(code);
    this.name = 'ApiKeyInputError';
  }
}

type CreateApiKeyResult = {
  id: number | bigint;
  keyName: string;
  apiKey: string;
};

type ValidatedApiKeyUser = {
  id: number;
  username: string;
  role: 'owner' | 'admin' | 'user';
  api_key_id: number;
  authorization_generation: number;
};

/** Outcome of resolveApiKey: the owning user, or why the key was refused. */
export type ApiKeyResolution =
  | { ok: true; user: ValidatedApiKeyUser }
  | { ok: false; reason: 'invalid' | 'sso_attestation_expired' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generates a cryptographically random API key with the `ck_` prefix. */
function generateApiKey(): string {
  return 'ck_' + crypto.randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const apiKeysDb = {
  generateApiKey,

  /** Creates a new API key for the given user and returns it for one-time display. */
  createApiKey(userId: number, keyName: string): CreateApiKeyResult {
    const db = getConnection();
    const normalizedName = typeof keyName === 'string' ? keyName.trim() : '';
    if (normalizedName.length === 0 || normalizedName.length > MAX_API_KEY_NAME_LENGTH) {
      throw new ApiKeyInputError('invalid_name');
    }

    return db.transaction(() => {
      const count = db
        .prepare('SELECT COUNT(*) AS count FROM api_keys WHERE user_id = ?')
        .get(userId) as { count: number };
      if (count.count >= MAX_API_KEYS_PER_USER) {
        throw new ApiKeyInputError('limit_reached');
      }

      const apiKey = generateApiKey();
      const keyDigest = digestApiKey(apiKey);
      if (!keyDigest) throw new Error('generated_api_key_invalid');
      const keyPrefix = apiKey.slice(0, API_KEY_PREFIX_LENGTH);
      const result = db
        .prepare(
          'INSERT INTO api_keys (user_id, key_name, key_digest, key_prefix) VALUES (?, ?, ?, ?)'
        )
        .run(userId, normalizedName, keyDigest, keyPrefix);
      return { id: result.lastInsertRowid, keyName: normalizedName, apiKey };
    })();
  },

  /** Lists all API keys for a user, most recent first. */
  getApiKeys(userId: number): ApiKeyRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT id, key_name, key_prefix || '...' AS api_key, key_prefix,
                created_at, last_used, is_active
         FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
      )
      .all(userId) as ApiKeyRow[];
  },

  /**
   * Resolves an API key to its owning user, or says why it is refused.
   * `last_used` is stamped only on success.
   *
   * SEC-APIKEY-STATUS: the owner must be fully active (`is_active = 1 AND
   * status = 'active'`), exactly like every JWT path (`userDb.getUserById`).
   *
   * T-1946: an SSO-linked non-owner is refused with `sso_attestation_expired`
   * once their newest SSO sign-in is older than the owner's window (see
   * api-key-sso-window.ts). The key itself is untouched, so the next SSO
   * sign-in makes it work again.
   */
  resolveApiKey(apiKey: string, nowMs: number = Date.now()): ApiKeyResolution {
    const keyDigest = digestApiKey(apiKey);
    if (!keyDigest) return { ok: false, reason: 'invalid' };
    const db = getConnection();
    const clause = apiKeySsoAttestationClause(db, nowMs);
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.authorization_generation, ak.id as api_key_id,
                CASE WHEN ${clause.sql} THEN 1 ELSE 0 END AS sso_attested
         FROM api_keys ak
         JOIN users u ON ak.user_id = u.id
         WHERE ak.key_digest = ?
           AND ak.is_active = 1
           AND u.is_active = 1
           AND u.status = 'active'`
      )
      .get(...clause.params, keyDigest) as
      | (ValidatedApiKeyUser & { sso_attested: number })
      | undefined;

    if (!row) return { ok: false, reason: 'invalid' };
    if (row.sso_attested !== 1) return { ok: false, reason: 'sso_attestation_expired' };
    db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(row.api_key_id);
    return {
      ok: true,
      user: {
        id: row.id,
        username: row.username,
        role: row.role,
        api_key_id: row.api_key_id,
        authorization_generation: row.authorization_generation,
      },
    };
  },

  /**
   * Revalidates the exact credential row and its immutable owning principal,
   * including the SSO attestation window (T-1946).
   */
  isAuthenticationPrincipalCurrent(
    apiKeyId: number,
    userId: number,
    authorizationGeneration: number,
  ): boolean {
    return apiKeysDb.authenticationPrincipalState(apiKeyId, userId, authorizationGeneration)
      === 'current';
  },

  /**
   * Same check as isAuthenticationPrincipalCurrent, but says why a principal is
   * refused, so a caller can answer `api_key_sso_attestation_expired`.
   */
  authenticationPrincipalState(
    apiKeyId: number,
    userId: number,
    authorizationGeneration: number,
  ): ApiKeyCredentialState {
    if (!Number.isSafeInteger(authorizationGeneration) || authorizationGeneration <= 0) {
      return 'invalid';
    }
    return apiKeyCredentialState(getConnection(), { apiKeyId, userId, authorizationGeneration });
  },

  /** Permanently removes an API key. Returns true if a row was deleted. */
  deleteApiKey(userId: number, apiKeyId: number): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?')
      .run(apiKeyId, userId);
    return result.changes > 0;
  },

  /**
   * Permanently removes every API key of a user and returns how many were
   * removed (T-1939: the IdP withdrew the member's grant or signed them out).
   * Deleted, not disabled, so the member cannot re-enable a revoked key.
   */
  revokeAllForUser(userId: number): number {
    return getConnection()
      .prepare('DELETE FROM api_keys WHERE user_id = ?')
      .run(userId).changes;
  },

  /** Enables or disables an API key without deleting it. */
  toggleApiKey(
    userId: number,
    apiKeyId: number,
    isActive: boolean
  ): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        'UPDATE api_keys SET is_active = ? WHERE id = ? AND user_id = ?'
      )
      .run(isActive ? 1 : 0, apiKeyId, userId);
    return result.changes > 0;
  },
};
