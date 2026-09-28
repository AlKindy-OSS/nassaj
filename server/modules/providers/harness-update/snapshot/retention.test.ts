import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { hasErrorCode } from './errors.js';
import { writeManifest, type HarnessSnapshotManifest } from './manifest.js';
import { ensurePrivateDir } from './paths.js';
import {
  assertDiskHeadroom,
  assertSnapshotCountWithinCap,
  pruneSnapshots,
  SNAPSHOT_MAX_AGE_MS,
  type RetentionAuditEvent,
} from './retention.js';
import { makeFixtureRoot, makeManifest, removeFixture, writeFixtureFile } from './__tests__/fixtures.js';

const base = makeFixtureRoot();
after(() => removeFixture(base));
const code = (c: Parameters<typeof hasErrorCode>[1]) => (e: unknown) => hasErrorCode(e, c);
const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

let seq = 0;
function snapRoot(): string {
  return path.join(base, `r${(seq += 1)}`);
}

function job(root: string, jobId: string, over: Partial<HarnessSnapshotManifest>, harness = 'codex'): string {
  const dir = path.join(root, harness, jobId);
  ensurePrivateDir(dir);
  writeFixtureFile(path.join(dir, 'binary/codex'), 'payload-bytes', 0o600);
  writeManifest(dir, makeManifest({ jobId, harness, createdAt: NOW - DAY, ...over }));
  return dir;
}

const exists = (p: string) => fs.existsSync(p);

test('keeps the newest 3 succeeded runs, prunes older terminal ones, never non-terminal', () => {
  const root = snapRoot();
  const events: RetentionAuditEvent[] = [];
  const dirs = [1, 2, 3, 4].map((i) => job(root, `s${i}`, { state: 'succeeded', createdAt: NOW - i * 3600_000 }));
  const failed = job(root, 'rf', { state: 'rollback_failed', createdAt: NOW - 30 * DAY });
  const inflight = job(root, 'mut', { state: 'mutating', createdAt: NOW - 30 * DAY });
  const noop = job(root, 'noop', { state: 'noop' });
  const report = pruneSnapshots({ root, now: NOW, audit: (e) => events.push(e) });
  assert.deepEqual(dirs.map(exists), [true, true, true, false]);
  assert.equal(exists(failed), true);
  assert.equal(exists(inflight), true);
  assert.equal(exists(noop), false);
  assert.equal(report.prunedSnapshots, 2);
  assert.ok(report.bytes > 0);
  assert.ok(events.every((e) => !JSON.stringify(e).includes('/')), 'audit carries no paths');
  assert.deepEqual(events.map((e) => e.action), ['harness_snapshot_pruned', 'harness_snapshot_pruned']);
});

test('age rule: a succeeded run older than 7 days is pruned even inside the window', () => {
  const root = snapRoot();
  const old = job(root, 'old', { state: 'succeeded', createdAt: NOW - SNAPSHOT_MAX_AGE_MS - 1 });
  const fresh = job(root, 'fresh', { state: 'succeeded', createdAt: NOW - 1 });
  pruneSnapshots({ root, now: NOW });
  assert.equal(exists(old), false);
  assert.equal(exists(fresh), true);
});

test('a restore not yet settled is never pruned', () => {
  const root = snapRoot();
  const dir = job(root, 'rest', {
    state: 'rolled_back', createdAt: NOW - 30 * DAY,
    restore: { kind: 'auto', scope: 'binary+data', startedAt: NOW - 30 * DAY, phase: 'swapping', files: [], dataLossAck: false },
  });
  pruneSnapshots({ root, now: NOW });
  assert.equal(exists(dir), true);
});

