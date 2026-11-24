/** T-2095 qa low items: lock owner atomicity, pre-withheld paths, temp-file cleanup, uniform misses. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { makeOverlay, makeRepository, recordingWriter, removeRepository, turnContext } from './checkpoint-fixture.test.js';
import { lockIsStale } from './checkpoint-store.js';

import {
  checkpointStorePath,
  enforceRetention,
  listTurnCheckpoints,
  readTurnCheckpointDiff,
  reconcileCheckpointStores,
  withTurnCheckpoint,
} from './index.js';

const commonDir = (repo) => fs.realpathSync(path.join(repo, '.git'));
const storeOf = (repo, binding) => checkpointStorePath({
  commonGitDir: commonDir(repo), principalId: '7', overlayId: binding.overlayId,
});

async function turn(binding, work, options) {
  await withTurnCheckpoint(turnContext(binding, recordingWriter()), work, options);
}

test('a lock directory whose owner file is not written yet is not stale (no steal mid-acquire)', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    await turn(binding, async () => {});
    const store = storeOf(repo, binding);
    fs.mkdirSync(path.join(store, 'nassaj.lock'));
    assert.equal(lockIsStale(store), false, 'a fresh lock without owner.json is still being created');
    assert.equal(lockIsStale(store, Date.now() + 60_000), true, 'after the grace period it is stale');
    fs.rmSync(path.join(store, 'nassaj.lock'), { recursive: true });
  } finally { removeRepository(repo); }
});

test('a path withheld before the turn is reported withheld, never as added', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    const options = { limits: { fileBytes: 16 } };
    await turn(binding, async () => fs.writeFileSync(path.join(binding.cwd, 'big.txt'), 'x'.repeat(40)), options);
    await turn(binding, async () => fs.writeFileSync(path.join(binding.cwd, 'big.txt'), 'small\n'), options);
    const listed = await listTurnCheckpoints({ binding, principalId: 7 });
    const second = listed.turns.find((entry) => entry.turnSeq === 2);
    const big = second.files.find((file) => file.path === 'big.txt');
    assert.equal(big.status, 'withheld');
    assert.equal(big.phase, 'pre');
    const diff = await readTurnCheckpointDiff({ binding, principalId: 7, turnSeq: 2, path: 'big.txt' });
    assert.equal(diff.withheld, true);
  } finally { removeRepository(repo); }
});

test('retention and boot reconciliation remove temporary pack and object files', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    for (let index = 0; index < 3; index += 1) {
      await turn(binding, async () => fs.writeFileSync(path.join(binding.cwd, 'n.txt'), `${index}\n`));
    }
    const store = storeOf(repo, binding);
    const tmpPack = path.join(store, 'objects', 'pack', 'tmp_pack_abandoned');
    fs.writeFileSync(tmpPack, 'x');
    await enforceRetention({
      store, commonGitDir: commonDir(repo), baseOid: binding.baseOid, deadline: Date.now() + 30_000, keepTurns: 1, pruneSlack: 0,
    });
    assert.equal(fs.existsSync(tmpPack), false);
    fs.mkdirSync(path.join(store, 'objects', 'ab'), { recursive: true });
    const tmpObject = path.join(store, 'objects', 'ab', 'tmp_obj_abandoned');
    fs.writeFileSync(tmpObject, 'x');
    fs.writeFileSync(tmpPack, 'x');
    await reconcileCheckpointStores({ commonGitDirs: [commonDir(repo)], boot: true });
    assert.equal(fs.existsSync(tmpObject), false);
    assert.equal(fs.existsSync(tmpPack), false);
  } finally { removeRepository(repo); }
});

test('a binding the overlay reader rejects reads as not found, never as an error', async () => {
  const repo = makeRepository();
  try {
    const binding = makeOverlay(repo);
    await turn(binding, async () => {});
    const forged = { ...binding, cwd: path.join(repo, 'not-an-instance', 'workspace') };
    assert.equal(await listTurnCheckpoints({ binding: forged, principalId: 7 }), null);
    assert.equal(await readTurnCheckpointDiff({ binding: forged, principalId: 7, turnSeq: 1 }), null);
  } finally { removeRepository(repo); }
});
