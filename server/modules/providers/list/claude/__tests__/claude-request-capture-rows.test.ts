/**
 * B-1629: Claude Code 2.1.300+ writes the API request it sends into the session
 * transcript as `api-request-blob` rows (`{ type, hash, sessionId, message }`,
 * no uuid, no timestamp) beside `api-request`, `last-prompt`, `ai-title` and
 * `atis-latch` rows. The history normalizer read any row with `message.role`
 * as a turn, so each blob carrying a user prompt became a user bubble with a
 * random id and the read time: every refresh after a reply re-appended earlier
 * prompts below it. Row shapes below copy the key sets of a real 2.1.300
 * transcript (session 7799151d on the reporting node); the text is invented.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  ClaudeSessionsProvider,
  isClaudeConversationRow,
} from '@/modules/providers/list/claude/claude-sessions.provider.js';

const SID = 'bbbbbbbb-0000-0000-0000-000000001629';
const SLUG = '-workspace-b1629';
const REMINDER = '<system-reminder>\nContext the CLI attaches.\n</system-reminder>';
const PROMPT_1 = 'first prompt';
const PROMPT_2 = 'second prompt';

const userRow = (uuid: string, timestamp: string, text: string) => ({
  parentUuid: null, isSidechain: false, type: 'user', uuid, timestamp, sessionId: SID,
  cwd: '/workspace/b1629', version: '2.1.300', message: { role: 'user', content: text },
});
const assistantRow = (uuid: string, timestamp: string, text: string) => ({
  parentUuid: null, isSidechain: false, type: 'assistant', uuid, timestamp, sessionId: SID,
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
});
const blob = (hash: string, message: Record<string, unknown>) => ({ type: 'api-request-blob', hash, sessionId: SID, message });

/** One turn as 2.1.300 records it: the prompt, its request capture, the reply. */
const TRANSCRIPT = [
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-15T08:39:55.956Z', sessionId: SID, content: PROMPT_1 },
  userRow('u-1', '2026-10-15T08:39:56.491Z', PROMPT_1),
  { type: 'api-request-shape', sessionId: SID, shape: {}, shapeHash: 's1', timestamp: '2026-10-15T08:39:56.582Z', version: 1 },
  blob('h-user-1', { role: 'user', content: [{ type: 'text', text: REMINDER }, { type: 'text', text: PROMPT_1 }] }),
  blob('h-system', { role: 'system', content: [{ type: 'text', text: 'system prompt' }] }),
  blob('h-asst', { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b1629', name: 'Bash', input: { command: 'true' } }] }),
  blob('h-result', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b1629', content: 'stale' }] }),
  {
    type: 'api-request', id: 'r1', sessionId: SID, timestamp: '2026-10-15T08:39:56.582Z', shapeHash: 's1',
    params: { model: 'claude-opus-5-5' }, tail: ['h-user-1'], keep: 0, cacheControl: null, querySource: 'repl', requestDigest: 'd', version: 1,
  },
  { type: 'last-prompt', sessionId: SID, lastPrompt: PROMPT_1, leafUuid: 'u-1' },
  { type: 'ai-title', sessionId: SID, aiTitle: 'Title' },
  { type: 'atis-latch', sessionId: SID, atis: {} },
  assistantRow('a-1', '2026-10-15T08:40:20.000Z', 'reply one'),
  userRow('u-2', '2026-10-15T09:02:04.847Z', PROMPT_2),
  blob('h-user-2', { role: 'user', content: [{ type: 'text', text: PROMPT_2 }] }),
  assistantRow('a-2', '2026-10-15T09:07:29.959Z', 'reply two'),
];

test('isClaudeConversationRow accepts turns and rejects request captures', () => {
  assert.equal(isClaudeConversationRow({ type: 'user' }), true);
  assert.equal(isClaudeConversationRow({ type: 'assistant' }), true);
  assert.equal(isClaudeConversationRow({ message: { role: 'user', content: 'x' } }), true);
  for (const type of ['api-request-blob', 'api-request', 'last-prompt', 'ai-title', 'atis-latch', 'queue-operation']) {
    assert.equal(isClaudeConversationRow({ type }), false, type);
  }
});

test('a request-capture blob normalizes to nothing, live or from history', () => {
  const provider = new ClaudeSessionsProvider();
  for (const raw of TRANSCRIPT.filter((row) => row.type === 'api-request-blob')) {
    assert.deepEqual(provider.normalizeMessage(raw, SID), [], String((raw as { hash: string }).hash));
  }
  const turn = provider.normalizeMessage(TRANSCRIPT[1], SID);
  assert.equal(turn.length, 1);
  assert.equal(turn[0].id, 'u-1');
  assert.equal(turn[0].timestamp, '2026-10-15T08:39:56.491Z');
});

test('history lists each prompt once, in place, with stable ids across reads', async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'claude-b1629-')));
  const saved = { db: process.env.DATABASE_PATH, homedir: os.homedir };
  closeConnection();
  process.env.DATABASE_PATH = path.join(base, 'auth.db');
  (os as { homedir: () => string }).homedir = () => base;
  try {
    await initializeDatabase();
    const dir = path.join(base, '.claude', 'projects', SLUG);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${SID}.jsonl`);
    writeFileSync(file, `${TRANSCRIPT.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(SID, 'claude', '/workspace/b1629', undefined, undefined, undefined, file);

    const provider = new ClaudeSessionsProvider();
    const first = await provider.fetchHistory(SID);
    const second = await provider.fetchHistory(SID);
    const summary = (rows: typeof first.messages) => rows
      .filter((row) => row.kind === 'text')
      .map((row) => `${row.role}:${row.id}:${row.timestamp}:${row.content}`);

    assert.deepEqual(summary(first.messages), [
      `user:u-1:2026-10-15T08:39:56.491Z:${PROMPT_1}`,
      'assistant:a-1_0:2026-10-15T08:40:20.000Z:reply one',
      `user:u-2:2026-10-15T09:02:04.847Z:${PROMPT_2}`,
      'assistant:a-2_0:2026-10-15T09:07:29.959Z:reply two',
    ]);
    assert.deepEqual(summary(second.messages), summary(first.messages), 'a second read mints no new rows');
    assert.equal(first.messages.some((row) => row.kind === 'tool_use' || row.kind === 'tool_result'), false,
      'request-capture tool blocks are not replayed as tool rows');
  } finally {
    closeConnection();
    (os as { homedir: () => string }).homedir = saved.homedir;
    if (saved.db === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = saved.db;
    rmSync(base, { recursive: true, force: true });
  }
});
