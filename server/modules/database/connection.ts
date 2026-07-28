/**
 * Database connection management.
 *
 * Owns the single SQLite connection used across all repositories.
 * Handles path resolution, directory creation, legacy database migration,
 * and eager app_config bootstrap so the auth middleware can read the
 * JWT secret before the full schema is applied.
 *
 * Consumers should never create their own Database instance — they use
 * `getConnection()` to obtain the shared singleton.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { APP_CONFIG_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the database file path from environment or falls back
 * to the legacy location inside the server/database/ folder.
 *
 * Priority:
 *   1. DATABASE_PATH environment variable (set by cli.js or load-env-vars.js)
 *   2. Legacy path: server/database/auth.db
 */
function resolveDatabasePath(): string {
    // process.env.DATABASE_PATH is set by load-env-vars.js to either the .env value or a default(~/.cloudcli/auth.db) in the user's home directory. 
    return process.env.DATABASE_PATH || resolveLegacyDatabasePath();
}

/**
 * Resolves the legacy database path (always inside server/database/).
 * Used for the one-time migration to the new external location.
 */
function resolveLegacyDatabasePath(): string {
  const serverDir = path.resolve(__dirname, '..', '..', '..');
  return path.join(serverDir, 'database', 'auth.db');
}

// ---------------------------------------------------------------------------
// Directory & migration helpers
// ---------------------------------------------------------------------------

function ensureDatabaseDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('Created database directory:', dir);
  }
}

/**
 * Restricts the SQLite database (and its WAL/SHM sidecars when present) to
 * owner read/write only (0600). Under the shared system uid this keeps the
 * auth/users tables — including password hashes and any stored secrets — from
 * being read by another local process. (m-DBPERM / B-MU-OS-PERM, ADR-023.)
 *
 * chmod on a live SQLite file is safe: it changes the inode's mode without
 * touching open descriptors, so it never disrupts an active connection.
 * Tolerant of missing sidecars and non-fatal on error — a permissions failure
 * must not prevent the database from opening.
 */
function restrictDatabasePermissions(dbPath: string): void {
  for (const file of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try {
      if (fs.existsSync(file)) {
        fs.chmodSync(file, 0o600);
      }
    } catch (err: any) {
      console.error('Could not restrict database file permissions', {
        file,
        error: err?.message ?? String(err),
      });
    }
  }
}

/**
 * If the database was moved to an external location (e.g. ~/.cloudcli/)
 * but the user still has a legacy auth.db inside the install directory,
 * copy it to the new location as a one-time migration.
 */
function migrateLegacyDatabase(targetPath: string): void {
  const legacyPath = resolveLegacyDatabasePath();

  if (targetPath === legacyPath) return;
  if (fs.existsSync(targetPath)) return;
  if (!fs.existsSync(legacyPath)) return;

  try {
    fs.copyFileSync(legacyPath, targetPath);
    console.log('Migrated legacy database', { from: legacyPath, to: targetPath });


    // copy the write-ahead log and shared memory files (auth.db-wal, auth.db-shm) if they exist, to preserve any uncommitted transactions
    for (const suffix of ['-wal', '-shm']) {
      const src = legacyPath + suffix;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, targetPath + suffix);
      }
    }
  } catch (err: any) {
    console.error('Could not migrate legacy database', { error: err.message });
  }
}


// ---------------------------------------------------------------------------
// Test-isolation guard
// ---------------------------------------------------------------------------

/**
 * Escape hatch for the deliberate (rare) case of pointing a test run at a
 * non-temporary database. Must be set explicitly to '1' — its absence is the
 * safe default.
 */
const ALLOW_NON_TEMP_TEST_DB_ENV = 'NASSAJ_ALLOW_NON_TEMP_TEST_DB';

/**
 * True when this process is executing an automated test suite.
 *
 * `NODE_ENV` alone is NOT sufficient: the server test script does not set it,
 * and a shell that has sourced the deployment env exports `NODE_ENV=production`
 * — exactly the situation in which the guard is most needed. `NODE_TEST_CONTEXT`
 * is set by the node:test runner in every test process, and `VITEST` by Vitest,
 * so together they detect a test run regardless of how NODE_ENV is set.
 */
function isTestRuntime(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    typeof process.env.NODE_TEST_CONTEXT === 'string' ||
    process.env.VITEST === 'true'
  );
}

