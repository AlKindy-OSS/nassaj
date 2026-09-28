import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { hasErrorCode } from './errors.js';
import { loadManifest, writeManifest, type HarnessSnapshotManifest } from './manifest.js';
import { ensurePrivateDir } from './paths.js';
import {
  backupStores,
  CODEX_STORE,
  enumerateStoreCoverage,
  estimateStoreBackupBytes,
  OPENCODE_STORE,
  restoreStores,
  resumeStoreRestore,
  rollForwardStoreRestore,
  storesFingerprint,
} from './store-backup.js';
import { makeFixtureRoot, makeManifest, modeOf, removeFixture, writeFixtureFile } from './__tests__/fixtures.js';

const root = makeFixtureRoot();
after(() => removeFixture(root));
const code = (c: Parameters<typeof hasErrorCode>[1]) => (e: unknown) => hasErrorCode(e, c);
const noHolders = () => undefined;
const SPECS = [CODEX_STORE, OPENCODE_STORE];
const CHILD = fileURLToPath(new URL('./__tests__/crash-restore-child.ts', import.meta.url));

let seq = 0;
/** host .codex (set with wal/shm), member 1 codex+opencode, member 2 without stores. */
function world() {
  const home = path.join(root, `h${(seq += 1)}`);
  writeFixtureFile(path.join(home, '.codex/state_5.sqlite'), 'host-db', 0o600);
  writeFixtureFile(path.join(home, '.codex/state_5.sqlite-wal'), 'host-wal', 0o600);
  writeFixtureFile(path.join(home, '.codex/state_5.sqlite-shm'), 'host-shm', 0o600);
  writeFixtureFile(path.join(home, '.codex/config.toml'), 'not a store', 0o600);
  writeFixtureFile(path.join(home, '.nassaj-users/1/.codex/logs_2.sqlite'), 'm1-logs', 0o600);
  writeFixtureFile(path.join(home, '.nassaj-users/1/.local/share/opencode/opencode.db'), 'm1-oc', 0o600);
  fs.mkdirSync(path.join(home, '.nassaj-users/2'), { recursive: true });
  const snap = path.join(home, 'snap/job-1');
  ensurePrivateDir(snap);
  return { home, snap };
}

function backedUp(w: { home: string; snap: string }): HarnessSnapshotManifest {
  const cov = enumerateStoreCoverage(SPECS, w.home);
  const m = makeManifest({ stores: backupStores(cov, w.snap, noHolders) });
  writeManifest(w.snap, m);
  return m;
}

