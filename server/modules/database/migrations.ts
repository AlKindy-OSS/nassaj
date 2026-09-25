import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';

import { migratePermissionExecution } from '@/modules/database/permission-execution.migration.js';
import { createUsageStatisticsV3Fresh } from '@/modules/database/usage-statistics-v3.migration.js';
import {
  API_KEY_DIGEST_PATTERN,
  API_KEY_PREFIX_LENGTH,
  API_KEY_PREFIX_PATTERN,
  digestApiKey,
} from '@/modules/database/api-key-digest.js';
import {
  decryptCredentialValue,
  encryptCredentialValue,
  isEncryptedCredentialValue,
} from '@/modules/database/database-credential-crypto.js';
import {
  APP_CONFIG_TABLE_SCHEMA_SQL,
  AUDIT_LOG_TABLE_SCHEMA_SQL,
  CLOSED_SESSIONS_TABLE_SCHEMA_SQL,
  CONNECTOR_PLACEMENTS_TABLE_SCHEMA_SQL,
  CONNECTOR_OAUTH_PENDING_TABLE_SCHEMA_SQL,
  CONNECTORS_TABLE_SCHEMA_SQL,
  GOVERNANCE_EXEMPTIONS_TABLE_SCHEMA_SQL,
  PROVIDER_CREDENTIAL_GRANTS_TABLE_SCHEMA_SQL,
  INVITES_TABLE_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  MESSAGE_AUTHORS_TABLE_SCHEMA_SQL,
  MESSAGE_COORDINATION_TABLE_SCHEMA_SQL,
  TURN_SUPERVISOR_TABLES_SCHEMA_SQL,
  PENDING_SERVER_ACTIONS_TABLE_SCHEMA_SQL,
  SOURCE_UPDATE_TABLES_SCHEMA_SQL,
  PROJECT_COST_DAILY_TABLE_SCHEMA_SQL,
  PROJECT_COST_SOURCES_TABLE_SCHEMA_SQL,
  CONVERSATION_USAGE_SNAPSHOTS_TABLE_SCHEMA_SQL,
  PROJECT_MEMBERS_TABLE_SCHEMA_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  RESPONSE_TURN_METRICS_TABLE_SCHEMA_SQL,
  TURN_RESOURCE_LEASES_TABLE_SCHEMA_SQL,
  PROVIDER_RUN_FAILURES_TABLE_SCHEMA_SQL,
  SESSION_OUTCOME_READS_TABLE_SCHEMA_SQL,
  SESSION_RUN_OUTCOMES_TABLE_SCHEMA_SQL,
  SESSION_TOMBSTONES_TABLE_SCHEMA_SQL,
  SCHEDULED_MESSAGES_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  SESSION_AGENTS_CACHE_TABLE_SCHEMA_SQL,
  SESSION_AGENTS_META_TABLE_SCHEMA_SQL,
  SESSION_PARTICIPANTS_TABLE_SCHEMA_SQL,
  INTERNAL_SESSION_CHAT_SCHEMA_SQL,
  SESSION_WORKSPACE_MODES_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  STARRED_SESSIONS_TABLE_SCHEMA_SQL,
  USER_IDENTITIES_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
  USAGE_BACKFILL_GENERATIONS_TABLE_SCHEMA_SQL,
  USAGE_DURATION_EVENTS_TABLE_SCHEMA_SQL,
  USAGE_REQUEST_EVENTS_TABLE_SCHEMA_SQL,
  USAGE_REQUEST_OCCURRENCES_TABLE_SCHEMA_SQL,
  USAGE_SOURCE_CHECKPOINTS_TABLE_SCHEMA_SQL,
  USAGE_SOURCE_LINKS_TABLE_SCHEMA_SQL,
  WEBAUTHN_CREDENTIALS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';
import {
  isInternalSessionChatFlagOn,
  setInternalSessionChatSchemaBlocked,
} from '@/modules/database/internal-session-chat-flag.js';

import { migrateLocalModelServers } from './local-model-servers.migration.js';

/** Additive durable queue for scheduled conversation messages. */
export const migrateScheduledMessages = (db: Database): void => {
  // The column probe and ALTER must share one immediate transaction. Two
  // admitted processes can otherwise both observe the legacy shape, and the
  // loser raises a duplicate-column error after the winner commits.
  db.transaction(() => {
    db.exec(SCHEDULED_MESSAGES_TABLE_SCHEMA_SQL);
    const columns = getTableInfo(db, 'scheduled_messages').map((column) => column.name);
    if (!columns.includes('available_at')) {
      db.exec('ALTER TABLE scheduled_messages ADD COLUMN available_at TEXT');
      db.exec('UPDATE scheduled_messages SET available_at = scheduled_for WHERE available_at IS NULL');
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_messages_user_status
      ON scheduled_messages(user_id, status, scheduled_for DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
      ON scheduled_messages(status, available_at, lease_expires_at)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_messages_lease_token
      ON scheduled_messages(lease_token) WHERE lease_token IS NOT NULL`);
  }).immediate();
};

/** ADR-187 tables in safe drop order (children first). */
export const INTERNAL_SESSION_CHAT_TABLES = Object.freeze([
  'session_internal_message_mentions',
  'session_internal_messages',
  'session_internal_room_members',
  'session_internal_rooms',
] as const);

/** User-reference columns that must be nullable `ON DELETE SET NULL` (never RESTRICT). */
const INTERNAL_SESSION_CHAT_ACTOR_COLUMNS = Object.freeze([
  ['session_internal_rooms', 'created_by'],
  ['session_internal_room_members', 'added_by'],
  ['session_internal_messages', 'author_user_id'],
] as const);

/** True when an existing table carries the pre-integration draft shape (NOT NULL/RESTRICT actor FK). */
const hasLegacyInternalChatShape = (db: Database): boolean =>
  INTERNAL_SESSION_CHAT_ACTOR_COLUMNS.some(([table, column]) => {
    if (!tableExists(db, table)) return false;
    const fk = db.prepare('SELECT on_delete AS onDelete FROM pragma_foreign_key_list(?) WHERE "from" = ?')
      .get(table, column) as { onDelete: string } | undefined;
    const info = db.prepare('SELECT "notnull" AS required FROM pragma_table_info(?) WHERE name = ?')
      .get(table, column) as { required: number } | undefined;
    return !info || info.required === 1 || fk?.onDelete !== 'SET NULL';
  });

/**
 * Replaces a legacy-shaped chat schema ONLY when every chat table is empty.
 * Returns false (and changes nothing) when any table holds a row: the caller
 * then keeps the feature disabled instead of crashing server boot.
 */
const replaceEmptyLegacyInternalChatSchema = (db: Database): boolean => {
  const present = INTERNAL_SESSION_CHAT_TABLES.filter((table) => tableExists(db, table));
  const populated = present.filter((table) => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
  if (populated.length > 0) {
    console.error('INTERNAL_CHAT_LEGACY_SCHEMA_NOT_EMPTY: internal session chat stays disabled', {
      tables: populated,
    });
    return false;
  }
  console.log('Running migration: Replacing empty legacy-shaped internal session chat tables');
  for (const table of present) db.exec(`DROP TABLE ${table}`);
  return true;
};

/**
 * ADR-187 schema, created ONLY while NASSAJ_INTERNAL_SESSION_CHAT_ENABLED=1 so a
 * rollback to a binary that does not classify these tables keeps working until
 * the flag is first enabled. Additive (CREATE ... IF NOT EXISTS), idempotent, no
 * backfill; FKs reference sessions and users, so it runs after both. A populated
 * legacy-shaped schema is left untouched and blocks the feature for this process.
 */
export const migrateInternalSessionChat = (db: Database, env: NodeJS.ProcessEnv = process.env): void => {
  setInternalSessionChatSchemaBlocked(false);
  if (!isInternalSessionChatFlagOn(env)) return;
  db.transaction(() => {
    if (hasLegacyInternalChatShape(db) && !replaceEmptyLegacyInternalChatSchema(db)) {
      setInternalSessionChatSchemaBlocked(true);
      return;
    }
    db.exec(INTERNAL_SESSION_CHAT_SCHEMA_SQL);
  }).immediate();
};

const SESSION_WORKSPACE_MODES_SNAPSHOT_MARKER = 'migration.session_workspace_modes.snapshot.v1';

/**
 * Atomically classifies only the sessions present at the first overlay-aware
 * boot. The marker and snapshot share a transaction, so a crash cannot turn a
 * partial copy into the permanent cutover boundary. Re-runs never classify
 * sessions created after that boundary; a fresh database records an empty
 * snapshot and stays empty until overlays are explicitly bound.
 */
export const migrateSessionWorkspaceModes = (db: Database): void => {
  db.transaction(() => {
    db.exec(SESSION_WORKSPACE_MODES_TABLE_SCHEMA_SQL);
    // Early development builds created this ledger as a child of sessions.
    // That is invalid for the live bind order: providers can emit their durable
    // id before the transcript synchronizer inserts the sessions row. Repair
    // that shape transactionally and keep the cutover ledger independently
    // durable across indexing lag or later transcript cleanup.
    const legacyForeignKeys = db.prepare(
      'PRAGMA foreign_key_list(session_workspace_modes)',
    ).all() as Array<Record<string, unknown>>;
    if (legacyForeignKeys.length > 0) {
      db.exec('ALTER TABLE session_workspace_modes RENAME TO session_workspace_modes__legacy_fk');
      db.exec(SESSION_WORKSPACE_MODES_TABLE_SCHEMA_SQL);
      db.exec(`
        INSERT INTO session_workspace_modes
          (session_id, mode, project_path, provider, classified_at)
        SELECT session_id, mode, project_path, provider, classified_at
        FROM session_workspace_modes__legacy_fk
      `);
      db.exec('DROP TABLE session_workspace_modes__legacy_fk');
    }
    const marked = db.prepare('SELECT 1 FROM app_config WHERE key = ?').get(
      SESSION_WORKSPACE_MODES_SNAPSHOT_MARKER,
    );
    if (marked) return;
    db.prepare(`
      INSERT INTO session_workspace_modes
        (session_id, mode, project_path, provider, classified_at)
      SELECT s.session_id, 'legacy_shared', s.project_path, s.provider, CURRENT_TIMESTAMP
      FROM sessions s
      JOIN projects p ON p.project_path = s.project_path
      WHERE s.project_path IS NOT NULL AND trim(s.project_path) <> ''
      ON CONFLICT(session_id) DO NOTHING
    `).run();
    db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)').run(
      SESSION_WORKSPACE_MODES_SNAPSHOT_MARKER,
      'complete',
    );
  })();
};

const SQLITE_UUID_SQL = `
lower(hex(randomblob(4))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(6)))
`;

type TableInfoRow = {
  name: string;
  pk: number;
};

const addColumnToTableIfNotExists = (
  db: Database,
  tableName: string,
  columnNames: string[],
  columnName: string,
  columnType: string
) => {
  if (!columnNames.includes(columnName)) {
    console.log(`Running migration: Adding ${columnName} column to ${tableName} table`);
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
};

const tableExists = (db: Database, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );

const getTableInfo = (db: Database, tableName: string): TableInfoRow[] =>
  db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];

const EXTERNAL_API_ENABLED_KEY = 'external_api.enabled';

type LegacyApiKeyRow = {
  id: number;
  user_id: number;
  key_name: string;
  api_key: string;
  created_at: string | null;
  last_used: string | null;
  is_active: number;
};

/**
 * Replaces recoverable API-key plaintext with a tagged SHA-256 digest.
 *
 * The whole table rebuild is one SQLite transaction. Any malformed legacy row,
 * schema drift, or write failure rolls the rebuild back and persists the
 * programmatic-access master switch as OFF before startup is rejected.
 */
export const migrateApiKeysToDigests = (db: Database): void => {
  if (!tableExists(db, 'api_keys')) return;

  const disableExternalApi = (): void => {
    db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
    db.prepare(
      `INSERT INTO app_config (key, value) VALUES (?, '0')
       ON CONFLICT(key) DO UPDATE SET value = '0'`
    ).run(EXTERNAL_API_ENABLED_KEY);
  };

  try {
    const columns = getTableInfo(db, 'api_keys').map((column) => column.name);
    const hasDigestSchema = columns.includes('key_digest') && columns.includes('key_prefix');
    const hasLegacyPlaintext = columns.includes('api_key');
    const hasPartialDigestSchema = columns.includes('key_digest') || columns.includes('key_prefix');
    if ((hasDigestSchema && hasLegacyPlaintext) || (hasPartialDigestSchema && !hasDigestSchema)) {
      throw new Error('api_key_storage_schema_mixed_or_partial');
    }
    if (hasDigestSchema) {
      const rows = db
        .prepare('SELECT key_digest, key_prefix FROM api_keys')
        .all() as Array<{ key_digest: string; key_prefix: string }>;
      if (rows.some((row) =>
        !API_KEY_DIGEST_PATTERN.test(row.key_digest)
        || !API_KEY_PREFIX_PATTERN.test(row.key_prefix)
      )) {
        throw new Error('api_key_digest_schema_contains_malformed_rows');
      }
      db.exec('DROP INDEX IF EXISTS idx_api_keys_key');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_digest ON api_keys(key_digest)');
      return;
    }

    if (!hasLegacyPlaintext) {
      throw new Error('api_key_storage_schema_unrecognized');
    }

    const legacyRows = db
      .prepare(
        `SELECT id, user_id, key_name, api_key, created_at, last_used, is_active
         FROM api_keys ORDER BY id`
      )
      .all() as LegacyApiKeyRow[];

    // Deliberately no pre-rebuild snapshot here: such a snapshot would preserve
    // the bearer secret this migration exists to remove. The SQLite transaction
    // is the rollback boundary for this one-time secret conversion.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE api_keys__digest_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          key_name TEXT NOT NULL,
          key_digest TEXT UNIQUE NOT NULL,
          key_prefix TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_used DATETIME,
          is_active BOOLEAN DEFAULT 1,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      const insert = db.prepare(
        `INSERT INTO api_keys__digest_new
           (id, user_id, key_name, key_digest, key_prefix, created_at, last_used, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const row of legacyRows) {
        const digest = digestApiKey(row.api_key);
        if (!digest) throw new Error(`api_key_plaintext_malformed:${row.id}`);
        insert.run(
          row.id,
          row.user_id,
          row.key_name,
          digest,
          row.api_key.slice(0, API_KEY_PREFIX_LENGTH),
          row.created_at,
          row.last_used,
          row.is_active
        );
      }
      db.exec('DROP TABLE api_keys');
      db.exec('ALTER TABLE api_keys__digest_new RENAME TO api_keys');
      db.exec('DROP INDEX IF EXISTS idx_api_keys_key');
      db.exec('CREATE UNIQUE INDEX idx_api_keys_digest ON api_keys(key_digest)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active)');
    })();
  } catch (error) {
    try {
      disableExternalApi();
    } catch {
      // Startup still fails below; never mask the migration failure.
    }
    throw error;
  }
};

type StoredCredentialRow = {
  id: number;
  user_id: number;
  credential_type: string;
  credential_value: string;
};

/**
 * Encrypts every generic credential atomically before repositories become
 * available. Existing envelopes are authenticated on every boot, so a missing
 * key, wrong key, moved row, changed type, or tampered tag aborts startup.
 */
export const migrateUserCredentialsEncryption = (db: Database): void => {
  if (!tableExists(db, 'user_credentials')) return;
  const rows = db
    .prepare('SELECT id, user_id, credential_type, credential_value FROM user_credentials ORDER BY id')
    .all() as StoredCredentialRow[];
  if (rows.length === 0) return;

  db.transaction(() => {
    const update = db.prepare('UPDATE user_credentials SET credential_value = ? WHERE id = ?');
    for (const row of rows) {
      const aad = {
        id: row.id,
        userId: row.user_id,
        credentialType: row.credential_type,
      };
      if (isEncryptedCredentialValue(row.credential_value)) {
        decryptCredentialValue(row.credential_value, aad);
        continue;
      }
      const encrypted = encryptCredentialValue(row.credential_value, aad);
      const result = update.run(encrypted, row.id);
      if (result.changes !== 1) throw new Error('credential_encryption_update_lost');
    }
  })();
};

// ---------------------------------------------------------------------------
// Rebuild safety net: backup, integrity check, quarantine
// ---------------------------------------------------------------------------

/** Sub-directory (next to the database file) holding pre-rebuild snapshots. */
const MIGRATION_BACKUP_DIR_NAME = 'migration-backups';
const MIGRATION_BACKUP_RETENTION = 5;
const MIGRATION_BACKUP_LABELS = new Set([
  'legacy-session-names',
  'rebuild-projects',
  'rebuild-sessions',
  'connectors-unique-scope',
  'session-agents-cascade',
  'legacy-workspace-original-paths',
  'rebuild-source-update-deferral',
]);
let migrationBackupSequence = 0;

type MigrationBackupDependencies = {
  vacuumInto?: (db: Database, target: string) => void;
  verifyIntegrity?: (target: string) => boolean;
  fsyncFile?: (target: string) => void;
  now?: () => Date;
  expectedUid?: number;
};

const fsyncPath = (target: string): void => {
  const descriptor = fs.openSync(target, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const verifyBackupIntegrity = (target: string): boolean => {
  const snapshot = new BetterSqlite3(target, { readonly: true, fileMustExist: true });
  try {
    return String(snapshot.pragma('integrity_check', { simple: true })) === 'ok';
  } finally {
    snapshot.close();
  }
};

const assertContainedPath = (root: string, target: string): void => {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('migration_backup_path_outside_root');
  }
};

const assertSecureBackupDirectory = (directory: string, parent: string, expectedUid: number): void => {
  const stat = fs.lstatSync(directory);
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.uid !== expectedUid
    || (stat.mode & 0o777) !== 0o700
    || stat.nlink < 2
  ) {
    throw new Error('migration_backup_directory_insecure');
  }
  const resolved = fs.realpathSync(directory);
  assertContainedPath(parent, resolved);
  if (resolved !== directory) throw new Error('migration_backup_directory_changed');
};

const assertSecureBackupFile = (target: string, directory: string, expectedUid: number): void => {
  const stat = fs.lstatSync(target);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.uid !== expectedUid
    || stat.nlink !== 1
    || (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error('migration_backup_file_insecure');
  }
  const resolved = fs.realpathSync(target);
  assertContainedPath(directory, resolved);
  if (resolved !== target) throw new Error('migration_backup_file_changed');
};

const pruneMigrationBackups = (directory: string, preserve: string, expectedUid: number): void => {
  const candidates = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.sqlite') && name.includes('-pre-'))
    .map((name) => path.join(directory, name))
    .filter((candidate) => {
      assertSecureBackupFile(candidate, directory, expectedUid);
      return true;
    })
    .sort((left, right) => {
      if (left === preserve) return 1;
      if (right === preserve) return -1;
      return fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs;
    });
  while (candidates.length > MIGRATION_BACKUP_RETENTION) {
    const oldest = candidates.shift();
    if (oldest && oldest !== preserve) fs.unlinkSync(oldest);
  }
  fsyncPath(directory);
};

/**
 * Takes a consistent snapshot of the whole database before a destructive
 * migration branch (any DROP/RENAME table rebuild).
 *
 * `VACUUM INTO` is used rather than a file copy for one decisive reason: in WAL
 * mode a committed transaction lives in the `-wal` sidecar until it is
 * checkpointed, so copying the main database file alone loses every commit
 * still in the log. VACUUM INTO goes through SQLite, sees
 * the fully merged state, and writes a single self-contained file with no
 * sidecars to keep together.
 *
 * The directory is owner-only before creation and SQLite creates the file under
 * a synchronous 0077 umask, so there is no world-readable chmod window. The
 * snapshot is fsynced, reopened read-only for integrity_check, and only then
 * counted as the newest known-good backup. Retention is bounded to five and is
 * pruned only after that verification, preserving the last known-good file when
 * a later attempt fails.
 *
 * Failure is fatal for persistent databases: every caller invokes this before
 * its first destructive statement, so a disk/permission/integrity failure stops
 * the migration while the source schema is untouched.
 */
export const backupDatabaseBeforeRebuild = (
  db: Database,
  label: string,
  dependencies: MigrationBackupDependencies = {},
): string | null => {
  const sourcePath = db.name;
  if (!sourcePath || sourcePath === ':memory:') {
    return null;
  }
  if (!MIGRATION_BACKUP_LABELS.has(label)) {
    throw new Error('migration_backup_label_invalid');
  }

  const resolvedExpectedUid = dependencies.expectedUid ?? (process.geteuid?.() ?? process.getuid?.());
  if (typeof resolvedExpectedUid !== 'number' || !Number.isInteger(resolvedExpectedUid)) {
    throw new Error('migration_backup_owner_unavailable');
  }
  const expectedUid = resolvedExpectedUid;
  const sourceDirectory = fs.realpathSync(path.dirname(path.resolve(sourcePath)));
  const directory = path.join(sourceDirectory, MIGRATION_BACKUP_DIR_NAME);
  let target: string | null = null;
  try {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
    assertSecureBackupDirectory(directory, sourceDirectory, expectedUid);

    const stamp = (dependencies.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    migrationBackupSequence += 1;
    const random = crypto.randomBytes(8).toString('hex');
    target = path.join(directory, `${stamp}-${process.pid}-${migrationBackupSequence}-${random}-pre-${label}.sqlite`);

    const previousUmask = process.umask(0o077);
    try {
      (dependencies.vacuumInto ?? ((database, destination) => {
        database.prepare('VACUUM INTO ?').run(destination);
      }))(db, target);
    } finally {
      process.umask(previousUmask);
    }

    assertSecureBackupFile(target, directory, expectedUid);
    (dependencies.fsyncFile ?? fsyncPath)(target);
    if (!(dependencies.verifyIntegrity ?? verifyBackupIntegrity)(target)) {
      throw new Error('migration_backup_integrity_failed');
    }
    fsyncPath(directory);
    pruneMigrationBackups(directory, target, expectedUid);

    console.log('Created pre-migration database snapshot', { label, target });
    return target;
  } catch (err: any) {
    if (target) {
      try {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        if (fs.existsSync(directory)) fsyncPath(directory);
      } catch {
        // Preserve the primary backup failure below.
      }
    }
    console.error('Could not create required pre-migration database snapshot', {
      label,
      error: err?.message ?? String(err),
    });
    throw new Error('migration_backup_required', { cause: err });
  }
};

type ForeignKeyViolationRow = {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
};

const readForeignKeyViolations = (db: Database): ForeignKeyViolationRow[] =>
  db.pragma('foreign_key_check') as ForeignKeyViolationRow[];

/** Collapses violation rows into a `child -> parent` => count map. */
const summarizeForeignKeyViolations = (
  rows: ForeignKeyViolationRow[]
): Record<string, number> => {
  const summary: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.table} -> ${row.parent}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
};

/**
 * Verifies that a table rebuild did not orphan its dependants.
 *
 * The rebuild pattern used below (`PRAGMA foreign_keys = OFF` + DROP + RENAME)
 * deliberately suspends enforcement, so every row that referenced a discarded
 * or re-keyed parent row survives as a dangling reference that SQLite will
 * never report on its own. This is exactly how `session_participants` ended up
 * with rows pointing at sessions that no longer exist — and because
 * `isParticipant()` is the authorization gate for session content, a later
 * re-creation of a session with the same id silently resurrects a stale
 * ownership claim. So every rebuild is now checked.
 *
 * Throws when the rebuild INTRODUCED violations (the failure this guards
 * against). Violations that already existed before the rebuild are reported at
 * error level but do not throw: they are pre-existing damage handled by
 * pruneOrphanSessionRefs, and failing the boot of an upgrading install over
 * them would turn old data damage into an outage.
 */
const assertRebuildPreservedIntegrity = (
  db: Database,
  label: string,
  before: Record<string, number>
): void => {
  const after = summarizeForeignKeyViolations(readForeignKeyViolations(db));
  const afterKeys = Object.keys(after);

  if (afterKeys.length > 0) {
    console.error('Foreign key violations present after migration rebuild', {
      migration: label,
      before,
      after,
    });
  }

  const introduced: Record<string, number> = {};
  for (const key of afterKeys) {
    const delta = after[key] - (before[key] ?? 0);
    if (delta > 0) {
      introduced[key] = delta;
    }
  }

  if (Object.keys(introduced).length > 0) {
    throw new Error(
      `Migration "${label}" introduced foreign key violations: ${JSON.stringify(introduced)}`
    );
  }

  if (afterKeys.length === 0) {
    console.log('Foreign key integrity verified after migration rebuild', { migration: label });
  }
};

/**
 * Quarantine table for rows a rebuild would otherwise drop on the floor.
 *
 * The rebuilds below silently discard rows (duplicate natural keys, rows with a
 * NULL/empty key) with no record of what disappeared. Deleting user data as a
 * side effect of a schema migration is not acceptable, so those rows are copied
 * here first, serialized as JSON because the legacy source shape varies by
 * install and cannot be mirrored column-for-column.
 *
 * Nothing ever reads or prunes this table automatically — it is a forensic
 * record kept until a human decides what to do with it.
 */
const DISCARDED_ROWS_TABLE_SQL = (tableName: string) => `
CREATE TABLE IF NOT EXISTS ${tableName} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    migration TEXT NOT NULL,
    reason TEXT NOT NULL,
    source_rowid INTEGER,
    row_json TEXT NOT NULL
);
`;

/**
 * Builds a `json_object('col', "col", …)` expression over the given columns so
 * a discarded row can be preserved verbatim regardless of the legacy shape.
 * Identifiers come from PRAGMA table_info (never from user input) and are still
 * quoted defensively.
 */
const buildRowJsonExpression = (columnNames: string[]): string => {
  if (columnNames.length === 0) {
    return `json_object()`;
  }
  const pairs = columnNames.map((name) => {
    const key = `'${name.replace(/'/g, "''")}'`;
    const identifier = `"${name.replace(/"/g, '""')}"`;
    return `${key}, ${identifier}`;
  });
  return `json_object(${pairs.join(', ')})`;
};

export const migrateLegacySessionNames = (db: Database): void => {
  const hasLegacySessionNamesTable = tableExists(db, 'session_names');
  const hasSessionsTable = tableExists(db, 'sessions');

  if (!hasLegacySessionNamesTable) {
    return;
  }

  backupDatabaseBeforeRebuild(db, 'legacy-session-names');

  if (hasSessionsTable) {
    console.log('Running migration: Merging session_names into sessions');
    db.exec(`
      INSERT INTO sessions (session_id, provider, custom_name, created_at, updated_at)
      SELECT
        session_id,
        COALESCE(provider, 'claude'),
        custom_name,
        COALESCE(created_at, CURRENT_TIMESTAMP),
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM session_names
      WHERE true
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
        created_at = COALESCE(sessions.created_at, excluded.created_at),
        updated_at = COALESCE(excluded.updated_at, sessions.updated_at)
    `);
    db.exec('DROP TABLE session_names');
    return;
  }

  console.log('Running migration: Renaming session_names table to sessions');
  db.exec('ALTER TABLE session_names RENAME TO sessions');
};

const migrateLegacyWorkspaceTableIntoProjects = (db: Database): void => {
  db.exec(PROJECTS_TABLE_SCHEMA_SQL);

  if (!tableExists(db, 'workspace_original_paths')) {
    return;
  }

  console.log('Running migration: Migrating workspace_original_paths data into projects');
  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      CASE
        WHEN workspace_id IS NULL OR trim(workspace_id) = ''
        THEN ${SQLITE_UUID_SQL}
        ELSE workspace_id
      END,
      workspace_path,
      custom_workspace_name,
      COALESCE(isStarred, 0),
      0
    FROM workspace_original_paths
    WHERE workspace_path IS NOT NULL AND trim(workspace_path) <> ''
    ON CONFLICT(project_path) DO UPDATE SET
      custom_project_name = COALESCE(projects.custom_project_name, excluded.custom_project_name),
      isStarred = COALESCE(projects.isStarred, excluded.isStarred)
  `);
};

const rebuildProjectsTableWithPrimaryKeySchema = (db: Database): void => {
  const hasProjectsTable = tableExists(db, 'projects');
  if (!hasProjectsTable) {
    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    return;
  }

  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);
  const hasProjectIdPrimaryKey = projectsTableInfo.some(
    (column) => column.name === 'project_id' && column.pk === 1,
  );

  if (hasProjectIdPrimaryKey) {
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'custom_project_name', 'TEXT DEFAULT NULL');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isStarred', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'visibility', "TEXT NOT NULL DEFAULT 'public'");
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'created_by', 'INTEGER');
    db.exec(`
      UPDATE projects
      SET project_id = ${SQLITE_UUID_SQL}
      WHERE project_id IS NULL OR trim(project_id) = ''
    `);
    return;
  }

  console.log('Running migration: Rebuilding projects table to enforce project_id primary key');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const customProjectNameExpression = columnNames.includes('custom_project_name')
    ? 'custom_project_name'
    : columnNames.includes('custom_workspace_name')
      ? 'custom_workspace_name'
      : 'NULL';

  const isStarredExpression = columnNames.includes('isStarred') ? 'COALESCE(isStarred, 0)' : '0';

  const isArchivedExpression = columnNames.includes('isArchived') ? 'COALESCE(isArchived, 0)' : '0';

  const visibilityExpression = columnNames.includes('visibility')
    ? "COALESCE(visibility, 'public')"
    : "'public'";

  const createdByExpression = columnNames.includes('created_by') ? 'created_by' : 'NULL';

  const projectIdExpression = columnNames.includes('project_id')
    ? `CASE
         WHEN project_id IS NULL OR trim(project_id) = ''
         THEN ${SQLITE_UUID_SQL}
         ELSE project_id
       END`
    : SQLITE_UUID_SQL;

  // A snapshot BEFORE the destructive branch: this is the only way back if the
  // rebuild goes wrong, and it must be taken outside the transaction.
  backupDatabaseBeforeRebuild(db, 'rebuild-projects');
  const violationsBeforeRebuild = summarizeForeignKeyViolations(readForeignKeyViolations(db));

  // Shared by the quarantine pass and the copy pass so the two can never drift
  // apart on what counts as a discarded row.
  const sourceRowsCte = `
      source_rows AS (
        SELECT
          ${projectPathExpression} AS project_path,
          ${customProjectNameExpression} AS custom_project_name,
          ${isStarredExpression} AS isStarred,
          ${isArchivedExpression} AS isArchived,
          ${visibilityExpression} AS visibility,
          ${createdByExpression} AS created_by,
          ${projectIdExpression} AS candidate_project_id,
          rowid AS source_rowid
        FROM projects
        WHERE ${projectPathExpression} IS NOT NULL AND trim(${projectPathExpression}) <> ''
      ),
      deduped_paths AS (
        SELECT
          project_path,
          custom_project_name,
          isStarred,
          isArchived,
          visibility,
          created_by,
          candidate_project_id,
          source_rowid,
          ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY source_rowid) AS project_path_rank
        FROM source_rows
      )`;

  const rowJsonExpression = buildRowJsonExpression(columnNames);

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS projects__new');
    db.exec(`
      CREATE TABLE projects__new (
        project_id TEXT PRIMARY KEY NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        detected_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0,
        visibility TEXT NOT NULL DEFAULT 'public',
        created_by INTEGER,
        dir_exists INTEGER,
        dir_checked_at TEXT
      )
    `);

    // Preserve every row the copy below will NOT carry over, before the source
    // table is dropped: rows without a usable path, and all but the first row
    // of each duplicated path.
    db.exec(DISCARDED_ROWS_TABLE_SQL('_discarded_projects'));
    db.exec(`
      INSERT INTO _discarded_projects (migration, reason, source_rowid, row_json)
      SELECT
        'rebuildProjectsTableWithPrimaryKeySchema',
        'missing_project_path',
        rowid,
        ${rowJsonExpression}
      FROM projects
      WHERE NOT (${projectPathExpression} IS NOT NULL AND trim(${projectPathExpression}) <> '')
    `);
    db.exec(`
      WITH ${sourceRowsCte}
      INSERT INTO _discarded_projects (migration, reason, source_rowid, row_json)
      SELECT
        'rebuildProjectsTableWithPrimaryKeySchema',
        'duplicate_project_path',
        projects.rowid,
        ${rowJsonExpression}
      FROM projects
      WHERE projects.rowid IN (
        SELECT source_rowid FROM deduped_paths WHERE project_path_rank > 1
      )
    `);
    const quarantinedProjects = db
      .prepare(
        `SELECT COUNT(*) AS count FROM _discarded_projects
         WHERE migration = 'rebuildProjectsTableWithPrimaryKeySchema'`
      )
      .get() as { count: number };
    if (quarantinedProjects.count > 0) {
      console.log('Quarantined project rows not carried over by the rebuild', {
        table: '_discarded_projects',
        rows: quarantinedProjects.count,
      });
    }

    db.exec(`
      WITH ${sourceRowsCte},
      prepared_rows AS (
        SELECT
          CASE
            WHEN ROW_NUMBER() OVER (PARTITION BY candidate_project_id ORDER BY source_rowid) = 1
            THEN candidate_project_id
            ELSE ${SQLITE_UUID_SQL}
          END AS project_id,
          project_path,
          custom_project_name,
          isStarred,
          isArchived,
          visibility,
          created_by
        FROM deduped_paths
        WHERE project_path_rank = 1
      )
      INSERT INTO projects__new (
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived,
        visibility,
        created_by
      )
      SELECT
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived,
        visibility,
        created_by
      FROM prepared_rows
    `);
    db.exec('DROP TABLE projects');
    db.exec('ALTER TABLE projects__new RENAME TO projects');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  // The rebuild re-keys projects and can drop rows, so anything referencing a
  // project (project_members, sessions.project_path) may now dangle.
  assertRebuildPreservedIntegrity(db, 'rebuild-projects', violationsBeforeRebuild);
};

const rebuildSessionsTableWithProjectSchema = (db: Database): void => {
  const hasSessions = tableExists(db, 'sessions');
  if (!hasSessions) {
    db.exec(SESSIONS_TABLE_SCHEMA_SQL);
    return;
  }

  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);
  const primaryKeyColumns = sessionsTableInfo
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);

  const shouldRebuild =
    !columnNames.includes('project_path') ||
    primaryKeyColumns.length !== 1 ||
    primaryKeyColumns[0] !== 'session_id' ||
    !columnNames.includes('provider');

  if (!shouldRebuild) {
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'jsonl_path', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'created_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'updated_at', 'DATETIME');
    // ADR-088 (B-258/B-262): server-authoritative engine axis. NULL = UNKNOWN,
    // never "official" — legacy rows are deliberately NOT backfilled here (a
    // batch guess would freeze wrong values; backfill happens lazily at resume
    // with the conservative any-engine-id rule, see engine-pin.js).
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'engine_provider', 'TEXT DEFAULT NULL');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'engine_provider_source', 'TEXT DEFAULT NULL');
    db.exec('UPDATE sessions SET isArchived = COALESCE(isArchived, 0)');
    db.exec('UPDATE sessions SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)');
    db.exec('UPDATE sessions SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)');
    return;
  }

  console.log('Running migration: Rebuilding sessions table to project-based schema');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const providerExpression = columnNames.includes('provider')
    ? "COALESCE(provider, 'claude')"
    : "'claude'";

  const customNameExpression = columnNames.includes('custom_name')
    ? 'custom_name'
    : 'NULL';

  const jsonlPathExpression = columnNames.includes('jsonl_path')
    ? 'jsonl_path'
    : 'NULL';

  const isArchivedExpression = columnNames.includes('isArchived')
    ? 'COALESCE(isArchived, 0)'
    : '0';

  const createdAtExpression = columnNames.includes('created_at')
    ? 'COALESCE(created_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  const updatedAtExpression = columnNames.includes('updated_at')
    ? 'COALESCE(updated_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  // ADR-088: the engine pin must survive a rebuild. Losing it silently would
  // reset every vendor-pinned session to "unknown" — the exact data loss this
  // column exists to end (qa-critic حرج 12).
  const engineProviderExpression = columnNames.includes('engine_provider')
    ? 'engine_provider'
    : 'NULL';
  const engineProviderSourceExpression = columnNames.includes('engine_provider_source')
    ? 'engine_provider_source'
    : 'NULL';

  backupDatabaseBeforeRebuild(db, 'rebuild-sessions');
  const violationsBeforeRebuild = summarizeForeignKeyViolations(readForeignKeyViolations(db));

  const sourceRowsCte = `
      source_rows AS (
        SELECT
          session_id,
          ${providerExpression} AS provider,
          ${customNameExpression} AS custom_name,
          ${projectPathExpression} AS project_path,
          ${jsonlPathExpression} AS jsonl_path,
          ${engineProviderExpression} AS engine_provider,
          ${engineProviderSourceExpression} AS engine_provider_source,
          ${isArchivedExpression} AS isArchived,
          ${createdAtExpression} AS created_at,
          ${updatedAtExpression} AS updated_at,
          rowid AS source_rowid
        FROM sessions
        WHERE session_id IS NOT NULL AND trim(session_id) <> ''
      ),
      ranked_rows AS (
        SELECT
          session_id,
          provider,
          custom_name,
          project_path,
          jsonl_path,
          engine_provider,
          engine_provider_source,
          isArchived,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, source_rowid DESC
          ) AS session_rank,
          -- B-359: must be PROJECTED, not just referenced in the window ORDER BY:
          -- the duplicate-discard CTE below reads source_rowid FROM ranked_rows,
          -- and without this projection the whole rebuild throws "no such column"
          -- on every legacy database that triggers it (broken since f62ff719;
          -- surfaced by the ADR-088 rebuild-preservation test).
          source_rowid
        FROM source_rows
      )`;

  const rowJsonExpression = buildRowJsonExpression(columnNames);

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS sessions__new');
    db.exec(`
      CREATE TABLE sessions__new (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        engine_provider TEXT DEFAULT NULL,
        engine_provider_source TEXT DEFAULT NULL,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id),
        FOREIGN KEY (project_path) REFERENCES projects(project_path)
        ON DELETE SET NULL
        ON UPDATE CASCADE
      )
    `);

    // Same contract as the projects rebuild: rows the copy will not carry over
    // are preserved verbatim instead of vanishing with the dropped table.
    db.exec(DISCARDED_ROWS_TABLE_SQL('_discarded_sessions'));
    db.exec(`
      INSERT INTO _discarded_sessions (migration, reason, source_rowid, row_json)
      SELECT
        'rebuildSessionsTableWithProjectSchema',
        'missing_session_id',
        rowid,
        ${rowJsonExpression}
      FROM sessions
      WHERE NOT (session_id IS NOT NULL AND trim(session_id) <> '')
    `);
    db.exec(`
      WITH ${sourceRowsCte}
      INSERT INTO _discarded_sessions (migration, reason, source_rowid, row_json)
      SELECT
        'rebuildSessionsTableWithProjectSchema',
        'duplicate_session_id',
        sessions.rowid,
        ${rowJsonExpression}
      FROM sessions
      WHERE sessions.rowid IN (
        SELECT source_rowid FROM ranked_rows WHERE session_rank > 1
      )
    `);
    const quarantinedSessions = db
      .prepare(
        `SELECT COUNT(*) AS count FROM _discarded_sessions
         WHERE migration = 'rebuildSessionsTableWithProjectSchema'`
      )
      .get() as { count: number };
    if (quarantinedSessions.count > 0) {
      console.log('Quarantined session rows not carried over by the rebuild', {
        table: '_discarded_sessions',
        rows: quarantinedSessions.count,
      });
    }

    db.exec(`
      WITH ${sourceRowsCte}
      INSERT INTO sessions__new (
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        engine_provider,
        engine_provider_source,
        isArchived,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        engine_provider,
        engine_provider_source,
        isArchived,
        created_at,
        updated_at
      FROM ranked_rows
      WHERE session_rank = 1
    `);
    db.exec('DROP TABLE sessions');
    db.exec('ALTER TABLE sessions__new RENAME TO sessions');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  // Dropping and re-creating `sessions` orphans every dependant that references
  // it — session_participants above all, which is the authorization gate for
  // session content. This is the check that would have caught the 34 orphaned
  // participant rows this database still carries.
  assertRebuildPreservedIntegrity(db, 'rebuild-sessions', violationsBeforeRebuild);
};

const ensureProjectsForSessionPaths = (db: Database): void => {
  if (!tableExists(db, 'sessions')) {
    return;
  }

  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      ${SQLITE_UUID_SQL},
      project_path,
      NULL,
      0,
      0
    FROM sessions
    WHERE project_path IS NOT NULL AND trim(project_path) <> ''
    ON CONFLICT(project_path) DO NOTHING
  `);
};

