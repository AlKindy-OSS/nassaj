/**
 * Harness snapshot manifest, schema 1 (T-1871 stage 3, spec §4).
 *
 * The manifest is the single durable record of a snapshot job: it is written
 * atomically (temp + fsync + rename + dir fsync) at every state change so boot
 * reconcile can resume or undo any interrupted step. `loadManifest` validates
 * every field it relies on and refuses anything else with MANIFEST_INVALID.
 */

import fs from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from './durable-fs.js';
import { snapshotError } from './errors.js';
import { assertHarnessId, assertJobId } from './paths.js';

/** Current manifest schema. */
export const MANIFEST_SCHEMA = 1;
/** File name of the manifest inside a job snapshot dir. */
export const MANIFEST_FILE = 'manifest.json';

export const MANIFEST_KINDS = ['update', 'restore-compatible', 'manual-rollback'] as const;
export const MANIFEST_STATES = [
  'queued', 'preflight', 'snapshotting', 'snapshotted', 'recheck', 'mutating', 'verifying',
  'succeeded', 'noop', 'recovering', 'rolled_back', 'rollback_failed', 'abandoned',
  'manual_restoring',
] as const;
export const RESTORE_PHASES = ['staging', 'asiding', 'swapping', 'committed', 'reverted'] as const;
export const BINARY_LAYOUTS = ['versioned-file', 'versioned-dir', 'single-file', 'npm-prefix'] as const;

export type ManifestKind = (typeof MANIFEST_KINDS)[number];
export type ManifestState = (typeof MANIFEST_STATES)[number];
export type RestorePhase = (typeof RESTORE_PHASES)[number];
export type BinaryLayout = (typeof BINARY_LAYOUTS)[number];
export type LinkMode = 'hardlink' | 'copy';

/** Version facts of the live binary (`from` before the update, `to` after). */
export interface VersionFacts {
  version: string | null;
  binarySha256: string | null;
  treeSha256: string | null;
}

/** One entry of a snapshotted tree; symlinks are recorded, never followed. */
export type TreeEntry =
  | { rel: string; type: 'file'; sha256: string; size: number; mode: number }
  | { rel: string; type: 'dir'; mode: number }
  | { rel: string; type: 'symlink'; linkTarget: string };

/** A live symlink captured with its exact target. */
export interface SymlinkRecord {
  path: string;
  linkTarget: string;
}

/** What a binary snapshot holds and how it was taken. */
export interface BinarySnapshotRecord {
  layout: BinaryLayout;
  linkMode: LinkMode;
  device: number;
  /** Absolute path of the snapshotted origin entry (file or dir). */
  origin: string;
  symlinks: SymlinkRecord[];
  files: TreeEntry[];
  treeSha256: string;
  /** Bytes physically copied (0 for hard links). */
  copiedBytes: number;
}

/** Coverage of one store kind in one home: `absent` when the dir does not exist. */
export interface StoreCoverageEntry {
  home: string;
  storeId: string;
  dir: string;
  status: 'present' | 'absent';
}

export type StoreSuffix = '' | '-wal' | '-shm';

/** One file of a SQLite set (db, -wal, -shm). */
export interface StoreSetMember {
  suffix: StoreSuffix;
  present: boolean;
  size: number;
  sha256: string | null;
  backupRel: string | null;
}

/** A SQLite database and its sidecars, backed up as one unit. */
export interface StoreSet {
  id: string;
  storeId: string;
  dir: string;
  base: string;
  members: StoreSetMember[];
}

/** Store coverage + set backup facts. */
export interface StoreBackupRecord {
  coverage: StoreCoverageEntry[];
  sets: StoreSet[];
  preFingerprint: string;
  postFingerprint: string | null;
  totalBytes: number;
}

/** A journaled restore file operation. */
export type RestoreFileOp =
  | { op: 'stage'; target: string; temp: string; sha256: string }
  | { op: 'aside'; target: string; aside: string };

