/**
 * SQLite store coverage, set backup and journaled restore (T-1871 stage 3,
 * spec §5, C-B).
 *
 * Coverage = host home + every `~/.nassaj-users/*` home, per store kind; an
 * absent store dir is recorded `absent`. A database is backed up with its
 * `-wal` and `-shm` as one set (copies, never hard links: a hard-linked db
 * would share the live inode). Restore is all-or-nothing and journaled in the
 * manifest BEFORE each phase:
 *   staging   verify backup digests, copy to `<file>.nassaj-restore-<jobId>`
 *   asiding   move every current store file aside — including a stale WAL and
 *             stores that appeared where coverage said `absent`
 *   swapping  rename staged files in, fsync dirs
 *   committed
 * An error before `swapping` reverts the asides; a crash during `swapping` is
 * rolled forward by boot reconcile (`resumeStoreRestore`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { copyFileHashed, fsyncPath, hashFile, lstatOrNull, sha256Text } from './durable-fs.js';
import { snapshotError } from './errors.js';
import {
  persistRestore,
  type HarnessSnapshotManifest,
  type RestoreFileOp,
  type RestorePhase,
  type StoreBackupRecord,
  type StoreCoverageEntry,
  type StoreSet,
  type StoreSuffix,
} from './manifest.js';
import { assertNoStoreHolders } from './open-handles.js';
import { ASIDE_INFIX, asidePath, ensurePrivateDir, isPathInside, PRIVATE_DIR_MODE, RESTORE_TEMP_INFIX, restoreTempPath } from './paths.js';

/** A kind of harness SQLite store, located relative to each home. */
export interface StoreSpec {
  id: string;
  relDir: string;
  /** True for a database base name (never for a -wal/-shm sidecar). */
  matchBase: (name: string) => boolean;
}

/** codex: every `*.sqlite` at depth 1 of `.codex`. */
export const CODEX_STORE: StoreSpec = { id: 'codex', relDir: '.codex', matchBase: (n) => n.endsWith('.sqlite') };
/** opencode: `opencode.db` in `.local/share/opencode`. */
export const OPENCODE_STORE: StoreSpec = {
  id: 'opencode',
  relDir: path.join('.local', 'share', 'opencode'),
  matchBase: (n) => n === 'opencode.db',
};
const STORE_SPECS: Record<string, StoreSpec> = { codex: CODEX_STORE, opencode: OPENCODE_STORE };

const SUFFIXES: StoreSuffix[] = ['', '-wal', '-shm'];

/** Live coverage: where each store kind lives and which sets exist now. */
export interface StoreCoverage {
  coverage: StoreCoverageEntry[];
  sets: StoreSet[];
}

/** Restore options (fault-injection hook and the holder check are injectable). */
export interface StoreRestoreOptions {
  now?: number;
  dataLossAck?: boolean;
  assertNoHolders?: (paths: string[]) => void;
  /** Called before every file operation; throwing simulates a failure there. */
  beforeStep?: (phase: RestorePhase, index: number) => void;
}

/** Host home plus every real directory under `<home>/.nassaj-users`. */
export function listCoverageHomes(home: string = os.homedir()): string[] {
  const usersDir = path.join(home, '.nassaj-users');
  const members = lstatOrNull(usersDir)?.isDirectory()
    ? fs.readdirSync(usersDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(usersDir, d.name))
    : [];
  return [home, ...members.sort()];
}

function isOwnArtifact(name: string): boolean {
  return name.includes(RESTORE_TEMP_INFIX) || name.includes(ASIDE_INFIX);
}

function setIdOf(dir: string, base: string): string {
  return sha256Text(`${dir}\0${base}`).slice(0, 16);
}

/** Sets currently present in `dir` for `spec`; a symlinked member is refused. */
function enumerateSets(dir: string, spec: StoreSpec): StoreSet[] {
  const bases = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => !isOwnArtifact(d.name) && spec.matchBase(d.name) && !d.isDirectory())
    .map((d) => d.name)
    .sort();
  return bases.map((base) => ({
    id: setIdOf(dir, base),
    storeId: spec.id,
    dir,
    base,
    members: SUFFIXES.map((suffix) => {
      const st = lstatOrNull(path.join(dir, base + suffix));
      if (st && !st.isFile()) throw snapshotError('SNAPSHOT_UNSAFE_ENTRY');
      return { suffix, present: Boolean(st), size: st?.size ?? 0, sha256: null, backupRel: null };
    }),
  }));
}

/** Enumerates store coverage of `specs` across the host and every member home. */
export function enumerateStoreCoverage(specs: StoreSpec[], home: string = os.homedir()): StoreCoverage {
  const coverage: StoreCoverageEntry[] = [];
  const sets: StoreSet[] = [];
  for (const h of listCoverageHomes(home)) {
    for (const spec of specs) {
      const dir = path.join(h, spec.relDir);
      const present = Boolean(lstatOrNull(dir)?.isDirectory());
      coverage.push({ home: h, storeId: spec.id, dir, status: present ? 'present' : 'absent' });
      if (present) sets.push(...enumerateSets(dir, spec));
    }
  }
  return { coverage, sets };
}

