import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  estimateBinarySnapshotBytes,
  liveBinaryFingerprint,
  restoreBinary,
  takeBinarySnapshot,
  verifyBinarySnapshot,
  type BinaryLayoutSpec,
} from './binary-snapshot.js';
import { hasErrorCode } from './errors.js';
import { isPathInside, jobSnapshotDir } from './paths.js';
import { makeFixtureRoot, modeOf, removeFixture, writeFixtureFile } from './__tests__/fixtures.js';

const root = makeFixtureRoot();
after(() => removeFixture(root));

let seq = 0;
function world() {
  const home = path.join(root, `w${(seq += 1)}`);
  const snaps = path.join(home, '.local/share/nassaj/harness-snapshots');
  return { home, snaps, dest: (id = 'job-1') => jobSnapshotDir(snaps, 'h', id) };
}
const code = (c: Parameters<typeof hasErrorCode>[1]) => (e: unknown) => hasErrorCode(e, c);
const read = (p: string) => fs.readFileSync(p, 'utf8');

/** claude-like: versions/<v> file + bin link. */
function claudeLike(home: string): BinaryLayoutSpec {
  const versions = path.join(home, 'versions');
  writeFixtureFile(path.join(versions, '1.0.0'), 'v1-binary', 0o755);
  const bin = path.join(home, 'bin/claude');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.symlinkSync(path.join(versions, '1.0.0'), bin);
  return { layout: 'versioned-file', linkMode: 'hardlink', binaryPath: bin, versionsDir: versions, symlinks: [bin] };
}

function simulateUpdate(spec: BinaryLayoutSpec, removeOld: boolean): void {
  const versions = spec.versionsDir as string;
  writeFixtureFile(path.join(versions, '2.0.0'), 'v2-binary', 0o755);
  fs.rmSync(spec.binaryPath);
  fs.symlinkSync(path.join(versions, '2.0.0'), spec.binaryPath);
  if (removeOld) fs.rmSync(path.join(versions, '1.0.0'));
}

test('same device → hard links (0 bytes), dirs 0700, snapshot verifies', () => {
  const w = world();
  const spec = claudeLike(w.home);
  assert.equal(estimateBinarySnapshotBytes(spec, path.dirname(w.snaps)), 0);
  const rec = takeBinarySnapshot(spec, w.dest());
  assert.equal(rec.linkMode, 'hardlink');
  assert.equal(rec.copiedBytes, 0);
  assert.equal(fs.statSync(path.join(w.dest(), 'binary/1.0.0')).ino, fs.statSync(path.join(w.home, 'versions/1.0.0')).ino);
  assert.equal(modeOf(w.dest()), 0o700);
  assert.equal(modeOf(path.join(w.dest(), 'binary')), 0o700);
  assert.equal(modeOf(path.join(w.dest(), 'binary/1.0.0')), 0o755, 'hard-linked file is never chmod-ed');
  verifyBinarySnapshot(rec, w.dest());
});

test('M-1: O_TRUNC write through the hard link → SNAPSHOT_TAMPERED, live untouched', () => {
  const w = world();
  const spec = claudeLike(w.home);
  const rec = takeBinarySnapshot(spec, w.dest());
  const live = path.join(w.home, 'versions/1.0.0');
  fs.writeFileSync(live, 'rewritten-in-place'); // opens with O_TRUNC on the shared inode
  assert.throws(() => verifyBinarySnapshot(rec, w.dest()), code('SNAPSHOT_TAMPERED'));
  simulateUpdate(spec, false);
  assert.throws(() => restoreBinary(rec, w.dest(), 'job-1'), code('SNAPSHOT_TAMPERED'));
  assert.equal(fs.readlinkSync(spec.binaryPath), path.join(w.home, 'versions/2.0.0'));
});

test('missing snapshot file or manifest tree tamper → SNAPSHOT_TAMPERED', () => {
  const w = world();
  const rec = takeBinarySnapshot(claudeLike(w.home), w.dest());
  assert.throws(() => verifyBinarySnapshot({ ...rec, treeSha256: 'f'.repeat(64) }, w.dest()), code('SNAPSHOT_TAMPERED'));
  fs.rmSync(path.join(w.dest(), 'binary/1.0.0'));
  assert.throws(() => verifyBinarySnapshot(rec, w.dest()), code('SNAPSHOT_TAMPERED'));
});

