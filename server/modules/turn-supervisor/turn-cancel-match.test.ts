/**
 * turn-cancel-match.test.ts — T-2093 (ADR-TURN-SCOPED-CONTROL), QA condition 3.
 *
 * Both supervisors (hosted and CLI) cancel only the active turn the stop names:
 * the provider and starter checks are unchanged (B-1765 tracks the starter rule
 * separately), and a stop carrying a clientMsgId must match the turn's own.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { isCancellableActiveTurn } from './turn-cancel-match.js';

const ACTIVE = { provider: 'codex', userId: 41, clientMsgId: 'turn-1' };

test('a stop without clientMsgId keeps the legacy provider + starter check', () => {
  assert.equal(isCancellableActiveTurn(ACTIVE, { provider: 'codex', userId: 41 }), true);
  assert.equal(isCancellableActiveTurn(ACTIVE, { provider: 'qwen', userId: 41 }), false);
  assert.equal(isCancellableActiveTurn(ACTIVE, { provider: 'codex', userId: 42 }), false);
  assert.equal(isCancellableActiveTurn(ACTIVE, { provider: 'codex', userId: null }), false);
  assert.equal(isCancellableActiveTurn(undefined, { provider: 'codex', userId: 41 }), false);
});

test('a stop naming another turn never cancels the active one', () => {
  assert.equal(isCancellableActiveTurn(ACTIVE, { provider: 'codex', userId: 41, clientMsgId: 'turn-1' }), true);
  assert.equal(isCancellableActiveTurn(ACTIVE, { provider: 'codex', userId: 41, clientMsgId: 'turn-0' }), false);
});

test('both supervisor runtimes record the clientMsgId and cancel through the shared predicate', () => {
  for (const file of ['hosted-turn-supervisor.service.ts', 'cli-turn-supervisor.service.ts']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, /this\.#active\.set\(sessionId, \{[^}]*clientMsgId: input\.clientMsgId/,
      `${file} stores clientMsgId in #active`);
    assert.match(source, /isCancellableActiveTurn\(this\.#active\.get\(input\.sessionId\), input\)/, file);
  }
});
