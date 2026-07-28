import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCodexFailure } from './modules/providers/list/codex/codex-failure.js';

test('classifies a missing Codex thread as a resumable UI action', () => {
  assert.deepEqual(
    classifyCodexFailure(
      { message: 'failed to record rollout items: thread dead-beef not found' },
      'dead-beef',
      'continue this work',
    ),
    {
      code: 'conversation_not_found',
      content: 'This Codex conversation no longer exists or its first turn never completed. Start a new conversation.',
      staleSessionId: 'dead-beef',
      command: 'continue this work',
    },
  );
});

test('unwraps nested API JSON and classifies unsupported models', () => {
  const failure = classifyCodexFailure({
    message: JSON.stringify({ error: { message: 'The model gpt-old is not supported.' } }),
  });
  assert.equal(failure.code, 'model_not_supported');
  assert.equal(failure.content, 'The model gpt-old is not supported.');
});

test('classifies incompatible model-cache schemas', () => {
  assert.equal(
    classifyCodexFailure('failed to load models cache: unknown variant `max`').code,
    'codex_cache_incompatible',
  );
});
