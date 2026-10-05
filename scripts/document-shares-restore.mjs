#!/usr/bin/env node
import { existsSync, lstatSync, realpathSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Fail closed if this database is still open by an observable process. */
function assertOffline(databasePath) {
  const target = statSync(databasePath);
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    let descriptors;
    try { descriptors = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of descriptors) {
      let stat;
      try { stat = statSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (stat.dev === target.dev && stat.ino === target.ino) throw new Error('restored_database_is_open');
    }
  }
}

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

/**
 * Disable document AND session share links (ADR-196) in one transaction.
 * Session shares also lose their snapshot blob, as every revocation does.
 * @returns {{ documentShares: number, sessionShares: number }}
 */
function disableAll(db, at) {
  return db.transaction(() => ({
    documentShares: hasTable(db, 'document_shares')
      ? db.prepare('UPDATE document_shares SET revoked_at=COALESCE(revoked_at,?)').run(at).changes : 0,
    sessionShares: hasTable(db, 'session_shares')
      ? db.prepare(`UPDATE session_shares SET revoked_at=COALESCE(revoked_at,@at),
          revoke_reason=COALESCE(revoke_reason,'restored'), snapshot=NULL`).run({ at }).changes : 0,
  }))();
}

/**
 * Disable all links in an explicitly selected, offline restored copy inside this project.
 * @returns {number} rows disabled across document and session shares
 */
export function disableRestoredShares(databasePath) {
  const counts = disableRestoredShareTables(databasePath);
  return counts.documentShares + counts.sessionShares;
}

/** Same as disableRestoredShares, with a per-table count. */
export function disableRestoredShareTables(databasePath) {
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)) throw new Error('absolute_restored_copy_required');
  const resolved = realpathSync(databasePath);
  if (resolved !== databasePath || !resolved.startsWith(`${ROOT}${path.sep}`)
    || !lstatSync(resolved).isFile() || lstatSync(resolved).nlink !== 1) throw new Error('unsafe_restored_copy');
  const livePaths = [process.env.DATABASE_PATH, path.join(os.homedir(), '.local/share/nassaj-dev/db.sqlite')].filter(Boolean);
  if (livePaths.some((candidate) => existsSync(candidate) && realpathSync(candidate) === resolved)) throw new Error('live_database_refused');
  assertOffline(resolved);
  const db = new Database(resolved, { fileMustExist: true });
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('restored_database_invalid');
    const counts = disableAll(db, new Date().toISOString());
    db.pragma('wal_checkpoint(TRUNCATE)');
    return counts;
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--restored-copy' || args[2] !== '--confirm-disable-shares') {
    process.stderr.write('Usage: node scripts/document-shares-restore.mjs --restored-copy <absolute-project-copy.sqlite> --confirm-disable-shares\n');
    process.exitCode = 2;
  } else {
    try {
      const counts = disableRestoredShareTables(args[1]);
      process.stdout.write(JSON.stringify({ disabled: counts.documentShares + counts.sessionShares, ...counts }) + '\n');
    }
    catch { process.stderr.write('Restore preparation refused. Use a verified offline copy inside the project; never the active database.\n'); process.exitCode = 1; }
  }
}