/**
 * Phase-MU migration: extend `users` with multi-user columns and create the
 * `audit_log` + `invites` tables. Idempotent and non-destructive — existing
 * rows keep their data and gain the new columns with safe defaults. The first
 * pre-existing user (lowest id) is promoted to `owner` so a single-user install
 * upgrading to multi-user does not lose admin access.
 */
const migrateMultiUserAuth = (db: Database, userColumnNames: string[]): void => {
  // SQLite cannot add a column with a non-constant default or a FK inline via
  // ALTER, so invited_by is added as a plain nullable INTEGER (FK enforced on
  // fresh installs via CREATE TABLE; logically references users.id).
  addColumnToTableIfNotExists(db, 'users', userColumnNames, 'role', "TEXT NOT NULL DEFAULT 'user'");
  addColumnToTableIfNotExists(db, 'users', userColumnNames, 'status', "TEXT NOT NULL DEFAULT 'active'");
  addColumnToTableIfNotExists(db, 'users', userColumnNames, 'invited_by', 'INTEGER');

  db.exec(AUDIT_LOG_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)');

  db.exec(INVITES_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_invites_token_hash ON invites(token_hash)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status)');

  db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)');

  // Promote the earliest pre-existing user to owner if no owner exists yet.
  const ownerRow = db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'owner'")
    .get() as { count: number };
  if (ownerRow.count === 0) {
    const firstUser = db
      .prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1')
      .get() as { id: number } | undefined;
    if (firstUser) {
      console.log('Running migration: Promoting first existing user to owner', { userId: firstUser.id });
      db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(firstUser.id);
    }
  }
};

