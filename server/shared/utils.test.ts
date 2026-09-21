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

test('readUtf8Tail returns whole small files and only complete trailing lines of large ones', async () => {
  const { readUtf8Tail } = await import('./utils.js');
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fsp.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'tail-'));
  try {
    const small = path.join(dir, 'small.jsonl');
    await fsp.writeFile(small, 'a\nb\n');
    assert.equal(await readUtf8Tail(small, 1024), 'a\nb\n');
    const large = path.join(dir, 'large.jsonl');
    await fsp.writeFile(large, Array.from({ length: 50 }, (_, i) => `{"n":${i}}`).join('\n') + '\n');
    const tail = await readUtf8Tail(large, 40);
    assert.ok(tail.endsWith('{"n":49}\n'));
    assert.ok(tail.startsWith('{"n":'), tail);
    assert.equal(await readUtf8Tail(path.join(dir, 'missing.jsonl')), '');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
