/**
 * B-1643 / T-2034: the shared session-id grammar.
 *
 * LIVE_SHAPES are the id shapes found in the app database on 2026-10-16
 * (read-only survey, 529 rows: claude/codex/hermes/qwen/antigravity UUIDs,
 * `agy_<ms>_<suffix>`, `kimi_<uuid>`, opencode `ses_<base62>`; 26–41 chars,
 * no dot, no colon). Digits are altered; the shapes are not.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SAFE_SESSION_ID } from '../services/server-actions.js';

import { SESSION_ID_MAX_LENGTH, isSessionId, parseSessionIdParam } from './session-id.js';
import { AppError } from './utils.js';

const LIVE_SHAPES = [
  '7150688b-7846-4100-965c-a54a90692901', // claude
  '11111111-2222-7333-8444-555555555555', // codex (UUIDv7)
  '803549b7-8fbc-4f15-9b51-e9055aee4e57', // hermes
  '25327a79-2072-488d-b6e2-766a67606154', // qwen
  '02e5fb9f-a67a-4990-b8b3-69c61721e688', // antigravity
  'agy_1789388813511_sccibe98', // antigravity (agy_ form, 26 chars)
  'kimi_f22f09e2-a05d-480c-9107-d1d47fcc86e3', // kimi (41 chars)
  'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa', // opencode (30 chars)
];

const REJECTED = [
  '', '.', '..', '...', '.x', 'a..b', 'a/b', '/', '%2F', 'a%2Fb', '..%2F..', ' ', ' abc', 'abc ', 'a b',
  'a\tb', 'a\nb', 'a\0b', 'a:b', 'a\\b', 'é', 'x'.repeat(SESSION_ID_MAX_LENGTH + 1),
];

test('accepts every live session-id shape', () => {
  for (const id of LIVE_SHAPES) {
    assert.equal(isSessionId(id), true, id);
    assert.equal(parseSessionIdParam(id), id);
  }
});

test('accepts short ids, inner single dots and the exact maximum length', () => {
  for (const id of ['-', 'a', '_', 'a.b', 'a.b.c', 'a-b_c.d', 'x'.repeat(SESSION_ID_MAX_LENGTH)]) {
    assert.equal(isSessionId(id), true, id);
  }
});

test('rejects dots that could name a directory entry, separators, whitespace and overlength', () => {
  for (const id of REJECTED) {
    assert.equal(isSessionId(id), false, JSON.stringify(id));
    assert.throws(() => parseSessionIdParam(id), (error: unknown) => (
      error instanceof AppError && error.statusCode === 400 && error.code === 'INVALID_SESSION_ID'
    ));
  }
});

test('rejects non-strings without coercion', () => {
  for (const value of [undefined, null, 123, ['abc'], { id: 'abc' }]) {
    assert.equal(isSessionId(value), false);
    assert.throws(() => parseSessionIdParam(value), AppError);
  }
});

test('never trims: the checked id is the returned id', () => {
  assert.throws(() => parseSessionIdParam(` ${LIVE_SHAPES[0]}`), AppError);
  assert.throws(() => parseSessionIdParam(`${LIVE_SHAPES[0]}\n`), AppError);
});

test('server-actions keeps a copy of the grammar that agrees with it (B-1643)', () => {
  for (const id of [...LIVE_SHAPES, ...REJECTED, '-', 'a.b', 'x'.repeat(SESSION_ID_MAX_LENGTH)]) {
    assert.equal(SAFE_SESSION_ID.test(id), isSessionId(id), JSON.stringify(id));
  }
});