/**
 * Server-action queue (ADR-066, T-944). Creates the pending_server_actions table
 * plus its two indexes (indexes live here, never in INIT_SCHEMA_SQL — see the
 * 502 lesson). Idempotent (IF NOT EXISTS on the table + IF NOT EXISTS on the
 * indexes); no backfill — the queue starts empty and is populated at runtime by
 * a coordinator request. Runs after migrateMultiUserAuth so it sits with the
 * rest of the auth-cluster tables; it has no cross-table FK dependency.
 *
 *   - idx_pending_actions_dedup: a PARTIAL UNIQUE index over
 *     (action_type, IFNULL(session_id,'')) restricted to status='pending'. This
 *     is what makes the coordinator INSERT idempotent (ON CONFLICT DO NOTHING):
 *     a second request for the same action+session while one is still pending is
 *     a no-op, but a failed/executing row does NOT block a fresh pending request.
 *   - idx_pending_actions_status: speeds the status IN (...) listing/count reads.
 */
const migratePendingServerActions = (db: Database): void => {
  db.exec(PENDING_SERVER_ACTIONS_TABLE_SCHEMA_SQL);
  const columns = db.prepare('PRAGMA table_info(pending_server_actions)').all() as { name: string }[];
  if (!columns.some(({ name }) => name === 'expected_server_build_id')) {
    db.exec('ALTER TABLE pending_server_actions ADD COLUMN expected_server_build_id TEXT');
  }
  migratePendingServerActionAttemptNonce(db);
  addColumnToTableIfNotExists(db, 'pending_server_actions', columns.map(({ name }) => name), 'source_update_job_id', 'TEXT');
  addColumnToTableIfNotExists(db, 'pending_server_actions', columns.map(({ name }) => name), 'source_update_transaction_id', 'TEXT');
  addColumnToTableIfNotExists(db, 'pending_server_actions', columns.map(({ name }) => name), 'activation_identity_sha256', 'TEXT');
  addColumnToTableIfNotExists(db, 'pending_server_actions', columns.map(({ name }) => name), 'release_commit', 'TEXT');
  // T-1684: settled_at records WHEN a row reached a terminal state, which is
  // what the one-hour history retention counts from. Rows settled by an earlier
  // build have none, so they are backfilled — otherwise pruneHistory would keep
  // them forever, or (with a NULL-sorts-first ordering) delete them out of turn.
  //
  // The backfill is CURRENT_TIMESTAMP, not COALESCE(executed_at, requested_at):
  // those older timestamps are almost always more than an hour in the past, so
  // dating the rows by them makes the first janitor pass after the upgrade
  // delete every pre-existing terminal row within a minute of boot — the owner
  // upgrades and their recent history is simply gone. Stamping the migration's
  // own clock instead gives every legacy row one full hour of grace from the
  // deploy, after which normal retention takes over. What is lost is precision
  // on rows whose real settle time nobody recorded; audit_log still holds it.
  addColumnToTableIfNotExists(db, 'pending_server_actions', columns.map(({ name }) => name), 'settled_at', 'DATETIME');
  db.exec(
    `UPDATE pending_server_actions
       SET settled_at = CURRENT_TIMESTAMP
     WHERE settled_at IS NULL AND status IN ('succeeded', 'failed', 'superseded')`
  );
  // ADR-129: safe-restart requests bound to different server generations are
  // distinct work. Recreate the old index with the generation in its key;
  // NULL preserves legacy/non-preview dedup semantics.
  db.exec('DROP INDEX IF EXISTS idx_pending_actions_dedup');
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_actions_dedup
       ON pending_server_actions(
         action_type, IFNULL(session_id, ''), IFNULL(expected_server_build_id, '')
       )
       WHERE status = 'pending'`
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_server_actions(status)'
  );
  // listActionable() orders by requested_at; without this index that ordering is
  // a sort over a full scan of the queue.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_pending_actions_requested_at
       ON pending_server_actions(requested_at)`
  );
};

/** Add only the nullable attempt nonce; reject incompatible existing evidence storage. */
export const migratePendingServerActionAttemptNonce = (db: Database): void => {
  const columns = db.prepare('PRAGMA table_xinfo(pending_server_actions)').all() as Array<{
    name: string; type: string; notnull: number; dflt_value: unknown; hidden: number; pk: number;
  }>;
  if (columns.length === 0) throw new Error('pending_server_actions_table_missing');
  const existing = columns.find(column => column.name.toLowerCase() === 'execution_attempt_nonce');
  if (existing) {
    if (existing.type.trim().toUpperCase() !== 'TEXT' || existing.notnull !== 0
      || existing.dflt_value !== null || existing.hidden !== 0 || existing.pk !== 0) {
      throw new Error('pending_server_actions_attempt_nonce_schema_incompatible');
    }
    return;
  }
  db.exec('ALTER TABLE pending_server_actions ADD COLUMN execution_attempt_nonce TEXT');
};

const SOURCE_UPDATE_V1_MIGRATION_MARKER = 'source_update_v1_migration_completed_at';

/** Install the v2 durable queue and permanently mark the legacy scan migration. */
export const migrateSourceUpdateJobs = (db: Database): void => {
  db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
  db.exec(SOURCE_UPDATE_TABLES_SCHEMA_SQL);
  db.exec(`
    INSERT INTO source_update_control(singleton, schema_version, fence_epoch)
    VALUES (1, 2, 0) ON CONFLICT(singleton) DO NOTHING;
    CREATE INDEX IF NOT EXISTS idx_source_update_jobs_status_created
      ON source_update_jobs(state, created_at);
    CREATE INDEX IF NOT EXISTS idx_source_update_jobs_lease
      ON source_update_jobs(state, worker_fence);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_source_update_one_active
      ON source_update_jobs((1)) WHERE state IN (
        'awaiting_sessions',
        'accepted','resolving','resolved','downloading','archive_verified','extracting',
        'staging','candidate_sealed','restart_queued','activating','runtime_verifying','rollback_pending'
      );
    CREATE INDEX IF NOT EXISTS idx_source_update_receipts_job
      ON source_update_receipts(job_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_source_update_effects_running
      ON source_update_effects(state, job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_action_source_update_identity
      ON pending_server_actions(source_update_job_id, source_update_transaction_id)
      WHERE source_update_job_id IS NOT NULL;
  `);
  const migrated = db.prepare('SELECT 1 AS ok FROM app_config WHERE key = ?').get(SOURCE_UPDATE_V1_MIGRATION_MARKER);
  if (!migrated) {
    db.transaction(() => {
      // Legacy updater rows have only a build id and require a directory scan.
      // Fence them permanently: v2 activation accepts direct DB identity only.
      db.prepare(`UPDATE pending_server_actions
        SET status = 'superseded', error = 'legacy_source_update_identity_unsupported'
        WHERE action_type = 'safe-restart' AND requested_by = 'system-update'
          AND source_update_job_id IS NULL AND status IN ('pending','failed')`).run();
      db.prepare('INSERT INTO app_config(key, value) VALUES (?, CURRENT_TIMESTAMP)')
        .run(SOURCE_UPDATE_V1_MIGRATION_MARKER);
    })();
  }
};

/**
 * T-1751: the owner's consent to activate, recorded on the job when it is
 * created. Additive and nullable-free with a default, so older code reading the
 * table is unaffected and existing jobs keep the manual confirmation.
 */
