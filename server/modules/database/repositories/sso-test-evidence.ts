/**
 * SSO test sign-in evidence repository (ADR-194 D8, T-1962 S3). Display
 * results are one-time and owner-bound; apply proofs are bound to owner,
 * config hash and draft version and survive reads. Every helper takes the
 * connection so the caller's transaction (and strict audit) covers it.
 */
import type { Database } from 'better-sqlite3';

export const SSO_TEST_RESULT_TTL_MS = 5 * 60_000;
export const SSO_APPLY_PROOF_TTL_MS = 24 * 60 * 60_000;

export type SsoApplyProofKind = 'discovery' | 'sign_in';

export type SsoApplyProofInput = Readonly<{
  ownerUserId: number;
  configHash: string;
  draftVersion: number;
  kind: SsoApplyProofKind;
  passed: boolean;
  shapeFlags: Readonly<Record<string, unknown>> | null;
}>;

/** Deletes display results older than 5 minutes and apply proofs older than 24 hours. */
export function sweepSsoTestEvidenceOn(db: Database, nowMs: number): void {
  db.prepare('DELETE FROM sso_test_results WHERE created_at <= ?').run(nowMs - SSO_TEST_RESULT_TTL_MS);
  db.prepare('DELETE FROM sso_apply_proofs WHERE created_at <= ?').run(nowMs - SSO_APPLY_PROOF_TTL_MS);
}

/** Stores one display result; `resultJson` must already hold only display-safe fields. */
export function insertSsoTestResultOn(db: Database, input: Readonly<{
  id: string; ownerUserId: number; configHash: string; resultJson: string; nowMs: number;
}>): void {
  db.prepare(`INSERT INTO sso_test_results (id, owner_user_id, config_hash, result_json, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(input.id, input.ownerUserId, input.configHash, input.resultJson, input.nowMs);
}

/**
 * Reads and deletes a display result for its own owner only (one-time). A
 * wrong owner or an expired id reads nothing and consumes nothing.
 */
export function consumeSsoTestResultOn(db: Database, id: string, ownerUserId: number, nowMs: number): string | null {
  sweepSsoTestEvidenceOn(db, nowMs);
  const row = db.prepare(`SELECT result_json AS resultJson FROM sso_test_results
    WHERE id = ? AND owner_user_id = ? AND consumed_at IS NULL`).get(id, ownerUserId) as
    { resultJson: string } | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM sso_test_results WHERE id = ? AND owner_user_id = ?').run(id, ownerUserId);
  return row.resultJson;
}

/** Records one apply proof. */
export function insertSsoApplyProofOn(db: Database, proof: SsoApplyProofInput, nowMs: number): void {
  db.prepare(`INSERT INTO sso_apply_proofs
    (owner_user_id, config_hash, draft_version, kind, passed, shape_flags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(proof.ownerUserId, proof.configHash, proof.draftVersion, proof.kind,
    proof.passed ? 1 : 0, proof.shapeFlags === null ? null : JSON.stringify(proof.shapeFlags), nowMs);
}

/** Whether a passed, unexpired proof of `kind` exists for exactly this owner, hash and draft version. */
export function hasPassedSsoApplyProofOn(db: Database, binding: Readonly<{
  ownerUserId: number; configHash: string; draftVersion: number; kind: SsoApplyProofKind; nowMs: number;
}>): boolean {
  return db.prepare(`SELECT 1 FROM sso_apply_proofs WHERE owner_user_id = ? AND config_hash = ?
    AND draft_version = ? AND kind = ? AND passed = 1 AND created_at > ? LIMIT 1`)
    .get(binding.ownerUserId, binding.configHash, binding.draftVersion, binding.kind,
      binding.nowMs - SSO_APPLY_PROOF_TTL_MS) !== undefined;
}