/** Journal of a data/binary restore; `phase` is persisted BEFORE each phase runs. */
export interface RestoreRecord {
  kind: 'auto' | 'manual';
  scope: 'binary' | 'binary+data';
  startedAt: number;
  phase: RestorePhase;
  files: RestoreFileOp[];
  dataLossAck: boolean;
}

/** The manifest (schema 1). Timestamps are epoch milliseconds. */
export interface HarnessSnapshotManifest {
  schema: typeof MANIFEST_SCHEMA;
  jobId: string;
  harness: string;
  kind: ManifestKind;
  trigger: string;
  userId: number | null;
  createdAt: number;
  expiresAt: number;
  state: ManifestState;
  stateHistory: { state: ManifestState; at: number }[];
  from: VersionFacts;
  to: VersionFacts | null;
  binary: BinarySnapshotRecord | null;
  stores: StoreBackupRecord | null;
  restore: RestoreRecord | null;
  /** True once this run counts toward the successful-run retention window. */
  counted: boolean;
  /**
   * Process group of the updater, persisted right after it was spawned so boot
   * reconcile can prove it dead before restoring. Absent before the mutation.
   */
  updater?: { pgid: number; startToken: string | null; bootId?: string | null } | null;
}

/** Persists `m` atomically as `<dir>/manifest.json`. */
export function writeManifest(dir: string, m: HarnessSnapshotManifest): void {
  validateManifest(m);
  writeFileAtomic(path.join(dir, MANIFEST_FILE), `${JSON.stringify(m, null, 1)}\n`);
}

/** Reads and validates `<dir>/manifest.json`; MANIFEST_INVALID on any defect. */
export function loadManifest(dir: string): HarnessSnapshotManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
  } catch {
    throw snapshotError('MANIFEST_INVALID');
  }
  return validateManifest(raw);
}

/** Moves `m` to `state`, appends history, persists, and returns the new manifest. */
export function transitionManifest(
  dir: string,
  m: HarnessSnapshotManifest,
  state: ManifestState,
  at: number = Date.now(),
): HarnessSnapshotManifest {
  const next = { ...m, state, stateHistory: [...m.stateHistory, { state, at }] };
  writeManifest(dir, next);
  return next;
}

/** Persists `m` with `restore` replaced; returns the new manifest. */
export function persistRestore(
  dir: string,
  m: HarnessSnapshotManifest,
  restore: RestoreRecord,
): HarnessSnapshotManifest {
  const next = { ...m, restore };
  writeManifest(dir, next);
  return next;
}

// ---------------------------------------------------------------- validation

type Rec = Record<string, unknown>;

function fail(): never {
  throw snapshotError('MANIFEST_INVALID');
}

function obj(v: unknown): Rec {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail();
  return v as Rec;
}

function str(v: unknown): string {
  if (typeof v !== 'string') fail();
  return v;
}

function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail();
  return v;
}

function nullableStr(v: unknown): void {
  if (v !== null) str(v);
}

function oneOf<T extends readonly string[]>(v: unknown, values: T): void {
  if (!values.includes(str(v))) fail();
}

function arr(v: unknown): unknown[] {
  if (!Array.isArray(v)) fail();
  return v;
}

function absPath(v: unknown): void {
  if (!path.isAbsolute(str(v))) fail();
}

/** A tree-relative path: non-empty, normalized, no `..`, not absolute. */
function safeRel(v: unknown): void {
  const rel = str(v);
  if (!rel || path.isAbsolute(rel) || path.normalize(rel) !== rel) fail();
  if (rel.split('/').some((part) => part === '..' || part === '.' || part === '')) fail();
}

function checkVersionFacts(v: unknown): void {
  const f = obj(v);
  nullableStr(f.version);
  nullableStr(f.binarySha256);
  nullableStr(f.treeSha256);
}

