import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type Identity = Readonly<{ realpath: string; device: string; inode: string }>;
const optionalStat = (file: string): fs.BigIntStats | null => {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};
const sameFile = (a: fs.BigIntStats, b: fs.BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
const digest = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Read-only filesystem inspection; the caller alone opens SQLite under its verified claim. */
export function inspectExistingStartupFiles(expected: Identity): () => void {
  const file = expected.realpath;
  const directory = path.dirname(file);
  const parent = fs.lstatSync(directory, { bigint: true });
  const main = fs.lstatSync(file, { bigint: true });
  const uid = BigInt(process.getuid!());
  if (!parent.isDirectory() || fs.realpathSync(directory) !== directory || parent.dev !== main.dev
    || parent.uid !== uid || (parent.mode & 0o022n) !== 0n) throw new Error('existing_startup_parent_unsafe');
  if (!main.isFile() || main.nlink !== 1n || fs.realpathSync(file) !== file || String(main.dev) !== expected.device
    || String(main.ino) !== expected.inode || main.uid !== uid || (main.mode & 0o777n) !== 0o600n) {
    throw new Error('existing_startup_database_unsafe');
  }
  const checkSidecars = (): Array<fs.BigIntStats | null> => {
    if (optionalStat(`${file}-journal`)) throw new Error('existing_startup_rollback_journal_present');
    return ['-wal', '-shm'].map(suffix => {
      const metadata = optionalStat(file + suffix);
      if (metadata && (!metadata.isFile() || metadata.nlink !== 1n || fs.realpathSync(file + suffix) !== file + suffix
        || metadata.dev !== main.dev || metadata.uid !== uid || (metadata.mode & 0o777n) !== 0o600n)) {
        throw new Error('existing_startup_sidecar_unsafe');
      }
      return metadata;
    });
  };
  const sidecars = checkSidecars();
  const mainDigest = digest(file);
  return () => {
    if (!sameFile(parent, fs.lstatSync(directory, { bigint: true })) || fs.realpathSync(directory) !== directory
      || !sameFile(main, fs.lstatSync(file, { bigint: true })) || fs.realpathSync(file) !== file
      || digest(file) !== mainDigest) throw new Error('existing_startup_database_files_changed');
    const after = checkSidecars();
    if (sidecars.some((before, index) => before && (!after[index] || !sameFile(before, after[index]!)))) {
      throw new Error('existing_startup_sidecar_changed');
    }
  };
}