test('asides: kept until their own age expires (payload pruned first), then deleted and audited', () => {
  const root = snapRoot();
  const member = path.join(base, `member${seq}/.codex`);
  const aside = path.join(member, 'state_5.sqlite.nassaj-pre-restore-rb');
  writeFixtureFile(aside, 'kept-aside', 0o600);
  const restore = (startedAt: number) => ({
    kind: 'manual' as const, scope: 'binary+data' as const, startedAt, phase: 'committed' as const, dataLossAck: true,
    files: [{ op: 'aside' as const, target: path.join(member, 'state_5.sqlite'), aside }],
  });
  const dir = job(root, 'rb', { state: 'rolled_back', createdAt: NOW - 2 * DAY, restore: restore(NOW - DAY) });
  const events: RetentionAuditEvent[] = [];
  pruneSnapshots({ root, now: NOW, audit: (e) => events.push(e) });
  assert.equal(exists(aside), true, 'aside younger than max age survives');
  assert.equal(exists(path.join(dir, 'binary')), false, 'payload pruned');
  assert.equal(exists(path.join(dir, 'manifest.json')), true, 'manifest kept as the aside record');
  assertSnapshotCountWithinCap(root, 'codex', 0);
  pruneSnapshots({ root, now: NOW + SNAPSHOT_MAX_AGE_MS, audit: (e) => events.push(e) });
  assert.equal(exists(aside), false);
  assert.equal(exists(dir), false);
  assert.ok(events.some((e) => e.action === 'harness_snapshot_aside_pruned' && e.count === 1 && e.bytes === 'kept-aside'.length));
});

test('orphan asides in sweep dirs are pruned by age; referenced or young ones stay', () => {
  const root = snapRoot();
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(base, `sweep${seq}`);
  const orphan = path.join(dir, 'a.sqlite.nassaj-pre-restore-x');
  writeFixtureFile(orphan, 'o', 0o600);
  writeFixtureFile(path.join(dir, 'a.sqlite'), 'live', 0o600);
  const events: RetentionAuditEvent[] = [];
  pruneSnapshots({ root, now: Date.now(), asideSweepDirs: [dir, path.join(dir, 'missing')], audit: (e) => events.push(e) });
  assert.equal(exists(orphan), true, 'young orphan kept');
  pruneSnapshots({ root, now: Date.now() + SNAPSHOT_MAX_AGE_MS + DAY, asideSweepDirs: [dir], audit: (e) => events.push(e) });
  assert.equal(exists(orphan), false);
  assert.equal(exists(path.join(dir, 'a.sqlite')), true);
  assert.deepEqual(events, [{ action: 'harness_snapshot_aside_pruned', harness: null, jobId: null, count: 1, bytes: 1 }]);
});

test('invalid manifests and odd dir names are skipped, not deleted', () => {
  const root = snapRoot();
  const bad = path.join(root, 'codex', 'broken');
  ensurePrivateDir(bad);
  fs.writeFileSync(path.join(bad, 'manifest.json'), '{');
  ensurePrivateDir(path.join(root, 'Bad.Harness'));
  const report = pruneSnapshots({ root, now: NOW, harness: 'codex' });
  assert.equal(report.skippedInvalid, 2);
  assert.equal(exists(bad), true);
});

test('count cap: MAX+1 payload snapshots after prune → SNAPSHOT_COUNT_CAP', () => {
  const root = snapRoot();
  for (const i of [1, 2]) job(root, `c${i}`, { state: 'succeeded' });
  assertSnapshotCountWithinCap(root, 'codex', 2);
  job(root, 'c3', { state: 'mutating' });
  assert.throws(() => assertSnapshotCountWithinCap(root, 'codex', 2), code('SNAPSHOT_COUNT_CAP'));
  assertSnapshotCountWithinCap(root, 'claude', 2);
});

test('disk guard: 97.1 % → INSUFFICIENT_STORAGE, 96.9 % passes, copy bytes count', () => {
  const statfs = () => ({ blocks: 1000, bfree: 40, bsize: 1000 }); // 96.0 % used
  assertDiskHeadroom(9_000, '/x', statfs); // 96.9 %
  assert.throws(() => assertDiskHeadroom(11_000, '/x', statfs), code('INSUFFICIENT_STORAGE')); // 97.1 %
  assertDiskHeadroom(0, '/x', statfs); // hard links on the same device cost nothing
  assert.throws(() => assertDiskHeadroom(0, '/x', () => ({ blocks: 0, bfree: 0, bsize: 4096 })), code('INSUFFICIENT_STORAGE'));
  assertDiskHeadroom(0, base); // real statfs of the fixture filesystem works
});
