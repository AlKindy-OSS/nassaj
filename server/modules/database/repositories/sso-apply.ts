/**
 * SSO apply and impact repository (ADR-194 D8/D9, T-1962 S4).
 *
 * Owns the SQL the owner settings routes need beyond the slot table itself:
 * linked-identity counts, the orphan set of an issuer change, attestation
 * reset, session and API key revocation, the active-slot write and the latest
 * apply proofs. Every helper takes the connection so the apply transaction,
 * its revocations and its strict audit commit or roll back together. Owners
 * are never counted, revoked or reset here: the owner signs in locally only.
 */
import type { Database } from 'better-sqlite3';

import { SSO_DRAFT_COLUMNS, type SsoDraftFields } from './sso-oidc-config.js';

const MAX_ISSUER_ROWS = 50;

export type IssuerIdentityCount = { issuer: string; linkedUsers: number };

export type LatestApplyProof = {
  configHash: string;
  draftVersion: number;
  passed: boolean;
  shapeFlags: Record<string, unknown> | null;
  createdAt: number;
};

/** Linked non-owner accounts per issuer (D8 `identityCountsByIssuer`). */
export function identityCountsByIssuerOn(db: Database): IssuerIdentityCount[] {
  return db.prepare(`SELECT ui.issuer AS issuer, COUNT(DISTINCT ui.user_id) AS linkedUsers
    FROM user_identities ui JOIN users u ON u.id = ui.user_id
    WHERE u.role <> 'owner' GROUP BY ui.issuer ORDER BY ui.issuer LIMIT ?`)
    .all(MAX_ISSUER_ROWS) as IssuerIdentityCount[];
}

/** Ids of every non-owner holding at least one link. */
export function linkedNonOwnerIdsOn(db: Database): number[] {
  return (db.prepare(`SELECT DISTINCT u.id AS id FROM users u
    JOIN user_identities ui ON ui.user_id = u.id WHERE u.role <> 'owner' ORDER BY u.id`)
    .all() as Array<{ id: number }>).map((row) => row.id);
}

/** Non-owners with links, none of them under `issuer` (orphaned by switching to it, D9). */
export function orphanedNonOwnerIdsOn(db: Database, issuer: string): number[] {
  return (db.prepare(`SELECT DISTINCT u.id AS id FROM users u
    JOIN user_identities ui ON ui.user_id = u.id
    WHERE u.role <> 'owner' AND NOT EXISTS (
      SELECT 1 FROM user_identities own WHERE own.user_id = u.id AND own.issuer = ?)
    ORDER BY u.id`).all(issuer) as Array<{ id: number }>).map((row) => row.id);
}

/** D9 mapping change: every linked non-owner must sign in again. Returns the account count. */
export function clearLinkedNonOwnerAttestationOn(db: Database): number {
  const ids = linkedNonOwnerIdsOn(db);
  db.prepare(`UPDATE user_identities SET last_attested_at = NULL
    WHERE user_id IN (SELECT id FROM users WHERE role <> 'owner')`).run();
  return ids.length;
}

/** Advances the password stamp (ends JWTs and refresh grace) of non-owners only. */
export function stampUsersSessionsRevokedOn(db: Database, userIds: readonly number[], nowMs: number): number[] {
  const stamp = db.prepare("UPDATE users SET password_changed_at = ? WHERE id = ? AND role <> 'owner'");
  return userIds.filter((id) => stamp.run(nowMs, id).changes === 1);
}

/** Deletes every API key of the given non-owners; returns the number deleted. */
export function revokeApiKeysForUsersOn(db: Database, userIds: readonly number[]): number {
  const remove = db.prepare(`DELETE FROM api_keys WHERE user_id = ?
    AND user_id IN (SELECT id FROM users WHERE role <> 'owner')`);
  return userIds.reduce((total, id) => total + remove.run(id).changes, 0);
}

const ACTIVE_COLUMNS = SSO_DRAFT_COLUMNS;

const WRITE_ACTIVE_SQL = `INSERT INTO sso_oidc_config
  (slot, enabled, ${ACTIVE_COLUMNS.join(', ')}, runtime_fault, draft_version, version, updated_at, updated_by)
  VALUES ('active', @enabled, ${ACTIVE_COLUMNS.map((column) => `@${column}`).join(', ')},
  NULL, @draft_version, @version, @updated_at, @updated_by)
  ON CONFLICT(slot) DO UPDATE SET enabled = excluded.enabled,
  ${ACTIVE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(',\n  ')},
  runtime_fault = NULL, draft_version = excluded.draft_version, version = excluded.version,
  updated_at = excluded.updated_at, updated_by = excluded.updated_by`;

/** Replaces the active slot (D9 step 2); `runtime_fault` is always cleared. */
export function writeActiveSlotOn(db: Database, fields: SsoDraftFields, meta: Readonly<{
  enabled: 0 | 1; version: number; draftVersion: number; actorUserId: number; nowMs: number;
}>): void {
  db.prepare(WRITE_ACTIVE_SQL).run({
    ...Object.fromEntries(ACTIVE_COLUMNS.map((column) => [column, fields[column]])),
    enabled: meta.enabled, draft_version: meta.draftVersion, version: meta.version,
    updated_at: meta.nowMs, updated_by: meta.actorUserId,
  });
}

function parseShapeFlags(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The newest proof of `kind` by this owner (any hash), or null. */
export function latestApplyProofOn(db: Database, ownerUserId: number, kind: 'discovery' | 'sign_in'):
  LatestApplyProof | null {
  const row = db.prepare(`SELECT config_hash AS configHash, draft_version AS draftVersion, passed,
    shape_flags AS shapeFlags, created_at AS createdAt FROM sso_apply_proofs
    WHERE owner_user_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(ownerUserId, kind) as { configHash: string; draftVersion: number; passed: number;
      shapeFlags: string | null; createdAt: number } | undefined;
  if (!row) return null;
  return { ...row, passed: row.passed === 1, shapeFlags: parseShapeFlags(row.shapeFlags) };
}
