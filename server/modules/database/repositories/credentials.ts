/**
 * User credentials repository.
 *
 * Manages external service tokens (GitHub, GitLab, Bitbucket, etc.)
 * stored per-user. Each credential has a type discriminator so multiple
 * credential kinds can coexist in the same table.
 */

import { getConnection } from '@/modules/database/connection.js';
import {
  decryptCredentialValue,
  encryptCredentialValue,
} from '@/modules/database/database-credential-crypto.js';
import type {
  CreateCredentialResult,
  CredentialPublicRow,
} from '@/shared/types.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const credentialsDb = {
  /** Stores a new credential and returns a safe (no raw value) result. */
  createCredential(
    userId: number,
    credentialName: string,
    credentialType: string,
    credentialValue: string,
    description: string | null = null
  ): CreateCredentialResult {
    const db = getConnection();
    const create = db.transaction(() => {
      const sequence = db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'user_credentials'")
        .get() as { seq: number } | undefined;
      const maximum = db
        .prepare('SELECT COALESCE(MAX(id), 0) AS id FROM user_credentials')
        .get() as { id: number };
      const id = Math.max(sequence?.seq ?? 0, maximum.id) + 1;
      const encrypted = encryptCredentialValue(credentialValue, {
        id,
        userId,
        credentialType,
      });
      db.prepare(
        `INSERT INTO user_credentials
           (id, user_id, credential_name, credential_type, credential_value, description)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, userId, credentialName, credentialType, encrypted, description);
      return { id, credentialName, credentialType };
    });
    return create.immediate() as CreateCredentialResult;
  },

  /**
   * Lists credentials for a user (excluding raw values).
   * Optionally filters by credential type (e.g. 'github_token').
   */
  getCredentials(
    userId: number,
    credentialType: string | null = null
  ): CredentialPublicRow[] {
    const db = getConnection();

    if (credentialType) {
      return db
        .prepare(
          'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ? AND credential_type = ? ORDER BY created_at DESC'
        )
        .all(userId, credentialType) as CredentialPublicRow[];
    }

    return db
      .prepare(
        'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ? ORDER BY created_at DESC'
      )
      .all(userId) as CredentialPublicRow[];
  },

  /**
   * Returns the raw credential value for the most recent active
   * credential of the given type, or null if none exists.
   */
  getActiveCredential(
    userId: number,
    credentialType: string
  ): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT id, user_id, credential_type, credential_value
         FROM user_credentials
         WHERE user_id = ? AND credential_type = ? AND is_active = 1
         ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(userId, credentialType) as {
        id: number;
        user_id: number;
        credential_type: string;
        credential_value: string;
      } | undefined;
    if (!row) return null;
    try {
      return decryptCredentialValue(row.credential_value, {
        id: row.id,
        userId: row.user_id,
        credentialType: row.credential_type,
      });
    } catch {
      return null;
    }
  },

  /** Permanently removes a credential. Returns true if a row was deleted. */
  deleteCredential(userId: number, credentialId: number): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?')
      .run(credentialId, userId);
    return result.changes > 0;
  },

  /** Enables or disables a credential without deleting it. */
  toggleCredential(
    userId: number,
    credentialId: number,
    isActive: boolean
  ): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        'UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?'
      )
      .run(isActive ? 1 : 0, credentialId, userId);
    return result.changes > 0;
  },
};
