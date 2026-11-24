import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { git, makeOverlay, makeRepository, recordingWriter, removeRepository, turnContext } from './checkpoint-fixture.test.js';

import {
  checkpointStorePath,
  createTurnCheckpointMaintenance,
  enforceRetention,
  listTurnCheckpoints,
  reconcileCheckpointStores,
  withTurnCheckpoint,
} from './index.js';

const storeGit = (store, ...args) => execFileSync('git', ['--git-dir', store, ...args], { encoding: 'utf8' }).trim();
const commonDir = (repo) => fs.realpathSync(path.join(repo, '.git'));
const storeOf = (repo, binding, principalId = 7) => checkpointStorePath({
  commonGitDir: commonDir(repo), principalId: String(principalId), overlayId: binding.overlayId,
});
const refSeqs = (store) => storeGit(store, 'for-each-ref', '--format=%(refname)', 'refs/checkpoints/')
  .split('\n').filter((ref) => ref.endsWith('/post')).map((ref) => Number(ref.split('/')[2]));

async function turns(binding, count, options = {}) {
  for (let index = 0; index < count; index += 1) {
    await withTurnCheckpoint(turnContext(binding, recordingWriter()), async () => {
      fs.writeFileSync(path.join(binding.cwd, 'counter.txt'), `turn ${index} ${'x'.repeat(index)}\n`);
    }, options);
  }
}

test('count retention keeps the newest turns, re-roots the chain on the base and stays fsck-clean', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    await turns(binding, 6, { retention: { keepTurns: 3, pruneSlack: 1 } });
    const store = storeOf(repo, binding);
    const kept = refSeqs(store);
    assert.ok(kept.length <= 4 && kept.includes(6), `kept ${kept}`);
    const oldest = String(Math.min(...kept)).padStart(8, '0');
    assert.equal(storeGit(store, 'rev-parse', `refs/checkpoints/${oldest}/pre^`), binding.baseOid);
    git(repo, 'gc', '-q', '--prune=now');
    execFileSync('git', ['--git-dir', store, 'fsck', '--full', '--strict'], { stdio: 'pipe' });
    assert.equal(storeGit(store, 'show', 'refs/checkpoints/00000006/post:counter.txt'), `turn 5 ${'x'.repeat(5)}`);
    const listed = await listTurnCheckpoints({ binding, principalId: 7 });
    assert.deepEqual(listed.turns[0].files, [{ path: 'counter.txt', status: 'M' }]);
  } finally { removeRepository(repo); }
});

test('age retention drops turns older than the window but never the newest', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    await turns(binding, 3);
    const store = storeOf(repo, binding);
    const later = Date.now() + 30 * 24 * 60 * 60_000;
    await enforceRetention({ store, commonGitDir: commonDir(repo), baseOid: binding.baseOid, deadline: Date.now() + 30_000, now: later });
    assert.deepEqual(refSeqs(store), [3]);
  } finally { removeRepository(repo); }
});

test('H2: a prune keeps each surviving turn\'s age (manifest time and commit dates)', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const day = 24 * 60 * 60_000;
    const tenDaysAgo = Date.now() - 10 * day;
    await turns(binding, 3, { now: () => tenDaysAgo });
    await turns(binding, 1);
    const store = storeOf(repo, binding);
    const datesBefore = storeGit(store, 'log', '-1', '--format=%at %ct', 'refs/checkpoints/00000003/post');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const base = { store, commonGitDir: commonDir(repo), baseOid: binding.baseOid, deadline: Date.now() + 30_000 };
    // A count prune re-roots turns 2..4 "now"; their recorded age must survive it.
    await enforceRetention({ ...base, keepTurns: 3, pruneSlack: 0 });
    assert.deepEqual(refSeqs(store), [2, 3, 4]);
    assert.equal(storeGit(store, 'log', '-1', '--format=%at %ct', 'refs/checkpoints/00000003/post'), datesBefore);
    // Five days later the turns created ten days ago are past the 14-day window.
    await enforceRetention({ ...base, keepTurns: 50, now: Date.now() + 5 * day });
    assert.deepEqual(refSeqs(store), [4]);
  } finally { removeRepository(repo); }
});

test('member cap and global cap prune the oldest turns down to the newest', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    await turns(binding, 5);
    const store = storeOf(repo, binding);
    const base = { store, commonGitDir: commonDir(repo), baseOid: binding.baseOid, deadline: Date.now() + 30_000 };
    await enforceRetention({ ...base, memberCapBytes: 1 });
    assert.deepEqual(refSeqs(store), [5]);
    await turns(binding, 3);
    await enforceRetention({ ...base, globalCapBytes: 1 });
    assert.deepEqual(refSeqs(store), [8]);
  } finally { removeRepository(repo); }
});

test('low disk skips capture with a reason and creates no store', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const writer = recordingWriter();
    await withTurnCheckpoint(turnContext(binding, writer), async () => {}, { freeDiskBytes: async () => 1024, minFreeBytes: 4096 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writer.checkpoint().status, 'skipped');
    assert.equal(writer.checkpoint().reason, 'low_disk');
    assert.equal(fs.existsSync(storeOf(repo, binding)), false);
  } finally { removeRepository(repo); }
});