export const migrateSourceUpdateAutoActivate = (db: Database): void => {
  const columns = (db.prepare('PRAGMA table_info(source_update_jobs)').all() as Array<{ name: string }>)
    .map((column) => column.name);
  if (columns.length === 0) throw new Error('source_update_jobs_table_missing');
  addColumnToTableIfNotExists(db, 'source_update_jobs', columns, 'auto_activate',
    'INTEGER NOT NULL DEFAULT 0 CHECK (auto_activate IN (0, 1))');
};

// The one-active partial index (mirrors SOURCE_UPDATE_ACTIVE_STATES): every
// non-terminal state, now including the deferral holding state, so a deferred
// job blocks a parallel one. `cancelled` is terminal and deliberately absent.
const SOURCE_UPDATE_ONE_ACTIVE_INDEX_SQL = `
  CREATE UNIQUE INDEX idx_source_update_one_active
    ON source_update_jobs((1)) WHERE state IN (
      'awaiting_sessions',
      'accepted','resolving','resolved','downloading','archive_verified','extracting',
      'staging','candidate_sealed','restart_queued','activating','runtime_verifying','rollback_pending'
    );`;

// Every source_update_jobs column, in schema order, that predates the deferral
// columns. The rebuild copies these explicitly and lets the four new deferral
// columns take their table defaults, so no legacy row loses data.
const SOURCE_UPDATE_PRE_DEFERRAL_COLUMNS = [
  'id', 'expected_version', 'owner_id', 'idempotency_key_hash', 'request_fingerprint',
  'strategy', 'state', 'worker_fence', 'transaction_id', 'release_id', 'release_tag',
  'release_asset_id', 'release_asset_name', 'release_asset_size', 'release_asset_sha256',
  'archive_sha256', 'activation_identity_sha256', 'release_commit', 'source_tree_sha256',
  'expected_server_build_id', 'expected_client_build_id', 'progress_seq', 'auto_activate',
  'error_code', 'error_message', 'created_at', 'started_at', 'updated_at', 'completed_at',
];

// The rebuilt table body, including the widened state CHECK (`awaiting_sessions`
// + `cancelled`) and the four INTEGER epoch-ms deferral columns. Kept identical
// to SOURCE_UPDATE_TABLES_SCHEMA_SQL's source_update_jobs definition; a drift
// between the two is caught by the three-way parity test (§7).
const SOURCE_UPDATE_JOBS_REBUILD_TABLE_SQL = (name: string) => `
  CREATE TABLE ${name} (
    id TEXT PRIMARY KEY NOT NULL,
    expected_version TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    idempotency_key_hash TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    strategy TEXT NOT NULL CHECK (strategy IN ('git-checkout-v2','release-layout-v2')),
    state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN (
      'awaiting_sessions',
      'accepted','resolving','resolved','downloading','archive_verified',
      'extracting','staging','candidate_sealed','restart_queued','activating',
      'runtime_verifying','activated','rollback_pending','rolled_back','failed',
      'superseded','manual_recovery_required','cancelled'
    )),
    worker_fence INTEGER,
    transaction_id TEXT UNIQUE,
    release_id TEXT,
    release_tag TEXT,
    release_asset_id TEXT,
    release_asset_name TEXT,
    release_asset_size INTEGER,
    release_asset_sha256 TEXT,
    archive_sha256 TEXT,
    activation_identity_sha256 TEXT,
    release_commit TEXT,
    source_tree_sha256 TEXT,
    expected_server_build_id TEXT,
    expected_client_build_id TEXT,
    progress_seq INTEGER NOT NULL DEFAULT 0 CHECK (progress_seq >= 0),
    auto_activate INTEGER NOT NULL DEFAULT 0 CHECK (auto_activate IN (0, 1)),
    defer_until_idle INTEGER NOT NULL DEFAULT 0 CHECK (defer_until_idle IN (0, 1)),
    deferral_deadline_at INTEGER,
    deferral_rearm_count INTEGER NOT NULL DEFAULT 0 CHECK (deferral_rearm_count >= 0),
    idle_observed_at INTEGER,
    error_code TEXT,
    error_message TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT,
    UNIQUE (owner_id, idempotency_key_hash)
  )`;

const sourceUpdateJobsStateCheckHas = (db: Database, needle: string): boolean => {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_update_jobs'",
  ).get() as { sql?: string } | undefined;
  return typeof row?.sql === 'string' && row.sql.includes(`'${needle}'`);
};

const countSourceUpdateChildren = (db: Database): number => {
  const receipts = (db.prepare('SELECT COUNT(*) AS c FROM source_update_receipts').get() as { c: number }).c;
  const effects = (db.prepare('SELECT COUNT(*) AS c FROM source_update_effects').get() as { c: number }).c;
  return receipts + effects;
};

/**
 * T-1730 W6 (ADR-156 §3.3, M6): declared session deferral. Widens the
 * source_update_jobs state CHECK with `awaiting_sessions` (active, un-fenced)
 * and `cancelled` (terminal), and adds four INTEGER epoch-ms deferral columns.
 *
 * SQLite cannot ALTER a CHECK, so the constraint is widened by a table rebuild
 * on the migrations.ts:802-905 pattern: `PRAGMA foreign_keys = OFF` OUTSIDE the
 * transaction, a pre-rebuild snapshot, and a foreign_key_check afterwards. The
 * two child tables (receipts, effects) cascade-delete to source_update_jobs, so
 * doing this inside one FK-enabled transaction would let `DROP TABLE` erase
 * every receipt (ADR-143); disabling FKs first preserves them, and the
 * before==after child-count invariant proves it. Idempotent: it detects the
 * widened CHECK and only re-asserts the index on an already-migrated database.
 */
export const migrateSourceUpdateDeferral = (db: Database): void => {
  if (!tableExists(db, 'source_update_jobs')) throw new Error('source_update_jobs_table_missing');

  if (!sourceUpdateJobsStateCheckHas(db, 'awaiting_sessions')) {
    backupDatabaseBeforeRebuild(db, 'rebuild-source-update-deferral');
    const violationsBeforeRebuild = summarizeForeignKeyViolations(readForeignKeyViolations(db));
    const childrenBefore = countSourceUpdateChildren(db);
    const columnList = SOURCE_UPDATE_PRE_DEFERRAL_COLUMNS.join(', ');

    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN TRANSACTION');
      db.exec('DROP TABLE IF EXISTS source_update_jobs__new');
      db.exec(SOURCE_UPDATE_JOBS_REBUILD_TABLE_SQL('source_update_jobs__new'));
      db.exec(`INSERT INTO source_update_jobs__new (${columnList})
               SELECT ${columnList} FROM source_update_jobs`);
      db.exec('DROP TABLE source_update_jobs');
      db.exec('ALTER TABLE source_update_jobs__new RENAME TO source_update_jobs');
      db.exec('COMMIT');
    } catch (migrationError) {
      db.exec('ROLLBACK');
      throw migrationError;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }

    const childrenAfter = countSourceUpdateChildren(db);
    if (childrenAfter !== childrenBefore) {
      throw new Error(
        `migrateSourceUpdateDeferral lost source-update children: ${childrenBefore} -> ${childrenAfter}`,
      );
    }
    assertRebuildPreservedIntegrity(db, 'rebuild-source-update-deferral', violationsBeforeRebuild);
  }

  // The one-active index dropped its old definition with the rebuild, and an
  // already-upgraded install keeps the pre-deferral list; recreate it either
  // way so `awaiting_sessions` blocks a parallel job.
  db.exec('DROP INDEX IF EXISTS idx_source_update_one_active');
  db.exec(SOURCE_UPDATE_ONE_ACTIVE_INDEX_SQL);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_source_update_jobs_status_created
             ON source_update_jobs(state, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_source_update_jobs_lease
             ON source_update_jobs(state, worker_fence)`);
};

/**
 * Reverse of migrateSourceUpdateDeferral (ADR-156 §4 rollback path). Refuses if
 * any row sits in a state the older schema cannot represent, so a downgrade can
 * never silently strand a deferred or cancelled job; otherwise it narrows the
 * CHECK back and drops the four deferral columns by the same rebuild pattern.
 */
export const reverseSourceUpdateDeferral = (db: Database): void => {
  if (!tableExists(db, 'source_update_jobs')) return;
  const stranded = db.prepare(
    "SELECT COUNT(*) AS c FROM source_update_jobs WHERE state IN ('awaiting_sessions', 'cancelled')",
  ).get() as { c: number };
  if (stranded.c > 0) {
    throw new Error('reverseSourceUpdateDeferral refuses: rows exist in awaiting_sessions/cancelled');
  }
  if (!sourceUpdateJobsStateCheckHas(db, 'awaiting_sessions')) return;

  backupDatabaseBeforeRebuild(db, 'rebuild-source-update-deferral');
  const violationsBeforeRebuild = summarizeForeignKeyViolations(readForeignKeyViolations(db));
  const childrenBefore = countSourceUpdateChildren(db);
  const columnList = SOURCE_UPDATE_PRE_DEFERRAL_COLUMNS.join(', ');

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS source_update_jobs__old');
    db.exec(`
      CREATE TABLE source_update_jobs__old (
        id TEXT PRIMARY KEY NOT NULL,
        expected_version TEXT NOT NULL,
        owner_id INTEGER NOT NULL,
        idempotency_key_hash TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        strategy TEXT NOT NULL CHECK (strategy IN ('git-checkout-v2','release-layout-v2')),
        state TEXT NOT NULL DEFAULT 'accepted' CHECK (state IN (
          'accepted','resolving','resolved','downloading','archive_verified',
          'extracting','staging','candidate_sealed','restart_queued','activating',
          'runtime_verifying','activated','rollback_pending','rolled_back','failed',
          'superseded','manual_recovery_required'
        )),
        worker_fence INTEGER,
        transaction_id TEXT UNIQUE,
        release_id TEXT,
        release_tag TEXT,
        release_asset_id TEXT,
        release_asset_name TEXT,
        release_asset_size INTEGER,
        release_asset_sha256 TEXT,
        archive_sha256 TEXT,
        activation_identity_sha256 TEXT,
        release_commit TEXT,
        source_tree_sha256 TEXT,
        expected_server_build_id TEXT,
        expected_client_build_id TEXT,
        progress_seq INTEGER NOT NULL DEFAULT 0 CHECK (progress_seq >= 0),
        auto_activate INTEGER NOT NULL DEFAULT 0 CHECK (auto_activate IN (0, 1)),
        error_code TEXT,
        error_message TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT,
        UNIQUE (owner_id, idempotency_key_hash)
      )`);
    db.exec(`INSERT INTO source_update_jobs__old (${columnList})
             SELECT ${columnList} FROM source_update_jobs`);
    db.exec('DROP TABLE source_update_jobs');
    db.exec('ALTER TABLE source_update_jobs__old RENAME TO source_update_jobs');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  const childrenAfter = countSourceUpdateChildren(db);
  if (childrenAfter !== childrenBefore) {
    throw new Error(`reverseSourceUpdateDeferral lost children: ${childrenBefore} -> ${childrenAfter}`);
  }
  assertRebuildPreservedIntegrity(db, 'rebuild-source-update-deferral', violationsBeforeRebuild);
  db.exec('DROP INDEX IF EXISTS idx_source_update_one_active');
  db.exec(`
    CREATE UNIQUE INDEX idx_source_update_one_active
      ON source_update_jobs((1)) WHERE state IN (
        'accepted','resolving','resolved','downloading','archive_verified','extracting',
        'staging','candidate_sealed','restart_queued','activating','runtime_verifying','rollback_pending'
      );`);
};

/**
 * audit_log diagnostic enrichment (T-182). Adds the `user_agent` column to the
 * audit_log table on existing installs so auth events can record the caller's
 * User-Agent string for forensics (e.g. distinguishing a real browser from a
 * scripted client during an account-takeover investigation). Fresh installs get
 * the column from AUDIT_LOG_TABLE_SCHEMA_SQL; this migration is the additive,
 * idempotent backstop for upgraded databases.
 *
 * Forward-only: no backfill (historical rows keep NULL), no index (the column is
 * read for inspection, never filtered/joined on). Guarded by tableExists so it
 * is a no-op on a pre-bootstrap database that has not created audit_log yet.
 */
const migrateAuditLogUserAgent = (db: Database): void => {
  if (!tableExists(db, 'audit_log')) {
    return;
  }
  const cols = (db.prepare('PRAGMA table_info(audit_log)').all() as { name: string }[]).map(
    (r) => r.name
  );
  addColumnToTableIfNotExists(db, 'audit_log', cols, 'user_agent', 'TEXT DEFAULT NULL');
};

/**
 * Password-lifecycle migration (C-1): adds the columns backing JWT invalidation
 * on password change and forced password rotation.
 *
 *   - password_changed_at: unix epoch (ms) of the last password change. Tokens
 *     minted before this instant carry a stale `pwd_iat` and are rejected.
 *   - must_change_password: 1 when an admin has reset the password and the user
 *     must set a new one before normal use.
 *
 * Existing users are backfilled with the current time so their live sessions
 * are not invalidated by the introduction of the `pwd_iat` check.
 */
const migratePasswordLifecycle = (db: Database, userColumnNames: string[]): void => {
  const hadPasswordChangedAt = userColumnNames.includes('password_changed_at');

  addColumnToTableIfNotExists(db, 'users', userColumnNames, 'password_changed_at', 'INTEGER');
  addColumnToTableIfNotExists(
    db,
    'users',
    userColumnNames,
    'must_change_password',
    'INTEGER NOT NULL DEFAULT 0'
  );

  // Backfill only on first introduction of the column: stamp existing users with
  // "now" so their currently valid tokens (pwd_iat == now at issue) are not
  // retroactively invalidated. Idempotent: skipped once the column exists.
  if (!hadPasswordChangedAt) {
    console.log('Running migration: Backfilling password_changed_at for existing users');
    db.prepare(
      'UPDATE users SET password_changed_at = ? WHERE password_changed_at IS NULL'
    ).run(Date.now());
  }

  // B-164 — SELF-HEALING backfill, on EVERY boot, not just first introduction.
  //
  // The one-shot backfill above only ever ran once; `createUser` did not stamp
  // the column, so every account created afterwards carried NULL forever. A NULL
  // stamp disables the pwd_iat gate for that user (auth.js: `if
  // (user.password_changed_at && ...)`), meaning their tokens survive a password
  // change or an admin reset until natural expiry. createUser now stamps at
  // insert; this heals the rows already on disk.
  //
  // Stamped from the account's OWN created_at (converted to ms), never "now":
  // "now" would be later than the mint time of every live token those users
  // hold, so healing would evict them all — a mass logout as a side effect of a
  // deploy. created_at precedes every token they could hold, so live sessions
  // survive while future password changes correctly invalidate them.
  // COALESCE guards the (schema-impossible) NULL created_at.
  const healed = db
    .prepare(
      `UPDATE users
          SET password_changed_at =
              COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, ?)
        WHERE password_changed_at IS NULL`
    )
    .run(Date.now());
  if (healed.changes > 0) {
    console.log('Healed NULL password_changed_at rows (B-164)', { rows: healed.changes });
  }
};

/** app_config key marking that the one-shot participant backfill already ran. */
const PARTICIPANTS_BACKFILL_MARKER = 'participants_backfill_completed_at';

/**
 * Participant & agent tracking migration. Creates the three tracking tables and
 * their indexes (indexes live here, never in INIT_SCHEMA_SQL — see the 502
 * lesson where indexing migration-added columns at init broke fresh boots), then
 * backfills sessions that have NO participant at all with the install owner, so
 * historical conversations are not left without an attributed human.
 *
 * B-476 — TWO BUGS FIXED HERE, both of which ran on production 120 times:
 *
 *   1. The backfill had no version guard, so it re-ran on EVERY boot, not once.
 *   2. `INSERT OR IGNORE` only swallows a (session_id, user_id) collision — it
 *      does NOT check whether the session already has a DIFFERENT owner. So a
 *      session spawned by member B received a SECOND 'owner' row for the
 *      platform owner on the next restart. The measured damage on this install
 *      was 93 sessions carrying two owners and 154 zero-message owner rows.
 *
 * That is not a cosmetic label. `session_participants` later became the CONSENT
 * boundary (ADR-099): `isParticipant` gates `restamp`, project file writes, and
 * cost attribution. A backfill written for a display purpose ("no conversation
 * without a name") was silently handing out authority — see ADR-104.
 *
 * Both fixes are structural, not defensive: the marker makes the run one-shot,
 * and `NOT EXISTS` makes attribution touch only genuinely unowned sessions. The
 * ownership SEMANTICS of the row it writes are corrected separately (T-1262);
 * this function deliberately stays a two-line change so it can ship alone.
 */