test('cross device (injected stat) → copy, bytes counted, files 0600', () => {
  const w = world();
  const spec = claudeLike(w.home);
  const deviceOf = (p: string) => (isPathInside(p, w.snaps) || p === path.dirname(w.snaps) ? 2 : 1);
  assert.equal(estimateBinarySnapshotBytes(spec, path.dirname(w.snaps), { deviceOf }), 'v1-binary'.length);
  fs.mkdirSync(w.dest(), { recursive: true });
  const rec = takeBinarySnapshot(spec, w.dest(), { deviceOf });
  assert.equal(rec.linkMode, 'copy');
  assert.equal(rec.copiedBytes, 'v1-binary'.length);
  const snapFile = path.join(w.dest(), 'binary/1.0.0');
  assert.notEqual(fs.statSync(snapFile).ino, fs.statSync(path.join(w.home, 'versions/1.0.0')).ino);
  assert.equal(modeOf(snapFile), 0o600);
});

test('versioned restore: entry still present → symlink swapped back, never into snapshots', () => {
  const w = world();
  const spec = claudeLike(w.home);
  const rec = takeBinarySnapshot(spec, w.dest());
  simulateUpdate(spec, false);
  restoreBinary(rec, w.dest(), 'job-1');
  const target = fs.readlinkSync(spec.binaryPath);
  assert.equal(target, path.join(w.home, 'versions/1.0.0'));
  assert.equal(isPathInside(fs.realpathSync(spec.binaryPath), w.snaps), false);
  assert.equal(read(spec.binaryPath), 'v1-binary');
});

test('versioned restore: entry removed by the updater → materialized with its mode (copy snapshot)', () => {
  const w = world();
  const spec = claudeLike(w.home);
  const rec = takeBinarySnapshot({ ...spec, linkMode: 'copy' }, w.dest());
  simulateUpdate(spec, true);
  restoreBinary(rec, w.dest(), 'job-1');
  const live = path.join(w.home, 'versions/1.0.0');
  assert.equal(read(live), 'v1-binary');
  assert.equal(modeOf(live), 0o755);
  assert.equal(isPathInside(fs.realpathSync(spec.binaryPath), w.snaps), false);
  assert.deepEqual(fs.readdirSync(path.join(w.home, 'versions')).sort(), ['1.0.0', '2.0.0'], 'no restore temp left');
});

test('ORIGIN_NAME_CONFLICT when the version name exists with other content', () => {
  const w = world();
  const spec = claudeLike(w.home);
  const rec = takeBinarySnapshot({ ...spec, linkMode: 'copy' }, w.dest());
  simulateUpdate(spec, true);
  writeFixtureFile(path.join(w.home, 'versions/1.0.0'), 'impostor', 0o755);
  assert.throws(() => restoreBinary(rec, w.dest(), 'job-1'), code('ORIGIN_NAME_CONFLICT'));
  assert.equal(fs.readlinkSync(spec.binaryPath), path.join(w.home, 'versions/2.0.0'), 'live untouched');
});

/** codex-like: releases/<v>/ dir, relative `current` link, bin link through current. */
function codexLike(home: string): BinaryLayoutSpec {
  const standalone = path.join(home, '.codex/packages/standalone');
  writeFixtureFile(path.join(standalone, 'releases/0.1.0/bin/codex'), 'codex-0.1', 0o755);
  writeFixtureFile(path.join(standalone, 'releases/0.1.0/codex-package.json'), '{}', 0o644);
  fs.symlinkSync('codex', path.join(standalone, 'releases/0.1.0/bin/codex-alias'));
  fs.symlinkSync('releases/0.1.0', path.join(standalone, 'current'));
  const bin = path.join(home, '.local/bin/codex');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.symlinkSync(path.join(standalone, 'current/bin/codex'), bin);
  return {
    layout: 'versioned-dir', linkMode: 'hardlink', binaryPath: bin,
    versionsDir: path.join(standalone, 'releases'), symlinks: [path.join(standalone, 'current'), bin],
  };
}

test('codex versioned-dir: both links swapped atomically, release tree restored', () => {
  const w = world();
  const spec = codexLike(w.home);
  const rec = takeBinarySnapshot({ ...spec, linkMode: 'copy' }, w.dest());
  assert.ok(rec.files.some((e) => e.type === 'symlink' && e.rel === '0.1.0/bin/codex-alias'));
  const standalone = path.join(w.home, '.codex/packages/standalone');
  writeFixtureFile(path.join(standalone, 'releases/0.2.0/bin/codex'), 'codex-0.2', 0o755);
  fs.rmSync(path.join(standalone, 'current'));
  fs.symlinkSync('releases/0.2.0', path.join(standalone, 'current'));
  fs.rmSync(path.join(standalone, 'releases/0.1.0'), { recursive: true });
  restoreBinary(rec, w.dest(), 'job-1');
  assert.equal(fs.readlinkSync(path.join(standalone, 'current')), 'releases/0.1.0');
  assert.equal(read(spec.binaryPath), 'codex-0.1');
  assert.equal(fs.readlinkSync(path.join(standalone, 'releases/0.1.0/bin/codex-alias')), 'codex');
  assert.equal(modeOf(path.join(standalone, 'releases/0.1.0/bin/codex')), 0o755);
  const fp = liveBinaryFingerprint(spec, () => '0.1.0');
  assert.equal(fp.treeSha256, rec.treeSha256);
  assert.equal(fp.version, '0.1.0');
});