/** Name → content of every file under the store dirs (asides included). */
function snapshotLive(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (p.startsWith(path.join(home, 'snap'))) continue;
      if (d.isDirectory()) walk(p);
      else out[path.relative(home, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(home);
  return out;
}

/** Post-update drift: db rewritten, new stale shm on m1, store appears in absent member 2 home. */
function drift(home: string): void {
  writeFixtureFile(path.join(home, '.codex/state_5.sqlite'), 'host-db-NEW', 0o600);
  fs.rmSync(path.join(home, '.codex/state_5.sqlite-wal'));
  writeFixtureFile(path.join(home, '.nassaj-users/1/.codex/logs_2.sqlite-wal'), 'stale-wal', 0o600);
  writeFixtureFile(path.join(home, '.nassaj-users/2/.codex/state_5.sqlite'), 'appeared', 0o600);
}

test('coverage: host + every member home, absent recorded, sets carry wal/shm', () => {
  const w = world();
  const cov = enumerateStoreCoverage(SPECS, w.home);
  const status = Object.fromEntries(cov.coverage.map((c) => [path.relative(w.home, c.dir), c.status]));
  assert.deepEqual(status, {
    '.codex': 'present', '.local/share/opencode': 'absent',
    '.nassaj-users/1/.codex': 'present', '.nassaj-users/1/.local/share/opencode': 'present',
    '.nassaj-users/2/.codex': 'absent', '.nassaj-users/2/.local/share/opencode': 'absent',
  });
  const host = cov.sets.find((s) => s.base === 'state_5.sqlite');
  assert.deepEqual(host?.members.map((m) => [m.suffix, m.present]), [['', true], ['-wal', true], ['-shm', true]]);
  assert.equal(cov.sets.some((s) => s.base === 'config.toml'), false);
  assert.equal(estimateStoreBackupBytes(cov), 'host-dbhost-walhost-shmm1-logsm1-oc'.length);
});

test('backup copies each set (0600, sha), pre fingerprint equals live; change detected', () => {
  const w = world();
  const m = backedUp(w);
  const rec = m.stores!;
  assert.equal(rec.totalBytes, 'host-dbhost-walhost-shmm1-logsm1-oc'.length);
  const wal = rec.sets.find((s) => s.base === 'state_5.sqlite')!.members[1];
  assert.equal(fs.readFileSync(path.join(w.snap, wal.backupRel!), 'utf8'), 'host-wal');
  assert.equal(modeOf(path.join(w.snap, wal.backupRel!)), 0o600);
  assert.equal(storesFingerprint(rec.coverage), rec.preFingerprint);
  writeFixtureFile(path.join(w.home, '.nassaj-users/2/.codex/new.sqlite'), 'x', 0o600);
  assert.notEqual(storesFingerprint(rec.coverage), rec.preFingerprint, 'a store appearing in an absent dir changes it');
});

test('backup refuses when a holder is reported, and a symlinked member', () => {
  const w = world();
  const cov = enumerateStoreCoverage(SPECS, w.home);
  assert.throws(() => backupStores(cov, w.snap, () => { throw new Error('held'); }), /held/);
  fs.symlinkSync('/etc/hostname', path.join(w.home, '.codex/other.sqlite-wal'));
  writeFixtureFile(path.join(w.home, '.codex/other.sqlite'), 'x', 0o600);
  assert.throws(() => enumerateStoreCoverage(SPECS, w.home), code('SNAPSHOT_UNSAFE_ENTRY'));
});

test('restore commits: backup content back, stale WAL and appeared store moved aside', () => {
  const w = world();
  const pre = snapshotLive(w.home);
  const m = backedUp(w);
  drift(w.home);
  const done = restoreStores(w.snap, m, 'manual', { assertNoHolders: noHolders, dataLossAck: true, now: 9 });
  assert.equal(done.restore?.phase, 'committed');
  assert.equal(loadManifest(w.snap).restore?.dataLossAck, true);
  const live = snapshotLive(w.home);
  for (const [rel, content] of Object.entries(pre)) assert.equal(live[rel], content, rel);
  assert.equal(live['.nassaj-users/1/.codex/logs_2.sqlite-wal.nassaj-pre-restore-job-1'], 'stale-wal');
  assert.equal(live['.nassaj-users/1/.codex/logs_2.sqlite-wal'], undefined);
  assert.equal(live['.nassaj-users/2/.codex/state_5.sqlite.nassaj-pre-restore-job-1'], 'appeared');
  assert.equal(live['.nassaj-users/2/.codex/state_5.sqlite'], undefined);
  assert.equal(live['.codex/state_5.sqlite.nassaj-pre-restore-job-1'], 'host-db-NEW');
  assert.equal(live['.codex/config.toml'], 'not a store');
  assert.equal(storesFingerprint(m.stores!.coverage), m.stores!.preFingerprint);
});

test('tampered backup → SNAPSHOT_TAMPERED during staging, live data unchanged, journal reverted', () => {
  const w = world();
  const m = backedUp(w);
  drift(w.home);
  const drifted = snapshotLive(w.home);
  const set = m.stores!.sets[0];
  fs.appendFileSync(path.join(w.snap, set.members[0].backupRel!), 'X');
  assert.throws(() => restoreStores(w.snap, m, 'auto', { assertNoHolders: noHolders }), code('SNAPSHOT_TAMPERED'));
  assert.deepEqual(snapshotLive(w.home), drifted);
  assert.equal(loadManifest(w.snap).restore?.phase, 'reverted');
});

test('holder check runs before anything changes', () => {
  const w = world();
  const m = backedUp(w);
  drift(w.home);
  const drifted = snapshotLive(w.home);
  assert.throws(() => restoreStores(w.snap, m, 'auto', { assertNoHolders: () => { throw new Error('STORE_IN_USE'); } }));
  assert.deepEqual(snapshotLive(w.home), drifted);
  assert.equal(loadManifest(w.snap).restore, null);
});

for (const [phase, index] of [['staging', 1], ['asiding', 2]] as const) {
  test(`error during ${phase} → asides reverted, temps removed, live unchanged`, () => {
    const w = world();
    const m = backedUp(w);
    drift(w.home);
    const drifted = snapshotLive(w.home);
    const beforeStep = (p: string, i: number) => { if (p === phase && i === index) throw new Error('injected'); };
    assert.throws(() => restoreStores(w.snap, m, 'auto', { assertNoHolders: noHolders, beforeStep }), /injected/);
    assert.deepEqual(snapshotLive(w.home), drifted);
    assert.equal(loadManifest(w.snap).restore?.phase, 'reverted');
  });
}

test('error during swapping → journal stays at swapping; roll-forward completes', () => {
  const w = world();
  const pre = snapshotLive(w.home);
  const m = backedUp(w);
  drift(w.home);
  const beforeStep = (p: string, i: number) => { if (p === 'swapping' && i === 2) throw new Error('injected'); };
  assert.throws(() => restoreStores(w.snap, m, 'auto', { assertNoHolders: noHolders, beforeStep }), /injected/);
  const journal = loadManifest(w.snap);
  assert.equal(journal.restore?.phase, 'swapping');
  assert.equal(rollForwardStoreRestore(w.snap, journal).restore?.phase, 'committed');
  const live = snapshotLive(w.home);
  for (const [rel, content] of Object.entries(pre)) assert.equal(live[rel], content, rel);
});

test('roll-forward refuses a swapped file whose digest no longer matches', () => {
  const w = world();
  const m = backedUp(w);
  const beforeStep = (p: string, i: number) => { if (p === 'swapping' && i === 1) throw new Error('injected'); };
  assert.throws(() => restoreStores(w.snap, m, 'auto', { assertNoHolders: noHolders, beforeStep }));
  const journal = loadManifest(w.snap);
  const first = journal.restore!.files.find((f) => f.op === 'stage')!;
  fs.writeFileSync(first.target, 'changed after swap');
  assert.throws(() => rollForwardStoreRestore(w.snap, journal), code('SNAPSHOT_TAMPERED'));
});

// Real crash: a child process hard-exits before a file op; boot resume must settle it.
for (const [phase, index, expectRestored] of [
  ['staging', 2, false], ['asiding', 1, false], ['swapping', 0, true], ['swapping', 3, true],
] as const) {
  test(`crash in ${phase}#${index} → resumeStoreRestore ${expectRestored ? 'rolls forward' : 'reverts'}`, () => {
    const w = world();
    const pre = snapshotLive(w.home);
    backedUp(w);
    drift(w.home);
    const drifted = snapshotLive(w.home);
    const res = spawnSync(process.execPath, ['--import', 'tsx', CHILD, w.snap, phase, String(index)], { env: process.env, encoding: 'utf8' });
    assert.equal(res.status, 137, res.stderr);
    const journal = loadManifest(w.snap);
    assert.equal(journal.restore?.phase, phase);
    const settled = resumeStoreRestore(w.snap, journal);
    assert.equal(settled.restore?.phase, expectRestored ? 'committed' : 'reverted');
    const live = snapshotLive(w.home);
    if (!expectRestored) assert.deepEqual(live, drifted);
    else for (const [rel, content] of Object.entries(pre)) assert.equal(live[rel], content, rel);
    assert.equal(Object.keys(live).some((k) => k.includes('.nassaj-restore-')), false, 'no temp left');
  });
}

test('resume is a no-op for settled or absent journals', () => {
  const m = makeManifest();
  assert.equal(resumeStoreRestore('/unused', m), m);
});