/** Every path an open-handle / privacy check must cover (dirs + all set members). */
export function storeCheckPaths(cov: StoreCoverage): string[] {
  const dirs = cov.coverage.filter((c) => c.status === 'present').map((c) => c.dir);
  const files = cov.sets.flatMap((s) => SUFFIXES.map((suffix) => path.join(s.dir, s.base + suffix)));
  return [...dirs, ...files];
}

/** Bytes a backup of `cov` will copy (always copies). */
export function estimateStoreBackupBytes(cov: StoreCoverage): number {
  return cov.sets.reduce((sum, s) => sum + s.members.reduce((n, m) => n + m.size, 0), 0);
}

/** Digest over store files only: an absent dir and an empty dir are equivalent. */
function fingerprintOf(files: { path: string; sha: string }[]): string {
  return sha256Text(files.map((f) => `${f.path}\0${f.sha}`).sort().join('\n'));
}

/**
 * Digest of the live content of every covered store dir: the sha256 of every
 * set member now present (sets that appeared since the backup included).
 */
export function storesFingerprint(coverage: StoreCoverageEntry[]): string {
  const files: { path: string; sha: string }[] = [];
  for (const c of coverage) {
    if (!lstatOrNull(c.dir)?.isDirectory()) continue;
    for (const set of enumerateSets(c.dir, STORE_SPECS[c.storeId])) {
      for (const m of set.members.filter((x) => x.present)) {
        const p = path.join(set.dir, set.base + m.suffix);
        files.push({ path: p, sha: hashFile(p).sha256 });
      }
    }
  }
  return fingerprintOf(files);
}

/**
 * Copies every present set member into `<dest>/stores/<setId>/` (0600, fsync)
 * after proving no process holds a store. A member that changes size while
 * being copied is STORE_IN_USE.
 */
export function backupStores(
  cov: StoreCoverage,
  dest: string,
  assertNoHolders: (paths: string[]) => void = assertNoStoreHolders,
): StoreBackupRecord {
  assertNoHolders(storeCheckPaths(cov));
  const sets: StoreSet[] = [];
  const files: { path: string; sha: string }[] = [];
  let totalBytes = 0;
  for (const set of cov.sets) {
    const setDir = path.join(dest, 'stores', set.id);
    ensurePrivateDir(setDir);
    const members = set.members.map((m) => {
      if (!m.present) return { ...m };
      const src = path.join(set.dir, set.base + m.suffix);
      const backupRel = path.join('stores', set.id, set.base + m.suffix);
      const res = copyFileHashed(src, path.join(dest, backupRel));
      if (lstatOrNull(src)?.size !== res.size) throw snapshotError('STORE_IN_USE');
      files.push({ path: src, sha: res.sha256 });
      totalBytes += res.size;
      return { ...m, size: res.size, sha256: res.sha256, backupRel };
    });
    fsyncPath(setDir);
    sets.push({ ...set, members });
  }
  return { coverage: cov.coverage, sets, preFingerprint: fingerprintOf(files), postFingerprint: null, totalBytes };
}

// ------------------------------------------------------------------ restore

function planStaging(dir: string, rec: StoreBackupRecord, jobId: string): { op: RestoreFileOp; backup: string }[] {
  return rec.sets.flatMap((set) => set.members.filter((m) => m.present).map((m) => {
    const backup = path.join(dir, m.backupRel as string);
    if (!isPathInside(backup, dir) || !m.sha256) throw snapshotError('SNAPSHOT_TAMPERED');
    const target = path.join(set.dir, set.base + m.suffix);
    return { op: { op: 'stage', target, temp: restoreTempPath(target, jobId), sha256: m.sha256 }, backup };
  }));
}

/** Every current store file in covered dirs (backed-up names, stale sidecars, new stores). */
function planAsides(rec: StoreBackupRecord, jobId: string): RestoreFileOp[] {
  const ops: RestoreFileOp[] = [];
  for (const c of rec.coverage) {
    if (!lstatOrNull(c.dir)?.isDirectory()) continue;
    const knownBases = new Set(rec.sets.filter((s) => s.dir === c.dir).map((s) => s.base));
    for (const d of fs.readdirSync(c.dir, { withFileTypes: true })) {
      if (d.isDirectory() || isOwnArtifact(d.name)) continue;
      const base = d.name.replace(/-(wal|shm)$/, '');
      if (!knownBases.has(base) && !STORE_SPECS[c.storeId].matchBase(base)) continue;
      const target = path.join(c.dir, d.name);
      ops.push({ op: 'aside', target, aside: asidePath(target, jobId) });
    }
  }
  return ops.sort((a, b) => (a.target < b.target ? -1 : 1));
}

