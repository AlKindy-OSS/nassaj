/**
 * T-1871 stage 3b — cross-process harness lock: single flight across Nassaj
 * processes sharing one snapshot root; a dead owner's lock is reclaimed.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  acquireHarnessFileLock,
  isHarnessLockedElsewhere,
  processStartToken,
  releaseHarnessFileLock,
} from './harness-lock.js';
import { makeFixtureRoot, removeFixture } from './snapshot/__tests__/fixtures.js';

const root = makeFixtureRoot();
after(() => removeFixture(root));
const lockOf = (h: string) => path.join(root, `.${h}.lock`);

test('acquire, conflict for the same process, release by the holder only', () => {
  assert.equal(acquireHarnessFileLock(root, 'codex', 'job-a'), null);
  assert.equal((fs.statSync(lockOf('codex')).mode & 0o777), 0o600);
  assert.equal(acquireHarnessFileLock(root, 'codex', 'job-b'), 'job-a');
  releaseHarnessFileLock(root, 'codex', 'job-b');
  assert.ok(fs.existsSync(lockOf('codex')), 'a non-holder cannot release');
  releaseHarnessFileLock(root, 'codex', 'job-a');
  assert.equal(fs.existsSync(lockOf('codex')), false);
  assert.equal(isHarnessLockedElsewhere(root, 'codex'), false);
});

test('a live sibling process holds the lock; a dead or reused pid is stale', () => {
  const parent = process.ppid;
  fs.writeFileSync(lockOf('cursor'), JSON.stringify({ pid: parent, start: processStartToken(parent), jobId: 'sibling' }));
  assert.equal(isHarnessLockedElsewhere(root, 'cursor'), true);
  assert.equal(acquireHarnessFileLock(root, 'cursor', 'mine'), 'sibling');
  fs.writeFileSync(lockOf('cursor'), JSON.stringify({ pid: parent, start: 'not-its-start', jobId: 'reused' }));
  assert.equal(isHarnessLockedElsewhere(root, 'cursor'), false);
  assert.equal(acquireHarnessFileLock(root, 'cursor', 'mine'), null);
  releaseHarnessFileLock(root, 'cursor', 'mine');
  fs.writeFileSync(lockOf('agy'), '{corrupt');
  assert.equal(acquireHarnessFileLock(root, 'agy', 'mine'), null, 'an unreadable lock is stale');
  releaseHarnessFileLock(root, 'agy', 'mine');
});

test('the start token reads /proc and is null for a missing pid; ids are validated', () => {
  assert.match(processStartToken(process.pid) ?? '', /^\d+$/);
  assert.equal(processStartToken(2 ** 30), null);
  assert.throws(() => acquireHarnessFileLock(root, '../x', 'j'), TypeError);
});
