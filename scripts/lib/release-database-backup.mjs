import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { canonicalSchemaRowsDigest } from '../../server/modules/database/canonical-schema-digest.js';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function assertOwnerRegular(file, mode = 0o600) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== mode
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) throw new Error('database_file_unsafe');
    return metadata;
}
function readPrivate(file) {
    const before = assertOwnerRegular(file); const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const opened = fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('database_file_changed');
        return readFileSync(fd); } finally { closeSync(fd); }
}
function nativeSqlite(file, sql, json, vacuumTarget) {
    const Database = require('better-sqlite3');
    const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 120_000 });
    try {
        if (vacuumTarget !== null) {
            db.prepare('VACUUM INTO ?').run(vacuumTarget);
            return '';
        }
        const rows = db.prepare(sql).all();
        return json ? JSON.stringify(rows) : rows.map(row => Object.values(row).join('|')).join('\n');
    } finally { db.close(); }
}
function sqlite(file, sql, json = false, vacuumTarget = null) {
    try {
        try { return execFileSync('/usr/bin/sqlite3', [...(json ? ['-json'] : []), file, sql], { encoding: 'utf8',
            env: { PATH: '/usr/bin:/bin', HOME: path.dirname(file), LC_ALL: 'C' }, timeout: 120_000 }); }
        catch (error) {
            if (error?.code !== 'ENOENT' || error?.path !== '/usr/bin/sqlite3') throw error;
            return nativeSqlite(file, sql, json, vacuumTarget);
        }
    } catch { throw new Error('database_sqlite_operation_failed'); }
}
function schemaDigest(file) {
    const rows = JSON.parse(sqlite(file, "SELECT type,name,tbl_name AS tableName,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name", true) || '[]');
    return canonicalSchemaRowsDigest(rows);
}
export function fingerprintDatabase(file) {
    const metadata = assertOwnerRegular(file); const bytes = readPrivate(file);
    if (bytes.length < 100 || bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\u0000') throw new Error('database_not_sqlite');
    return Object.freeze({ sha256: sha(bytes), size: bytes.length, device: metadata.dev, inode: metadata.ino, mtimeMs: metadata.mtimeMs });
}
export function databaseSchemaDigest(file) { assertOwnerRegular(file); return schemaDigest(file); }
export function verifySqliteDatabase(file) {
    assertOwnerRegular(file);
    if (sqlite(file, 'PRAGMA integrity_check;').trim() !== 'ok' || sqlite(file, 'PRAGMA foreign_key_check;').trim() !== '') {
        throw new Error('database_backup_verification_failed');
    }
    return Object.freeze({ fingerprint: fingerprintDatabase(file), integrityCheck: 'ok', foreignKeyViolations: 0,
        schemaDigest: schemaDigest(file) });
}
export function createVerifiedSqliteBackup(source, target) {
    assertOwnerRegular(source); const parent = path.dirname(target); const parentMetadata = lstatSync(parent);
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink() || (parentMetadata.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && parentMetadata.uid !== process.getuid())) throw new Error('database_backup_parent_unsafe');
    if (statSync(parent).dev !== statSync(source).dev) throw new Error('database_backup_cross_device');
    sqlite(source, `VACUUM INTO '${target.replaceAll("'", "''")}';`, false, target); chmodSync(target, 0o600); assertOwnerRegular(target);
    const fd = openSync(target, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    const directoryFd = openSync(parent, 'r'); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    return Object.freeze({ ...verifySqliteDatabase(target), sourceWalIncluded: true, sourceSchemaDigest: schemaDigest(source) });
}
