/**
 * External platform connectors repository (T-1226, ADR-098).
 *
 * The registry half of the connectors feature: which external platforms the
 * operator has connected (Canva, Wafeq, Google, …), what each is called, and
 * whether the platform permits a shared key at all.
 *
 * THE SECRET IS NOT HERE. The API key lives encrypted in
 * `provider-secrets-store` under the `connector` namespace. Nothing in this file
 * reads, writes, returns, or logs key material — a row is safe to hand to a
 * client as-is, which is the whole reason the split exists. If a future change
 * makes a key reachable from a `ConnectorRow`, that change is wrong.
 *
 * OWNERSHIP, NOT PERMISSION (ADR-098 rev2, owner decision 2026-08-04). A
 * connector is either PERSONAL — `credential_mode = 'per_member'`, owned by one
 * member via `owner_user_id`, visible and distributed to that member only — or
 * SHARED, which every member gets. That is a choice about WHOSE ACCOUNT the key
 * belongs to, not a permission tier.
 *
 * There is deliberately no `min_role` column: under a shared uid a role gate is
 * a UI affordance rather than a boundary, and encoding one would invite callers
 * to trust it. Personal-vs-shared is different in kind — it does not claim to
 * stop anyone, it decides whose credential is used.
 */

import { getConnection } from '@/modules/database/connection.js';

/** How a connector's credential is owned. Only 'org_shared' is used today. */
export type ConnectorCredentialMode = 'org_shared' | 'per_member';

/** How the platform's MCP server is reached. */
export type ConnectorTransport = 'stdio' | 'http';

/** 'key' = a pasted credential; 'oauth' = a browser grant held by mcp-remote. */
export type ConnectorAuthMode = 'key' | 'oauth';

export type ConnectorRow = {
  /** Stable slug, also the id under which the secret is stored. */
  id: string;
  /** Platform family, e.g. 'canva' — several rows may share one service. */
  service: string;
  displayName: string;
  /** Distinguishes two connections to the same service; '' when there is one. */
  accountLabel: string;
  credentialMode: ConnectorCredentialMode;
  /** For a personal connector: whose it is. Null for a shared one. */
  ownerUserId: number | null;
  /** Whether the PLATFORM permits one shared key. Not a user preference. */
  allowsSharing: boolean;
  enabled: boolean;
  transport: ConnectorTransport;
  /** stdio: the MCP server to launch. */
  command: string | null;
  args: string[];
  /** http: the remote MCP endpoint. */
  url: string | null;
  /** stdio: which env var carries the secret into the server. */
  keyEnvVar: string | null;
  /** http: which header carries the secret. */
  keyHeader: string | null;
  /** http: what goes in front of the secret, e.g. 'Bearer '. */
  keyHeaderPrefix: string;
  /** Non-secret extras the server needs to boot, e.g. Slack's workspace id. */
  extraEnv: Record<string, string>;
  authMode: ConnectorAuthMode;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  /** Even when stable; odd while credential/grant promotion is in flight. */
  sourceRevision: number;
};

type ConnectorDbRow = {
  id: string;
  service: string;
  display_name: string;
  account_label: string;
  credential_mode: string;
  owner_user_id: number | null;
  allows_sharing: number;
  enabled: number;
  transport: string;
  command: string | null;
  args_json: string;
  url: string | null;
  key_env_var: string | null;
  key_header: string | null;
  key_header_prefix: string;
  extra_env_json: string;
  auth_mode: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  source_revision: number;
};

/**
 * Parses the stored args array. A corrupt value degrades to [] rather than
 * throwing: a connector with unreadable args should fail to launch visibly at
 * the MCP layer, not crash every list request that merely mentions it.
 */
function parseArgs(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Mirrors the id shape enforced by provider-secrets-store, because the same
 * string is used as this table's primary key AND as the secret's storage key.
 * Validating in both places is deliberate: neither module may assume the other
 * was called first.
 */
const CONNECTOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Parses the stored extras. A corrupt value degrades to {} for the same reason
 * `parseArgs` degrades to []: the connector should fail visibly at launch, not
 * take down every list request that merely mentions it.
 */
function parseExtraEnv(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => [k, v as string]),
    );
  } catch {
    return {};
  }
}

