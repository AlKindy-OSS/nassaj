/**
 * Binary snapshot and restore of a harness install (T-1871 stage 3, spec §3, M-1).
 *
 * - Hard links only when the snapshot root and the origin share a device and
 *   the layout allows it; otherwise bytes are copied (and counted).
 * - Every regular file is recorded {rel, sha256, size, mode}; symlinks are
 *   recorded {rel, linkTarget} and never followed; any other type is refused.
 * - Before any restore every snapshot file is re-hashed: an in-place (O_TRUNC)
 *   write through a hard link, a missing file or a changed size is
 *   SNAPSHOT_TAMPERED and the live install is left untouched.
 * - Restore materializes next to the origin, fsyncs, renames atomically and
 *   swaps symlinks via temp link + rename + dir fsync. No live symlink ever
 *   points into the snapshot root.
 */

import fs from 'node:fs';
import path from 'node:path';

import { copyFileHashed, fsyncPath, hashFile, lstatOrNull, sha256Text } from './durable-fs.js';
import { snapshotError } from './errors.js';
import type { BinaryLayout, BinarySnapshotRecord, LinkMode, SymlinkRecord, TreeEntry } from './manifest.js';
import {
  asidePath,
  ensurePrivateDir,
  isPathInside,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  restoreTempPath,
  versionedRestoreTempPath,
  withPrivateUmask,
} from './paths.js';

/** How a harness install is laid out on disk (descriptor `snapshot` block). */
export interface BinaryLayoutSpec {
  layout: BinaryLayout;
  /** Preferred mode; `hardlink` silently degrades to `copy` across devices. */
  linkMode: LinkMode;
  /** The resolver path Nassaj spawns (e.g. ~/.local/bin/codex). */
  binaryPath: string;
  /** versioned-*: the directory holding one entry per version. */
  versionsDir?: string;
  /** npm-prefix: the installed package directory. */
  packageDir?: string;
  /** Live symlinks to capture, in restore order (codex: `current`, then the bin link). */
  symlinks: string[];
}

/** Injectable device lookup (tests simulate a cross-device snapshot root). */
export interface BinarySnapshotDeps {
  deviceOf?: (p: string) => number;
}

/** Live fingerprint compared with the manifest `from`/`to` facts. */
export interface LiveBinaryFingerprint {
  version: string | null;
  sha256: string;
  treeSha256: string;
}

const PAYLOAD_DIR = 'binary';

/** Device of `p`, or of its nearest existing ancestor (the snapshot root may not exist yet). */
function defaultDeviceOf(p: string): number {
  for (let dir = path.resolve(p); ; dir = path.dirname(dir)) {
    const st = lstatOrNull(dir);
    if (st) return fs.statSync(dir).dev;
    if (dir === path.dirname(dir)) throw new Error('no existing ancestor');
  }
}

/** Resolves the snapshot origin entry (version entry, single file or package dir). */
export function resolveOrigin(spec: BinaryLayoutSpec): string {
  if (spec.layout === 'single-file') {
    const st = lstatOrNull(spec.binaryPath);
    if (!st?.isFile()) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
    return path.resolve(spec.binaryPath);
  }
  if (spec.layout === 'npm-prefix') {
    const st = spec.packageDir ? lstatOrNull(spec.packageDir) : null;
    if (!st?.isDirectory()) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
    return path.resolve(spec.packageDir as string);
  }
  return resolveVersionedOrigin(spec);
}

