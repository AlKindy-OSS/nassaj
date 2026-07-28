/**
 * T-821 / C1 (T-820 audit) — the disk-queue DoS defenses. Proves:
 *   - countPendingIntents counts a user's on-disk intents (fail-CLOSED on error),
 *   - sweepStaleIntents deletes intents past the TTL (and only those),
 *   - QueuedRetryTracker gates a queued intent to once per back-off (the probe-
 *     amplification fix).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  countPendingIntents,
  sweepStaleIntents,
  QueuedRetryTracker,
} from '@/modules/workflow-supervisor/queue-guard.js';

function envFor(root: string): NodeJS.ProcessEnv {
  return { ...process.env, WORKFLOW_SUPERVISOR_STATE_DIR: root };
}

function writeIntent(root: string, userId: number, name: string, ageMs = 0): void {
  const dir = path.join(root, 'intents', String(userId));
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '{}');
  if (ageMs > 0) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
  }
}

test('countPendingIntents counts real intent files, ignores .tmp-, 0 for missing dir', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qg-count-'));
  try {
    const env = envFor(root);
    assert.equal(countPendingIntents(1, env), 0, 'no dir ⇒ 0');
    writeIntent(root, 1, 'a.json');
    writeIntent(root, 1, 'b.json');
    writeIntent(root, 1, 'c.json.tmp-123'); // half-written rename target — not counted
    assert.equal(countPendingIntents(1, env), 2);
    assert.equal(countPendingIntents(2, env), 0, 'other user unaffected');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweepStaleIntents deletes only intents older than the TTL', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qg-sweep-'));
  try {
    const env = envFor(root);
    writeIntent(root, 1, 'fresh.json', 0);
    writeIntent(root, 1, 'stale.json', 60 * 60 * 1000); // 1h old
    const res = sweepStaleIntents(env, 30 * 60 * 1000); // TTL 30m
    assert.equal(res.deleted, 1);
    assert.equal(fs.existsSync(path.join(root, 'intents', '1', 'fresh.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'intents', '1', 'stale.json')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('QueuedRetryTracker gates a queued key to once per back-off', () => {
  let clock = 1000;
  const now = () => clock;
  const tracker = new QueuedRetryTracker(500, now);

  assert.equal(tracker.shouldAttempt('k'), true, 'never attempted ⇒ allowed');
  tracker.markAttempt('k');
  assert.equal(tracker.shouldAttempt('k'), false, 'within back-off ⇒ skipped');
  clock += 499;
  assert.equal(tracker.shouldAttempt('k'), false, 'still within back-off');
  clock += 1;
  assert.equal(tracker.shouldAttempt('k'), true, 'past back-off ⇒ allowed again');

  // forget/retain keep the tracker bounded.
  tracker.markAttempt('k');
  tracker.forget('k');
  assert.equal(tracker.shouldAttempt('k'), true, 'forgotten key is fresh');
  tracker.markAttempt('x');
  tracker.retain(new Set()); // no live keys ⇒ prune all
  assert.equal(tracker.shouldAttempt('x'), true, 'pruned key is fresh');
});
