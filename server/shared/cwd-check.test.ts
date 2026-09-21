/**
 * cwd-check.test.ts — unit tests for B-31 checkCwdExists helper.
 *
 * Verifies that:
 *   - an existing directory returns { ok: true }
 *   - a missing directory returns { ok: false, error: { code: 'project_dir_missing', … } }
 *   - empty / falsy cwd returns { ok: false, error: … }
 *   - buildCwdMissingPayload produces the correct WS envelope shape
 *
 * Runner: Node built-in test runner (no fs mocking needed — uses os.tmpdir()).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkCwdExists, buildCwdMissingPayload } from '@/shared/cwd-check.js';

// ---------------------------------------------------------------------------
// checkCwdExists
// ---------------------------------------------------------------------------

test('checkCwdExists returns ok:true for a real temporary directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nassaj-cwd-check-'));
  try {
    const result = await checkCwdExists(dir);
    assert.equal(result.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkCwdExists returns ok:false for a non-existent path', async () => {
  const result = await checkCwdExists('/this/path/does/not/exist/nassaj-cwd-check-test');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'project_dir_missing');
    assert.ok(result.error.fallbackMessage.length > 0);
  }
});

test('checkCwdExists returns ok:false for empty string', async () => {
  const result = await checkCwdExists('');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'project_dir_missing');
  }
});

test('checkCwdExists returns ok:false for whitespace-only string', async () => {
  const result = await checkCwdExists('   ');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'project_dir_missing');
  }
});

test('checkCwdExists returns ok:false for null', async () => {
  const result = await checkCwdExists(null);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'project_dir_missing');
  }
});

test('checkCwdExists returns ok:false for undefined', async () => {
  const result = await checkCwdExists(undefined);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'project_dir_missing');
  }
});

// ---------------------------------------------------------------------------
// buildCwdMissingPayload
// ---------------------------------------------------------------------------

test('buildCwdMissingPayload produces correct WS envelope shape', () => {
  const error = { code: 'project_dir_missing' as const, fallbackMessage: 'dir not found: /x' };
  const payload = buildCwdMissingPayload(error, { sessionId: 'sess-1', provider: 'claude' });

  assert.equal(payload['kind'], 'error');
  assert.equal(payload['code'], 'project_dir_missing');
  assert.equal(payload['content'], 'dir not found: /x');
  assert.equal(payload['sessionId'], 'sess-1');
  assert.equal(payload['provider'], 'claude');
});

test('buildCwdMissingPayload uses null sessionId when absent', () => {
  const error = { code: 'project_dir_missing' as const, fallbackMessage: 'x' };
  const payload = buildCwdMissingPayload(error, { provider: 'cursor' });
  assert.equal(payload['sessionId'], null);
});

test('buildCwdMissingPayload includes requestId when provided', () => {
  const error = { code: 'project_dir_missing' as const, fallbackMessage: 'x' };
  const payload = buildCwdMissingPayload(error, { provider: 'cursor', requestId: 'req-42' });
  assert.equal(payload['requestId'], 'req-42');
});

test('buildCwdMissingPayload omits requestId when not provided', () => {
  const error = { code: 'project_dir_missing' as const, fallbackMessage: 'x' };
  const payload = buildCwdMissingPayload(error, { provider: 'claude' });
  assert.equal('requestId' in payload, false);
});

test('buildCwdMissingPayload sets isNewSessionError flag for a new (no-sessionId) spawn', () => {
  const error = { code: 'project_dir_missing' as const, fallbackMessage: 'x' };
  const payload = buildCwdMissingPayload(error, { provider: 'claude', isNewSessionError: true });
  assert.equal(payload['isNewSessionError'], true);
});

test('buildCwdMissingPayload omits isNewSessionError on a resume (sessionId present)', () => {
  // Resume path: cwd check runs with an existing sessionId and no isNewSessionError
  // flag, so the frontend correlates the failure with the existing session.
  const error = { code: 'project_dir_missing' as const, fallbackMessage: 'x' };
  const payload = buildCwdMissingPayload(error, { sessionId: 'sess-resume', provider: 'claude' });
  assert.equal('isNewSessionError' in payload, false);
  assert.equal(payload['sessionId'], 'sess-resume');
});
