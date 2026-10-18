/**
 * SSO device sessions and their IdP session ids (ADR-H20 S6, N5/N8).
 * `privileged_until` is a retired column (the N2 owner step-up was withdrawn
 * 2026-10-18); it stays in the schema and is always written NULL.
 *
 * One row per Nassaj device session (`refresh_sid`) started through SSO; see
 * sso-linked-sessions.migration.ts for the columns. Every read is a primary-key
 * or indexed lookup and every write a single short transaction, so another
 * process sees a change on its very next request. Rows are pruned (on every
 * bind) only past `prune_after`, which the service sets beyond any token of
 * that session.
 */

import { getConnection } from '@/modules/database/connection.js';

/**
 * ADR-H20 D9 / N8: an SSO device session ends after 24 h with no use, with no
 * absolute cap other than the IdP session. Checked by every session verifier
 * (token-session.ts) before any renewal, so an idle session never renews.
 */
export const SSO_SESSION_IDLE_MS = 24 * 60 * 60_000;

/** True when the row's idle clock ran out at `nowMs`. */
export function ssoDeviceSessionIdleExpired(row: { last_seen_at: number } | undefined, nowMs: number): boolean {
  return row !== undefined && nowMs - row.last_seen_at > SSO_SESSION_IDLE_MS;
}

export type SsoDeviceSessionRow = {
  refresh_sid: string;
  user_id: number;
  issuer: string;
  login_hint: string | null;
  owner_tier: number;
  created_at: number;
  last_seen_at: number;
  last_recheck_at: number;
  privileged_until: number | null;
  prune_after: number;
};

export type SsoDeviceSessionBinding = {
  refreshSid: string;
  userId: number;
  issuer: string;
  idpSid: string | null;
  loginHint: string | null;
  ownerTier: boolean;
  nowMs: number;
  pruneAfter: number;
};

const SELECT_COLUMNS = `refresh_sid, user_id, issuer, login_hint, owner_tier, created_at,
  last_seen_at, last_recheck_at, privileged_until, prune_after`;

function insertIdpSid(issuer: string, idpSid: string, refreshSid: string, nowMs: number): void {
  getConnection().prepare(`INSERT OR IGNORE INTO sso_device_session_idp_sids
    (issuer, idp_sid, refresh_sid, added_at) VALUES (?, ?, ?, ?)`).run(issuer, idpSid, refreshSid, nowMs);
}

