import type { Database } from 'better-sqlite3';

/**
 * Passkey step-up eligibility (T-1939 slice 6A, B-1407).
 *
 * `webauthn_credentials.step_up_eligible` marks passkeys enrolled under the
 * hardened ceremony (step-up proof + user verification required). Only those
 * may satisfy a step-up or mint a connector recent-auth session. Additive with
 * DEFAULT 0: every passkey that exists today stays NOT eligible (it was
 * enrolled with a bare JWT) until the user re-registers it. Probe and ALTER
 * share one immediate transaction so two admitted processes cannot both add
 * the column. Runs after migrateWebAuthnCredentials, which creates the table.
 */
export function migrateWebAuthnStepUpEligible(db: Database): void {
  db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(webauthn_credentials)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'step_up_eligible')) {
      db.exec('ALTER TABLE webauthn_credentials ADD COLUMN step_up_eligible INTEGER NOT NULL DEFAULT 0');
    }
  }).immediate();
}

/** Explicit rollback of the slice 6A column; never invoked automatically. */
export function rollbackWebAuthnStepUpEligible(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(webauthn_credentials)').all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === 'step_up_eligible')) {
    db.exec('ALTER TABLE webauthn_credentials DROP COLUMN step_up_eligible');
  }
}