const migrateParticipantsAndAgents = (db: Database): void => {
  db.exec(SESSION_PARTICIPANTS_TABLE_SCHEMA_SQL);
  db.exec(SESSION_AGENTS_CACHE_TABLE_SCHEMA_SQL);
  db.exec(SESSION_AGENTS_META_TABLE_SCHEMA_SQL);

  db.exec('CREATE INDEX IF NOT EXISTS idx_session_participants_session ON session_participants(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_participants_user ON session_participants(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_agents_cache_session ON session_agents_cache(session_id)');

  // Guard 1 (B-476): one shot, ever. The marker is written below after a
  // completed pass, so an install that crashes mid-backfill retries on the next
  // boot rather than skipping a half-done job. An install predating this fix has
  // no marker, so it gets exactly ONE more pass — which is harmless because
  // guard 2 now narrows that pass to sessions nobody owns.
  const alreadyRan = db
    .prepare('SELECT 1 AS ok FROM app_config WHERE key = ?')
    .get(PARTICIPANTS_BACKFILL_MARKER) as { ok: number } | undefined;

  if (alreadyRan) {
    return;
  }

  // Attribute unowned sessions to the install owner so the participant view is
  // complete from day one. Skip silently when no owner exists yet (pre-bootstrap
  // install) or no sessions are present.
  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as
    | { id: number }
    | undefined;

  if (!owner) {
    return;
  }

  // Guard 2 (B-476): only sessions with NO participant whatsoever. A session
  // that already has a human — whoever it is — is never re-attributed, so the
  // backfill can no longer mint a second 'owner' beside the real one.
  const sessions = db
    .prepare(
      `SELECT s.session_id
       FROM sessions s
       WHERE NOT EXISTS (
         SELECT 1 FROM session_participants sp WHERE sp.session_id = s.session_id
       )`
    )
    .all() as { session_id: string }[];

  const insertOwner = db.prepare(
    `INSERT OR IGNORE INTO session_participants (session_id, user_id, role)
     VALUES (?, ?, 'owner')`
  );

  let inserted = 0;
  const runBackfill = db.transaction((rows: { session_id: string }[]) => {
    for (const s of rows) {
      inserted += insertOwner.run(s.session_id, owner.id).changes;
    }
  });
  runBackfill(sessions);

  // The marker is written even when nothing was inserted: "there was nothing to
  // backfill" is a completed pass too, and re-checking it every boot is exactly
  // the scan this guard exists to stop.
  db.prepare(
    `INSERT INTO app_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(PARTICIPANTS_BACKFILL_MARKER, new Date().toISOString());

  if (inserted > 0) {
    console.log('Running migration: Backfilled session participants', { inserted });
    db.prepare(
      'INSERT INTO audit_log (user_id, action, metadata) VALUES (?, ?, ?)'
    ).run(owner.id, 'participants_backfilled', JSON.stringify({ inserted }));
  }
};

/**
 * Per-message sender attribution (B-MU-UX-FIX-MSG-AUTHOR). Creates the
 * message_authors sidecar table the run path writes a row into for every user
 * prompt, plus the session lookup index the history-stamping path reads.
 * Idempotent (IF NOT EXISTS); no backfill is possible — pre-existing messages
 * have no recorded author and stay unattributed by design.
 */
const migrateMessageAuthors = (db: Database): void => {
  db.exec(MESSAGE_AUTHORS_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_message_authors_session ON message_authors(session_id)');
};

/**
 * Upgrade the immutable message-coordination ingress sidecar in place.
 *
 * Early fleet databases created this table before lifecycle fencing was added.
 * `CREATE TABLE IF NOT EXISTS` deliberately leaves such a table untouched, so
 * every repository read of lifecycle_status failed at runtime.  The additive
 * repair is kept in the same boot-order slot as table creation and is one
 * transaction: no application writer can observe the temporary SQLite default
 * assigned while the legacy rows are being classified.
 *
 * Existing rows predate lifecycle recording.  They must never be presented as
 * a newly claimed/live dispatch, nor may they become retryable: `terminal` with
 * a NULL verdict is the conservative state (duplicate claims remain ambiguous
 * and therefore cannot produce a second provider effect).
 */
export const migrateMessageCoordination = (db: Database): void => {
  const migrate = db.transaction(() => {
    db.exec(MESSAGE_COORDINATION_TABLE_SCHEMA_SQL);

    const columns = getTableInfo(db, 'message_coordination_ingress').map((column) => column.name);
    if (!columns.includes('lifecycle_status')) {
      console.log('Running migration: Adding lifecycle_status to message_coordination_ingress');
      db.exec(
        `ALTER TABLE message_coordination_ingress
         ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'claimed'
         CHECK (lifecycle_status IN ('claimed', 'started', 'not_started', 'terminal'))`,
      );
      db.exec(
        `UPDATE message_coordination_ingress
         SET lifecycle_status = 'terminal'`,
      );
    }

    if (!columns.includes('accepted_at')) {
      db.exec('ALTER TABLE message_coordination_ingress ADD COLUMN accepted_at TEXT');
    }

    if (!columns.includes('verdict_json')) {
      console.log('Running migration: Adding verdict_json to message_coordination_ingress');
      db.exec('ALTER TABLE message_coordination_ingress ADD COLUMN verdict_json TEXT');
    }

    // Claude receipt identity (B-1025 review, 2026-09-10): the two columns and
    // their indexes existed only in CREATE TABLE, so an existing database never
    // received them while message-coordination.db.ts reads and writes them and
    // the identity query uses INDEXED BY (a hard requirement in SQLite). The
    // definitions match the live nassaj-dev schema exactly: a no-op there and a
    // real catch-up on every other database.
    if (!columns.includes('claude_user_uuid')) {
      console.log('Running migration: Adding claude_user_uuid to message_coordination_ingress');
      db.exec('ALTER TABLE message_coordination_ingress ADD COLUMN claude_user_uuid TEXT');
    }
    if (!columns.includes('claude_payload_sha256')) {
      console.log('Running migration: Adding claude_payload_sha256 to message_coordination_ingress');
      db.exec('ALTER TABLE message_coordination_ingress ADD COLUMN claude_payload_sha256 TEXT');
    }

    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_message_coordination_session ON message_coordination_ingress(session_id)',
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_coordination_claude_uuid
       ON message_coordination_ingress(provider, claude_user_uuid) WHERE claude_user_uuid IS NOT NULL`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_coordination_claude_owner_session
       ON message_coordination_ingress(user_id, provider, session_id) WHERE claude_user_uuid IS NOT NULL`,
    );
  });

  migrate();
};

/**
 * M1 of the provider-neutral turn supervisor. Additive and safe to run on a
 * fleet: no existing ingress row is rewritten and no execution path consumes
 * these tables until the later harness-integration milestone.
 */
const migrateTurnSupervisor = (db: Database): void => {
  db.exec(TURN_SUPERVISOR_TABLES_SCHEMA_SQL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_turn_supervisor_turns_session ON turn_supervisor_turns(session_id)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_turn_supervisor_runs_turn_state ON turn_supervisor_runs(turn_id, state)',
  );
};

/** app_config key marking that the one-shot ownership repair already ran. */
const PARTICIPANTS_REPAIR_MARKER = 'participants_ownership_repaired_at';

/**
 * Rows a real human spawn never produced (B-476 / B-477). Two independent
 * signatures, deliberately narrow — each is provable from the write paths:
 *
 *   S1 — `role='owner' AND message_count=0`. recordSpawn inserts with
 *        message_count=1 and increments on conflict, so a zero counter on an
 *        owner row can ONLY come from the historical backfill, which inserted
 *        (session_id, user_id, role) and left the counter at its default.
 *
 *   S2 — the user authored NOTHING in a session where somebody else did, and
 *        their counter is at most 1. On every provider that records authorship
 *        (claude / opencode / antigravity) the web spawn path writes the
 *        participant row and the author row in the SAME function, so "recorded
 *        as present, never authored a word, while a real author exists" is the
 *        fingerprint of the opencode synchronizer beating the spawn path by two
 *        seconds. The `<= 1` bound keeps a long-running co-participant out.
 *
 * Both are conservative by construction: a provider that never writes
 * message_authors (codex, cursor, kimi, hermes) can only ever match S1,
 * whose zero counter is unambiguous. Measured on this install: 158 rows.
 */
const PROVENANCE_ROW_PREDICATE_SQL = `(
  (sp.role = 'owner' AND sp.message_count = 0)
  OR (
    sp.message_count <= 1
    AND NOT EXISTS (
      SELECT 1 FROM message_authors ma
      WHERE ma.session_id = sp.session_id AND ma.user_id = sp.user_id
    )
    AND EXISTS (
      SELECT 1 FROM message_authors mb
      WHERE mb.session_id = sp.session_id AND mb.user_id <> sp.user_id
    )
  )
)`;

/**
 * Ownership repair + the constraint that keeps it repaired (T-1263 / T-1264).
 *
 * Runs ONCE, after the attribution column exists. Four passes, in this order —
 * the order is load-bearing, since each pass assumes the previous one ran:
 *
 *   1. MARK every provenance row (above) as attribution='provenance'. The row is
 *      never deleted. Deleting it would be silent data loss twice over: it is
 *      the only thing keeping 87 conversations past the native-session predicate
 *      (they have no message_authors row at all), and it is the cost bucket for
 *      everything before the first recorded prompt — dropping it makes the
 *      per-user total come out UNDER the real bill.
 *
 *   2. DEMOTE marked rows to 'participant' where the session has another human.
 *      A marked row that is the session's ONLY row keeps role='owner': something
 *      must own the session for display and cost, and 'provenance' already
 *      strips its authority.
 *
 *   3. DEMOTE the later of two genuine owners. 26 sessions here have two owner
 *      rows where BOTH humans really wrote — the backfill created the second
 *      one, then its user ran a turn in the session and the counter moved off
 *      zero, so no signature above catches them. Their participation is real
 *      (and keeps its 'spawn' attribution and its access); only the badge is
 *      wrong, and the badge belongs to whoever appeared first.
 *
 *   4. PROMOTE a real author to owner where step 1-3 left a session without one
 *      — the opencode race victims, whose real starter was recorded as a mere
 *      'participant' two seconds after the synchronizer claimed the session.
 *
 * Only then is the unique index created: it is the LOCK on this repair, not its
 * tool. SQLite refuses a unique index that the existing rows already violate, so
 * creating it before step 3 would throw at boot and the server would not come
 * up. It is created inside a try/catch that logs and continues for exactly that
 * reason — a fleet node restored from an unrepaired backup must still boot.
 */
const migrateParticipantAttributionAndOwnership = (db: Database): void => {
  const columnNames = getTableInfo(db, 'session_participants').map((column) => column.name);
  addColumnToTableIfNotExists(
    db,
    'session_participants',
    columnNames,
    'attribution',
    // 'spawn' is the only safe default: the ~350 rows already written by the run
    // path carry real consent, and defaulting to 'provenance' would revoke it
    // from every one of them in a single statement.
    "TEXT NOT NULL DEFAULT 'spawn'"
  );

  const alreadyRepaired = db
    .prepare('SELECT 1 AS ok FROM app_config WHERE key = ?')
    .get(PARTICIPANTS_REPAIR_MARKER) as { ok: number } | undefined;

  if (!alreadyRepaired) {
    const repair = db.transaction(() => {
      const marked = db
        .prepare(
          `UPDATE session_participants AS sp
           SET attribution = 'provenance'
           WHERE ${PROVENANCE_ROW_PREDICATE_SQL}`
        )
        .run().changes;

      const demoted = db
        .prepare(
          `UPDATE session_participants AS sp
           SET role = 'participant'
           WHERE sp.attribution = 'provenance'
             AND sp.role = 'owner'
             AND EXISTS (
               SELECT 1 FROM session_participants other
               WHERE other.session_id = sp.session_id AND other.user_id <> sp.user_id
             )`
        )
        .run().changes;

      const deduped = db
        .prepare(
          `UPDATE session_participants AS sp
           SET role = 'participant'
           WHERE sp.role = 'owner'
             AND EXISTS (
               SELECT 1 FROM session_participants earlier
               WHERE earlier.session_id = sp.session_id
                 AND earlier.role = 'owner'
                 AND earlier.user_id <> sp.user_id
                 AND (
                   datetime(earlier.first_seen) < datetime(sp.first_seen)
                   OR (datetime(earlier.first_seen) = datetime(sp.first_seen)
                       AND earlier.user_id < sp.user_id)
                 )
             )`
        )
        .run().changes;

      // Promote the earliest remaining human on any session the passes above
      // left ownerless. Ordered by first_seen so the promoted human is the one
      // who actually started the conversation, not whoever spoke last.
      const promoted = db
        .prepare(
          `UPDATE session_participants
           SET role = 'owner'
           WHERE rowid IN (
             SELECT (
               SELECT candidate.rowid FROM session_participants candidate
               WHERE candidate.session_id = s.session_id
                 AND candidate.attribution = 'spawn'
               ORDER BY datetime(candidate.first_seen) ASC, candidate.user_id ASC
               LIMIT 1
             )
             FROM (SELECT DISTINCT session_id FROM session_participants) s
             WHERE NOT EXISTS (
               SELECT 1 FROM session_participants owner_row
               WHERE owner_row.session_id = s.session_id AND owner_row.role = 'owner'
             )
           )`
        )
        .run().changes;

      db.prepare(
        `INSERT INTO app_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(PARTICIPANTS_REPAIR_MARKER, new Date().toISOString());

      if (marked > 0 || demoted > 0 || deduped > 0 || promoted > 0) {
        console.log('Running migration: Repaired session ownership (B-476)', {
          marked,
          demoted,
          deduped,
          promoted,
        });
        db.prepare('INSERT INTO audit_log (user_id, action, metadata) VALUES (?, ?, ?)').run(
          null,
          'participants_ownership_repaired',
          JSON.stringify({ marked, demoted, deduped, promoted })
        );
      }
    });

    repair();
  }

  // The lock. Never fatal: a node restored from an unrepaired backup still has
  // violations, and refusing to boot over a display label would cost far more
  // than the label is worth. The count is logged so the anomaly is visible.
  try {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_participants_single_owner
       ON session_participants(session_id) WHERE role = 'owner'`
    );
  } catch (error) {
    const violations = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT session_id FROM session_participants
           WHERE role = 'owner' GROUP BY session_id HAVING COUNT(*) > 1
         )`
      )
      .get() as { n: number };
    console.error(
      'Could not enforce single-owner index; sessions with duplicate owners remain (B-476)',
      { violations: violations.n, error: error instanceof Error ? error.message : String(error) }
    );
  }
};

/**
 * Private-project visibility (B-PRIV-1). Ensures the `visibility` + `created_by`
 * columns exist on `projects` and creates the visibility lookup index.
 *
 * The columns are normally added by rebuildProjectsTableWithPrimaryKeySchema
 * (which also keeps the table-rebuild path in sync — critical so they are not
 * dropped on a future legacy rebuild). This function is a defensive, idempotent
 * backstop that also owns the index (index lives in migrations, never in
 * INIT_SCHEMA_SQL — see the 502 lesson). Existing rows default to 'public', so
 * the introduction of private projects never retroactively hides any project.
 */
const migrateProjectVisibility = (db: Database): void => {
  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);

  addColumnToTableIfNotExists(db, 'projects', columnNames, 'visibility', "TEXT NOT NULL DEFAULT 'public'");
  addColumnToTableIfNotExists(db, 'projects', columnNames, 'created_by', 'INTEGER');
  // T-1403: per-project logo. Holds the PUBLIC, server-relative URL
  // (/project-logos/<projectId>.<ext>?v=<token>) — never a filesystem path — so
  // the value can be handed to the client verbatim. NULL = no logo, which every
  // pre-existing row keeps.
  addColumnToTableIfNotExists(db, 'projects', columnNames, 'logo_url', 'TEXT');
  addColumnToTableIfNotExists(db, 'projects', columnNames, 'detected_name', 'TEXT');
  // Preserve the pre-v2 visible label. Background reconciliation may improve
  // detected_name later without rewriting an explicit custom name.
  db.exec(`UPDATE projects
           SET detected_name = custom_project_name
           WHERE detected_name IS NULL AND custom_project_name IS NOT NULL`);
  // DB-first project listing: directory status is refreshed by the reconcile
  // scheduler, never probed in a GET request. NULL is an explicit unknown.
  addColumnToTableIfNotExists(db, 'projects', columnNames, 'dir_exists', 'INTEGER');
  addColumnToTableIfNotExists(db, 'projects', columnNames, 'dir_checked_at', 'TEXT');

  // Defensive backfill: any NULL visibility (e.g. from a partial legacy rebuild)
  // resolves to the safe 'public' default so it is never silently hidden.
  db.exec("UPDATE projects SET visibility = 'public' WHERE visibility IS NULL");

  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_visibility ON projects(visibility)');
};

