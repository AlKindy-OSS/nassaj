/**
 * active-turn-registry.test.ts — T-2093 (ADR-TURN-SCOPED-CONTROL).
 *
 * The registry maps a session to the turn currently running in it (turnKey =
 * the clientMsgId that started the turn). QA condition 1: an entry is never
 * overwritten, and only the owning turn may delete it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ActiveTurnRegistry } from './active-turn-registry.js';

const writerA = { name: 'socket-a' };
const writerB = { name: 'socket-b' };

test('registers a turn and reports match / stale / absent verdicts', () => {
  const registry = new ActiveTurnRegistry();
  assert.equal(registry.verdict('s1', 'k1'), 'absent');
  assert.equal(registry.register({ sessionId: 's1', turnKey: 'k1', starterUserId: 1, writer: writerA }), true);
  assert.equal(registry.verdict('s1', 'k1'), 'match');
  assert.equal(registry.verdict('s1', 'k0'), 'stale');
  assert.equal(registry.verdict('s2', 'k1'), 'absent');
});

test('condition 1: a second turn (session_busy send) never overwrites the running entry', () => {
  const registry = new ActiveTurnRegistry();
  registry.register({ sessionId: 's1', turnKey: 'running', starterUserId: 1, writer: writerA });
  assert.equal(
    registry.register({ sessionId: 's1', turnKey: 'rejected', starterUserId: 2, writer: writerB }),
    false,
  );
  // The rejected send's writer finally releases with ITS key: a no-op.
  assert.equal(registry.release('s1', 'rejected'), false);
  assert.equal(registry.get('s1')?.turnKey, 'running');
  assert.equal(registry.verdict('s1', 'running'), 'match');
});

test('release deletes only while the key still matches, then a new turn may register', () => {
  const registry = new ActiveTurnRegistry();
  registry.register({ sessionId: 's1', turnKey: 'k1', starterUserId: 1, writer: writerA });
  assert.equal(registry.release('s1', 'k1'), true);
  assert.equal(registry.verdict('s1', 'k1'), 'absent');
  assert.equal(registry.register({ sessionId: 's1', turnKey: 'k2', starterUserId: 1, writer: writerA }), true);
  assert.equal(registry.release('s1', 'k1'), false, 'a late release of the old turn is a no-op');
  assert.equal(registry.verdict('s1', 'k2'), 'match');
});

test('findStartedTurn is scoped to the starter: another user never resolves the key', () => {
  const registry = new ActiveTurnRegistry();
  registry.register({ sessionId: 's1', turnKey: 'k1', starterUserId: 1, writer: writerA });
  assert.equal(registry.findStartedTurn(1, 'k1')?.sessionId, 's1');
  assert.equal(registry.findStartedTurn(2, 'k1'), undefined);
  assert.equal(registry.findStartedTurn(null, 'k1'), undefined);
  registry.release('s1', 'k1');
  assert.equal(registry.findStartedTurn(1, 'k1'), undefined, 'the key index is cleaned with the entry');
});

test('the same key string from two users does not collide in the key index', () => {
  const registry = new ActiveTurnRegistry();
  registry.register({ sessionId: 's1', turnKey: 'same', starterUserId: 1, writer: writerA });
  registry.register({ sessionId: 's2', turnKey: 'same', starterUserId: 2, writer: writerB });
  assert.equal(registry.findStartedTurn(1, 'same')?.sessionId, 's1');
  assert.equal(registry.findStartedTurn(2, 'same')?.sessionId, 's2');
});

test('empty session id or key never registers', () => {
  const registry = new ActiveTurnRegistry();
  assert.equal(registry.register({ sessionId: '', turnKey: 'k', starterUserId: 1, writer: writerA }), false);
  assert.equal(registry.register({ sessionId: 's', turnKey: '', starterUserId: 1, writer: writerA }), false);
  assert.equal(registry.size(), 0);
});
