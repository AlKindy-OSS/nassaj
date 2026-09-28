// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { defaultSpawnLedgerPath, SpawnLedger } from './spawn-ledger.js';
import { makeFixtureRoot, modeOf, removeFixture } from './snapshot/__tests__/fixtures.js';

const root = makeFixtureRoot();
after(() => removeFixture(root));
let seq = 0;
const ledgerFile = () => path.join(root, `l${(seq += 1)}`, 'nassaj', 'harness-spawn-ledger.json');

test('default path lives under ~/.local/share/nassaj', () => {
  assert.equal(defaultSpawnLedgerPath('/h'), '/h/.local/share/nassaj/harness-spawn-ledger.json');
});

test('success then spawns: first spawn time fixed, count grows, file 0600 in 0700 dir', () => {
  const file = ledgerFile();
  let t = 100;
  const ledger = new SpawnLedger(file, () => t);
  ledger.recordUpdateSuccess('codex', 'job-1', 50);
  assert.deepEqual(ledger.spawnFactsSince('codex', 'job-1'), { firstSpawnAt: null, count: 0, unknown: false });
  ledger.noteSpawn('codex');
  t = 200;
  ledger.noteSpawn('codex');
  ledger.noteSpawn('claude'); // other harness: no runs, no effect
  assert.deepEqual(ledger.spawnFactsSince('codex', 'job-1'), { firstSpawnAt: 100, count: 2, unknown: false });
  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(path.dirname(file)), 0o700);
  // a fresh process reads the durable facts
  assert.deepEqual(new SpawnLedger(file).spawnFactsSince('codex', 'job-1'), { firstSpawnAt: 100, count: 2, unknown: false });
});

test('a later success starts a new run; the older run keeps counting', () => {
  const file = ledgerFile();
  const ledger = new SpawnLedger(file, () => 10);
  ledger.recordUpdateSuccess('codex', 'a', 1);
  ledger.noteSpawn('codex');
  ledger.recordUpdateSuccess('codex', 'b', 5);
  ledger.noteSpawn('codex');
  assert.equal(ledger.spawnFactsSince('codex', 'a').count, 2);
  assert.equal(ledger.spawnFactsSince('codex', 'b').count, 1);
  ledger.forgetRun('codex', 'a');
  ledger.forgetRun('codex', 'zzz');
  assert.equal(ledger.spawnFactsSince('codex', 'a').unknown, true);
});

test('missing ledger, missing run (crash between succeeded and ledger) and corrupt file → unknown', () => {
  const file = ledgerFile();
  const ledger = new SpawnLedger(file);
  assert.deepEqual(ledger.spawnFactsSince('codex', 'job-1'), { firstSpawnAt: null, count: 0, unknown: true });
  ledger.recordUpdateSuccess('codex', 'job-1', 1);
  assert.equal(ledger.spawnFactsSince('codex', 'other').unknown, true);
  fs.writeFileSync(file, '{"schema":1,"harnesses":{"codex":{"job-1":{"count":"x"}}}}');
  assert.equal(ledger.spawnFactsSince('codex', 'job-1').unknown, true);
  fs.writeFileSync(file, 'garbage');
  assert.equal(ledger.spawnFactsSince('codex', 'job-1').unknown, true);
  ledger.noteSpawn('codex'); // corrupt ledger: no throw, spawn proceeds
});

test('write failure: spawn proceeds, run becomes unknown, flag persisted on the next good write', () => {
  const file = ledgerFile();
  const ledger = new SpawnLedger(file, () => 100);
  ledger.recordUpdateSuccess('codex', 'job-1', 50);
  const dir = path.dirname(file);
  fs.chmodSync(dir, 0o500); // temp file cannot be created
  assert.doesNotThrow(() => ledger.noteSpawn('codex'));
  assert.equal(ledger.spawnFactsSince('codex', 'job-1').unknown, true);
  fs.chmodSync(dir, 0o700);
  ledger.noteSpawn('codex');
  assert.equal(new SpawnLedger(file).spawnFactsSince('codex', 'job-1').unknown, true, 'unknown is durable');
  ledger.recordUpdateSuccess('codex', 'job-2', 200);
  assert.equal(ledger.spawnFactsSince('codex', 'job-2').unknown, false, 'a newer run starts known');
});
