import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, it, mock } from 'node:test';

import type { AnyRecord, LLMProvider, NormalizedMessage } from '@/shared/types.js';

const scratch = fs.mkdtempSync(path.join(process.cwd(), '.artifacts/response-model-history-'));
let transcript = path.join(scratch, 'synthetic.jsonl');
const sessionsDb = { getSessionById: () => ({ jsonl_path: transcript }) };
mock.module('@/modules/database/index.js', { namedExports: {
  sessionsDb, providerRunFailuresDb: { getFailure: () => null },
} });
mock.module('@/modules/database/repositories/sessions.db.js', { namedExports: { sessionsDb } });
mock.module('@/modules/providers/shared/vendor/vendor-transcript.js', { namedExports: {
  resolveVendorTranscriptForRead: async () => transcript,
} });
const { GeminiSessionsProvider } = await import('../list/gemini/gemini-sessions.provider.js');
const { CursorSessionsProvider } = await import('../list/cursor/cursor-sessions.provider.js');
const { OpenCodeSessionsProvider } = await import('../list/opencode/opencode-sessions.provider.js');
const { AntigravitySessionsProvider } = await import('../list/antigravity/antigravity-sessions.provider.js');
const { VendorSessionsProvider } = await import('../shared/vendor/vendor-sessions.provider.js');
const { createVendorResponseModelReader, readResponseModel } = await import('../shared/response-model.js');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const models = ['model-a', 'model-b', undefined];
const assistants = (messages: NormalizedMessage[]) => messages.filter((m) => m.role === 'assistant' && m.kind === 'text');

it('bounds model identifiers and rejects invalid values', () => {
  for (const value of [null, {}, 123, '', 'bad model', 'bad\u0000model', 'a'.repeat(257)]) {
    assert.equal(readResponseModel(value), undefined);
  }
  assert.equal(readResponseModel(' model-a '), 'model-a');
});

for (const format of ['jsonl', 'json']) {
  it(`Gemini ${format} keeps each assistant model and stable native id without labeling users`, async () => {
    transcript = path.join(scratch, `gemini.${format}`);
    const rows = models.map((model, index) => ({
      id: `msg-${index}`, type: 'gemini', model, content: `reply-${index}`,
    }));
    const user = { id: 'user', type: 'user', model: 'not-an-assistant', content: 'prompt' };
    fs.writeFileSync(transcript, format === 'jsonl'
      ? [user, ...rows].map((row) => JSON.stringify(row)).join('\n')
      : JSON.stringify({ model: 'future-session-selection', messages: [user, ...rows] }));
    const provider = new GeminiSessionsProvider();
    const first = await provider.fetchHistory('gemini-model-test');
    const second = await provider.fetchHistory('gemini-model-test');
    assert.deepEqual(assistants(first.messages).map((m) => m.model), models);
    assert.deepEqual(first.messages.map((m) => m.id), second.messages.map((m) => m.id));
    assert.equal(first.messages[0].model, undefined);
  });
}

it('Cursor keeps models for nested, flat-array and flat-text blobs and leaves absent models unknown', () => {
  const provider = new CursorSessionsProvider() as unknown as {
    normalizeCursorBlobs(rows: AnyRecord[], sessionId: string): NormalizedMessage[];
  };
  const contents = [
    { message: { role: 'assistant', model: 'model-a', content: 'a' } },
    { role: 'assistant', model: 'model-b', content: [{ type: 'text', text: 'b' }] },
    { role: 'assistant', content: 'unknown' },
    { role: 'user', model: 'ignored', content: 'prompt' },
  ];
  const rows = contents.map((content, i) => ({ id: `blob-${i}`, rowid: i, sequence: i, content }));
  const first = provider.normalizeCursorBlobs(rows, 'cursor-test');
  const second = provider.normalizeCursorBlobs(rows, 'cursor-test');
  assert.deepEqual(assistants(first).map((m) => m.model), models);
  assert.deepEqual(first.map((m) => m.id), second.map((m) => m.id));
  assert.equal(first.at(-1)?.model, undefined);
});

