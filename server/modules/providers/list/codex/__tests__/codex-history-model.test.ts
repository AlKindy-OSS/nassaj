import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, it, mock } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(process.cwd(), '.artifacts/codex-history-model-'));
const transcript = path.join(sandbox, 'synthetic.jsonl');
mock.module('@/modules/database/index.js', { namedExports: {
  sessionsDb: { getSessionById: () => ({ jsonl_path: transcript }) },
  appConfigDb: { getOrCreateJwtSecret: () => 'synthetic-history-cursor-key' },
} });
const { CodexSessionsProvider } = await import('../codex-sessions.provider.js');
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const context = (model: unknown, turnId?: string) => ({
  type: 'turn_context', payload: { model, turn_id: turnId },
});
const event = (type: string, turnId?: string) => ({
  type: 'event_msg', payload: { type, turn_id: turnId },
});
const answer = (id: string, phase = 'commentary', turnId?: string, model?: string) => ({
  type: 'response_item', payload: {
    type: 'message', id, phase, role: 'assistant', model,
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
    content: [{ type: 'output_text', text: id }],
  },
});

async function history(rows: unknown[], limit?: number) {
  fs.writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join('\n'));
  return new CodexSessionsProvider().fetchHistory('synthetic-model-session', { limit });
}

it('preserves per-turn models on commentary and final answers across model changes', async () => {
  const result = await history([
    event('task_started', 'a'), context('gpt-6-astra', 'a'),
    answer('progress-a', 'commentary', 'a'),
    { type: 'event_msg', payload: { type: 'user_message', message: 'steering' } },
    answer('final-a', 'final_answer', 'a'), event('task_complete', 'a'),
    event('task_started', 'b'), context('gpt-5.6-sol', 'b'),
    answer('progress-b', 'commentary', 'b'), answer('final-b', 'final_answer', 'b'),
  ]);
  const replies = result.messages.filter((row) => row.role === 'assistant');
  assert.deepEqual(replies.map((row) => row.model),
    ['gpt-6-astra', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-sol']);
  assert.deepEqual(replies.map((row) => Boolean(row.isFinalAnswer)), [false, true, false, true]);
  assert.equal(result.messages.find((row) => row.role === 'user')?.model, undefined);
});

it('does not label earlier answers from a later context or inherit a missing context', async () => {
  const result = await history([
    answer('before-context'), context('gpt-6-astra', 'a'), answer('known'),
    event('task_started', 'b'), answer('missing-context'), context(undefined, 'b'),
    answer('missing-model'), context('gpt-5.6-sol', 'c'), answer('known-c'),
  ]);
  assert.deepEqual(result.messages.map((row) => row.model),
    [undefined, 'gpt-6-astra', undefined, undefined, 'gpt-5.6-sol']);
});

it('clears attribution after final, completion or abort even in legacy id-less rollouts', async () => {
  const result = await history([
    context('gpt-6-astra'), answer('final', 'final_answer'), answer('after-final'),
    context('gpt-6-astra'), event('task_complete'), answer('after-complete'),
    context('gpt-6-astra'), event('turn_aborted'), answer('after-abort'),
  ]);
  assert.deepEqual(result.messages.map((row) => row.model), ['gpt-6-astra', undefined, undefined, undefined]);
});

it('respects explicit turn mismatch and message-attested model precedence', async () => {
  const result = await history([
    context('gpt-6-astra', 'a'), event('task_started', 'a'),
    answer('wrong-turn', 'commentary', 'b'),
    answer('explicit-model', 'commentary', 'b', 'gpt-5.6-sol'),
    event('task_complete', 'stale-turn'), answer('current-turn', 'commentary', 'a'),
  ]);
  assert.deepEqual(result.messages.map((row) => row.model), [undefined, 'gpt-5.6-sol', 'gpt-6-astra']);
});

it('rejects invalid or oversized model data and does not keep the prior valid context', async () => {
  const rows: unknown[] = [context('gpt-6-astra'), answer('valid')];
  for (const [index, value] of [null, {}, 42, '', 'bad model', 'bad\u0000model', 'x'.repeat(257)].entries()) {
    rows.push(context(value), answer(`invalid-${index}`));
  }
  const result = await history(rows);
  assert.deepEqual(result.messages.map((row) => row.model), ['gpt-6-astra', ...Array(7).fill(undefined)]);
});

it('retains the model from before a pagination boundary without borrowing the next model', async () => {
  const result = await history([
    context('gpt-6-astra', 'a'), answer('a', 'final_answer', 'a'),
    context('gpt-5.6-sol', 'b'), answer('b-progress'), answer('b-final', 'final_answer', 'b'),
  ], 1);
  assert.equal(result.messages[0]?.model, 'gpt-5.6-sol');
  const previous = await new CodexSessionsProvider().fetchHistory('synthetic-model-session', {
    limit: 2, cursor: result.nextCursor,
  });
  assert.deepEqual(previous.messages.map((row) => row.model), ['gpt-6-astra', 'gpt-5.6-sol']);
});


it('only fully flushed durable completed final responses expose a continuation identity', async () => {
  const rows = [context('gpt-6-astra', 'a'), answer('msg_comment', 'commentary', 'a'),
    answer('msg_final', 'final_answer', 'a'), event('task_complete', 'a'),
    context('gpt-5.6-sol', 'b'), answer('msg_live', 'final_answer', 'b')];
  fs.writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const result = await new CodexSessionsProvider().fetchHistory('synthetic-model-session', {});
  assert.deepEqual(result.messages.map(row => row.transcriptMessageId), [undefined, 'msg_final', undefined]);
  fs.appendFileSync(transcript, '{');
  const incomplete = await new CodexSessionsProvider().fetchHistory('synthetic-model-session', {});
  assert.ok(incomplete.messages.every(row => row.transcriptMessageId === undefined));
});
