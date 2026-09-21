import test from 'node:test';
import assert from 'node:assert/strict';

// Regression guard for G3-preventive (SEC/dead-code):
// buildConversationContext was the lone structural
// Body-1-history -> next-provider formatter and was confirmed dead
// (zero production callers). It is reachable only via the exported
// singleton, so we assert it no longer exists on that export while the
// legitimately-used session methods remain intact.
import mod from './sessionManager.js';

test('sessionManager export has no buildConversationContext method', () => {
  assert.strictEqual(typeof mod.buildConversationContext, 'undefined');
});

test('sessionManager retains its live public methods', () => {
  for (const name of [
    'createSession',
    'addMessage',
    'getSession',
    'saveSession',
    'deleteSession',
  ]) {
    assert.strictEqual(
      typeof mod[name],
      'function',
      `expected sessionManager.${name} to remain a function`,
    );
  }
});
