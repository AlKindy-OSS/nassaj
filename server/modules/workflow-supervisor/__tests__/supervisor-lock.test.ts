/**
 * T-821 — the single-owner flock gate (الشرط 5). Proves in-process mutual
 * exclusion: a second acquire on the SAME lock file fails while the first is held,
 * and release lets a subsequent acquire succeed. (The kill-9 kernel-release
 * property is exercised live in the shadow harness; here we prove the in-process
 * contract deterministically.)
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireSingleOwnerLock } from '@/modules/workflow-supervisor/supervisor-lock.js';

test('single-owner: second acquire fails while the first is held; release frees it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lock-'));
  const lockPath = path.join(dir, 'supervisor.lock');
  try {
    const first = acquireSingleOwnerLock(lockPath);
    assert.ok(first, 'first acquire succeeds');

    const second = acquireSingleOwnerLock(lockPath);
    assert.equal(second, null, 'second acquire fails while held (one monitor at a time)');

    first!.release();

    const third = acquireSingleOwnerLock(lockPath);
    assert.ok(third, 'acquire succeeds again after release');
    third!.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('acquire creates the lock file dir if missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lock-mk-'));
  const lockPath = path.join(dir, 'nested', 'deep', 'supervisor.lock');
  try {
    const lock = acquireSingleOwnerLock(lockPath);
    assert.ok(lock, 'acquire creates parent dirs and locks');
    lock!.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