function checkTreeEntry(v: unknown): void {
  const e = obj(v);
  safeRel(e.rel);
  if (e.type === 'file') {
    str(e.sha256);
    num(e.size);
    num(e.mode);
  } else if (e.type === 'dir') {
    num(e.mode);
  } else if (e.type === 'symlink') {
    str(e.linkTarget);
  } else {
    fail();
  }
}

function checkBinary(v: unknown): void {
  if (v === null) return;
  const b = obj(v);
  oneOf(b.layout, BINARY_LAYOUTS);
  oneOf(b.linkMode, ['hardlink', 'copy'] as const);
  num(b.device);
  absPath(b.origin);
  for (const s of arr(b.symlinks)) {
    absPath(obj(s).path);
    str(obj(s).linkTarget);
  }
  arr(b.files).forEach(checkTreeEntry);
  str(b.treeSha256);
  num(b.copiedBytes);
}

function checkSet(v: unknown): void {
  const s = obj(v);
  str(s.id);
  str(s.storeId);
  absPath(s.dir);
  if (str(s.base).includes('/')) fail();
  for (const raw of arr(s.members)) {
    const m = obj(raw);
    oneOf(m.suffix, ['', '-wal', '-shm'] as const);
    if (typeof m.present !== 'boolean') fail();
    num(m.size);
    nullableStr(m.sha256);
    if (m.backupRel !== null) safeRel(m.backupRel);
  }
}

function checkStores(v: unknown): void {
  if (v === null) return;
  const s = obj(v);
  for (const raw of arr(s.coverage)) {
    const c = obj(raw);
    absPath(c.home);
    str(c.storeId);
    absPath(c.dir);
    oneOf(c.status, ['present', 'absent'] as const);
  }
  arr(s.sets).forEach(checkSet);
  str(s.preFingerprint);
  nullableStr(s.postFingerprint);
  num(s.totalBytes);
}

function checkRestoreOp(v: unknown): void {
  const op = obj(v);
  absPath(op.target);
  if (op.op === 'stage') {
    absPath(op.temp);
    str(op.sha256);
  } else if (op.op === 'aside') {
    absPath(op.aside);
  } else {
    fail();
  }
}

function checkRestore(v: unknown): void {
  if (v === null) return;
  const r = obj(v);
  oneOf(r.kind, ['auto', 'manual'] as const);
  oneOf(r.scope, ['binary', 'binary+data'] as const);
  num(r.startedAt);
  oneOf(r.phase, RESTORE_PHASES);
  arr(r.files).forEach(checkRestoreOp);
  if (typeof r.dataLossAck !== 'boolean') fail();
}

function checkHeader(m: Rec): void {
  if (m.schema !== MANIFEST_SCHEMA) fail();
  try {
    assertJobId(str(m.jobId));
    assertHarnessId(str(m.harness));
  } catch {
    fail();
  }
  oneOf(m.kind, MANIFEST_KINDS);
  str(m.trigger);
  if (m.userId !== null) num(m.userId);
  num(m.createdAt);
  num(m.expiresAt);
  oneOf(m.state, MANIFEST_STATES);
  for (const h of arr(m.stateHistory)) {
    oneOf(obj(h).state, MANIFEST_STATES);
    num(obj(h).at);
  }
  if (typeof m.counted !== 'boolean') fail();
  if (m.updater !== undefined && m.updater !== null) {
    const u = obj(m.updater);
    if (!Number.isInteger(u.pgid) || (u.pgid as number) <= 1) fail();
    nullableStr(u.startToken);
    if (u.bootId !== undefined) nullableStr(u.bootId);
  }
}

/** Validates an untrusted value as a schema-1 manifest (MANIFEST_INVALID otherwise). */
export function validateManifest(raw: unknown): HarnessSnapshotManifest {
  const m = obj(raw);
  checkHeader(m);
  checkVersionFacts(m.from);
  if (m.to !== null) checkVersionFacts(m.to);
  checkBinary(m.binary);
  checkStores(m.stores);
  checkRestore(m.restore);
  return m as unknown as HarnessSnapshotManifest;
}
