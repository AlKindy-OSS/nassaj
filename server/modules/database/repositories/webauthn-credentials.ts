/**
 * WebAuthn credentials repository (B-PK-1).
 *
 * Stores registered passkeys. The primary key is the credential ID exactly as
 * the authenticator reports it (base64url string), so login assertions can be
 * resolved with a single lookup. public_key holds the raw COSE key bytes
 * (BLOB/Buffer) consumed by @simplewebauthn/server during verification.
 *
 * All queries use prepared statements; ownership-scoped mutations (rename,
 * delete) always filter by user_id so a user can never touch another user's
 * credential even with a guessed id.
 */

import { getConnection } from '@/modules/database/connection.js';

export type WebAuthnCredentialRow = {
  id: string;
  user_id: number;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  aaguid: string | null;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
};

/** Listing shape — everything except the public key bytes. */
export type WebAuthnCredentialSummary = Omit<WebAuthnCredentialRow, 'public_key'>;

export type CreateWebAuthnCredentialInput = {
  /** Credential ID, base64url string (as returned by the authenticator). */
  id: string;
  userId: number;
  /** COSE public key bytes. */
  publicKey: Buffer | Uint8Array;
  counter?: number;
  /** Transport hints, stored as a JSON array string when provided. */
  transports?: string[] | null;
  deviceType?: string | null;
  backedUp?: boolean;
  aaguid?: string | null;
  name?: string | null;
};

const SUMMARY_COLUMNS =
  'id, user_id, counter, transports, device_type, backed_up, aaguid, name, created_at, last_used_at';

export const webauthnCredentialsDb = {
  /** Persists a newly verified registration. */
  create(input: CreateWebAuthnCredentialInput): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO webauthn_credentials
         (id, user_id, public_key, counter, transports, device_type, backed_up, aaguid, name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.id,
      input.userId,
      Buffer.isBuffer(input.publicKey) ? input.publicKey : Buffer.from(input.publicKey),
      input.counter ?? 0,
      input.transports && input.transports.length > 0 ? JSON.stringify(input.transports) : null,
      input.deviceType ?? null,
      input.backedUp ? 1 : 0,
      input.aaguid ?? null,
      input.name ?? null
    );
  },

  /** Full row (incl. public key) by credential ID — the login verify path. */
  getById(id: string): WebAuthnCredentialRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM webauthn_credentials WHERE id = ?')
      .get(id) as WebAuthnCredentialRow | undefined;
  },

  /** All credentials of a user, newest first, WITHOUT public key bytes. */
  listByUserId(userId: number): WebAuthnCredentialSummary[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM webauthn_credentials
         WHERE user_id = ? ORDER BY created_at DESC, id ASC`
      )
      .all(userId) as WebAuthnCredentialSummary[];
  },

  /** Advances the signature counter and stamps last_used_at after a login. */
  updateCounterAndLastUsed(id: string, counter: number): void {
    const db = getConnection();
    db.prepare(
      'UPDATE webauthn_credentials SET counter = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(counter, id);
  },

  /** Renames a credential. Ownership enforced. Returns true if a row changed. */
  rename(id: string, userId: number, name: string): boolean {
    const db = getConnection();
    const result = db
      .prepare('UPDATE webauthn_credentials SET name = ? WHERE id = ? AND user_id = ?')
      .run(name, id, userId);
    return result.changes > 0;
  },

  /** Deletes a credential. Ownership enforced. Returns true if a row was deleted. */
  deleteByIdForUser(id: string, userId: number): boolean {
    const db = getConnection();
    const result = db
      .prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return result.changes > 0;
  },
};
