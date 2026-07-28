import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendFinishedId,
  isCompletionSignal,
  removeFinishedId,
  shouldMarkSessionFinished,
} from './sessionCompletionStore.js';

// State-transition coverage for the sidebar three-state activity indicator:
// running (live store) → finished-unopened (this store) → cleared on open.

describe('isCompletionSignal', () => {
  it('accepts turn-level complete and error messages', () => {
    assert.equal(isCompletionSignal({ kind: 'complete' }), true);
    assert.equal(isCompletionSignal({ kind: 'error' }), true);
  });

  it('accepts the /proc monitor final idle broadcast', () => {
    assert.equal(
      isCompletionSignal({ kind: 'status', text: 'process_state', processState: 'idle' }),
      true,
    );
  });

  it('rejects live process states and unrelated payloads', () => {
    assert.equal(
      isCompletionSignal({ kind: 'status', text: 'process_state', processState: 'running' }),
      false,
    );
    assert.equal(
      isCompletionSignal({ kind: 'status', text: 'process_state', processState: 'frozen' }),
      false,
    );
    assert.equal(isCompletionSignal({ kind: 'status', text: 'token_usage' }), false);
    assert.equal(isCompletionSignal({ kind: 'message' }), false);
    assert.equal(isCompletionSignal({}), false);
  });
});

describe('shouldMarkSessionFinished', () => {
  it('marks a completion for a session the user is NOT viewing', () => {
    assert.equal(shouldMarkSessionFinished({ kind: 'complete', sessionId: 'bg-1' }, 'open-2'), true);
    assert.equal(shouldMarkSessionFinished({ kind: 'complete', sessionId: 'bg-1' }, null), true);
    assert.equal(shouldMarkSessionFinished({ kind: 'complete', sessionId: 'bg-1' }, undefined), true);
  });

  it('never marks the currently open conversation', () => {
    assert.equal(shouldMarkSessionFinished({ kind: 'complete', sessionId: 'open-2' }, 'open-2'), false);
  });

  it('requires a real session id and a completion signal', () => {
    assert.equal(shouldMarkSessionFinished({ kind: 'complete', sessionId: '' }, null), false);
    assert.equal(shouldMarkSessionFinished({ kind: 'complete' }, null), false);
    assert.equal(shouldMarkSessionFinished({ kind: 'complete', sessionId: 42 }, null), false);
    assert.equal(
      shouldMarkSessionFinished(
        { kind: 'status', text: 'process_state', processState: 'running', sessionId: 'bg-1' },
        null,
      ),
      false,
    );
  });
});

describe('appendFinishedId / removeFinishedId', () => {
  it('appends newest last and de-duplicates (re-mark refreshes recency)', () => {
    assert.deepEqual(appendFinishedId([], 'a'), ['a']);
    assert.deepEqual(appendFinishedId(['a', 'b'], 'c'), ['a', 'b', 'c']);
    assert.deepEqual(appendFinishedId(['a', 'b'], 'a'), ['b', 'a']);
  });

  it('caps the list by evicting the oldest marks', () => {
    assert.deepEqual(appendFinishedId(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd']);
  });

  it('removes a present id and signals no-op with null otherwise', () => {
    assert.deepEqual(removeFinishedId(['a', 'b'], 'a'), ['b']);
    assert.equal(removeFinishedId(['a', 'b'], 'zzz'), null);
  });

  it('round-trips the full lifecycle: finish → persist shape → open clears', () => {
    let ids: readonly string[] = [];
    ids = appendFinishedId(ids, 'session-1'); // run finished in background
    ids = appendFinishedId(ids, 'session-2');
    assert.deepEqual(ids, ['session-1', 'session-2']);
    ids = removeFinishedId(ids, 'session-1') ?? ids; // user opened it
    assert.deepEqual(ids, ['session-2']);
  });
});
