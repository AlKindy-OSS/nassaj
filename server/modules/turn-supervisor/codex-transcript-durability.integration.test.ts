import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const sandbox = fs.mkdtempSync('/var/tmp/nassaj-supervised-codex-transcript-');
process.env.DATABASE_PATH = `${sandbox}/db.sqlite`;
fs.writeFileSync(process.env.DATABASE_PATH, '');

const { closeConnection, initializeDatabase, messageAuthorsDb, sessionsDb, userDb } = await import('@/modules/database/index.js');
const { CodexSessionsProvider } = await import('@/modules/providers/index.js');
const { vendorTranscriptPath } = await import('@/modules/providers/shared/vendor/vendor-transcript.js');
await initializeDatabase();

after(() => {
  closeConnection();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('supervised ephemeral Codex transcript is registered DB truth and readable by Codex history', async () => {
  const sessionId = 'codex_supervised_durable';
  // B-1564: the supervisor writes to the nassaj-owned Codex tree (vendorTranscriptPath), the reader's root.
  const transcript = vendorTranscriptPath('codex', sessionId, sandbox);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [
    JSON.stringify({
      eventId: 'turn:user', timestamp: '2026-08-19T00:00:00.000Z', type: 'event_msg',
      payload: { type: 'user_message', kind: 'plain', message: 'visible user request' },
    }),
    JSON.stringify({
      eventId: 'turn:assistant', timestamp: '2026-08-19T00:00:01.000Z', type: 'response_item',
      payload: {
        type: 'message', id: 'turn:assistant', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'visible final synthesis' }],
      },
    }),
  ].join('\n') + '\n');
  sessionsDb.createSession(sessionId, 'codex', sandbox, undefined, undefined, undefined, transcript);
  const userId = userDb.createUser('supervised-codex-reader', 'hash', 'user').id;
  messageAuthorsDb.recordUserMessage(sessionId, userId, 'visible user request');

  const stored = sessionsDb.getSessionById(sessionId);
  assert.equal(stored?.provider, 'codex');
  assert.equal(stored?.jsonl_path, transcript);
  const history = await new CodexSessionsProvider().fetchHistory(sessionId);
  assert.equal(history.total, 2);
  assert.deepEqual(history.messages.map((message) => message.content), [
    'visible user request', 'visible final synthesis',
  ]);
});

test('a supervised Codex transcript stays bound to its own id (ADR-201 A1)', async () => {
  // A row of another id recorded at this file is refused by name: nothing is read.
  const victim = vendorTranscriptPath('codex', 'codex_supervised_durable', sandbox);
  sessionsDb.createSession('codex_supervised_other', 'codex', sandbox, undefined, undefined, undefined, victim);
  assert.equal(sessionsDb.getSessionById('codex_supervised_other')?.jsonl_path, victim);
  const history = await new CodexSessionsProvider().fetchHistory('codex_supervised_other');
  assert.equal(history.total, 0);
  assert.deepEqual(history.messages, []);
});
