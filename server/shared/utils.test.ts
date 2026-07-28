import assert from 'node:assert/strict';
import test from 'node:test';

import { isCliInstalled } from '@/shared/utils.js';

/**
 * Builds a fake spawn.sync that returns a fixed result object, mirroring the
 * shapes cross-spawn / child_process.spawnSync actually produce. These tests
 * pin the B-56 root cause: spawn.sync signals "binary missing" via the returned
 * object (error.code === 'ENOENT', status === null), NOT via a thrown error.
 */
type FakeResult = {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
};

const spawnReturning = (result: FakeResult) =>
  ({ spawnSync: (() => result) as never });

test('ENOENT (missing binary) => installed=false even though spawn.sync did not throw', () => {
  const err = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawn codex' });
  const installed = isCliInstalled('codex', {}, spawnReturning({ status: null, error: err }));
  assert.equal(installed, false);
});

test('clean --version exit (status 0, no error) => installed=true', () => {
  const installed = isCliInstalled('claude', {}, spawnReturning({ status: 0 }));
  assert.equal(installed, true);
});

test('non-zero exit with no spawn error => installed=false', () => {
  // Binary ran but `--version` exited non-zero: treat as not a healthy install.
  const installed = isCliInstalled('weird-cli', {}, spawnReturning({ status: 1 }));
  assert.equal(installed, false);
});

test('status null with no error (defensive) => installed=false', () => {
  const installed = isCliInstalled('odd-cli', {}, spawnReturning({ status: null }));
  assert.equal(installed, false);
});

test('ETIMEDOUT (slow but present binary) => installed=true (must not hide a real provider)', () => {
  const err = Object.assign(new Error('spawnSync sleep ETIMEDOUT'), { code: 'ETIMEDOUT', errno: -110 });
  const installed = isCliInstalled('slow-cli', {}, spawnReturning({ status: null, signal: 'SIGTERM', error: err }));
  assert.equal(installed, true);
});

test('SIGTERM signal without explicit code is still treated as a timeout => installed=true', () => {
  const installed = isCliInstalled('slow-cli', {}, spawnReturning({ status: null, signal: 'SIGTERM' }));
  assert.equal(installed, true);
});

test('EACCES (present but not executable) => installed=false', () => {
  const err = Object.assign(new Error('spawn EACCES'), { code: 'EACCES', errno: -13 });
  const installed = isCliInstalled('blocked-cli', {}, spawnReturning({ status: null, error: err }));
  assert.equal(installed, false);
});

test('an unexpected thrown error is caught and reported as not installed', () => {
  const throwing = { spawnSync: (() => { throw new Error('boom'); }) as never };
  const installed = isCliInstalled('boom-cli', {}, throwing);
  assert.equal(installed, false);
});
