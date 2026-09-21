import { getConnection } from '@/modules/database/connection.js';

export type GovernanceExemptionRow = {
  userId: number;
  provider: string;
  grantedBy: number | null;
  createdAt: string;
  expiresAt: string;
};

type DbRow = {
  user_id: number;
  provider: string;
  granted_by: number | null;
  created_at: string;
  expires_at: string;
};

function numericUserId(userId: string | number | null | undefined): number | null {
  if (userId === null || userId === undefined || userId === '') return null;
  const parsed = Number(userId);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toPublic(row: DbRow): GovernanceExemptionRow {
  return {
    userId: row.user_id,
    provider: row.provider,
    grantedBy: row.granted_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export const governanceExemptionsDb = {
  findStored(
    userId: string | number | null | undefined,
    provider: string,
  ): GovernanceExemptionRow | null {
    const id = numericUserId(userId);
    if (id === null || !provider) return null;
    const row = getConnection().prepare(
      `SELECT user_id, provider, granted_by, created_at, expires_at
         FROM governance_exemptions
        WHERE user_id = ? AND provider = ?`,
    ).get(id, provider) as DbRow | undefined;
    return row ? toPublic(row) : null;
  },

  listStoredForUser(
    userId: string | number | null | undefined,
  ): GovernanceExemptionRow[] {
    const id = numericUserId(userId);
    if (id === null) return [];
    const rows = getConnection().prepare(
      `SELECT user_id, provider, granted_by, created_at, expires_at
         FROM governance_exemptions
        WHERE user_id = ?
        ORDER BY provider ASC`,
    ).all(id) as DbRow[];
    return rows.map(toPublic);
  },

  isExempt(userId: string | number | null | undefined, provider: string): boolean {
    const id = numericUserId(userId);
    if (id === null || !provider) return false;
    try {
      return Boolean(getConnection().prepare(
        `SELECT 1 FROM governance_exemptions
          WHERE user_id = ? AND provider = ?
            AND expires_at IS NOT NULL AND datetime(expires_at) > CURRENT_TIMESTAMP
          LIMIT 1`,
      ).get(id, provider));
    } catch (error) {
      console.error('[governance-exemptions] read failed; treating user as governed', {
        userId: id,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  },

  listExemptProviders(userId: string | number | null | undefined): Set<string> {
    return new Set(this.listForUser(userId).map((row) => row.provider));
  },

  listForUser(userId: string | number | null | undefined): GovernanceExemptionRow[] {
    const id = numericUserId(userId);
    if (id === null) return [];
    try {
      const rows = getConnection().prepare(
        `SELECT user_id, provider, granted_by, created_at, expires_at
           FROM governance_exemptions
          WHERE user_id = ?
            AND expires_at IS NOT NULL AND datetime(expires_at) > CURRENT_TIMESTAMP
          ORDER BY provider ASC`,
      ).all(id) as DbRow[];
      return rows.map(toPublic);
    } catch (error) {
      console.error('[governance-exemptions] list failed; treating user as governed', {
        userId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  },

  grant(
    userId: string | number,
    provider: string,
    grantedBy: string | number,
    expiresAt: string,
  ): GovernanceExemptionRow {
    const id = numericUserId(userId);
    const grantor = numericUserId(grantedBy);
    if (id === null || grantor === null || !Number.isFinite(Date.parse(expiresAt))) {
      throw new Error('governance exemption requires valid server-resolved principals and expiry');
    }
    getConnection().prepare(
      `INSERT INTO governance_exemptions (user_id, provider, granted_by, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, provider) DO UPDATE SET
         granted_by = excluded.granted_by,
         created_at = CURRENT_TIMESTAMP,
         expires_at = excluded.expires_at`,
    ).run(id, provider, grantor, expiresAt);
    const row = getConnection().prepare(
      `SELECT user_id, provider, granted_by, created_at, expires_at
         FROM governance_exemptions WHERE user_id = ? AND provider = ?`,
    ).get(id, provider) as DbRow | undefined;
    if (!row) throw new Error('governance exemption write was not persisted');
    return toPublic(row);
  },

  revoke(userId: string | number, provider: string): void {
    const id = numericUserId(userId);
    if (id === null) return;
    getConnection().prepare(
      'DELETE FROM governance_exemptions WHERE user_id = ? AND provider = ?',
    ).run(id, provider);
  },
};
