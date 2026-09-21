import fs from 'node:fs';
import path from 'node:path';
import { createVerifiedSqliteBackup, verifySqliteDatabase } from './release-database-backup.mjs';

const TX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SCHEMA = 'nassaj-update-database-snapshot/v1';
function privatePath(file, directory = false) {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()) || (st.mode & 0o077)
        || (process.getuid && st.uid !== process.getuid())) throw new Error('database_snapshot_path_unsafe');
    if (fs.realpathSync(file) !== path.resolve(file)) throw new Error('database_snapshot_path_unsafe');
}
function durableWrite(file, value) {
    const temp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    const parent = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
/** Reload and verify the immutable baseline without trusting in-memory metadata. */
export function readDatabaseSnapshot({ snapshotRoot, transactionId, databasePath, targetCommit = null, actionId = transactionId }) {
    if (!TX.test(transactionId || '')) throw new Error('database_snapshot_transaction_invalid');
    privatePath(snapshotRoot, true);
    const snapshotDir = path.join(snapshotRoot, transactionId);
    privatePath(snapshotDir, true);
    const descriptorFile = path.join(snapshotDir, 'descriptor.json');
    privatePath(descriptorFile);
    const value = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'));
    if (value.schema !== SCHEMA || value.transactionId !== transactionId || value.actionId !== actionId
        || value.targetCommit !== targetCommit || value.databasePath !== path.resolve(databasePath)
        || value.snapshotFile !== path.join(snapshotDir, 'pre-update.sqlite') || value.snapshotDir !== snapshotDir
        || value.basename !== 'pre-update.sqlite' || value.phase !== 'CAPTURED') throw new Error('database_snapshot_descriptor_invalid');
    privatePath(value.snapshotFile);
    const verified = verifySqliteDatabase(value.snapshotFile);
    if (verified.schemaDigest !== value.snapshotSchemaDigest || verified.fingerprint.sha256 !== value.snapshotFingerprint?.sha256
        || verified.fingerprint.size !== value.snapshotFingerprint?.size) throw new Error('database_snapshot_verification_failed');
    return Object.freeze(value);
}
/** Retention only removes explicitly terminal snapshots; unknown/manual transactions stay pinned. */
export function pruneDatabaseSnapshots(snapshotRoot, keep = 2) {
    if (!fs.existsSync(snapshotRoot)) return [];
    const eligible = fs.readdirSync(snapshotRoot, { withFileTypes: true }).filter(e => e.isDirectory() && TX.test(e.name))
        .map(e => path.join(snapshotRoot, e.name)).filter(dir => {
            try { privatePath(dir, true); privatePath(path.join(dir, 'descriptor.json'));
                return JSON.parse(fs.readFileSync(path.join(dir, 'descriptor.json'), 'utf8')).phase === 'TERMINAL';
            } catch { return false; }
        }).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const removed = eligible.slice(Math.max(0, keep));
    for (const dir of removed) fs.rmSync(dir, { recursive: true });
    return removed;
}
/** Capture once, persisting intent and verified evidence before any artifact exchange. */
export function captureDatabaseSnapshot({ databasePath, snapshotRoot, transactionId, targetCommit = null,
    actionId = transactionId, statfs = fs.statfsSync }) {
    if (!TX.test(transactionId || '')) throw new Error('database_snapshot_transaction_invalid');
    if (!databasePath || !fs.existsSync(databasePath)) throw new Error('database_snapshot_source_missing');
    fs.mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
    privatePath(snapshotRoot, true);
    const snapshotDir = path.join(snapshotRoot, transactionId);
    if (fs.existsSync(snapshotDir)) return readDatabaseSnapshot({ snapshotRoot, transactionId, databasePath, targetCommit, actionId });
    const storage = statfs(snapshotRoot);
    if (Number(storage.type) === 0x01021994) throw new Error('database_snapshot_tmpfs');
    if (fs.statSync(snapshotRoot).dev !== fs.statSync(databasePath).dev) throw new Error('database_snapshot_cross_device');
    const walBytes = fs.existsSync(`${databasePath}-wal`) ? fs.statSync(`${databasePath}-wal`).size : 0;
    const required = (fs.statSync(databasePath).size + walBytes) * 2 + 16 * 1024 * 1024;
    const available = Number(storage.bavail) * Number(storage.bsize);
    if (!Number.isSafeInteger(available) || available < required) throw new Error('database_snapshot_insufficient_disk');
    fs.mkdirSync(snapshotDir, { mode: 0o700 });
    const rootFd = fs.openSync(snapshotRoot, 'r');
    try { fs.fsyncSync(rootFd); } finally { fs.closeSync(rootFd); }
    const descriptorFile = path.join(snapshotDir, 'descriptor.json');
    const identity = { schema: SCHEMA, transactionId, actionId, targetCommit, databasePath: path.resolve(databasePath),
        snapshotDir, snapshotFile: path.join(snapshotDir, 'pre-update.sqlite'), basename: 'pre-update.sqlite', phase: 'CAPTURE_INTENT' };
    durableWrite(descriptorFile, identity);
    const backup = createVerifiedSqliteBackup(databasePath, identity.snapshotFile);
    const value = { ...identity, phase: 'CAPTURED', state: 'captured', sourceSchemaDigest: backup.sourceSchemaDigest,
        snapshotSchemaDigest: backup.schemaDigest, snapshotFingerprint: backup.fingerprint };
    durableWrite(descriptorFile, value);
    return Object.freeze(value);
}
/** ADR-143 containment: a SQLite lock probe cannot prove continuous writer isolation. */
export function restoreDatabaseSnapshot() {
    throw new Error('database_restore_requires_manual_quiescence');
}