/** Additive v2 ingestion/read-model storage. No legacy cost table is modified. */
const migrateUsageIngestionV2 = (db: Database): void => {
  db.exec(USAGE_SOURCE_CHECKPOINTS_TABLE_SCHEMA_SQL);
  db.exec(USAGE_REQUEST_EVENTS_TABLE_SCHEMA_SQL);
  db.exec(USAGE_REQUEST_OCCURRENCES_TABLE_SCHEMA_SQL);
  db.exec(USAGE_SOURCE_LINKS_TABLE_SCHEMA_SQL);
  db.exec(USAGE_DURATION_EVENTS_TABLE_SCHEMA_SQL);
  db.exec(USAGE_BACKFILL_GENERATIONS_TABLE_SCHEMA_SQL);
  db.exec(CONVERSATION_USAGE_SNAPSHOTS_TABLE_SCHEMA_SQL);

  const checkpointColumns = getTableInfo(db, 'usage_source_checkpoints').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'usage_source_checkpoints', checkpointColumns, 'boundary_hash', 'TEXT');

  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_checkpoints_status ON usage_source_checkpoints(status, updated_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_requests_session ON usage_request_events(session_id, occurred_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_requests_project ON usage_request_events(project_id, occurred_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_occurrences_source ON usage_request_occurrences(source_key, source_generation, byte_start)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_occurrences_fact ON usage_request_occurrences(session_id, request_key, attribution_kind, attribution_id, attribution_scope)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_source_links_child ON usage_source_links(child_source_key, generation)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_durations_session ON usage_duration_events(session_id, started_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_backfills_status ON usage_backfill_generations(status, generation)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversation_usage_project ON conversation_usage_snapshots(project_id, updated_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversation_usage_state ON conversation_usage_snapshots(snapshot_status, updated_at)');
};

/** ADR-169 v3 is additive and deliberately has no backfill from v1/v2. */
const migrateUsageStatisticsV3 = (db: Database): void => {
  createUsageStatisticsV3Fresh(db);
  const runColumns = getTableInfo(db, 'usage_statistics_runs').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'usage_statistics_runs', runColumns, 'authority_token', 'INTEGER NOT NULL DEFAULT 0 CHECK (authority_token >= 0)');
  addColumnToTableIfNotExists(db, 'usage_statistics_runs', runColumns, 'fact_count', 'INTEGER NOT NULL DEFAULT 0 CHECK (fact_count >= 0 AND fact_count <= 500000)');
  addColumnToTableIfNotExists(db, 'usage_statistics_runs', runColumns, 'source_bytes', 'INTEGER NOT NULL DEFAULT 0 CHECK (source_bytes >= 0 AND source_bytes <= 268435456)');
  addColumnToTableIfNotExists(db, 'usage_statistics_runs', runColumns, 'source_count', 'INTEGER NOT NULL DEFAULT 0 CHECK (source_count >= 0 AND source_count <= 256)');
  addColumnToTableIfNotExists(db, 'usage_statistics_runs', runColumns, 'lineage_count', 'INTEGER NOT NULL DEFAULT 0 CHECK (lineage_count >= 0 AND lineage_count <= 4096)');
  addColumnToTableIfNotExists(db, 'usage_statistics_runs', runColumns, 'work_duration_ms', 'INTEGER CHECK (work_duration_ms IS NULL OR (work_duration_ms >= 0 AND work_duration_ms <= 9007199254740991))');
  const canonicalRunColumns = getTableInfo(db, 'usage_v3_canonical_runs').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'usage_v3_canonical_runs', canonicalRunColumns, 'failure_code', 'TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128)');
  addColumnToTableIfNotExists(db, 'usage_v3_canonical_runs', canonicalRunColumns, 'metrics_fingerprint', "TEXT NOT NULL DEFAULT '' CHECK (length(metrics_fingerprint) <= 512)");
  addColumnToTableIfNotExists(db, 'usage_v3_canonical_runs', canonicalRunColumns, 'pricing_version', "TEXT NOT NULL DEFAULT '' CHECK (length(pricing_version) <= 256)");
  addColumnToTableIfNotExists(db, 'usage_v3_canonical_runs', canonicalRunColumns, 'envelope_json', "TEXT NOT NULL DEFAULT '{}' CHECK (length(CAST(envelope_json AS BLOB)) <= 4096)");
  addColumnToTableIfNotExists(db, 'usage_v3_canonical_runs', canonicalRunColumns, 'work_duration_ms', 'INTEGER CHECK (work_duration_ms IS NULL OR (work_duration_ms >= 0 AND work_duration_ms <= 9007199254740991))');
  addColumnToTableIfNotExists(db, 'usage_v3_canonical_runs', canonicalRunColumns, 'fact_count', 'INTEGER NOT NULL DEFAULT 0 CHECK (fact_count BETWEEN 0 AND 500000)');
  addColumnToTableIfNotExists(db, 'usage_v3_canonical_runs', canonicalRunColumns, 'fact_bytes', 'INTEGER NOT NULL DEFAULT 0 CHECK (fact_bytes BETWEEN 0 AND 268435456)');
  addColumnToTableIfNotExists(db, 'usage_v3_canonical_runs', canonicalRunColumns, 'lineage_count', 'INTEGER NOT NULL DEFAULT 0 CHECK (lineage_count BETWEEN 0 AND 512)');
  const receiptColumns = getTableInfo(db, 'usage_v3_preflight_receipts').map((column) => column.name);
  addColumnToTableIfNotExists(db, 'usage_v3_preflight_receipts', receiptColumns, 'created_at_ms', 'INTEGER NOT NULL DEFAULT 0 CHECK (created_at_ms >= 0)');
  addColumnToTableIfNotExists(db, 'usage_v3_preflight_receipts', receiptColumns, 'failure_code', 'TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128)');
  addColumnToTableIfNotExists(db, 'usage_v3_preflight_receipts', receiptColumns, 'accounted_io_bytes', 'INTEGER NOT NULL DEFAULT 0 CHECK (accounted_io_bytes BETWEEN 0 AND 268435456)');
  addColumnToTableIfNotExists(db, 'usage_v3_preflight_receipts', receiptColumns, 'io_budget_reserved', 'INTEGER NOT NULL DEFAULT 0 CHECK (io_budget_reserved IN (0, 1))');
};

/** Durable response timing sidecar (ADR-126).  No historical backfill: a
 * transcript does not prove runner start/completion boundaries. */
export const migrateResponseTurnMetrics = (db: Database): void => {
  const exists = tableExists(db, 'response_turn_metrics');
  const hasSessionCascade = exists && (db.pragma('foreign_key_list(response_turn_metrics)') as Array<{
    table: string;
    from: string;
    on_delete: string;
  }>).some((fk) => fk.table === 'sessions' && fk.from === 'session_id' && fk.on_delete === 'CASCADE');
  const tableSql = exists ? (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'response_turn_metrics'",
  ).get() as { sql: string } | undefined)?.sql ?? '' : '';
  const hasDurationCeiling = tableSql.includes('duration_ms <= 2592000000');

  if (exists && (!hasSessionCascade || !hasDurationCeiling)) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE response_turn_metrics_v2 (
          turn_id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL,
          assistant_message_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0 AND duration_ms <= 2592000000),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(session_id, assistant_message_id),
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO response_turn_metrics_v2
          (turn_id, session_id, assistant_message_id, started_at, completed_at, duration_ms, created_at)
        SELECT m.turn_id, m.session_id, m.assistant_message_id,
               m.started_at, m.completed_at, m.duration_ms, m.created_at
        FROM response_turn_metrics m
        INNER JOIN sessions s ON s.session_id = m.session_id
        WHERE m.duration_ms BETWEEN 0 AND 2592000000
      `);
      db.exec('DROP TABLE response_turn_metrics');
      db.exec('ALTER TABLE response_turn_metrics_v2 RENAME TO response_turn_metrics');
    })();
  } else {
    db.exec(RESPONSE_TURN_METRICS_TABLE_SCHEMA_SQL);
  }
  db.exec(`DELETE FROM response_turn_metrics
           WHERE session_id NOT IN (SELECT session_id FROM sessions)`);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_response_turn_metrics_session_message '
    + 'ON response_turn_metrics(session_id, assistant_message_id)',
  );
};

/** Durable host-capacity leases used by every Turn Supervisor harness. */
export const migrateTurnResourceLeases = (db: Database): void => {
  const existing = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turn_resource_leases'",
  ).get() as { sql: string } | undefined;
  if (existing && (
    !existing.sql.includes('adapter_terminal') || !existing.sql.includes('dispatch_not_started')
    || /turn_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(existing.sql)
  )) {
    // The first M4 draft allowed process-backed exit proofs only. Hosted HTTP
    // workers have no PID, so preserve every lease while widening the proof
    // kind to the registry-attested adapter terminal proof.
    db.transaction(() => {
      db.exec('DROP TRIGGER IF EXISTS trg_turn_resource_leases_no_active_delete');
      db.exec('ALTER TABLE turn_resource_leases RENAME TO turn_resource_leases_pre_adapter_proof');
      db.exec(TURN_RESOURCE_LEASES_TABLE_SCHEMA_SQL);
      db.exec(`
        INSERT INTO turn_resource_leases (
          lease_id, turn_id, user_id, owner_id, owner_pid, cpu_reserved,
          memory_reserved, status, created_at_ms, heartbeat_at_ms,
          exit_proof_at_ms, exit_proof_kind, released_at_ms
        )
        SELECT lease_id, turn_id, user_id, owner_id, owner_pid, cpu_reserved,
          memory_reserved, status, created_at_ms, heartbeat_at_ms,
          exit_proof_at_ms, exit_proof_kind, released_at_ms
        FROM turn_resource_leases_pre_adapter_proof
      `);
      db.exec('DROP TABLE turn_resource_leases_pre_adapter_proof');
    }).immediate();
  }
  db.exec(TURN_RESOURCE_LEASES_TABLE_SCHEMA_SQL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_turn_resource_leases_active '
    + 'ON turn_resource_leases(status, user_id, heartbeat_at_ms)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_turn_resource_leases_owner '
    + 'ON turn_resource_leases(owner_id, status)',
  );
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_resource_leases_one_active_turn '
    + "ON turn_resource_leases(turn_id) WHERE status = 'active'",
  );
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_turn_resource_leases_no_active_delete
    BEFORE DELETE ON turn_resource_leases
    WHEN OLD.status = 'active'
    BEGIN
      SELECT RAISE(ABORT, 'active resource lease requires exit proof before deletion');
    END
  `);
};

/**
 * Explicit project membership (B-PRIV-1). Creates the project_members table and
 * its user lookup index (index lives here, never in INIT_SCHEMA_SQL — see the
 * 502 lesson). Idempotent (IF NOT EXISTS); no backfill — membership is derived
 * for legacy private conversions at conversion time, and public projects need
 * no rows. Must run AFTER both `projects` and `users` exist so the FKs resolve.
 */
const migrateProjectMembers = (db: Database): void => {
  db.exec(PROJECT_MEMBERS_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)');
};

/**
 * Passkey support (B-PK-1). Creates the webauthn_credentials table and its
 * user lookup index (index lives here, never in INIT_SCHEMA_SQL — see the 502
 * lesson). Idempotent (IF NOT EXISTS); no backfill — users register passkeys
 * explicitly from their account settings.
 */
const migrateWebAuthnCredentials = (db: Database): void => {
  db.exec(WEBAUTHN_CREDENTIALS_TABLE_SCHEMA_SQL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_id ON webauthn_credentials(user_id)'
  );
};

/**
 * Per-user session stars/favorites (B-STAR). Creates the starred_sessions table
 * and its user lookup index (index lives here, never in INIT_SCHEMA_SQL — see
 * the 502 lesson). Idempotent (IF NOT EXISTS); no backfill — stars are an
 * explicit user action, so existing sessions start unstarred for everyone. Must
 * run AFTER users exists so the user_id FK resolves.
 */
const migrateStarredSessions = (db: Database): void => {
  db.exec(STARRED_SESSIONS_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_starred_sessions_user ON starred_sessions(user_id)');
};

/**
 * Per-user governance exemptions (owner decision 2026-08-08). Creates the
 * `governance_exemptions` exception table and the one index the read path needs
 * (the index lives here, never in INIT_SCHEMA_SQL — see the 502 lesson).
 *
 * NO BACKFILL, and that is the point: this table stores exceptions only, so an
 * empty table means every user is governed on every engine — exactly the state
 * the install is in before the feature exists. There is no "migrate existing
 * preferences" step because there is no default to migrate; the absence of rows
 * IS the default. Must run AFTER users exists so both FKs resolve.
 */
const migrateGovernanceExemptions = (db: Database): void => {
  db.exec(GOVERNANCE_EXEMPTIONS_TABLE_SCHEMA_SQL);
  const columns = getTableInfo(db, 'governance_exemptions').map((column) => column.name);
  if (!columns.includes('expires_at')) {
    // Legacy rows were unbounded. Add the column conservatively and expire
    // every pre-existing exemption immediately; a fresh owner grant is needed
    // to create a new bounded exemption.
    db.exec('ALTER TABLE governance_exemptions ADD COLUMN expires_at DATETIME');
    db.exec('UPDATE governance_exemptions SET expires_at = CURRENT_TIMESTAMP WHERE expires_at IS NULL');
  }
  // The hot read is "which engines has THIS user exempted" (one query per
  // provisioning pass and per governance page load). The composite primary key
  // already covers a (user_id, provider) probe; this covers the user-only scan.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_governance_exemptions_user ON governance_exemptions(user_id)'
  );
};

/**
 * External platform connectors (T-1226, ADR-098). Creates the `connectors`
 * registry and its lookup index (the index lives here, never in
 * INIT_SCHEMA_SQL — see the 502 lesson). Idempotent (IF NOT EXISTS); no backfill,
 * because a connector only ever exists as a deliberate operator action.
 *
 * Holds no secret material: the API key lives encrypted in
 * provider-secrets-store under the `connector` namespace (T-1225). Must run
 * AFTER users exists so the created_by FK resolves.
 */
