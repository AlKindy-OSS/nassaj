import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { hasErrorCode } from './errors.js';
import { loadManifest, MANIFEST_FILE, persistRestore, transitionManifest, validateManifest, writeManifest } from './manifest.js';
import { asidePath, ensurePrivateDir, isPathInside, jobSnapshotDir, restoreTempPath, snapshotRootDir, versionedRestoreTempPath } from './paths.js';
import { makeFixtureRoot, makeManifest, modeOf, removeFixture } from './__tests__/fixtures.js';

const root = makeFixtureRoot();
after(() => removeFixture(root));

const invalid = (fn: () => unknown) => assert.throws(fn, (e) => hasErrorCode(e, 'MANIFEST_INVALID'));

test('write → load round-trips; file 0600, dir 0700, no temp left', () => {
  const dir = path.join(root, 'rt');
  ensurePrivateDir(dir);
  const m = makeManifest();
  writeManifest(dir, m);
  assert.deepEqual(loadManifest(dir), m);
  assert.equal(modeOf(path.join(dir, MANIFEST_FILE)), 0o600);
  assert.equal(modeOf(dir), 0o700);
  assert.deepEqual(fs.readdirSync(dir), [MANIFEST_FILE]);
});

test('transition appends history; persistRestore replaces the journal', () => {
  const dir = path.join(root, 'tr');
  ensurePrivateDir(dir);
  let m = makeManifest();
  writeManifest(dir, m);
  m = transitionManifest(dir, m, 'mutating', 5);
  assert.equal(loadManifest(dir).state, 'mutating');
  assert.deepEqual(loadManifest(dir).stateHistory.at(-1), { state: 'mutating', at: 5 });
  m = persistRestore(dir, m, { kind: 'auto', scope: 'binary', startedAt: 1, phase: 'staging', files: [], dataLossAck: false });
  assert.equal(loadManifest(dir).restore?.phase, 'staging');
});

test('missing or corrupt manifest → MANIFEST_INVALID', () => {
  const dir = path.join(root, 'bad');
  ensurePrivateDir(dir);
  invalid(() => loadManifest(dir));
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), '{not json');
  invalid(() => loadManifest(dir));
});

test('validation rejects wrong schema, ids, enums and unsafe rels', () => {
  invalid(() => validateManifest({ ...makeManifest(), schema: 2 }));
  invalid(() => validateManifest({ ...makeManifest(), jobId: '../x' }));
  invalid(() => validateManifest({ ...makeManifest(), harness: 'Codex/..' }));
  invalid(() => validateManifest({ ...makeManifest(), state: 'weird' }));
  invalid(() => validateManifest({ ...makeManifest(), counted: 'no' }));
  invalid(() => validateManifest(null));
  const binary = {
    layout: 'single-file', linkMode: 'copy', device: 1, origin: '/x/agy', symlinks: [],
    files: [{ rel: '../escape', type: 'file', sha256: 'a', size: 1, mode: 0o755 }], treeSha256: 'x', copiedBytes: 0,
  };
  invalid(() => validateManifest({ ...makeManifest(), binary }));
  invalid(() => validateManifest({ ...makeManifest(), binary: { ...binary, files: [{ rel: 'a', type: 'fifo' }] } }));
  invalid(() => validateManifest({ ...makeManifest(), binary: { ...binary, origin: 'relative' } }));
  const ok = { ...binary, files: [{ rel: 'agy', type: 'file', sha256: 'a', size: 1, mode: 0o755 }, { rel: 'agy/l', type: 'symlink', linkTarget: 'x' }, { rel: 'agy/d', type: 'dir', mode: 0o755 }] };
  assert.ok(validateManifest({ ...makeManifest(), binary: ok }));
});

test('validation of stores and restore journal', () => {
  const stores = {
    coverage: [{ home: '/h', storeId: 'codex', dir: '/h/.codex', status: 'present' }],
    sets: [{ id: 's', storeId: 'codex', dir: '/h/.codex', base: 'a.sqlite', members: [{ suffix: '', present: true, size: 1, sha256: 'x', backupRel: 'stores/s/a.sqlite' }] }],
    preFingerprint: 'p', postFingerprint: null, totalBytes: 1,
  };
  assert.ok(validateManifest({ ...makeManifest(), stores }));
  invalid(() => validateManifest({ ...makeManifest(), stores: { ...stores, sets: [{ ...stores.sets[0], base: 'a/b' }] } }));
  invalid(() => validateManifest({ ...makeManifest(), stores: { ...stores, coverage: [{ ...stores.coverage[0], status: 'maybe' }] } }));
  const restore = { kind: 'manual', scope: 'binary+data', startedAt: 1, phase: 'asiding', dataLossAck: true,
    files: [{ op: 'stage', target: '/a', temp: '/a.t', sha256: 'x' }, { op: 'aside', target: '/b', aside: '/b.a' }] };
  assert.ok(validateManifest({ ...makeManifest(), restore }));
  invalid(() => validateManifest({ ...makeManifest(), restore: { ...restore, files: [{ op: 'delete', target: '/a' }] } }));
  invalid(() => validateManifest({ ...makeManifest(), restore: { ...restore, phase: 'done' } }));
});

test('paths: id validation and derived names', () => {
  assert.equal(snapshotRootDir('/h'), '/h/.local/share/nassaj/harness-snapshots');
  assert.equal(jobSnapshotDir('/r', 'codex', 'j-1'), '/r/codex/j-1');
  assert.throws(() => jobSnapshotDir('/r', 'codex', '../j'));
  assert.throws(() => jobSnapshotDir('/r', '../codex', 'j'));
  assert.equal(restoreTempPath('/a/b', 'j'), '/a/b.nassaj-restore-j');
  assert.equal(asidePath('/a/b', 'j'), '/a/b.nassaj-pre-restore-j');
  assert.equal(versionedRestoreTempPath('/v', '1.0', 'j'), '/v/.1.0.nassaj-restore-j');
  assert.equal(isPathInside('/a/b/c', '/a/b'), true);
  assert.equal(isPathInside('/a/bc', '/a/b'), false);
});

test('ensurePrivateDir tightens a loose dir and refuses a symlink', () => {
  const loose = path.join(root, 'loose');
  fs.mkdirSync(loose, { mode: 0o755 });
  fs.chmodSync(loose, 0o755);
  ensurePrivateDir(loose);
  assert.equal(modeOf(loose), 0o700);
  const link = path.join(root, 'link');
  fs.symlinkSync(loose, link);
  assert.throws(() => ensurePrivateDir(link));
});
