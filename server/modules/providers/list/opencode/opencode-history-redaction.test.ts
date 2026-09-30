/**
 * T-1906 — a Coding Plan key that reached opencode.db (a model echoed it, a
 * tool printed the env) is redacted on READ: history text, tool output and the
 * synchronized session title never return it.
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { OpenCodeSessionsProvider } from './opencode-sessions.provider.js';

const KEY = ['sk', 'sp-history-secret-0123456789'].join('-');
const SESSION = 'ses_redact';
const dbDir = path.join(SANDBOX_HOME, '.local', 'share', 'opencode');
fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(path.join(dbDir, 'opencode.db'));
db.exec(`
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
`);
const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');
insertMessage.run('m1', SESSION, 1, JSON.stringify({ role: 'assistant', modelID: 'qwen3-coder-plus' }));
insertPart.run('p1', SESSION, 'm1', 1, JSON.stringify({ type: 'text', text: `your key is ${KEY}` }));
insertPart.run('p2', SESSION, 'm1', 2, JSON.stringify({
  type: 'tool', tool: 'bash', callID: 'c1',
  state: { status: 'completed', input: { command: 'env' }, output: `NASSAJ_QWEN_PLAN_API_KEY=${KEY}` },
}));
insertMessage.run('m2', SESSION, 3, JSON.stringify({ role: 'assistant', error: { message: `bad key ${KEY}` } }));
db.close();

test('fetchHistory never returns a stored Coding Plan key', async () => {
  const history = await new OpenCodeSessionsProvider().fetchHistory(SESSION);
  assert.ok(history.messages.length >= 2, JSON.stringify(history));
  const text = JSON.stringify(history.messages);
  assert.ok(!text.includes(KEY), 'no message carries the key');
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(text.includes('your key is'), 'the surrounding text survives');
});
