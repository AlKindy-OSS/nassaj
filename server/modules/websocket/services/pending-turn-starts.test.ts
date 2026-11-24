import assert from 'node:assert/strict';
import test from 'node:test';

import { PendingTurnStarts } from './pending-turn-starts.js';

const socketA = { id: 'a' };
const socketB = { id: 'b' };

test('a named session stop matches its pending start, and only with the same turn key when one is named', () => {
  const starts = new PendingTurnStarts();
  const pending = starts.begin({ sessionId: 's1', turnKey: 't1', starterUserId: 7, connection: socketA });
  assert.equal(starts.stop({ sessionId: 's2', turnKey: null, userId: 7, connection: socketA }), null);
  assert.equal(starts.stop({ sessionId: 's1', turnKey: 'other', userId: 7, connection: socketA }), null);
  assert.equal(starts.stop({ sessionId: 's1', turnKey: 't1', userId: 9, connection: socketB }), pending);
  assert.equal(pending.stopped, true);
});

test('an empty-id stop matches only the same starter on the same connection', () => {
  const starts = new PendingTurnStarts();
  const pending = starts.begin({ sessionId: null, turnKey: 't1', starterUserId: 7, connection: socketA });
  assert.equal(starts.stop({ sessionId: '', turnKey: 't1', userId: 8, connection: socketA }), null);
  assert.equal(starts.stop({ sessionId: '', turnKey: 't1', userId: 7, connection: socketB }), null);
  assert.equal(starts.stop({ sessionId: '', turnKey: 't1', userId: 7, connection: null }), null);
  assert.equal(starts.stop({ sessionId: '', turnKey: 't1', userId: 7, connection: socketA }), pending);
});

test('an ended start is never stopped and the registry empties', () => {
  const starts = new PendingTurnStarts();
  const pending = starts.begin({ sessionId: 's1', turnKey: 't1', starterUserId: 7, connection: socketA });
  starts.end(pending);
  assert.equal(starts.stop({ sessionId: 's1', turnKey: 't1', userId: 7, connection: socketA }), null);
  assert.equal(pending.stopped, false);
  assert.equal(starts.size(), 0);
});