function toRow(row: ConnectorDbRow): ConnectorRow {
  if (!Number.isSafeInteger(row.source_revision) || row.source_revision < 0) {
    throw new Error('connector_source_revision_invalid');
  }
  return {
    id: row.id,
    service: row.service,
    displayName: row.display_name,
    accountLabel: row.account_label,
    // Widened by SQLite to string; narrowed here rather than cast blindly so an
    // unexpected value surfaces as 'org_shared' (the only mode in use) instead
    // of a silently invalid union member flowing into callers.
    credentialMode: row.credential_mode === 'per_member' ? 'per_member' : 'org_shared',
    ownerUserId: row.owner_user_id,
    allowsSharing: row.allows_sharing === 1,
    enabled: row.enabled === 1,
    transport: row.transport === 'http' ? 'http' : 'stdio',
    command: row.command,
    args: parseArgs(row.args_json),
    url: row.url,
    keyEnvVar: row.key_env_var,
    keyHeader: row.key_header,
    keyHeaderPrefix: row.key_header_prefix ?? '',
    extraEnv: parseExtraEnv(row.extra_env_json),
    authMode: row.auth_mode === 'oauth' ? 'oauth' : 'key',
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceRevision: row.source_revision,
  };
}

export type CreateConnectorInput = {
  id: string;
  service: string;
  displayName: string;
  accountLabel?: string;
  allowsSharing?: boolean;
  credentialMode?: ConnectorCredentialMode;
  ownerUserId?: number | null;
  transport?: ConnectorTransport;
  command?: string | null;
  args?: string[];
  url?: string | null;
  keyEnvVar?: string | null;
  keyHeader?: string | null;
  keyHeaderPrefix?: string;
  extraEnv?: Record<string, string>;
  authMode?: ConnectorAuthMode;
  createdBy?: number | null;
};

