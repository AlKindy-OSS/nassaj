import fs from 'node:fs';
import path from 'node:path';

import { Database } from 'better-sqlite3';

import {
  APP_CONFIG_TABLE_SCHEMA_SQL,
  AUDIT_LOG_TABLE_SCHEMA_SQL,
  CLOSED_SESSIONS_TABLE_SCHEMA_SQL,
  INVITES_TABLE_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  MESSAGE_AUTHORS_TABLE_SCHEMA_SQL,
  PENDING_SERVER_ACTIONS_TABLE_SCHEMA_SQL,
  PROJECT_COST_DAILY_TABLE_SCHEMA_SQL,
  PROJECT_COST_SOURCES_TABLE_SCHEMA_SQL,
  PROJECT_MEMBERS_TABLE_SCHEMA_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  SESSION_AGENTS_CACHE_TABLE_SCHEMA_SQL,
  SESSION_AGENTS_META_TABLE_SCHEMA_SQL,
  SESSION_PARTICIPANTS_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  STARRED_SESSIONS_TABLE_SCHEMA_SQL,
  USER_IDENTITIES_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
  WEBAUTHN_CREDENTIALS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';

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

// ---------------------------------------------------------------------------
// Rebuild safety net: backup, integrity check, quarantine
// ---------------------------------------------------------------------------

/** Sub-directory (next to the database file) holding pre-rebuild snapshots. */
const MIGRATION_BACKUP_DIR_NAME = 'migration-backups';

/**
 * Takes a consistent snapshot of the whole database before a destructive
 * migration branch (any DROP/RENAME table rebuild).
 *
 * `VACUUM INTO` is used rather than a file copy for one decisive reason: in WAL
 * mode a committed transaction lives in the `-wal` sidecar until it is
 * checkpointed, so copying the main database file alone loses every commit
 * still in the log — on this install the WAL has repeatedly been several times
 * larger than the database file itself. VACUUM INTO goes through SQLite, sees
 * the fully merged state, and writes a single self-contained file with no
 * sidecars to keep together.
 *
 * Retention: NONE. Snapshots accumulate deliberately — a migration backup is
 * the only path back from a bad rebuild, so nothing here ever deletes one. The
 * file is chmod 0600 because it contains the full users table (password
 * hashes, credentials) exactly like the database it snapshots.
 *
 * Best-effort by design: an unwritable directory or a failing VACUUM must not
 * block boot, so failures are logged and null is returned. Returns the snapshot
 * path on success, or null when skipped (in-memory database) or failed.
 */
const backupDatabaseBeforeRebuild = (db: Database, label: string): string | null => {
  const sourcePath = db.name;
  if (!sourcePath || sourcePath === ':memory:') {
    return null;
  }

  try {
    const directory = path.join(path.dirname(sourcePath), MIGRATION_BACKUP_DIR_NAME);
    fs.mkdirSync(directory, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(directory, `${stamp}-pre-${label}.sqlite`);

    // Parameterized: the destination is bound, never interpolated into SQL.
    db.prepare('VACUUM INTO ?').run(target);

    try {
      fs.chmodSync(target, 0o600);
    } catch (permissionError: any) {
      console.error('Could not restrict migration backup permissions', {
        target,
        error: permissionError?.message ?? String(permissionError),
      });
    }

    console.log('Created pre-migration database snapshot', { label, target });
    return target;
  } catch (err: any) {
    console.error('Could not create pre-migration database snapshot (non-fatal)', {
      label,
      error: err?.message ?? String(err),
    });
    return null;
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

const migrateLegacySessionNames = (db: Database): void => {
  const hasLegacySessionNamesTable = tableExists(db, 'session_names');
  const hasSessionsTable = tableExists(db, 'sessions');

  if (!hasLegacySessionNamesTable) {
    return;
  }

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
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0,
        visibility TEXT NOT NULL DEFAULT 'public',
        created_by INTEGER
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
          isArchived,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, source_rowid DESC
          ) AS session_rank
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
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_actions_dedup
       ON pending_server_actions(action_type, IFNULL(session_id, ''))
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

/**
 * Participant & agent tracking migration. Creates the three tracking tables and
 * their indexes (indexes live here, never in INIT_SCHEMA_SQL — see the 502
 * lesson where indexing migration-added columns at init broke fresh boots), then
 * backfills every existing session with the install owner as its 'owner'
 * participant so historical conversations are not left without an attributed
 * human. Idempotent: tables use IF NOT EXISTS and the backfill uses
 * INSERT OR IGNORE, so re-runs are no-ops. The backfill is recorded once in the
 * audit log per run that actually inserts rows.
 */
const migrateParticipantsAndAgents = (db: Database): void => {
  db.exec(SESSION_PARTICIPANTS_TABLE_SCHEMA_SQL);
  db.exec(SESSION_AGENTS_CACHE_TABLE_SCHEMA_SQL);
  db.exec(SESSION_AGENTS_META_TABLE_SCHEMA_SQL);

  db.exec('CREATE INDEX IF NOT EXISTS idx_session_participants_session ON session_participants(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_participants_user ON session_participants(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_agents_cache_session ON session_agents_cache(session_id)');

  // Backfill: attribute every existing session to the install owner so the
  // participant view is complete from day one. Skip silently when no owner
  // exists yet (pre-bootstrap install) or no sessions are present.
  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").get() as
    | { id: number }
    | undefined;

  if (!owner) {
    return;
  }

  const sessions = db.prepare('SELECT session_id FROM sessions').all() as { session_id: string }[];
  if (sessions.length === 0) {
    return;
  }

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

  // Defensive backfill: any NULL visibility (e.g. from a partial legacy rebuild)
  // resolves to the safe 'public' default so it is never silently hidden.
  db.exec("UPDATE projects SET visibility = 'public' WHERE visibility IS NULL");

  db.exec('CREATE INDEX IF NOT EXISTS idx_projects_visibility ON projects(visibility)');
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

      db.exec('DROP TABLE IF EXISTS session_agents_cache__new');
      db.exec(`
        CREATE TABLE session_agents_cache__new (
          session_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          agent_kind TEXT NOT NULL,
          invocation_count INTEGER DEFAULT 1,
          agent_model TEXT DEFAULT NULL,
          PRIMARY KEY (session_id, agent_name, agent_kind),
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        )
      `);
      if (cacheHasModel) {
        db.exec(`
          INSERT INTO session_agents_cache__new
            (session_id, agent_name, agent_kind, invocation_count, agent_model)
          SELECT session_id, agent_name, agent_kind, invocation_count, agent_model
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
    // Server-action queue (ADR-066, T-944) — after migrateMultiUserAuth so it
    // joins the auth-cluster tables; no FK dependency of its own.
    migratePendingServerActions(db);
    // audit_log.user_agent (T-182) — after migrateMultiUserAuth has ensured the
    // audit_log table exists, so the additive column migration finds its target.
    migrateAuditLogUserAgent(db);
    migratePasswordLifecycle(db, userColumnNames);

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

    // OIDC identity linking (P-IDP-3, ADR-046) — after users exist so the
    // user_id FK resolves. Idempotent (IF NOT EXISTS); no backfill (links are
    // created explicitly when a user authenticates through or connects an IdP).
    if (!tableExists(db, 'user_identities')) {
      console.log('Running migration: Creating user_identities table');
      db.exec(USER_IDENTITIES_TABLE_SCHEMA_SQL);
    }

    // FK CASCADE on session_agents tables — must run after sessions exist so
    // the REFERENCES sessions(session_id) constraint is satisfiable. (B-38.)
    migrateSessionAgentsCascade(db);

    // agent_model column on session_agents_cache — stores the resolved model
    // string for each agent row so the UI can display per-agent model badges.
    migrateSessionAgentsModel(db);

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
export const pruneOrphanSessionRefs = (db: Database): void => {
  try {
    // Without the sessions table every row would look orphaned — refuse to run.
    if (!tableExists(db, 'sessions')) {
      return;
    }
    const cutoff = `-${ORPHAN_SESSION_REF_GRACE_DAYS} days`;

    if (tableExists(db, 'message_authors')) {
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

    if (tableExists(db, 'starred_sessions')) {
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

    if (tableExists(db, 'session_participants')) {
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