export const ssoDeviceSessionsDb = {
  /** Creates (or replaces) the row for a new SSO device session, with its first IdP sid. */
  bind(binding: SsoDeviceSessionBinding): void {
    const db = getConnection();
    db.transaction(() => {
      // Prune on write: rows past prune_after can no longer back any token.
      db.prepare(`DELETE FROM sso_device_session_idp_sids WHERE refresh_sid IN
        (SELECT refresh_sid FROM sso_device_sessions WHERE prune_after <= ?)`).run(binding.nowMs);
      db.prepare('DELETE FROM sso_device_sessions WHERE prune_after <= ?').run(binding.nowMs);
      db.prepare('DELETE FROM sso_device_session_idp_sids WHERE refresh_sid = ?').run(binding.refreshSid);
      db.prepare(`INSERT OR REPLACE INTO sso_device_sessions (${SELECT_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        binding.refreshSid, binding.userId, binding.issuer, binding.loginHint, binding.ownerTier ? 1 : 0,
        binding.nowMs, binding.nowMs, binding.nowMs, null, binding.pruneAfter,
      );
      if (binding.idpSid) insertIdpSid(binding.issuer, binding.idpSid, binding.refreshSid, binding.nowMs);
    }).immediate();
  },

  /** The row for one device session, or undefined (a password session has none). */
  get(refreshSid: string): SsoDeviceSessionRow | undefined {
    return getConnection()
      .prepare(`SELECT ${SELECT_COLUMNS} FROM sso_device_sessions WHERE refresh_sid = ?`)
      .get(refreshSid) as SsoDeviceSessionRow | undefined;
  },

  /** Every device session that saw this IdP session id under this issuer. */
  findByIdpSid(issuer: string, idpSid: string): SsoDeviceSessionRow[] {
    return getConnection().prepare(`SELECT s.refresh_sid, s.user_id, s.issuer, s.login_hint, s.owner_tier,
      s.created_at, s.last_seen_at, s.last_recheck_at, s.privileged_until, s.prune_after
      FROM sso_device_session_idp_sids m JOIN sso_device_sessions s ON s.refresh_sid = m.refresh_sid
      WHERE m.issuer = ? AND m.idp_sid = ?`).all(issuer, idpSid) as SsoDeviceSessionRow[];
  },

  /** Records another IdP sid for an existing device session (re-check). */
  addIdpSid(refreshSid: string, idpSid: string, nowMs: number): boolean {
    const row = this.get(refreshSid);
    if (!row) return false;
    insertIdpSid(row.issuer, idpSid, refreshSid, nowMs);
    return true;
  },

  /**
   * Moves the idle clock forward, at most once per `throttleMs` (one indexed
   * UPDATE that changes nothing inside the throttle). True when it wrote.
   */
  touch(refreshSid: string, nowMs: number, throttleMs: number, pruneAfter: number): boolean {
    return getConnection().prepare(`UPDATE sso_device_sessions SET last_seen_at = ?, prune_after = max(prune_after, ?)
      WHERE refresh_sid = ? AND last_seen_at <= ?`).run(nowMs, pruneAfter, refreshSid, nowMs - throttleMs).changes > 0;
  },

  /** Stamps a completed silent re-check (success or "needs interaction"). */
  markRechecked(refreshSid: string, nowMs: number): boolean {
    return getConnection().prepare('UPDATE sso_device_sessions SET last_recheck_at = ? WHERE refresh_sid = ?')
      .run(nowMs, refreshSid).changes > 0;
  },

  /** Forgets one device session and its IdP sids (after its revocation is stored). */
  remove(refreshSid: string): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare('DELETE FROM sso_device_session_idp_sids WHERE refresh_sid = ?').run(refreshSid);
      db.prepare('DELETE FROM sso_device_sessions WHERE refresh_sid = ?').run(refreshSid);
    }).immediate();
  },

  /** Deletes rows past `prune_after` and their sids; returns the row count. */
  pruneExpired(nowMs: number): number {
    const db = getConnection();
    let removed = 0;
    db.transaction(() => {
      db.prepare(`DELETE FROM sso_device_session_idp_sids WHERE refresh_sid IN
        (SELECT refresh_sid FROM sso_device_sessions WHERE prune_after <= ?)`).run(nowMs);
      removed = db.prepare('DELETE FROM sso_device_sessions WHERE prune_after <= ?').run(nowMs).changes;
    }).immediate();
    return removed;
  },
};

export type LogoutJtiOutcome = 'recorded' | 'full';

export const oidcLogoutJtisDb = {
  /** True when this logout token was already answered 200 and is still remembered. */
  seen(issuer: string, jti: string, nowMs: number): boolean {
    return getConnection()
      .prepare('SELECT 1 FROM oidc_logout_jtis WHERE issuer = ? AND jti = ? AND expires_at > ?')
      .get(issuer, jti, nowMs) !== undefined;
  },

  /**
   * Records a processed `jti`. Expired rows are pruned first; an unexpired row
   * is never evicted, so a store holding `maxEntries` unexpired rows answers
   * 'full' and records nothing.
   */
  record(issuer: string, jti: string, { expiresAt, nowMs, maxEntries }: {
    expiresAt: number; nowMs: number; maxEntries: number;
  }): LogoutJtiOutcome {
    const db = getConnection();
    let outcome: LogoutJtiOutcome = 'recorded';
    db.transaction(() => {
      db.prepare('DELETE FROM oidc_logout_jtis WHERE expires_at <= ?').run(nowMs);
      const { count } = db.prepare('SELECT count(*) AS count FROM oidc_logout_jtis').get() as { count: number };
      if (count >= maxEntries) {
        outcome = 'full';
        return;
      }
      db.prepare(`INSERT INTO oidc_logout_jtis (issuer, jti, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(issuer, jti) DO UPDATE SET expires_at = max(expires_at, excluded.expires_at)`)
        .run(issuer, jti, expiresAt);
    }).immediate();
    return outcome;
  },

  /** Unexpired rows at `nowMs`. */
  countActive(nowMs: number): number {
    return (getConnection().prepare('SELECT count(*) AS count FROM oidc_logout_jtis WHERE expires_at > ?')
      .get(nowMs) as { count: number }).count;
  },
};