const migrateConnectors = (db: Database): void => {
  db.exec(CONNECTORS_TABLE_SCHEMA_SQL);

  // The first shipped shape carried UNIQUE(service, account_label), which was
  // right while every connector was team-wide and is wrong now that a connector
  // can be personal: it would let the FIRST member connect Notion and refuse
  // every colleague after them. SQLite cannot drop a constraint, so the table is
  // rebuilt once, in place, when that old constraint is detected.
  const connectorsSql = (db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connectors'")
    .get() as { sql?: string } | undefined)?.sql ?? '';
  if (connectorsSql.includes('UNIQUE(service, account_label)')) {
    console.log('Running migration: Rebuilding connectors without the team-wide UNIQUE');
    db.exec('DROP TABLE IF EXISTS connectors__new');
    db.exec(CONNECTORS_TABLE_SCHEMA_SQL.replace('connectors', 'connectors__new'));
    const cols = getTableInfo(db, 'connectors').map((c) => c.name);
    const carried = getTableInfo(db, 'connectors__new')
      .map((c) => c.name)
      .filter((name) => cols.includes(name));
    db.exec(
      `INSERT INTO connectors__new (${carried.join(', ')}) SELECT ${carried.join(', ')} FROM connectors`
    );
    db.exec('DROP TABLE connectors');
    db.exec('ALTER TABLE connectors__new RENAME TO connectors');
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_connectors_enabled ON connectors(enabled)');

  // Two partial indexes rather than one constraint, because the rule differs by
  // mode: at most ONE shared connection per (service, label) for the whole
  // install, and at most one PERSONAL connection per (service, label) PER
  // MEMBER. A single index spanning owner_user_id could not say both.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_connectors_shared_unique
       ON connectors(service, account_label) WHERE credential_mode = 'org_shared'`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_connectors_personal_unique
       ON connectors(service, account_label, owner_user_id) WHERE credential_mode = 'per_member'`
  );

  // The reach columns (transport/command/args/url/key placement) landed after the
  // table itself. ALTER for databases created in that window; CREATE TABLE above
  // already carries them for fresh ones. Both paths must exist — a column that
  // only appears on fresh installs is a production-only failure.
  const columns = getTableInfo(db, 'connectors').map((column) => column.name);
  // owner_user_id (ADR-098 rev2): a personal connector belongs to one member.
  // Added without the FK because SQLite cannot add a REFERENCES column by ALTER;
  // ON DELETE CASCADE therefore applies only to databases created fresh, and the
  // delete path sweeps personal rows explicitly for the rest.
  addColumnToTableIfNotExists(db, 'connectors', columns, 'owner_user_id', 'INTEGER');
  addColumnToTableIfNotExists(db, 'connectors', columns, 'transport', "TEXT NOT NULL DEFAULT 'stdio'");
  addColumnToTableIfNotExists(db, 'connectors', columns, 'command', 'TEXT');
  addColumnToTableIfNotExists(db, 'connectors', columns, 'args_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnToTableIfNotExists(db, 'connectors', columns, 'url', 'TEXT');
  addColumnToTableIfNotExists(db, 'connectors', columns, 'key_env_var', 'TEXT');
  addColumnToTableIfNotExists(db, 'connectors', columns, 'key_header', 'TEXT');
  addColumnToTableIfNotExists(
    db,
    'connectors',
    columns,
    'key_header_prefix',
    "TEXT NOT NULL DEFAULT ''"
  );
  // Non-secret extras a server needs to boot (Slack's workspace id). Stored as a
  // plain object here rather than in the encrypted store because they are
  // configuration, not credentials.
  addColumnToTableIfNotExists(db, 'connectors', columns, 'extra_env_json', "TEXT NOT NULL DEFAULT '{}'");
  // 'key' (a pasted credential) or 'oauth' (a browser grant held by mcp-remote).
  addColumnToTableIfNotExists(db, 'connectors', columns, 'auth_mode', "TEXT NOT NULL DEFAULT 'key'");
  // Even = stable source snapshot; odd = credential/grant promotion in flight.
  // Existing rows start at the stable revision 0. There is deliberately no
  // recovery that silently advances an odd value after a crash.
  addColumnToTableIfNotExists(
    db,
    'connectors',
    columns,
    'source_revision',
    'INTEGER NOT NULL DEFAULT 0 CHECK (source_revision BETWEEN 0 AND 9007199254740991)',
  );
};

/**
 * Adds the connector placement ledger without touching the connectors registry.
 *
 * There is intentionally no backfill and no startup worker here. An empty
 * ledger is the honest initial state until the separately gated reconciler is
 * armed. Foreign keys are RESTRICT/NO ACTION rather than CASCADE so deleting a
 * connector or member cannot destroy unresolved cleanup evidence.
 */
export const migrateConnectorPlacements = (db: Database): void => {
  db.exec(CONNECTOR_PLACEMENTS_TABLE_SCHEMA_SQL);
  const columns = getTableInfo(db, 'connector_placements').map((column) => column.name);
  addColumnToTableIfNotExists(
    db,
    'connector_placements',
    columns,
    'desired_fingerprint_version',
    'INTEGER NOT NULL DEFAULT 0 CHECK (desired_fingerprint_version IN (0, 1, 2))',
  );
  addColumnToTableIfNotExists(
    db,
    'connector_placements',
    columns,
    'applied_fingerprint_version',
    'INTEGER CHECK (applied_fingerprint_version IS NULL OR applied_fingerprint_version IN (1, 2))',
  );
  addColumnToTableIfNotExists(
    db,
    'connector_placements',
    columns,
    'desired_source_revision',
    'INTEGER NOT NULL DEFAULT -1 CHECK (desired_source_revision BETWEEN -1 AND 9007199254740991)',
  );
  addColumnToTableIfNotExists(
    db,
    'connector_placements',
    columns,
    'desired_present',
    'INTEGER NOT NULL DEFAULT 1 CHECK (desired_present IN (0, 1))',
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_connector_placements_state_retry
       ON connector_placements(state, next_retry_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_connector_placements_lease
       ON connector_placements(lease_expires_at_ms, fencing_token)`,
  );
};

/** Additive OAuth callback-state storage. It starts empty and contains only AEAD envelopes. */
export const migrateConnectorOAuthPending = (db: Database): void => {
  db.exec(CONNECTOR_OAUTH_PENDING_TABLE_SCHEMA_SQL);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_connector_oauth_pending_expiry
       ON connector_oauth_pending(expires_at)`,
  );
};

/**
 * Global "conversation closed" markers. Creates the closed_sessions table and
 * the closer lookup index (index lives here, never in INIT_SCHEMA_SQL — see the
 * 502 lesson). Idempotent (IF NOT EXISTS); no backfill — closing is an explicit
 * action, so every existing conversation starts open. Must run AFTER users
 * exists so the closed_by FK resolves.
 */
const migrateClosedSessions = (db: Database): void => {
  db.exec(CLOSED_SESSIONS_TABLE_SCHEMA_SQL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_closed_sessions_closed_by ON closed_sessions(closed_by)');
};

/**
 * Durable per-project cost ledger (ADR-078). Creates project_cost_daily and its
 * scan watermark table, plus the read indexes (indexes live HERE, never in
 * INIT_SCHEMA_SQL — the 502 lesson).
 *
 * Idempotent (IF NOT EXISTS) and with NO backfill: the ledger is filled by
 * costLedgerService.scan(), which reads the transcripts on disk. It also has no
 * FK to projects — the whole point of the table is that spend survives after the
 * conversations (and even the project row) are gone.
 */
const migrateProjectCostLedger = (db: Database): void => {
  db.exec(PROJECT_COST_DAILY_TABLE_SCHEMA_SQL);
  db.exec(PROJECT_COST_SOURCES_TABLE_SCHEMA_SQL);
  // كل قراءات اللوحة تبدأ بـ(المشروع، اليوم): إجمالي، وسلسلة يومية، وإحصاءات.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_project_cost_daily_project
       ON project_cost_daily(project_id, day)`
  );
  // جسر المسار: مشروع أُعيد تسجيله بمُعرِّف جديد يستعيد تاريخه عبر مساره.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_project_cost_daily_path
       ON project_cost_daily(project_path, day)`
  );
  // إعادة المسح تحذف صفوف المصدر أوّلاً — بلا هذا الفهرس كل ملف يعني مسحاً كاملاً.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_project_cost_daily_source ON project_cost_daily(source_key)'
  );
};

/**
 * provider_run_failures (T-1191) — the last failed run's cause per conversation,
 * plus the quota reset instant when the cause was an exhausted quota.
 *
 * Idempotent (IF NOT EXISTS) and with NO backfill: past failures left no record
 * anywhere that could be replayed — their whole defect was that the cause was
 * written to stderr and nowhere else. The table fills from the next failure on.
 *
 * The index serves the provider-level read (`getActiveQuotaBlock`): "is this
 * provider currently quota-blocked, and until when?" — a lookup by provider
 * ordered by reset instant, run on every header poll.
 */
/**
 * ‏B-577/T-1340 — حالة نهاية الجولة وإقرار رؤيتها حقيقتان خادميتان مشتركتان.
 *
 * الجدولان معاً في ترحيلٍ واحد: أحدهما بلا الآخر يعطي إمّا شارةً لا تُطفأ
 * أبداً، وإمّا إقراراً بلا شيءٍ يُقَرّ به.
 */
export const migrateSessionOutcomes = (db: Database): void => {
  db.exec(SESSION_RUN_OUTCOMES_TABLE_SCHEMA_SQL);
  db.exec(SESSION_OUTCOME_READS_TABLE_SCHEMA_SQL);
  const columns = db.prepare('PRAGMA table_info(session_run_outcomes)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'global_seen_at')) {
    db.exec('ALTER TABLE session_run_outcomes ADD COLUMN global_seen_at DATETIME DEFAULT NULL');
  }
  // ترقية دلالة القراءة الشخصية القديمة إلى الإقرار العالمي: يكفي أن يكون أي
  // عضو قد قرأ النسخة الحالية. السؤال مستثنى لأن فتحه لا يستهلكه في T-1340.
  db.exec(
    `UPDATE session_run_outcomes
        SET global_seen_at = (
          SELECT MAX(r.seen_at)
            FROM session_outcome_reads r
           WHERE r.session_id = session_run_outcomes.session_id
             AND r.seen_at >= session_run_outcomes.outcome_at
        )
      WHERE outcome IN ('done', 'error')
        AND global_seen_at IS NULL
        AND EXISTS (
          SELECT 1 FROM session_outcome_reads r
           WHERE r.session_id = session_run_outcomes.session_id
             AND r.seen_at >= session_run_outcomes.outcome_at
        )`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_session_run_outcomes_at
       ON session_run_outcomes(outcome_at)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_session_outcome_reads_user
       ON session_outcome_reads(user_id)`
  );
};

/**
 * شواهدُ الحذف (ADR-114) — الجدولُ الذي يمنع عودة محادثةٍ حُذفت عن قصد.
 *
 * ‏idempotent وبلا أي تعبئة رجعية: المحذوفُ قبل هذا الترحيل لا شاهدَ له، وهذا
 * صحيح — لم يُتَّخذ فيه قرارُ حذفٍ محروس. والفهرسان هنا لا في `INIT_SCHEMA_SQL`.
 */
const migrateSessionTombstones = (db: Database): void => {
  db.exec(SESSION_TOMBSTONES_TABLE_SCHEMA_SQL);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_session_tombstones_project
       ON session_tombstones(project_path)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_session_tombstones_deleted_at
       ON session_tombstones(deleted_at)`
  );
};

const migrateProviderRunFailures = (db: Database): void => {
  db.exec(PROVIDER_RUN_FAILURES_TABLE_SCHEMA_SQL);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_provider_run_failures_quota
       ON provider_run_failures(provider, quota_resets_at)`
  );
};

/**
 * Adds ON DELETE CASCADE from session_agents_cache and session_agents_meta to
 * sessions. SQLite does not support ALTER TABLE … ADD CONSTRAINT, so we use
 * the safe rename-and-rebuild pattern inside an explicit transaction.
 *
 * Idempotent: checks whether the FK already carries the CASCADE action by
 * inspecting `PRAGMA foreign_key_list` — a rebuild is only performed when
 * needed, so this function is always safe to call during boot.
 *
 * Data preservation is guaranteed: all existing rows AND columns are copied to
 * the new tables before the old ones are dropped — including the later-added
 * `agent_model` column when the source database already carries it (B-148). The
 * operation runs under a single transaction so a partial failure leaves the
 * original tables intact.
 *
 * (B-38 / ADR-023.)
 */
export const migrateSessionAgentsCascade = (db: Database): void => {
  type FkListRow = { table: string; on_delete: string };

  const cascadeNeededFor = (tableName: string): boolean => {
    if (!tableExists(db, tableName)) {
      return false;
    }
    const fkList = db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as FkListRow[];
    // Look for the FK that points at sessions — if it's already CASCADE we're done.
    const sessionFk = fkList.find((row) => row.table === 'sessions');
    return !sessionFk || sessionFk.on_delete !== 'CASCADE';
  };

  const needsCacheRebuild = cascadeNeededFor('session_agents_cache');
  const needsMetaRebuild = cascadeNeededFor('session_agents_meta');

  if (!needsCacheRebuild && !needsMetaRebuild) {
    return;
  }

  console.log('Running migration: Adding ON DELETE CASCADE to session_agents tables');

  backupDatabaseBeforeRebuild(db, 'session-agents-cascade');
  const violationsBeforeRebuild = summarizeForeignKeyViolations(readForeignKeyViolations(db));

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');

    if (needsCacheRebuild) {
      // Preserve agent_model (B-148): the live schema carries an agent_model
      // column, but databases created before it was added do not. Detect whether
      // the source table has the column and copy it when present so the rebuild
      // never silently drops resolved model values. The __new table always
      // declares agent_model, matching SESSION_AGENTS_CACHE_TABLE_SCHEMA_SQL, so
      // migrateSessionAgentsModel (which runs next) becomes a no-op afterwards.
      const cacheHasModel = getTableInfo(db, 'session_agents_cache').some(
        (col) => col.name === 'agent_model'
      );
      // Same rule for the T-1144 provider fingerprint: copy it when the source
      // table already carries it, so the rebuild never silently drops the
      // wire-derived provider evidence (the B-148 lesson applied a second time).
      const cacheHasProvider = getTableInfo(db, 'session_agents_cache').some(
        (col) => col.name === 'agent_provider'
      );

      db.exec('DROP TABLE IF EXISTS session_agents_cache__new');
      db.exec(`
        CREATE TABLE session_agents_cache__new (
          session_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          agent_kind TEXT NOT NULL,
          invocation_count INTEGER DEFAULT 1,
          agent_model TEXT DEFAULT NULL,
          agent_provider TEXT DEFAULT NULL,
          PRIMARY KEY (session_id, agent_name, agent_kind),
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        )
      `);
      if (cacheHasModel) {
        db.exec(`
          INSERT INTO session_agents_cache__new
            (session_id, agent_name, agent_kind, invocation_count, agent_model${cacheHasProvider ? ', agent_provider' : ''})
          SELECT session_id, agent_name, agent_kind, invocation_count, agent_model${cacheHasProvider ? ', agent_provider' : ''}
          FROM session_agents_cache
        `);
      } else {
        db.exec(`
          INSERT INTO session_agents_cache__new
            (session_id, agent_name, agent_kind, invocation_count)
          SELECT session_id, agent_name, agent_kind, invocation_count
          FROM session_agents_cache
        `);
      }
      db.exec('DROP TABLE session_agents_cache');
      db.exec('ALTER TABLE session_agents_cache__new RENAME TO session_agents_cache');
      // Recreate the index that normally lives in migrateParticipantsAndAgents.
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_session_agents_cache_session ON session_agents_cache(session_id)'
      );
    }

    if (needsMetaRebuild) {
      db.exec('DROP TABLE IF EXISTS session_agents_meta__new');
      db.exec(`
        CREATE TABLE session_agents_meta__new (
          session_id TEXT PRIMARY KEY,
          transcript_mtime INTEGER NOT NULL,
          parsed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO session_agents_meta__new
          (session_id, transcript_mtime, parsed_at)
        SELECT session_id, transcript_mtime, parsed_at
        FROM session_agents_meta
      `);
      db.exec('DROP TABLE session_agents_meta');
      db.exec('ALTER TABLE session_agents_meta__new RENAME TO session_agents_meta');
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  assertRebuildPreservedIntegrity(db, 'session-agents-cascade', violationsBeforeRebuild);
};

/**
 * Adds the `agent_model` column to `session_agents_cache` so that the
 * transcript parser can record the resolved model string for each agent
 * (coordinator model and per-subagent model when recoverable from subagent
 * JSONL files). Idempotent — uses `addColumnToTableIfNotExists`.
 *
 * Fresh installs already have this column from SESSION_AGENTS_CACHE_TABLE_SCHEMA_SQL;
 * this migration handles existing databases that were created before the column
 * was added.
 */
const migrateSessionAgentsModel = (db: Database): void => {
  if (!tableExists(db, 'session_agents_cache')) {
    return;
  }
  const cols = (db.prepare('PRAGMA table_info(session_agents_cache)').all() as { name: string }[]).map(
    (r) => r.name
  );
  addColumnToTableIfNotExists(db, 'session_agents_cache', cols, 'agent_model', 'TEXT DEFAULT NULL');
  /**
   * T-1144: `agent_provider` — the wire fingerprint of the provider that
   * answered with each model (msg_/req_ ⇒ anthropic, chatcmpl- ⇒ vendor named
   * via its catalog; provider-fingerprint.js). No backfill: pre-existing rows
   * keep NULL until their session is re-parsed, which the epoch-2 bump in
   * transcript-parser.js forces on first read.
   */
  addColumnToTableIfNotExists(db, 'session_agents_cache', cols, 'agent_provider', 'TEXT DEFAULT NULL');
  /**
   * B-352: `sort_order` preserves the order the parser produced — for models,
   * the order they first answered in the transcript.
   *
   * Without it a cache HIT and a fresh PARSE of the same session disagree: the
   * read ordered alphabetically while the parser returned chronologically, so a
   * conversation's model chips silently reshuffled the moment its rows came
   * from cache. No backfill: pre-existing rows default to 0 and keep the old
   * alphabetical tiebreak until their session is re-parsed (which the cache
   * epoch forces on first read anyway).
   */
  addColumnToTableIfNotExists(db, 'session_agents_cache', cols, 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
};


/**
 * User-to-user credential grants (T-1675). Creates the
 * `provider_credential_grants` table and the one index the hot path needs: the
 * spawn-time question is "does THIS grantee hold a live grant for THIS
 * provider", which the composite primary key (owner-first) does not cover.
 *
 * NO BACKFILL: an empty table means every member runs on their own credential,
 * which is the base state the feature starts from. Must run AFTER users exists
 * so both FKs resolve.
 */
const migrateProviderCredentialGrants = (db: Database): void => {
  db.exec(PROVIDER_CREDENTIAL_GRANTS_TABLE_SCHEMA_SQL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_provider_credential_grants_grantee '
      + 'ON provider_credential_grants(grantee_user_id, provider)'
  );
};

export const runMigrations = (db: Database) => {
  try {
    const usersTableInfo = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const userColumnNames = usersTableInfo.map((column) => column.name);

    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_name', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_email', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'avatar_url', 'TEXT');
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'has_completed_onboarding',
      'BOOLEAN DEFAULT 0'
    );

    migrateMultiUserAuth(db, userColumnNames);
    // Convert bearer secrets before any destructive migration can snapshot the
    // database or any repository can expose them to the running application.
    migrateApiKeysToDigests(db);
    migrateUserCredentialsEncryption(db);
    // Server-action queue (ADR-066, T-944) — after migrateMultiUserAuth so it
    // joins the auth-cluster tables; no FK dependency of its own.
    migratePendingServerActions(db);
    migrateSourceUpdateJobs(db);
    migrateSourceUpdateAutoActivate(db);
    // T-1730 W6 (ADR-156 §3.3): widen the state CHECK for declared deferral and
    // add the INTEGER deferral columns. After the auto_activate column so the
    // rebuild copies it forward. The rebuild needs VACUUM INTO and its own
    // BEGIN, both illegal inside a transaction; under the connector fence
    // (B-1147) initializeDatabase runs it right after the fenced block.
    if (!db.inTransaction) migrateSourceUpdateDeferral(db);
    // audit_log.user_agent (T-182) — after migrateMultiUserAuth has ensured the
    // audit_log table exists, so the additive column migration finds its target.
    migrateAuditLogUserAgent(db);
    migratePasswordLifecycle(db, userColumnNames);
    // ADR-134: additive permission decisions, leases, transitions, and actor
    // revocation generation. This creates no fleet marker or protocol floor.
    migratePermissionExecution(db);

    db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
    db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL);
    db.exec(VAPID_KEYS_TABLE_SCHEMA_SQL);
    db.exec(PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)');

    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    rebuildProjectsTableWithPrimaryKeySchema(db);

    migrateLegacyWorkspaceTableIntoProjects(db);
    rebuildSessionsTableWithProjectSchema(db);
    migrateLegacySessionNames(db);
    ensureProjectsForSessionPaths(db);
    migrateSessionWorkspaceModes(db);

    db.exec('CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_is_archived ON sessions(isArchived)');

    // jsonl_path lookups were full table scans. Both callers run per filesystem
    // event: the watcher's unlink handler (deleteSessionsByJsonlPath) and the
    // synchronizer's ghost sweep (getSessionFilePathsByProvider), so the scan
    // cost is paid on every transcript write, not once.
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_jsonl_path ON sessions(jsonl_path)');
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_provider_jsonl_path
         ON sessions(provider, jsonl_path)`
    );
    // Covers the sidebar page query (project_path = ? AND isArchived = 0
    // ORDER BY created_at DESC) end to end, including its ordering.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_project_archived_created
         ON sessions(project_path, isArchived, created_at DESC)`
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_starred ON projects(isStarred)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON projects(isArchived)');

    db.exec('DROP INDEX IF EXISTS idx_session_names_lookup');
    db.exec('DROP INDEX IF EXISTS idx_sessions_workspace_path');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_is_starred');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_workspace_id');

    if (tableExists(db, 'workspace_original_paths')) {
      console.log('Running migration: Dropping legacy workspace_original_paths table');
      db.exec('DROP TABLE workspace_original_paths');
    }

    db.exec(LAST_SCANNED_AT_SQL);

    // Participant & agent tracking — must run after sessions/users exist so the
    // FKs resolve and the owner backfill can find both tables.
    migrateParticipantsAndAgents(db);

    // Message sender attribution — after users exist so the FK resolves.
    migrateMessageAuthors(db);
    migrateMessageCoordination(db);
    migrateTurnSupervisor(db);

    // Participant attribution + ownership repair (ADR-104, B-476/B-477) — MUST
    // follow migrateMessageAuthors: the provenance signature reads that table to
    // tell an inferred row from a real one.
    migrateParticipantAttributionAndOwnership(db);

    // Private-project visibility + membership — after the projects table has its
    // project_id primary key (rebuildProjectsTableWithPrimaryKeySchema, above)
    // and after users exist so the project_members FKs resolve.
    migrateProjectVisibility(db);
    migrateProjectMembers(db);

    // Passkeys (WebAuthn) — after users exist so the FK resolves.
    migrateWebAuthnCredentials(db);

    // Per-user session stars — after users exist so the FK resolves.
    migrateStarredSessions(db);

    // Global "conversation closed" markers — after users exist so the
    // closed_by FK resolves.
    migrateClosedSessions(db);

    // Durable per-project cost ledger (ADR-078). No FK of its own, so ordering
    // is free; kept next to the other presentation-layer tables.
    migrateProjectCostLedger(db);
    migrateUsageIngestionV2(db);
    migrateUsageStatisticsV3(db);
    migrateResponseTurnMetrics(db);
    migrateTurnResourceLeases(db);

    // Last-failure cause per conversation (T-1191). No FK, so ordering against
    // the sessions table does not matter; kept beside the other standalone
    // marker tables.
    migrateProviderRunFailures(db);
    migrateSessionOutcomes(db);
    migrateSessionTombstones(db);
    migrateScheduledMessages(db);
    migrateLocalModelServers(db);

    // OIDC identity linking (P-IDP-3, ADR-046) — after users exist so the
    // user_id FK resolves. Idempotent (IF NOT EXISTS); no backfill (links are
    // created explicitly when a user authenticates through or connects an IdP).
    if (!tableExists(db, 'user_identities')) {
      console.log('Running migration: Creating user_identities table');
      db.exec(USER_IDENTITIES_TABLE_SCHEMA_SQL);
    }

    // External platform connectors (T-1226, ADR-098) — after users exist so the
    // created_by FK resolves. Idempotent; no backfill (a connector is only ever
    // created by an explicit operator action).
    migrateConnectors(db);
    migrateConnectorPlacements(db);
    migrateConnectorOAuthPending(db);

    // Per-user governance exemptions (owner decision 2026-08-08) — after users
    // exists so the user_id/granted_by FKs resolve. Idempotent; no backfill (an
    // absent row IS "governed", so there is nothing to seed).
    migrateGovernanceExemptions(db);

    // User-to-user credential grants (T-1675) — after users exists so the
    // owner/grantee FKs resolve. Idempotent; no backfill (empty = all isolated).
    migrateProviderCredentialGrants(db);

    // FK CASCADE on session_agents tables — must run after sessions exist so
    // the REFERENCES sessions(session_id) constraint is satisfiable. (B-38.)
    migrateSessionAgentsCascade(db);

    // agent_model column on session_agents_cache — stores the resolved model
    // string for each agent row so the UI can display per-agent model badges.
    migrateSessionAgentsModel(db);

    // Internal session team chat (T-1860, ADR-187) — ordered after every
    // existing migration; its FKs need sessions and users only.
    migrateInternalSessionChat(db);

    // Refresh the query planner's statistics (sqlite_stat1). Without them SQLite
    // plans on defaults alone and picks indexes on its own guesswork — which is
    // how the sidebar query ended up choosing a two-value boolean index over the
    // project_path one. Runs last so it measures the final schema, and is
    // best-effort: stale statistics degrade plans, a failure here must not block
    // boot. (ANALYZE is incremental and cheap at this database's size.)
    try {
      db.exec('ANALYZE');
    } catch (analyzeError: any) {
      console.error('ANALYZE failed after migrations (non-fatal)', {
        error: analyzeError?.message ?? String(analyzeError),
      });
    }

    console.log('Database migrations completed successfully');
  } catch (error: any) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};

/** Retention horizon for audit_log rows (T-182, qa-critic D-3): 90 days. */
const AUDIT_LOG_RETENTION_DAYS = 90;

/**
 * Prunes audit_log rows older than the retention horizon (T-182, qa-critic D-3).
 * The audit log is append-only and grows unbounded otherwise; this bounds it to
 * a rolling 90-day window. Called once at boot after runMigrations (best-effort:
 * a prune failure must never block startup). Parameterized + guarded by
 * tableExists so it is a safe no-op on a pre-bootstrap database.
 */
export const pruneAuditLog = (db: Database): void => {
  try {
    if (!tableExists(db, 'audit_log')) {
      return;
    }
    const cutoff = `-${AUDIT_LOG_RETENTION_DAYS} days`;
    const result = db
      .prepare("DELETE FROM audit_log WHERE created_at < datetime('now', ?)")
      .run(cutoff);
    if (result.changes > 0) {
      console.log('Pruned old audit_log rows', { deleted: result.changes });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Failed to prune audit_log (non-fatal)', { error: message });
  }
};

/**
 * Grace window (days) before an orphaned attribution/star row may be pruned
 * (B-149). `message_authors` and `starred_sessions` intentionally carry NO FK
 * on session_id — sessions are synchronized lazily, so a freshly created star
 * or author row may briefly reference a session whose `sessions` row has not
 * been synced yet (see the schema comments on both tables). Only rows older
 * than this window are eligible, so a row pending its session's first sync is
 * never removed — we only ever prune references to sessions that are genuinely
 * gone (e.g. hard-deleted long ago).
 */
const ORPHAN_SESSION_REF_GRACE_DAYS = 7;

/**
 * جداولٌ تُشير إلى جلساتٍ غير موجودة **عن قصد** فلا تكنسها هذه المكنسة أبداً
 * (ADR-114).
 *
 * ‏`session_tombstones` هو الحالة الوحيدة اليوم، والإشارةُ المعلَّقة فيه **هي
 * غرضُ الصفّ لا عطبُه**: الشاهد موجودٌ لأن صفَّ الجلسة غير موجود. وكنسُه يُعيد
 * البعث بالضبط — تُحذف المحادثة، فيُكنس شاهدها بعد سبعة أيام، فتُعيدها أوّلُ
 * مزامنةٍ إن كان نصُّها ما يزال على القرص.
 *
 * وتقليمُ الشواهد له قاعدةٌ أخرى تماماً («زوال الأثر» لا العمر — انظر عقد
 * الجدول في `schema.ts`)، ولا مقلِّمَ لها في هذه النسخة. فمن أضاف جدولاً هنا
 * لاحقاً بحسن نيّة: تحقّق أنه ليس من هذا الصنف.
 */
export const TABLES_EXEMPT_FROM_ORPHAN_PRUNE = ['session_tombstones'] as const;

/**
 * البوابةُ التي تمرّ منها كلُّ كتلة كنسٍ في `pruneOrphanSessionRefs`.
 *
 * وجودُها بدل `tableExists` المجرّدة مقصود: مَن أضاف كتلةً جديدة نسخَ المجاورة،
 * فورث الحمايةَ بلا أن يعرفها. والثابتُ أعلاه لو بقي بلا مستعملٍ لكان تعليقاً
 * يزعم حمايةً غير موجودة.
 */
const isPrunableSessionRefTable = (db: Database, table: string): boolean => {
  if ((TABLES_EXEMPT_FROM_ORPHAN_PRUNE as readonly string[]).includes(table)) {
    return false;
  }
  return tableExists(db, table);
};

/**
 * Maximum orphan rows deleted per table per run (B-149). Bounds the DELETE so a
 * large accumulated backlog is cleared across successive boots rather than in a
 * single oversized transaction.
 */
const ORPHAN_SESSION_REF_BATCH_LIMIT = 5000;

/**
 * Prunes orphaned rows in the session-reference tables (B-149). A row is
 * orphaned when NO matching row exists in `sessions`. Mirrors pruneAuditLog
 * exactly: called once at boot after runMigrations (best-effort — a prune
 * failure must never block startup), parameterized, guarded by tableExists, and
 * bounded by a per-table batch limit. The `datetime()` wrapper normalizes both
 * the ISO-8601 timestamps and the CURRENT_TIMESTAMP form in use across these
 * tables, and a row with an unparseable timestamp yields NULL (< is NULL →
 * falsy) so it is conservatively kept rather than deleted.
 *
 * Three tables are covered:
 *
 *   - `message_authors` / `starred_sessions` carry no FK on session_id by
 *     design, so nothing ever cleans them.
 *
 *   - `session_participants` DOES declare `REFERENCES sessions(session_id) ON
 *     DELETE CASCADE`, which is precisely why it was overlooked here — but the
 *     table-rebuild migrations run under `PRAGMA foreign_keys = OFF`, so rows
 *     survived a `sessions` rebuild as dangling references the cascade never
 *     saw. Leaving them is not a tidiness problem: `participantsDb.isParticipant()`
 *     is the sole authorization gate for session content, so when a session id
 *     is re-created (the synchronizer re-indexes a returning transcript file) a
 *     stale row instantly grants a past user ownership of the new session
 *     without any action on their part. Same grace window and batch limit as the
 *     other two: a participant row written just before its session is indexed is
 *     never touched.
 */
/**
 * Boot-time audit for duplicate session owners (T-1266). Counts, logs, and never
 * blocks.
 *
 * The unique index created in migrateParticipantAttributionAndOwnership already
 * makes duplicates impossible on a repaired database, which is exactly why this
 * exists: the interesting case is a database where that index could NOT be
 * created — a fleet node restored from an older backup, or a future write path
 * that finds its way around the repository. Without a counter, that state is
 * indistinguishable from a healthy one until a member notices somebody else's
 * name on their conversation.
 *
 * Deliberately NOT fail-closed. The damage a duplicate owner does is a wrong
 * badge plus a consent row that ADR-104's attribution filter already declaws;
 * taking the whole server down over it would trade a label bug for an outage —
 * and this install has already paid once for a boot path that refused to
 * complete (the drain/port incident). Logs to console AND audit_log so the
 * anomaly survives a log rotation.
 */
export const auditParticipantOwnership = (db: Database): void => {
  try {
    if (!tableExists(db, 'session_participants')) {
      return;
    }

    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT session_id FROM session_participants
           WHERE role = 'owner'
           GROUP BY session_id
           HAVING COUNT(*) > 1
         )`
      )
      .get() as { n: number } | undefined;

    const duplicates = row?.n ?? 0;
    if (duplicates === 0) {
      return;
    }

    console.error('Sessions with more than one owner detected (B-476)', { sessions: duplicates });
    db.prepare('INSERT INTO audit_log (user_id, action, metadata) VALUES (?, ?, ?)').run(
      null,
      'participants_duplicate_owner_detected',
      JSON.stringify({ sessions: duplicates })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Duplicate-owner audit failed', { error: message });
  }
};