it('OpenCode uses each persisted assistant modelID, preserving message/part identity', () => {
  const provider = new OpenCodeSessionsProvider() as unknown as {
    normalizeHistoryRows(rows: AnyRecord[], sessionId: string): NormalizedMessage[];
  };
  const rows = models.map((modelID, index) => ({
    message_id: `msg-${index}`, part_id: `part-${index}`, message_time_created: 1, part_time_created: 2,
    message_data: JSON.stringify({ role: 'assistant', modelID }),
    part_data: JSON.stringify({ type: 'text', text: 'reply' }),
  }));
  const normalized = provider.normalizeHistoryRows(rows, 'opencode-test');
  assert.deepEqual(normalized.map((m) => m.model), models);
  assert.deepEqual(normalized.map((m) => m.id), ['msg-0_part-0', 'msg-1_part-1', 'msg-2_part-2']);
});

it('Antigravity preserves model only when the response line itself contains it', async () => {
  transcript = path.join(scratch, 'agy.jsonl');
  fs.writeFileSync(transcript, models.map((model, index) => JSON.stringify({
    step_index: index, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
    model, content: 'reply', created_at: '2026-09-05T12:00:00Z',
  })).join('\n'));
  const result = await new AntigravitySessionsProvider().fetchHistory('agy-test');
  assert.deepEqual(assistants(result.messages).map((m) => m.model), models);
});

for (const providerName of ['kimi', 'qwen', 'hermes', 'deepseek', 'glm'] as LLMProvider[]) {
  it(`${providerName} replays message-local models and stable persisted full-message IDs`, async () => {
    transcript = path.join(scratch, `${providerName}.jsonl`);
    fs.writeFileSync(transcript, models.map((model, index) => JSON.stringify({
      type: 'message', message: { id: `durable-${index}`, role: 'assistant', model, content: 'reply' },
    })).join('\n'));
    const provider = new VendorSessionsProvider({ provider: providerName });
    const result = await provider.fetchHistory('vendor-test');
    const repeat = await provider.fetchHistory('vendor-test');
    assert.deepEqual(assistants(result.messages).map((m) => m.model), models);
    assert.deepEqual(result.messages.map((m) => m.id), ['durable-0', 'durable-1', 'durable-2']);
    assert.deepEqual(repeat.messages.map((m) => m.id), result.messages.map((m) => m.id));
  });
}

it('vendor message_start metadata stays within its response in history and realtime normalization', async () => {
  const rows = models.flatMap((model) => [
    { type: 'message_start', message: { model } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply' } },
    { type: 'message_stop' },
  ]);
  rows.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'after-stop' } });
  transcript = path.join(scratch, 'vendor-stream.jsonl');
  fs.writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join('\n'));
  const provider = new VendorSessionsProvider({ provider: 'deepseek' });
  const readModel = createVendorResponseModelReader();
  const live = rows.flatMap((row) => provider.normalizeMessage(readModel(row), 'stream-test'));
  assert.deepEqual(live.map((m) => m.model), [...models, undefined]);
  const result = await provider.fetchHistory('stream-test');
  assert.deepEqual(assistants(result.messages).map((m) => m.model), models);
});

it('vendor final replay after message_stop may use only an exact matching provider message ID', () => {
  const readModel = createVendorResponseModelReader();
  readModel({ type: 'message_start', message: { id: 'response-a', model: 'model-a' } });
  readModel({ type: 'message_stop' });
  assert.equal(readModel({ type: 'message', id: 'response-a', role: 'assistant', content: 'final' }).model, 'model-a');
  assert.equal(readModel({ type: 'message', id: 'other', role: 'assistant', content: 'other' }).model, undefined);
  assert.equal(readModel({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'late' } }).model, undefined);
  readModel({ type: 'message_start', message: { id: 'response-b' } });
  assert.equal(readModel({ type: 'message', id: 'response-a', role: 'assistant', content: 'old' }).model, undefined);
  assert.equal(readModel({ type: 'message', id: 'response-b', role: 'assistant', content: 'new' }).model, undefined);
});
