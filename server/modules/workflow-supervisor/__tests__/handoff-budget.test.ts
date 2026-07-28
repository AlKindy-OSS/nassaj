/**
 * T-822 §د cost governance — the daily token budget.
 *  - readSpend/recordSpend accumulate per-conversation AND per-user, day-bucketed,
 *  - wouldExceedBudget trips on the PRE-CHARGE estimate (conservative, early),
 *  - the per-conversation ceiling trips before the per-user one,
 *  - tokensFromResult reads real usage, else falls back to the estimate.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readSpend,
  recordSpend,
  wouldExceedBudget,
  tokensFromResult,
  dayBucket,
} from '@/modules/workflow-supervisor/handoff-budget.js';

function envFor(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, WORKFLOW_SUPERVISOR_STATE_DIR: root, ...extra };
}

const NOW = Date.parse('2026-07-10T12:00:00Z');

test('recordSpend accumulates per-conversation and per-user, day-bucketed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bud-'));
  const env = envFor(root);
  try {
    assert.deepEqual(readSpend(env, 'conv', 'c1', NOW), { turns: 0, tokens: 0 });
    recordSpend(env, { userId: 7, conversationId: 'c1', tokens: 1000 }, NOW);
    recordSpend(env, { userId: 7, conversationId: 'c1', tokens: 500 }, NOW);
    assert.deepEqual(readSpend(env, 'conv', 'c1', NOW), { turns: 2, tokens: 1500 });
    assert.deepEqual(readSpend(env, 'user', 7, NOW), { turns: 2, tokens: 1500 });
    // A different day is a fresh bucket.
    const tomorrow = NOW + 24 * 3600 * 1000;
    assert.notEqual(dayBucket(NOW), dayBucket(tomorrow));
    assert.deepEqual(readSpend(env, 'conv', 'c1', tomorrow), { turns: 0, tokens: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wouldExceedBudget: conversation ceiling trips first, on the pre-charge estimate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bud2-'));
  const env = envFor(root, {
    WORKFLOW_SUPERVISOR_HANDOFF_TOKENS_CONV_MAX: '100000',
    WORKFLOW_SUPERVISOR_HANDOFF_TOKENS_USER_MAX: '1000000',
    WORKFLOW_SUPERVISOR_HANDOFF_TURN_TOKEN_ESTIMATE: '73000',
  });
  try {
    // Empty: 0 + 73k <= 100k ⇒ allowed.
    assert.equal(wouldExceedBudget(env, { userId: 3, conversationId: 'cx' }, NOW).exceeded, false);
    // After one 73k turn: 73k + 73k = 146k > 100k ⇒ conversation ceiling trips.
    recordSpend(env, { userId: 3, conversationId: 'cx', tokens: 73000 }, NOW);
    const v = wouldExceedBudget(env, { userId: 3, conversationId: 'cx' }, NOW);
    assert.equal(v.exceeded, true);
    assert.equal(v.exceeded && v.scope, 'conversation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wouldExceedBudget: per-user ceiling trips across conversations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bud3-'));
  const env = envFor(root, {
    WORKFLOW_SUPERVISOR_HANDOFF_TOKENS_CONV_MAX: '10000000',
    WORKFLOW_SUPERVISOR_HANDOFF_TOKENS_USER_MAX: '100000',
    WORKFLOW_SUPERVISOR_HANDOFF_TURN_TOKEN_ESTIMATE: '73000',
  });
  try {
    recordSpend(env, { userId: 9, conversationId: 'a', tokens: 50000 }, NOW);
    // Different conversation 'b': conv ceiling huge, but user 50k+73k > 100k.
    const v = wouldExceedBudget(env, { userId: 9, conversationId: 'b' }, NOW);
    assert.equal(v.exceeded, true);
    assert.equal(v.exceeded && v.scope, 'user');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tokensFromResult: reads usage, else the configured estimate', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bud4-'));
  const env = envFor(root, { WORKFLOW_SUPERVISOR_HANDOFF_TURN_TOKEN_ESTIMATE: '5000' });
  try {
    assert.equal(
      tokensFromResult(env, { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } }),
      125,
    );
    assert.equal(tokensFromResult(env, { no: 'usage' }), 5000, 'falls back to estimate');
    assert.equal(tokensFromResult(env, null), 5000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