test('boot reconciliation marks a pre without post interrupted and clears a stale lock', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    let releaseTurn;
    const blocked = new Promise((resolve) => { releaseTurn = resolve; });
    const running = withTurnCheckpoint(turnContext(binding, recordingWriter()), () => blocked);
    const store = storeOf(repo, binding);
    const preExists = () => {
      try { return storeGit(store, 'for-each-ref', 'refs/checkpoints/').includes('/pre'); } catch { return false; }
    };
    while (!preExists() || fs.existsSync(path.join(store, 'nassaj.lock'))) await new Promise((resolve) => setTimeout(resolve, 10));
    // Simulate a crash: an orphan pre whose turn is still open under a dead process, and a dead lock owner.
    const state = JSON.parse(fs.readFileSync(path.join(store, 'nassaj-state.json'), 'utf8'));
    state.open['1'].pid = 2 ** 22 + 17;
    fs.writeFileSync(path.join(store, 'nassaj-state.json'), JSON.stringify(state));
    fs.mkdirSync(path.join(store, 'nassaj.lock'));
    fs.writeFileSync(path.join(store, 'nassaj.lock', 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 17, at: Date.now() }));
    fs.writeFileSync(path.join(store, 'tmp', 'idx-leftover'), 'x');
    const report = await reconcileCheckpointStores({ commonGitDirs: [commonDir(repo)], boot: true });
    assert.equal(report.interrupted, 1);
    assert.equal(report.locksCleared, 1);
    assert.equal(fs.existsSync(path.join(store, 'tmp', 'idx-leftover')), false);
    assert.ok(state.open['1']);
    const listed = await listTurnCheckpoints({ binding, principalId: 7 });
    assert.equal(listed.turns[0].status, 'interrupted');
    releaseTurn();
    await running;
  } finally { removeRepository(repo); }
});

test('M2: boot reconciliation leaves a live turn of a running process open', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const store = storeOf(repo, binding);
    const turn = await openTurn(binding, store);
    const report = await reconcileCheckpointStores({ commonGitDirs: [commonDir(repo)], boot: true });
    assert.equal(report.interrupted, 0);
    await turn.finish();
    assert.equal(turn.writer.checkpoint().status, 'captured');
    const state = JSON.parse(fs.readFileSync(path.join(store, 'nassaj-state.json'), 'utf8'));
    assert.deepEqual(state.interrupted, []);
  } finally { removeRepository(repo); }
});

test('M2: reconciliation waits for a capture in progress and never removes its index', async () => {
  const repo = makeRepository({ 'a.ts': 'a\n', 'b.ts': 'b\n' });
  try {
    const binding = makeOverlay(repo);
    let sweep = null;
    const options = { hooks: { afterRead: () => {
      sweep ??= reconcileCheckpointStores({ commonGitDirs: [commonDir(repo)], boot: true });
    } } };
    const writer = recordingWriter();
    await withTurnCheckpoint(turnContext(binding, writer), async () => {
      fs.writeFileSync(path.join(binding.cwd, 'new.ts'), 'n\n');
    }, options);
    await sweep;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writer.checkpoint().status, 'captured');
    const tree = storeGit(storeOf(repo, binding), 'ls-tree', '-r', '--name-only', 'refs/checkpoints/00000001/post');
    assert.deepEqual(tree.split('\n').sort(), ['a.ts', 'b.ts', 'new.ts']);
  } finally { removeRepository(repo); }
});

