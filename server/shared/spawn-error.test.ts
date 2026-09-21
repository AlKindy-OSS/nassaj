/**
 * spawn-error.test.ts — unit tests for B-32 mapSpawnError helper.
 *
 * Verifies that raw Node.js spawn errors are consistently mapped to the
 * structured {code, fallbackMessage} contract the frontend depends on.
 *
 * Runner: Node built-in test runner (vitest-compatible assertions via node:assert).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { mapSpawnError, type MappedSpawnError } from '@/shared/spawn-error.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNodeError(code: string, message: string, path?: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  if (path !== undefined) {
    (err as unknown as Record<string, unknown>).path = path;
  }
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('mapSpawnError with context=cwd always returns project_dir_missing', () => {
  const err = makeNodeError('ENOENT', '/missing/dir does not exist');
  const result: MappedSpawnError = mapSpawnError(err, 'cwd');
  assert.equal(result.code, 'project_dir_missing');
  assert.ok(result.fallbackMessage.length > 0);
});

test('mapSpawnError ENOENT with a path hint (cwd missing) returns project_dir_missing', () => {
  const err = makeNodeError('ENOENT', 'spawn ENOENT', '/home/user/myproject');
  const result = mapSpawnError(err);
  assert.equal(result.code, 'project_dir_missing');
});

test('mapSpawnError ENOENT without a path hint (binary missing) returns cli_not_installed', () => {
  const err = makeNodeError('ENOENT', 'spawn claude ENOENT');
  const result = mapSpawnError(err);
  assert.equal(result.code, 'cli_not_installed');
});

test('mapSpawnError with context=binary returns cli_not_installed', () => {
  const err = makeNodeError('ENOENT', 'spawn ENOENT', '/usr/local/bin/cursor-agent');
  const result = mapSpawnError(err, 'binary');
  assert.equal(result.code, 'cli_not_installed');
});

test('mapSpawnError EACCES returns permission_denied (distinct from cwd/binary)', () => {
  const err = makeNodeError('EACCES', 'spawn EACCES');
  const result = mapSpawnError(err);
  assert.equal(result.code, 'permission_denied');
  assert.ok(result.fallbackMessage.toLowerCase().includes('permission'));
});

test('mapSpawnError EPERM returns permission_denied', () => {
  const err = makeNodeError('EPERM', 'operation not permitted');
  const result = mapSpawnError(err);
  assert.equal(result.code, 'permission_denied');
});

test('mapSpawnError unknown error code returns spawn_failed', () => {
  const err = makeNodeError('ETIMEDOUT', 'connection timed out');
  const result = mapSpawnError(err);
  assert.equal(result.code, 'spawn_failed');
});

test('mapSpawnError non-Error value is handled gracefully', () => {
  const result = mapSpawnError('something went wrong');
  assert.equal(result.code, 'spawn_failed');
  assert.ok(result.fallbackMessage.length > 0);
});

test('mapSpawnError null/undefined is handled gracefully', () => {
  const result = mapSpawnError(null);
  assert.equal(result.code, 'spawn_failed');
});

test('mapSpawnError fallbackMessage is non-empty for all cases', () => {
  const cases: unknown[] = [
    makeNodeError('ENOENT', 'x', '/a/b'),
    makeNodeError('ENOENT', 'x'),
    makeNodeError('EACCES', 'denied'),
    null,
    undefined,
    'string error',
    42,
  ];
  for (const c of cases) {
    const result = mapSpawnError(c);
    assert.ok(result.fallbackMessage.length > 0, `Expected non-empty message for ${JSON.stringify(c)}`);
  }
});