/** Resolves the realpath of the deepest existing ancestor of `target`. */
function realpathOfNearestExistingAncestor(target: string): string {
  let current = path.resolve(target);
  for (;;) {
    try {
      return fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

function isPathInside(child: string, parent: string): boolean {
  const normalizedParent = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child === parent || child.startsWith(normalizedParent);
}

/**
 * True when `target` lives under a temporary directory. Both the literal path
 * and the realpath of its nearest existing ancestor are tested so a symlinked
 * temp root (e.g. macOS /tmp → /private/tmp) is still recognised.
 */
function isUnderTemporaryDirectory(target: string): boolean {
  const resolvedTarget = path.resolve(target);
  const realTarget = realpathOfNearestExistingAncestor(resolvedTarget);

  const roots = new Set<string>();
  for (const raw of [os.tmpdir(), process.env.TMPDIR, '/tmp', '/var/tmp']) {
    if (!raw) continue;
    const absolute = path.resolve(raw);
    roots.add(absolute);
    try {
      roots.add(fs.realpathSync(absolute));
    } catch {
      // A non-existent temp root simply contributes nothing.
    }
  }

  for (const root of roots) {
    if (isPathInside(resolvedTarget, root) || isPathInside(realTarget, root)) {
      return true;
    }
  }
  return false;
}

/**
 * Refuses to open a real database from a test run.
 *
 * `resolveDatabasePath()` falls back to the in-repo `server/database/auth.db`
 * when DATABASE_PATH is unset, but when it IS set — which is the case in any
 * shell that sourced the deployment environment — it points at the LIVE
 * production database. Without this guard a plain `npm test` in such a shell
 * runs the whole suite, migrations and all, against production data.
 *
 * Accepted in a test runtime: any path under a temporary directory (the
 * isolation pattern every database test already uses) and the in-repo scratch
 * database that is the historical no-DATABASE_PATH fallback. Everything else
 * throws before the connection is opened, so nothing is created or written.
 */
function assertTestDatabaseIsIsolated(dbPath: string): void {
  if (!isTestRuntime()) return;
  if (process.env[ALLOW_NON_TEMP_TEST_DB_ENV] === '1') return;
  if (isUnderTemporaryDirectory(dbPath)) return;
  if (path.resolve(dbPath) === path.resolve(resolveLegacyDatabasePath())) return;

  throw new Error(
    `Refusing to open a non-isolated database from a test run: ${dbPath}. ` +
      'Point DATABASE_PATH at a file under a temporary directory (see the ' +
      'withIsolatedDatabase helper used by the database tests), or set ' +
      `${ALLOW_NON_TEMP_TEST_DB_ENV}=1 to override deliberately.`
  );
}

// ---------------------------------------------------------------------------
// Singleton connection
// ---------------------------------------------------------------------------

let instance: Database.Database | null = null;

/**
 * Returns the shared database connection, creating it on first call.
 *
 * The first invocation:
 *   1. Resolves the target database path
 *   2. Refuses a non-isolated database when running under a test runner
 *   3. Ensures the parent directory exists
 *   4. Migrates from the legacy install-directory path if needed
 *   5. Opens the SQLite connection
 *   6. Enables foreign-key enforcement (before ANY consumer can write)
 *   7. Eagerly creates the app_config table (auth reads JWT secret at import time)
 */
export function getConnection(): Database.Database {
  if (instance) return instance;

  const dbPath = resolveDatabasePath();

  // Before anything is created on disk: a test run must never touch a real
  // database, least of all the live one DATABASE_PATH may point at.
  assertTestDatabaseIsIsolated(dbPath);

  ensureDatabaseDirectory(dbPath);
  migrateLegacyDatabase(dbPath);

  instance = new Database(dbPath);

  // Lock the DB (and any WAL/SHM created by the open above) to 0600 so only
  // `nassaj` can read it under the shared system uid. Safe on a live handle.
  restrictDatabasePermissions(dbPath);

  // WAL journal mode: concurrent readers never block writers; a single writer
  // does not block readers. Safe to enable on an existing DB — SQLite converts
  // transparently. busy_timeout lets concurrent writes retry for up to 5 s
  // before returning SQLITE_BUSY, eliminating most race-condition errors under
  // concurrent session creation and synchronizer activity. (B-38 / ADR-023.)
  instance.pragma('journal_mode = WAL');
  instance.pragma('busy_timeout = 5000');

  // Foreign-key enforcement is OFF by default in SQLite and is a PER-CONNECTION
  // setting, so it must be enabled HERE — on the shared singleton, before any
  // consumer can use it. It used to be enabled only by INIT_SCHEMA_SQL, which
  // runs inside initializeDatabase(); every write performed between the first
  // getConnection() (the auth middleware reads the JWT secret at module-load
  // time) and that call therefore ran completely unconstrained. Enabling it at
  // open closes that window and removes the implicit ordering assumption the
  // repositories were relying on.
  instance.pragma('foreign_keys = ON');

  // app_config must exist immediately — the auth middleware reads
  // the JWT secret at module-load time, before initializeDatabase() runs.
  instance.exec(APP_CONFIG_TABLE_SCHEMA_SQL);

  return instance;
}

/**
 * Checkpoints the write-ahead log into the main database file.
 *
 * In WAL mode a committed transaction lives in the `-wal` sidecar until a
 * checkpoint folds it back into the database file. Any backup that copies only
 * the main file therefore silently loses every commit still sitting in the WAL
 * — on this install the live WAL has repeatedly been several times larger than
 * the database itself, i.e. a `cp`-style backup can lose hours of writes.
 *
 * TRUNCATE is the default mode: it blocks until every frame has been written
 * back and then resets the WAL to zero length, which is what a caller wanting a
 * consistent on-disk file (shutdown, pre-backup, maintenance) actually wants.
 * PASSIVE never blocks other connections but may checkpoint nothing.
 *
 * Best-effort by contract: returns null when no connection is open or when
 * SQLite refuses (e.g. a concurrent reader holds the WAL), and never throws, so
 * a caller on a shutdown path can invoke it unconditionally.
 */
export function checkpointWal(
  mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'TRUNCATE'
): { busy: number; log: number; checkpointed: number } | null {
  if (!instance) return null;

  try {
    const rows = instance.pragma(`wal_checkpoint(${mode})`) as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const result = Array.isArray(rows) ? rows[0] : null;
    if (!result) return null;

    if (result.busy !== 0) {
      console.warn('WAL checkpoint could not complete (database busy)', { mode, ...result });
    }
    return result;
  } catch (err: any) {
    console.error('WAL checkpoint failed', { mode, error: err?.message ?? String(err) });
    return null;
  }
}

/**
 * Returns the resolved database file path without opening a connection.
 * Useful for diagnostics and CLI status commands.
 */
export function getDatabasePath(): string {
  return resolveDatabasePath();
}

/**
 * Closes the database connection and clears the singleton.
 * Primarily used for graceful shutdown or testing.
 */
export function closeConnection(): void {
  if (instance) {
    instance.close();
    instance = null;
    console.log('Database connection closed');
  }
}