test('M2: no ref ever points at a tree whose index vanished; the next turn still works', async () => {
  const repo = makeRepository({ 'a.ts': 'a\n' });
  try {
    const binding = makeOverlay(repo);
    const store = storeOf(repo, binding);
    const writer = recordingWriter();
    await withTurnCheckpoint(turnContext(binding, writer), async () => {
      fs.writeFileSync(path.join(binding.cwd, 'x.ts'), 'x\n');
    }, { hooks: { afterWriteTree: (indexFile, phase) => { if (phase === 'post') fs.rmSync(indexFile); } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writer.checkpoint().status, 'failed');
    assert.equal(storeGit(store, 'for-each-ref', 'refs/checkpoints/00000001/post'), '');
    await turns(binding, 1);
    assert.match(storeGit(store, 'ls-tree', '-r', '--name-only', 'refs/checkpoints/00000002/post'), /a\.ts/);
  } finally { removeRepository(repo); }
});

test('orphan sweep deletes stores whose overlay manifest is gone, through the lifecycle hook', async () => {
  const repo = makeRepository();
  try {
    const kept = makeOverlay(repo, { sessionId: 'kept' });
    const gone = makeOverlay(repo, { sessionId: 'gone' });
    await turns(kept, 1);
    await turns(gone, 1);
    fs.rmSync(path.join(commonDir(repo), 'nassaj-session-overlays', 'instances', gone.overlayId, 'manifest.json'));
    const maintenance = createTurnCheckpointMaintenance({ listProjectPaths: () => [repo, '/nonexistent-project'] });
    await maintenance.start();
    maintenance.stop();
    assert.equal(fs.existsSync(storeOf(repo, gone)), false);
    assert.equal(fs.existsSync(storeOf(repo, kept)), true);
  } finally { removeRepository(repo); }
});

/** Starts a turn that stays open until the returned release() is called. */
async function openTurn(binding, store, { file = 'during.txt', body = 'written during the open turn\n' } = {}) {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const writer = recordingWriter();
  const running = withTurnCheckpoint(turnContext(binding, writer), async () => {
    await blocked;
    fs.writeFileSync(path.join(binding.cwd, file), body);
  });
  const preCount = () => {
    try { return storeGit(store, 'for-each-ref', 'refs/checkpoints/').split('\n').filter((r) => r.endsWith('/pre')).length; } catch { return 0; }
  };
  const before = preCount();
  while (preCount() === before || fs.existsSync(path.join(store, 'nassaj.lock'))) await new Promise((resolve) => setTimeout(resolve, 10));
  return { writer, finish: async () => { release(); await running; await new Promise((resolve) => setImmediate(resolve)); } };
}

test('M1: retention during an open turn neither drops it nor breaks its post checkpoint', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    await turns(binding, 3);
    const store = storeOf(repo, binding);
    const turn = await openTurn(binding, store);
    await enforceRetention({
      store, commonGitDir: commonDir(repo), baseOid: binding.baseOid, deadline: Date.now() + 30_000, keepTurns: 0, pruneSlack: 0,
    });
    await turn.finish();
    assert.equal(turn.writer.checkpoint().status, 'captured');
    assert.equal(storeGit(store, 'rev-parse', 'refs/checkpoints/00000004/post^'), storeGit(store, 'rev-parse', 'refs/checkpoints/00000004/pre'));
    const listed = await listTurnCheckpoints({ binding, principalId: 7 });
    assert.deepEqual(listed.turns.find((entry) => entry.turnSeq === 4).files, [{ path: 'during.txt', status: 'A' }]);
  } finally { removeRepository(repo); }
});

test('M1: a failed post checkpoint marks the turn interrupted, never running', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const store = checkpointStorePath({ commonGitDir: commonDir(repo), principalId: '7', overlayId: binding.overlayId });
    await turns(binding, 1);
    const turn = await openTurn(binding, store);
    storeGit(store, 'update-ref', '-d', 'refs/checkpoints/00000002/pre');
    await turn.finish();
    assert.equal(turn.writer.checkpoint().status, 'failed');
    const state = JSON.parse(fs.readFileSync(path.join(store, 'nassaj-state.json'), 'utf8'));
    assert.deepEqual(state.open, {});
    assert.ok(state.interrupted.includes(2));
  } finally { removeRepository(repo); }
});

test('round 2: the turn the private index reflects survives a size-cap prune', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const store = checkpointStorePath({ commonGitDir: commonDir(repo), principalId: '7', overlayId: binding.overlayId });
    const older = await openTurn(binding, store, { file: 'older.txt', body: `older ${Math.random()}\n` });
    const newer = await openTurn(binding, store, { file: 'newer.txt', body: 'newer\n' });
    await newer.finish();
    await older.finish();
    assert.equal(older.writer.checkpoint().status, 'captured');
    await enforceRetention({
      store, commonGitDir: commonDir(repo), baseOid: binding.baseOid, deadline: Date.now() + 30_000, memberCapBytes: 1,
    });
    const writer = recordingWriter();
    await withTurnCheckpoint(turnContext(binding, writer), async () => {
      fs.writeFileSync(path.join(binding.cwd, 'after.txt'), 'after\n');
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writer.checkpoint().status, 'captured', JSON.stringify(writer.checkpoint()));
    execFileSync('git', ['--git-dir', store, 'fsck', '--full', '--strict'], { stdio: 'pipe' });
  } finally { removeRepository(repo); }
});

test('round 2: a broken private index is dropped and the next capture rebuilds it from the base', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    await turns(binding, 1);
    const store = storeOf(repo, binding);
    fs.writeFileSync(path.join(store, 'index'), 'DIRC not really an index');
    const broken = recordingWriter();
    await withTurnCheckpoint(turnContext(binding, broken), async () => {});
    const healed = recordingWriter();
    await withTurnCheckpoint(turnContext(binding, healed), async () => {
      fs.writeFileSync(path.join(binding.cwd, 'healed.txt'), 'ok\n');
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(broken.checkpoint().status, 'failed');
    assert.equal(healed.checkpoint().status, 'captured', JSON.stringify(healed.checkpoint()));
    const post = `refs/checkpoints/${String(healed.checkpoint().turnSeq).padStart(8, '0')}/post`;
    assert.match(storeGit(store, 'ls-tree', '-r', '--name-only', post), /healed\.txt/);
  } finally { removeRepository(repo); }
});