function resolveVersionedOrigin(spec: BinaryLayoutSpec): string {
  if (!spec.versionsDir) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
  let versions: string;
  let target: string;
  try {
    versions = fs.realpathSync(spec.versionsDir);
    target = fs.realpathSync(spec.binaryPath);
  } catch {
    throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
  }
  const rel = path.relative(versions, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
  const origin = path.join(versions, rel.split(path.sep)[0]);
  const st = fs.lstatSync(origin);
  const wantDir = spec.layout === 'versioned-dir';
  if (wantDir ? !st.isDirectory() : !st.isFile()) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
  return origin;
}

/**
 * Walks `root` without following symlinks. `rel` of every entry starts with
 * `name` (default: basename of root) so a tree materialized under a temp name
 * hashes identically. Sockets, FIFOs and devices are refused.
 */
export function walkTree(root: string, name: string = path.basename(root), withHash = true): TreeEntry[] {
  const out: TreeEntry[] = [];
  const visit = (abs: string, rel: string): void => {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      out.push({ rel, type: 'symlink', linkTarget: fs.readlinkSync(abs) });
    } else if (st.isFile()) {
      const sha256 = withHash ? hashFile(abs).sha256 : '';
      out.push({ rel, type: 'file', sha256, size: st.size, mode: st.mode & 0o7777 });
    } else if (st.isDirectory()) {
      out.push({ rel, type: 'dir', mode: st.mode & 0o7777 });
      for (const child of fs.readdirSync(abs).sort()) visit(path.join(abs, child), `${rel}/${child}`);
    } else {
      throw snapshotError('SNAPSHOT_UNSAFE_ENTRY');
    }
  };
  visit(root, name);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Order-stable digest over tree entries (type, rel, content/target, mode). */
export function treeSha256(entries: TreeEntry[]): string {
  const lines = entries.map((e) => {
    if (e.type === 'file') return `f\0${e.rel}\0${e.sha256}\0${e.mode}`;
    if (e.type === 'dir') return `d\0${e.rel}\0${e.mode}`;
    return `l\0${e.rel}\0${e.linkTarget}`;
  });
  return sha256Text(lines.join('\n'));
}

function wouldHardlink(spec: BinaryLayoutSpec, snapshotRoot: string, origin: string, deps: BinarySnapshotDeps): boolean {
  const deviceOf = deps.deviceOf ?? defaultDeviceOf;
  return spec.linkMode === 'hardlink' && deviceOf(snapshotRoot) === deviceOf(path.dirname(origin));
}

/** Bytes a snapshot would physically write: 0 for same-device hard links, else the tree size. */
export function estimateBinarySnapshotBytes(spec: BinaryLayoutSpec, snapshotRoot: string, deps: BinarySnapshotDeps = {}): number {
  const origin = resolveOrigin(spec);
  if (wouldHardlink(spec, snapshotRoot, origin, deps)) return 0;
  return walkTree(origin, undefined, false).reduce((sum, e) => sum + (e.type === 'file' ? e.size : 0), 0);
}

function readSymlinks(paths: string[]): SymlinkRecord[] {
  return paths.map((p) => {
    const st = lstatOrNull(p);
    if (!st?.isSymbolicLink()) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
    return { path: path.resolve(p), linkTarget: fs.readlinkSync(p) };
  });
}

function copyIntoSnapshot(entries: TreeEntry[], originParent: string, payload: string, hardlink: boolean): number {
  let copied = 0;
  for (const e of entries) {
    const src = path.join(originParent, e.rel);
    const dst = path.join(payload, e.rel);
    if (e.type === 'dir') {
      withPrivateUmask(() => fs.mkdirSync(dst, { mode: PRIVATE_DIR_MODE }));
    } else if (e.type === 'file' && hardlink) {
      fs.linkSync(src, dst);
    } else if (e.type === 'file') {
      const res = copyFileHashed(src, dst, PRIVATE_FILE_MODE);
      if (res.sha256 !== e.sha256) throw snapshotError('SNAPSHOT_TAMPERED');
      copied += res.size;
    }
  }
  return copied;
}

/**
 * Snapshots the live install described by `spec` into `<dest>/binary` and
 * returns the record for the manifest. The snapshot is verified before return,
 * so a file that changed while it was being captured is SNAPSHOT_TAMPERED.
 */
export function takeBinarySnapshot(spec: BinaryLayoutSpec, dest: string, deps: BinarySnapshotDeps = {}): BinarySnapshotRecord {
  const origin = resolveOrigin(spec);
  const symlinks = readSymlinks(spec.symlinks);
  const files = walkTree(origin);
  ensurePrivateDir(dest);
  const hardlink = wouldHardlink(spec, dest, origin, deps);
  const payload = path.join(dest, PAYLOAD_DIR);
  ensurePrivateDir(payload);
  const copiedBytes = copyIntoSnapshot(files, path.dirname(origin), payload, hardlink);
  fsyncPath(payload);
  const record: BinarySnapshotRecord = {
    layout: spec.layout,
    linkMode: hardlink ? 'hardlink' : 'copy',
    device: (deps.deviceOf ?? defaultDeviceOf)(path.dirname(origin)),
    origin,
    symlinks,
    files,
    treeSha256: treeSha256(files),
    copiedBytes,
  };
  verifyBinarySnapshot(record, dest);
  return record;
}

/** Re-hashes every snapshot file; any mismatch/missing/odd type is SNAPSHOT_TAMPERED. */
export function verifyBinarySnapshot(rec: BinarySnapshotRecord, dir: string): void {
  if (treeSha256(rec.files) !== rec.treeSha256) throw snapshotError('SNAPSHOT_TAMPERED');
  const payload = path.join(dir, PAYLOAD_DIR);
  for (const e of rec.files) {
    if (e.type !== 'file') continue;
    const p = path.join(payload, e.rel);
    if (!isPathInside(p, payload)) throw snapshotError('SNAPSHOT_TAMPERED');
    const st = lstatOrNull(p);
    if (!st?.isFile() || st.size !== e.size) throw snapshotError('SNAPSHOT_TAMPERED');
    if (hashFile(p).sha256 !== e.sha256) throw snapshotError('SNAPSHOT_TAMPERED');
  }
}

/** Reads the live version, binary digest and origin tree digest. */
export function liveBinaryFingerprint(
  spec: BinaryLayoutSpec,
  readVersion: (binaryPath: string) => string | null,
): LiveBinaryFingerprint {
  const origin = resolveOrigin(spec);
  return {
    version: readVersion(spec.binaryPath),
    sha256: hashFile(fs.realpathSync(spec.binaryPath)).sha256,
    treeSha256: treeSha256(walkTree(origin)),
  };
}

function linkResolvesInto(linkPath: string, target: string, root: string): boolean {
  return isPathInside(path.resolve(path.dirname(linkPath), target), root);
}

/** Refuses a record whose symlinks (live or in-tree) would resolve into the snapshot root. */
function assertNoLinkIntoSnapshots(rec: BinarySnapshotRecord, snapshotRoot: string): void {
  for (const s of rec.symlinks) {
    if (linkResolvesInto(s.path, s.linkTarget, snapshotRoot)) throw snapshotError('SNAPSHOT_TAMPERED');
  }
  const originParent = path.dirname(rec.origin);
  for (const e of rec.files) {
    if (e.type === 'symlink' && linkResolvesInto(path.join(originParent, e.rel), e.linkTarget, snapshotRoot)) {
      throw snapshotError('SNAPSHOT_TAMPERED');
    }
  }
}

/** Recreates the recorded tree at `destRoot` (renamed later), fsyncing files and dirs. */
function materializeTree(rec: BinarySnapshotRecord, dir: string, destRoot: string): void {
  const name = path.basename(rec.origin);
  const payload = path.join(dir, PAYLOAD_DIR);
  const dirs: { dst: string; mode: number }[] = [];
  for (const e of rec.files) {
    const dst = path.join(destRoot, e.rel.slice(name.length));
    if (e.type === 'dir') {
      fs.mkdirSync(dst, { mode: PRIVATE_DIR_MODE });
      dirs.push({ dst, mode: e.mode });
    } else if (e.type === 'symlink') {
      fs.symlinkSync(e.linkTarget, dst);
    } else if (copyFileHashed(path.join(payload, e.rel), dst, e.mode).sha256 !== e.sha256) {
      throw snapshotError('SNAPSHOT_TAMPERED');
    }
  }
  for (const d of dirs.reverse()) {
    fs.chmodSync(d.dst, d.mode);
    fsyncPath(d.dst);
  }
  if (treeSha256(walkTree(destRoot, name)) !== rec.treeSha256) throw snapshotError('SNAPSHOT_TAMPERED');
}

/** Atomically repoints each recorded symlink (tmp link + rename + dir fsync). */
function swapSymlinks(links: SymlinkRecord[], jobId: string): void {
  for (const link of links) {
    const tmp = restoreTempPath(link.path, jobId);
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(link.linkTarget, tmp);
    fs.renameSync(tmp, link.path);
    fsyncPath(path.dirname(link.path));
    if (fs.readlinkSync(link.path) !== link.linkTarget) throw snapshotError('SNAPSHOT_TAMPERED');
  }
}

/**
 * ORIGIN_NAME_CONFLICT when a versioned origin entry exists with content other
 * than the snapshot (a restore would otherwise overwrite a different install).
 * No-op for single-file / npm layouts, which are replaced atomically.
 */
export function assertNoOriginConflict(rec: BinarySnapshotRecord): void {
  if (rec.layout !== 'versioned-file' && rec.layout !== 'versioned-dir') return;
  if (lstatOrNull(rec.origin) && treeSha256(walkTree(rec.origin)) !== rec.treeSha256) {
    throw snapshotError('ORIGIN_NAME_CONFLICT');
  }
}

function restoreVersioned(rec: BinarySnapshotRecord, dir: string, jobId: string): void {
  const originDir = path.dirname(rec.origin);
  const name = path.basename(rec.origin);
  assertNoOriginConflict(rec);
  if (!lstatOrNull(rec.origin)) {
    const tmp = versionedRestoreTempPath(originDir, name, jobId);
    fs.rmSync(tmp, { recursive: true, force: true });
    materializeTree(rec, dir, tmp);
    fs.renameSync(tmp, rec.origin);
    fsyncPath(originDir);
  }
  swapSymlinks(rec.symlinks, jobId);
}

function restoreSingleFile(rec: BinarySnapshotRecord, dir: string, jobId: string): void {
  const tmp = restoreTempPath(rec.origin, jobId);
  fs.rmSync(tmp, { force: true });
  materializeTree(rec, dir, tmp);
  fs.renameSync(tmp, rec.origin);
  fsyncPath(path.dirname(rec.origin));
}

function restoreNpmPackage(rec: BinarySnapshotRecord, dir: string, jobId: string): void {
  const tmp = restoreTempPath(rec.origin, jobId);
  fs.rmSync(tmp, { recursive: true, force: true });
  materializeTree(rec, dir, tmp);
  const aside = asidePath(rec.origin, jobId);
  if (lstatOrNull(rec.origin)) {
    fs.rmSync(aside, { recursive: true, force: true });
    fs.renameSync(rec.origin, aside);
  }
  fs.renameSync(tmp, rec.origin);
  fsyncPath(path.dirname(rec.origin));
  swapSymlinks(rec.symlinks, jobId);
}

/**
 * Restores the snapshot in `dir` over the live install. Verifies the snapshot
 * first (SNAPSHOT_TAMPERED leaves live untouched); a versioned entry that
 * exists with different content is ORIGIN_NAME_CONFLICT. `snapshotRoot`
 * defaults to the grandparent of `dir` (`<root>/<harness>/<jobId>`).
 */
export function restoreBinary(
  rec: BinarySnapshotRecord,
  dir: string,
  jobId: string,
  snapshotRoot: string = path.dirname(path.dirname(dir)),
): void {
  verifyBinarySnapshot(rec, dir);
  assertNoLinkIntoSnapshots(rec, snapshotRoot);
  if (rec.layout === 'single-file') restoreSingleFile(rec, dir, jobId);
  else if (rec.layout === 'npm-prefix') restoreNpmPackage(rec, dir, jobId);
  else restoreVersioned(rec, dir, jobId);
}