export const connectorsDb = {
  /** Every connector, newest first. Includes disabled rows. */
  list(): ConnectorRow[] {
    const db = getConnection();
    const rows = db
      .prepare('SELECT * FROM connectors ORDER BY created_at DESC, id ASC')
      .all() as ConnectorDbRow[];
    return rows.map(toRow);
  },

  /**
   * The connectors that should actually be distributed into member trees.
   * Disabled rows are excluded here rather than filtered by each caller, so
   * "enabled" has one meaning in one place.
   */
  listEnabled(): ConnectorRow[] {
    const db = getConnection();
    const rows = db
      .prepare('SELECT * FROM connectors WHERE enabled = 1 ORDER BY id ASC')
      .all() as ConnectorDbRow[];
    return rows.map(toRow);
  },

  get(id: string): ConnectorRow | null {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as
      | ConnectorDbRow
      | undefined;
    return row ? toRow(row) : null;
  },

  /** Connectors owned by one member (personal) plus every shared one. */
  listVisibleTo(userId: number): ConnectorRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT * FROM connectors
          WHERE credential_mode = 'org_shared' OR owner_user_id = ?
          ORDER BY created_at DESC, id ASC`
      )
      .all(userId) as ConnectorDbRow[];
    return rows.map(toRow);
  },

  /** Enabled connectors that should land in ONE member's tree. */
  listEnabledForUser(userId: number): ConnectorRow[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT * FROM connectors
          WHERE enabled = 1 AND (credential_mode = 'org_shared' OR owner_user_id = ?)
          ORDER BY id ASC`
      )
      .all(userId) as ConnectorDbRow[];
    return rows.map(toRow);
  },

  /**
   * Registers a connector. Throws on a malformed id, a personal row without an
   * owner, or a duplicate — the UNIQUE constraint is what stops an operator from
   * silently creating a second shared "Canva" that shadows the first, while
   * still letting each member keep their own personal one.
   *
   * `allowsSharing` is recorded per row rather than derived at read time, so
   * revising our view of a platform later cannot retroactively re-authorize a
   * row that already exists.
   */
  create(input: CreateConnectorInput): ConnectorRow {
    if (!CONNECTOR_ID_PATTERN.test(input.id)) {
      throw new Error('Connector id must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}');
    }
    if (typeof input.service !== 'string' || input.service.trim() === '') {
      throw new Error('Connector service must be a non-empty string');
    }
    if (typeof input.displayName !== 'string' || input.displayName.trim() === '') {
      throw new Error('Connector displayName must be a non-empty string');
    }

    // A connector that cannot be reached is not a connector. Validated here, at
    // the only place rows are born, so no later stage has to cope with a row
    // that names a platform but no way to talk to it.
    const transport: ConnectorTransport = input.transport === 'http' ? 'http' : 'stdio';
    if (transport === 'stdio' && (typeof input.command !== 'string' || input.command.trim() === '')) {
      throw new Error('A stdio connector requires a command');
    }
    if (transport === 'http' && (typeof input.url !== 'string' || input.url.trim() === '')) {
      throw new Error('An http connector requires a url');
    }

    // A personal connector MUST carry its owner, or it would be visible to
    // nobody and distributed to nobody — a row that exists and does nothing.
    const credentialMode: ConnectorCredentialMode =
      input.credentialMode === 'per_member' ? 'per_member' : 'org_shared';
    const ownerUserId = credentialMode === 'per_member' ? (input.ownerUserId ?? null) : null;
    if (credentialMode === 'per_member' && ownerUserId === null) {
      throw new Error('A personal connector requires an owner');
    }

    const db = getConnection();
    db.prepare(
      `INSERT INTO connectors (id, service, display_name, account_label, credential_mode, owner_user_id, allows_sharing, enabled,
                               transport, command, args_json, url, key_env_var, key_header, key_header_prefix,
                               extra_env_json, auth_mode, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.id,
      input.service.trim(),
      input.displayName.trim(),
      input.accountLabel?.trim() ?? '',
      credentialMode,
      ownerUserId,
      input.allowsSharing === false ? 0 : 1,
      transport,
      transport === 'stdio' ? (input.command as string).trim() : null,
      JSON.stringify(Array.isArray(input.args) ? input.args : []),
      transport === 'http' ? (input.url as string).trim() : null,
      input.keyEnvVar?.trim() || null,
      input.keyHeader?.trim() || null,
      input.keyHeaderPrefix ?? '',
      JSON.stringify(input.extraEnv ?? {}),
      input.authMode === 'oauth' ? 'oauth' : 'key',
      input.createdBy ?? null
    );

    const created = this.get(input.id);
    if (!created) {
      // Unreachable in practice; a throw here beats returning a lie.
      throw new Error(`Connector ${input.id} vanished immediately after insert`);
    }
    return created;
  },

  /**
   * Enables or disables a connector without deleting it, so an operator can stop
   * distribution while keeping the row (and the stored key) intact.
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        `UPDATE connectors
         SET enabled = ?, source_revision = source_revision + 2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND source_revision % 2 = 0
           AND source_revision <= 9007199254740989`
      )
      .run(enabled ? 1 : 0, id);
    return result.changes > 0;
  },

  /**
   * Moves the row between personal and team-shared.
   *
   * `owner_user_id` moves with it and is not optional bookkeeping: a shared
   * connector belongs to nobody in particular, and leaving a stale owner on it
   * would make the personal-scope reads (which key `owner_user_id`) find a row
   * that no longer answers to them.
   */
  setCredentialMode(id: string, mode: 'per_member' | 'org_shared', ownerUserId?: number | null): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        `UPDATE connectors
            SET credential_mode = ?,
                owner_user_id = CASE WHEN ? = 'org_shared' THEN NULL ELSE COALESCE(?, owner_user_id) END,
                source_revision = source_revision + 2,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND source_revision % 2 = 0
            AND source_revision <= 9007199254740989`,
      )
      .run(mode, mode, ownerUserId ?? null, id);
    return result.changes > 0;
  },

  /** Replaces the non-secret startup values a server needs beside its key. */
  setExtraEnv(id: string, extraEnv: Record<string, string>): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        `UPDATE connectors
         SET extra_env_json = ?, source_revision = source_revision + 2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND source_revision % 2 = 0
           AND source_revision <= 9007199254740989`,
      )
      .run(JSON.stringify(extraEnv ?? {}), id);
    return result.changes > 0;
  },

  rename(id: string, displayName: string): boolean {
    if (typeof displayName !== 'string' || displayName.trim() === '') {
      throw new Error('Connector displayName must be a non-empty string');
    }
    const db = getConnection();
    const result = db
      .prepare(
        `UPDATE connectors
         SET display_name = ?, source_revision = source_revision + 2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND source_revision % 2 = 0
           AND source_revision <= 9007199254740989`
      )
      .run(displayName.trim(), id);
    return result.changes > 0;
  },

  /**
   * Opens a serialized credential/grant promotion. The returned odd revision is
   * the only token accepted by `finishSourceMutation`; a crash deliberately
   * leaves the row odd so reconciliation fails closed.
   */
  beginSourceMutation(id: string, expectedEvenRevision?: number): number | null {
    if (
      expectedEvenRevision !== undefined
      && (!Number.isSafeInteger(expectedEvenRevision) || expectedEvenRevision < 0
        || expectedEvenRevision % 2 !== 0)
    ) throw new Error('connector_source_revision_invalid');
    const db = getConnection();
    const row = db.prepare(
      `UPDATE connectors
       SET source_revision = source_revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND source_revision % 2 = 0
         AND source_revision <= 9007199254740988
         AND (? IS NULL OR source_revision = ?)
       RETURNING source_revision`,
    ).get(id, expectedEvenRevision ?? null, expectedEvenRevision ?? null) as
      | { source_revision: number }
      | undefined;
    return row?.source_revision ?? null;
  },

  /** Closes exactly the odd mutation token and returns the next stable revision. */
  finishSourceMutation(id: string, oddRevision: number): number | null {
    if (!Number.isSafeInteger(oddRevision) || oddRevision < 1 || oddRevision % 2 !== 1) {
      throw new Error('connector_source_revision_invalid');
    }
    const db = getConnection();
    const row = db.prepare(
      `UPDATE connectors
       SET source_revision = source_revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND source_revision = ? AND source_revision % 2 = 1
         AND source_revision <= 9007199254740990
       RETURNING source_revision`,
    ).get(id, oddRevision) as { source_revision: number } | undefined;
    return row?.source_revision ?? null;
  },

  /** Releases a start-only claim without claiming that connector material changed. */
  releaseSourceMutationUnchanged(id: string, oddRevision: number): number | null {
    if (!Number.isSafeInteger(oddRevision) || oddRevision < 1 || oddRevision % 2 !== 1) {
      throw new Error('connector_source_revision_invalid');
    }
    const priorEvenRevision = oddRevision - 1;
    const row = getConnection().prepare(
      `UPDATE connectors
       SET source_revision = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND source_revision = ? AND source_revision % 2 = 1
       RETURNING source_revision`,
    ).get(priorEvenRevision, id, oddRevision) as { source_revision: number } | undefined;
    return row?.source_revision ?? null;
  },

  /**
   * Removes the registry row. Idempotent.
   *
   * Deleting the row does NOT delete the stored secret or the copies already
   * distributed into member trees — those are filesystem effects the caller must
   * undo explicitly (T-1227/T-1229). Doing it here would hide a filesystem
   * mutation behind a SQL delete; the honest boundary is that this repository
   * owns the table and nothing else.
   */
  remove(id: string): boolean {
    const db = getConnection();
    const result = db.prepare('DELETE FROM connectors WHERE id = ?').run(id);
    return result.changes > 0;
  },

  /** Deletes only a newborn row still held by this request's exact odd claim. */
  removeExactClaimedNewbornPersonalOAuth(
    id: string,
    ownerUserId: number,
    oddRevision: number,
    expectedPriorEvenRevision: number,
  ): boolean {
    if (!Number.isSafeInteger(oddRevision) || oddRevision < 1 || oddRevision % 2 !== 1
      || expectedPriorEvenRevision !== 0 || oddRevision !== expectedPriorEvenRevision + 1) {
      return false;
    }
    const result = getConnection().prepare(
      `DELETE FROM connectors
       WHERE id = ? AND owner_user_id = ? AND credential_mode = 'per_member'
         AND auth_mode = 'oauth' AND source_revision = ?`,
    ).run(id, ownerUserId, oddRevision);
    return result.changes > 0;
  },
};