function fsyncParents(ops: RestoreFileOp[]): void {
  for (const dir of new Set(ops.map((o) => path.dirname(o.target)))) {
    if (lstatOrNull(dir)) fsyncPath(dir);
  }
}

function runStaging(staging: { op: RestoreFileOp; backup: string }[], hook: StoreRestoreOptions['beforeStep']): void {
  staging.forEach(({ op, backup }, i) => {
    if (op.op !== 'stage') return;
    hook?.('staging', i);
    fs.mkdirSync(path.dirname(op.target), { recursive: true, mode: PRIVATE_DIR_MODE });
    fs.rmSync(op.temp, { force: true });
    if (copyFileHashed(backup, op.temp).sha256 !== op.sha256) throw snapshotError('SNAPSHOT_TAMPERED');
  });
}

function runAsides(ops: RestoreFileOp[], hook: StoreRestoreOptions['beforeStep']): void {
  ops.forEach((op, i) => {
    if (op.op !== 'aside') return;
    hook?.('asiding', i);
    fs.rmSync(op.aside, { recursive: true, force: true });
    fs.renameSync(op.target, op.aside);
  });
  fsyncParents(ops);
}

function runSwaps(ops: RestoreFileOp[], hook: StoreRestoreOptions['beforeStep']): void {
  ops.forEach((op, i) => {
    if (op.op !== 'stage') return;
    hook?.('swapping', i);
    fs.renameSync(op.temp, op.target);
  });
  fsyncParents(ops);
}

function withPhase(dir: string, m: HarnessSnapshotManifest, phase: RestorePhase, files?: RestoreFileOp[]): HarnessSnapshotManifest {
  const restore = m.restore as NonNullable<HarnessSnapshotManifest['restore']>;
  return persistRestore(dir, m, { ...restore, phase, files: files ?? restore.files });
}

/**
 * Journaled all-or-nothing restore of the stores backed up in `dir`. Returns
 * the committed manifest. Before `swapping` any error reverts (live data
 * unchanged, phase `reverted`) and rethrows; an error during `swapping` is
 * rethrown with the journal left at `swapping` for roll-forward.
 */
export function restoreStores(
  dir: string,
  manifest: HarnessSnapshotManifest,
  kind: 'auto' | 'manual',
  opts: StoreRestoreOptions = {},
): HarnessSnapshotManifest {
  const rec = manifest.stores;
  if (!rec) throw snapshotError('MANIFEST_INVALID');
  (opts.assertNoHolders ?? assertNoStoreHolders)(storeCheckPaths(rec));
  const staging = planStaging(dir, rec, manifest.jobId);
  const stageOps = staging.map((s) => s.op);
  let m = persistRestore(dir, manifest, {
    kind, scope: 'binary+data', startedAt: opts.now ?? Date.now(), phase: 'staging',
    files: stageOps, dataLossAck: opts.dataLossAck ?? false,
  });
  try {
    runStaging(staging, opts.beforeStep);
    const asideOps = planAsides(rec, manifest.jobId);
    m = withPhase(dir, m, 'asiding', [...stageOps, ...asideOps]);
    runAsides(asideOps, opts.beforeStep);
  } catch (error) {
    revertStoreRestore(dir, m);
    throw error;
  }
  m = withPhase(dir, m, 'swapping');
  runSwaps(m.restore!.files, opts.beforeStep);
  return withPhase(dir, m, 'committed');
}

/** Undo of a restore that never reached `swapping`: asides back, temps removed. */
export function revertStoreRestore(dir: string, m: HarnessSnapshotManifest): HarnessSnapshotManifest {
  const ops = m.restore?.files ?? [];
  for (const op of [...ops].reverse()) {
    if (op.op === 'aside' && lstatOrNull(op.aside)) fs.renameSync(op.aside, op.target);
    if (op.op === 'stage') fs.rmSync(op.temp, { force: true });
  }
  fsyncParents(ops);
  return m.restore ? withPhase(dir, m, 'reverted') : m;
}

/** Completes a restore interrupted during `swapping`; a swapped file must match its digest. */
export function rollForwardStoreRestore(dir: string, m: HarnessSnapshotManifest): HarnessSnapshotManifest {
  const ops = m.restore?.files ?? [];
  for (const op of ops) {
    if (op.op !== 'stage') continue;
    if (lstatOrNull(op.temp)) fs.renameSync(op.temp, op.target);
    else if (!lstatOrNull(op.target) || hashFile(op.target).sha256 !== op.sha256) throw snapshotError('SNAPSHOT_TAMPERED');
  }
  fsyncParents(ops);
  return withPhase(dir, m, 'committed');
}

/** Boot-reconcile entry: revert before `swapping`, roll forward from `swapping`, else no-op. */
export function resumeStoreRestore(dir: string, m: HarnessSnapshotManifest): HarnessSnapshotManifest {
  const phase = m.restore?.phase;
  if (phase === 'staging' || phase === 'asiding') return revertStoreRestore(dir, m);
  if (phase === 'swapping') return rollForwardStoreRestore(dir, m);
  return m;
}
