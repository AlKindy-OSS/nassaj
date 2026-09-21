import type { Database } from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

export type OAuthPendingEnvelope = {
  stateHash: string;
  keyVersion: 1;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  expiresAt: number;
  createdAt: number;
};

type EnvelopeRow = {
  state_hash: string;
  key_version: 1;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  expires_at: number;
  created_at: number;
};

function toEnvelope(row: EnvelopeRow): OAuthPendingEnvelope {
  return {
    stateHash: row.state_hash,
    keyVersion: row.key_version,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    tag: row.tag,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/** Repository factory keeps transaction tests independent from the process singleton. */
export function createConnectorOAuthPendingDb(database: Database = getConnection()) {
  const consumeTransaction = database.transaction((stateHash: string, now: number) => {
    const claimed = database.prepare(
      `UPDATE connector_oauth_pending SET consumed_at = ?
       WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    ).run(now, stateHash, now);
    if (claimed.changes !== 1) return null;
    const row = database.prepare(
      `SELECT state_hash, key_version, nonce, ciphertext, tag, expires_at, created_at
       FROM connector_oauth_pending WHERE state_hash = ? AND consumed_at = ?`,
    ).get(stateHash, now) as EnvelopeRow | undefined;
    return row ? toEnvelope(row) : null;
  });

  return {
    put(envelope: OAuthPendingEnvelope): void {
      database.prepare(
        `INSERT INTO connector_oauth_pending (
           state_hash, key_version, nonce, ciphertext, tag, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        envelope.stateHash, envelope.keyVersion, envelope.nonce, envelope.ciphertext,
        envelope.tag, envelope.expiresAt, envelope.createdAt,
      );
    },
    consume(stateHash: string, now: number): OAuthPendingEnvelope | null {
      return consumeTransaction.immediate(stateHash, now);
    },
    sweep(now: number): number {
      return database.prepare('DELETE FROM connector_oauth_pending WHERE expires_at <= ?').run(now).changes;
    },
    count(now: number): number {
      return (database.prepare(
        `SELECT COUNT(*) AS count FROM connector_oauth_pending
         WHERE consumed_at IS NULL AND expires_at > ?`,
      ).get(now) as { count: number }).count;
    },
  };
}

/** Lazy facade: importing OAuth routes must not open SQLite before boot migration runs. */
export const connectorOAuthPendingDb = {
  put: (envelope: OAuthPendingEnvelope) => createConnectorOAuthPendingDb().put(envelope),
  consume: (stateHash: string, now: number) => createConnectorOAuthPendingDb().consume(stateHash, now),
  sweep: (now: number) => createConnectorOAuthPendingDb().sweep(now),
  count: (now: number) => createConnectorOAuthPendingDb().count(now),
};