export const pruneOrphanSessionRefs = (db: Database): void => {
  try {
    // Without the sessions table every row would look orphaned — refuse to run.
    if (!tableExists(db, 'sessions')) {
      return;
    }
    const cutoff = `-${ORPHAN_SESSION_REF_GRACE_DAYS} days`;

    if (isPrunableSessionRefTable(db, 'message_authors')) {
      const result = db
        .prepare(
          `DELETE FROM message_authors
           WHERE id IN (
             SELECT id FROM message_authors AS m
             WHERE NOT EXISTS (
               SELECT 1 FROM sessions AS s WHERE s.session_id = m.session_id
             )
               AND datetime(m.created_at) < datetime('now', ?)
             LIMIT ?
           )`
        )
        .run(cutoff, ORPHAN_SESSION_REF_BATCH_LIMIT);
      if (result.changes > 0) {
        console.log('Pruned orphaned message_authors rows', { deleted: result.changes });
      }
    }

    if (isPrunableSessionRefTable(db, 'starred_sessions')) {
      const result = db
        .prepare(
          `DELETE FROM starred_sessions
           WHERE rowid IN (
             SELECT rowid FROM starred_sessions AS ss
             WHERE NOT EXISTS (
               SELECT 1 FROM sessions AS s WHERE s.session_id = ss.session_id
             )
               AND datetime(ss.created_at) < datetime('now', ?)
             LIMIT ?
           )`
        )
        .run(cutoff, ORPHAN_SESSION_REF_BATCH_LIMIT);
      if (result.changes > 0) {
        console.log('Pruned orphaned starred_sessions rows', { deleted: result.changes });
      }
    }

    if (isPrunableSessionRefTable(db, 'session_participants')) {
      const result = db
        .prepare(
          `DELETE FROM session_participants
           WHERE rowid IN (
             SELECT rowid FROM session_participants AS sp
             WHERE NOT EXISTS (
               SELECT 1 FROM sessions AS s WHERE s.session_id = sp.session_id
             )
               AND datetime(sp.first_seen) < datetime('now', ?)
             LIMIT ?
           )`
        )
        .run(cutoff, ORPHAN_SESSION_REF_BATCH_LIMIT);
      if (result.changes > 0) {
        console.log('Pruned orphaned session_participants rows', { deleted: result.changes });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Failed to prune orphaned session refs (non-fatal)', { error: message });
  }
};
