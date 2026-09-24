/**
 * opencode-sessions.normalize.test — live `opencode run --format json` normalization.
 *
 * B-1296: real text/reasoning lines nest their content under `part`
 * (`{type:'text', part:{type:'text', text:'…'}}`). Reading `raw.text` alone left the
 * content empty and the whole live reply was silently dropped (no stream_delta). These
 * cases pin the real nested shape for both the text and the reasoning branch.
 *
 * B-1298(b): a `type:'error'` event carrying a 401/403 status or a context-overflow
 * message is tagged with a fixed, non-secret code the client can display.
 *
 * Pure unit test: no DB, no network — normalizeMessage is a synchronous transform.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OpenCodeSessionsProvider,
  OPENCODE_AUTH_ERROR_CODE,
  OPENCODE_CONTEXT_OVERFLOW_CODE,
} from './opencode-sessions.provider.js';

const provider = new OpenCodeSessionsProvider();
const SESSION = 'ses_synthetic_actor';

describe('OpenCodeSessionsProvider.normalizeMessage — B-1296 nested live parts', () => {
  it('emits a stream_delta for a real nested text line', () => {
    const messages = provider.normalizeMessage(
      { type: 'text', sessionID: SESSION, part: { type: 'text', text: 'Hello from the model' } },
      null,
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'stream_delta');
    assert.equal(messages[0].content, 'Hello from the model');
    assert.equal(messages[0].sessionId, SESSION);
  });

  it('emits a thinking message for a real nested reasoning line', () => {
    const messages = provider.normalizeMessage(
      { type: 'reasoning', sessionID: SESSION, part: { type: 'reasoning', text: 'Let me think' } },
      null,
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'thinking');
    assert.equal(messages[0].content, 'Let me think');
  });

  it('still accepts the flat text shape (raw.text) for compatibility', () => {
    const messages = provider.normalizeMessage(
      { type: 'text', sessionID: SESSION, text: 'flat content' },
      null,
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'flat content');
  });

  it('falls back to the top-level text when the part carries no text', () => {
    // `??` would stop at the present-but-empty part and drop the reply again.
    const messages = provider.normalizeMessage(
      { type: 'text', sessionID: SESSION, part: { type: 'text' }, text: 'fallback content' },
      null,
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'fallback content');
  });

  it('falls back to the top-level text when the part is not a text part', () => {
    const messages = provider.normalizeMessage(
      { type: 'text', sessionID: SESSION, part: { type: 'step-start' }, text: 'still delivered' },
      null,
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'still delivered');
  });

  it('falls back to the top-level text for a reasoning part with no text', () => {
    const messages = provider.normalizeMessage(
      { type: 'reasoning', sessionID: SESSION, part: { type: 'reasoning' }, text: 'thought' },
      null,
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'thinking');
    assert.equal(messages[0].content, 'thought');
  });

  it('drops an empty nested text part instead of emitting a blank delta', () => {
    const messages = provider.normalizeMessage(
      { type: 'text', sessionID: SESSION, part: { type: 'text', text: '   ' } },
      null,
    );
    assert.deepEqual(messages, []);
  });

  it('does not echo a user text part back as assistant text', () => {
    const messages = provider.normalizeMessage(
      { type: 'text', sessionID: SESSION, part: { type: 'text', role: 'user', text: 'my prompt' } },
      null,
    );
    assert.deepEqual(messages, []);
  });
});

describe('OpenCodeSessionsProvider.normalizeMessage — B-1298(b) error codes', () => {
  it('tags a 401 status error as provider_auth_failed', () => {
    const [message] = provider.normalizeMessage(
      { type: 'error', sessionID: SESSION, statusCode: 401, message: 'Unauthorized' },
      null,
    );
    assert.equal(message.kind, 'error');
    assert.equal(message.code, OPENCODE_AUTH_ERROR_CODE);
  });

  it('tags a nested 403 status error as provider_auth_failed', () => {
    const [message] = provider.normalizeMessage(
      { type: 'error', sessionID: SESSION, error: { statusCode: 403, message: 'Forbidden' } },
      null,
    );
    assert.equal(message.code, OPENCODE_AUTH_ERROR_CODE);
  });

  it('tags a context-overflow message as provider_context_overflow', () => {
    const [message] = provider.normalizeMessage(
      {
        type: 'error', sessionID: SESSION,
        message: 'This model\'s maximum context length is 128000 tokens, however you requested 130000',
      },
      null,
    );
    assert.equal(message.code, OPENCODE_CONTEXT_OVERFLOW_CODE);
  });

  it('leaves an ordinary error without a specific code', () => {
    const [message] = provider.normalizeMessage(
      { type: 'error', sessionID: SESSION, message: 'connection reset by peer' },
      null,
    );
    assert.equal(message.kind, 'error');
    assert.equal(message.code, undefined);
  });

  it('keeps the provider message as content but only a fixed code as the code', () => {
    const [message] = provider.normalizeMessage(
      { type: 'error', sessionID: SESSION, statusCode: 401, message: 'invalid key sk-secret at https://host/v1' },
      null,
    );
    assert.equal(message.code, OPENCODE_AUTH_ERROR_CODE);
    // The code itself never carries provider text.
    assert.equal(message.code, 'provider_auth_failed');
  });
});