test('a recorded link resolving into the snapshot root is refused (SNAPSHOT_TAMPERED)', () => {
  const w = world();
  const spec = claudeLike(w.home);
  const rec = takeBinarySnapshot(spec, w.dest());
  const evil = { ...rec, symlinks: [{ path: spec.binaryPath, linkTarget: path.join(w.dest(), 'binary/1.0.0') }] };
  assert.throws(() => restoreBinary(evil, w.dest(), 'job-1'), code('SNAPSHOT_TAMPERED'));
});

test('single-file (agy-like, copy): in-place self-update undone via temp + rename', () => {
  const w = world();
  const bin = path.join(w.home, '.local/bin/agy');
  writeFixtureFile(bin, 'agy-1.2.11', 0o755);
  const spec: BinaryLayoutSpec = { layout: 'single-file', linkMode: 'copy', binaryPath: bin, symlinks: [] };
  const rec = takeBinarySnapshot(spec, w.dest());
  assert.equal(rec.copiedBytes, 'agy-1.2.11'.length);
  const before = liveBinaryFingerprint(spec, () => '1.2.11');
  writeFixtureFile(bin, 'agy-1.2.12', 0o755);
  assert.notEqual(liveBinaryFingerprint(spec, () => '1.2.12').sha256, before.sha256);
  restoreBinary(rec, w.dest(), 'job-1');
  assert.equal(read(bin), 'agy-1.2.11');
  assert.equal(modeOf(bin), 0o755);
  assert.deepEqual(liveBinaryFingerprint(spec, () => '1.2.11'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(bin)), ['agy']);
});

test('single-file refuses a symlinked binary (layout mismatch)', () => {
  const w = world();
  const spec = claudeLike(w.home);
  assert.throws(() => takeBinarySnapshot({ ...spec, layout: 'single-file' }, w.dest()), code('SNAPSHOT_LAYOUT_MISMATCH'));
  assert.throws(() => takeBinarySnapshot({ ...spec, symlinks: [path.join(w.home, 'versions/1.0.0')] }, w.dest()), code('SNAPSHOT_LAYOUT_MISMATCH'));
});

test('npm-prefix: new package dir renamed in, old one kept aside, bin link restored', () => {
  const w = world();
  const pkg = path.join(w.home, 'prefix/lib/node_modules/qwen');
  writeFixtureFile(path.join(pkg, 'cli.js'), 'qwen-0.24.0', 0o755);
  const bin = path.join(w.home, 'prefix/bin/qwen');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.symlinkSync('../lib/node_modules/qwen/cli.js', bin);
  const spec: BinaryLayoutSpec = { layout: 'npm-prefix', linkMode: 'copy', binaryPath: bin, packageDir: pkg, symlinks: [bin] };
  const rec = takeBinarySnapshot(spec, w.dest());
  writeFixtureFile(path.join(pkg, 'cli.js'), 'qwen-0.24.6', 0o755);
  restoreBinary(rec, w.dest(), 'job-1');
  assert.equal(read(bin), 'qwen-0.24.0');
  assert.equal(read(path.join(`${pkg}.nassaj-pre-restore-job-1`, 'cli.js')), 'qwen-0.24.6');
});

test('a FIFO inside the origin tree is refused (SNAPSHOT_UNSAFE_ENTRY)', () => {
  const w = world();
  const pkg = path.join(w.home, 'pkg/odd');
  writeFixtureFile(path.join(pkg, 'a.js'), 'x');
  execFileSync('mkfifo', [path.join(pkg, 'pipe')]);
  const spec: BinaryLayoutSpec = { layout: 'npm-prefix', linkMode: 'copy', binaryPath: path.join(pkg, 'a.js'), packageDir: pkg, symlinks: [] };
  assert.throws(() => takeBinarySnapshot(spec, w.dest()), code('SNAPSHOT_UNSAFE_ENTRY'));
});

test('versioned layout mismatch: binary outside versionsDir', () => {
  const w = world();
  const spec = claudeLike(w.home);
  writeFixtureFile(path.join(w.home, 'elsewhere/claude'), 'x');
  fs.rmSync(spec.binaryPath);
  fs.symlinkSync(path.join(w.home, 'elsewhere/claude'), spec.binaryPath);
  assert.throws(() => takeBinarySnapshot(spec, w.dest()), code('SNAPSHOT_LAYOUT_MISMATCH'));
  assert.throws(() => takeBinarySnapshot({ ...spec, versionsDir: undefined }, w.dest()), code('SNAPSHOT_LAYOUT_MISMATCH'));
});
