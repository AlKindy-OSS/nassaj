/**
 * dsh-abort-target.test.ts — T-2093 (ADR-TURN-SCOPED-CONTROL), review item 2.
 *
 * With an empty session id, a dsh stop used to kill the NEWEST run on the
 * socket. A turn-scoped stop names its turn (`expectedTurnKey` = the clientMsgId
 * that started it): only the run carrying that key is chosen, and a socket whose
 * runs all carry other keys yields `stale` (nothing killed). Without a key the
 * legacy choice is unchanged.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { selectDshAbortRun } from '../dsh-acp-runtime.js';

const tab = { readyState: 1 };
const otherTab = { readyState: 1 };
const runA = { runId: 'a', sessionId: null, clientMsgId: 'turn-a', writer: { ws: tab } };
const runB = { runId: 'b', sessionId: null, clientMsgId: 'turn-b', writer: { ws: tab } };
const named = { runId: 'n', sessionId: 'dsh-s1', clientMsgId: 'turn-n', writer: { ws: otherTab } };

test('empty id + key: the run with the key on this socket, not the newest', () => {
  assert.deepEqual(selectDshAbortRun([runA, runB], '', tab, 'turn-a'), { run: runA, stale: false });
});

test('empty id + key nobody on this socket carries: stale, nothing chosen', () => {
  assert.deepEqual(selectDshAbortRun([runA, runB], '', tab, 'turn-x'), { run: null, stale: true });
  assert.deepEqual(selectDshAbortRun([named], '', tab, 'turn-n'), { run: null, stale: false },
    'another socket\'s run is never a target, and an empty socket is just "nothing running"');
});

test('empty id without a key keeps the legacy newest-run-on-socket choice', () => {
  assert.deepEqual(selectDshAbortRun([runA, runB], '', tab, null), { run: runB, stale: false });
});

test('named id: a run started by another turn is stale', () => {
  assert.deepEqual(selectDshAbortRun([named], 'dsh-s1', tab, 'turn-old'), { run: null, stale: true });
  assert.deepEqual(selectDshAbortRun([named], 'dsh-s1', tab, 'turn-n'), { run: named, stale: false });
  assert.deepEqual(selectDshAbortRun([named], 'dsh-s1', tab, null), { run: named, stale: false });
});

test('a run recorded without a clientMsgId keeps the legacy named stop', () => {
  const unkeyed = { ...named, clientMsgId: null };
  assert.deepEqual(selectDshAbortRun([unkeyed], 'dsh-s1', tab, 'turn-1'), { run: unkeyed, stale: false });
});
