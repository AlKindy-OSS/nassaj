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
   * Validates an API key and resolves the owning user.
   * If the key is valid, its `last_used` timestamp is updated as a side effect.
   * Returns undefined when the key is invalid, disabled, or its owner is not a
   * fully active account.
   *
   * SEC-APIKEY-STATUS: the predicate used to be `ak.is_active = 1 AND
   * u.is_active = 1` — it checked the LEGACY `is_active` column only. Account
   * suspension, however, is expressed through `users.status` (userDb.setStatus
   * writes `status` and nothing else), and every JWT path already requires BOTH
   * (`userDb.getUserById`: `is_active = 1 AND status = 'active'`). The two
   * predicates therefore disagreed: disabling a departing member killed their
   * tokens but left every API key of theirs valid — on /api/agent, which runs
   * with permissionMode:'bypassPermissions'. The `u.status = 'active'` clause
   * below makes the API-key path match the JWT path exactly.
   */
  validateApiKey(apiKey: string): ValidatedApiKeyUser | undefined {
    const keyDigest = digestApiKey(apiKey);
    if (!keyDigest) return undefined;
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.authorization_generation, ak.id as api_key_id
         FROM api_keys ak
         JOIN users u ON ak.user_id = u.id
         WHERE ak.key_digest = ?
           AND ak.is_active = 1
           AND u.is_active = 1
           AND u.status = 'active'`
      )
      .get(keyDigest) as ValidatedApiKeyUser | undefined;

    if (row) {
      db.prepare(
        'UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(row.api_key_id);
    }

    return row;
  },

  /** Revalidates the exact credential row and its immutable owning principal. */
  isAuthenticationPrincipalCurrent(
    apiKeyId: number,
    userId: number,
    authorizationGeneration: number,
  ): boolean {
    if (!Number.isSafeInteger(apiKeyId) || apiKeyId <= 0
      || !Number.isSafeInteger(userId) || userId <= 0
      || !Number.isSafeInteger(authorizationGeneration) || authorizationGeneration <= 0) {
      return false;
    }
    const row = getConnection().prepare(`SELECT 1
      FROM api_keys ak
      JOIN users u ON u.id = ak.user_id
      WHERE ak.id = ? AND ak.user_id = ? AND ak.is_active = 1
        AND u.is_active = 1 AND u.status = 'active'
        AND u.authorization_generation = ?`).get(apiKeyId, userId, authorizationGeneration);
    return row !== undefined;
  },

  /** Permanently removes an API key. Returns true if a row was deleted. */
  deleteApiKey(userId: number, apiKeyId: number): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?')
      .run(apiKeyId, userId);
    return result.changes > 0;
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
