/**
 * T-1906 / ADR-200 §8 (M-5) — a vendor key that reached opencode.db (a model
 * echoed it, a tool printed the env) is redacted on READ: history text, tool
 * output and errors never return it. Under ADR-089 every member reads every
 * session, so the current keys of EVERY sender in the session are redacted,
 * whoever is reading — plus the owner of the data dir the history is read from,
 * the auth.json in that dir (M-6), and the legacy `sk-sp-` pattern.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import Database from 'better-sqlite3';

// B-1544: must stay the first app-side import; it sandboxes HOME, DATABASE_PATH and the
// harness roots before any app module reads them.
import { removeSandbox, sandboxHome } from '@/modules/providers/tests/helpers/hermetic-sandbox.js';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { initializeDatabase, closeConnection, userDb, messageAuthorsDb } = await import('@/modules/database/index.js');
const { _resetProviderSecretsServerKeyCache } = await import('@/services/isolation/provider-secrets-store.js');
const { providerSecretsService } = await import('@/modules/providers/services/provider-secrets.service.js');
const { OpenCodeSessionsProvider } = await import('./opencode-sessions.provider.js');
const { collectOpenCodeSessionSecrets } = await import('./opencode-redaction-secrets.js');

await initializeDatabase();
_resetProviderSecretsServerKeyCache();

const LEGACY_KEY = ['sk', 'sp-history-secret-0123456789'].join('-');
const OWNER_KEY = ['tp', 'owner-token-plan-0123456789'].join('-');
const PEER_KEY = ['tp', 'peer-token-plan-9876543210'].join('-');
const PEER_GLM_KEY = ['glm', 'peer-vendor-key-0123456789'].join('-');
const DIR_OWNER_KEY = ['glm', 'platform-owner-key-0123456789'].join('-');
const AUTH_JSON_KEY = ['sk', 'or-auth-json-openrouter-0123456789'].join('-');
const SESSION = 'ses_redact';

// The platform owner owns the shared operator data dir and never authored here.
const platform = userDb.createUser('redaction-platform-owner', 'hash', 'owner');
providerSecretsService.setKey(platform.id, 'glm', DIR_OWNER_KEY);
const owner = userDb.createUser('redaction-owner', 'hash', 'user');
const peer = userDb.createUser('redaction-peer', 'hash', 'user');
const reader = userDb.createUser('redaction-reader', 'hash', 'user');
providerSecretsService.setKey(owner.id, 'qwen', OWNER_KEY);
providerSecretsService.setKey(peer.id, 'qwen', PEER_KEY);
providerSecretsService.setKey(peer.id, 'glm', PEER_GLM_KEY);
messageAuthorsDb.recordUserMessage(SESSION, owner.id, 'first prompt');
messageAuthorsDb.recordUserMessage(SESSION, peer.id, 'second prompt');

const dbDir = path.join(sandboxHome, '.local', 'share', 'opencode');
fs.mkdirSync(dbDir, { recursive: true });
fs.writeFileSync(path.join(dbDir, 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: AUTH_JSON_KEY } }));
const db = new Database(path.join(dbDir, 'opencode.db'));
db.exec(`
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
`);
const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');
insertMessage.run('m1', SESSION, 1, JSON.stringify({ role: 'assistant', modelID: 'qwen3.7-plus' }));
insertPart.run('p1', SESSION, 'm1', 1, JSON.stringify({ type: 'text', text: `your key is ${OWNER_KEY}` }));
insertPart.run('p2', SESSION, 'm1', 2, JSON.stringify({
  type: 'tool', tool: 'bash', callID: 'c1',
  state: { status: 'completed', input: { command: 'env' }, output: `NASSAJ_QWEN_PLAN_API_KEY=${PEER_KEY}` },
}));
insertPart.run('p3', SESSION, 'm1', 3, JSON.stringify({ type: 'text', text: `old ${LEGACY_KEY} and ${PEER_GLM_KEY}` }));
insertPart.run('p4', SESSION, 'm1', 4, JSON.stringify({ type: 'text', text: `dir ${DIR_OWNER_KEY} ${AUTH_JSON_KEY}` }));
insertMessage.run('m2', SESSION, 5, JSON.stringify({ role: 'assistant', error: { message: `bad key ${PEER_KEY}` } }));
db.close();

after(() => {
  closeConnection();
  removeSandbox();
});

test('read redaction covers every sender in the session, not only the reader', () => {
  const secrets = collectOpenCodeSessionSecrets(SESSION);
  for (const key of [OWNER_KEY, PEER_KEY, PEER_GLM_KEY]) assert.ok(secrets.includes(key));
  assert.ok(!secrets.includes(DIR_OWNER_KEY), 'the dir owner is added by the reader, not the session');
  assert.deepEqual(collectOpenCodeSessionSecrets('ses_unknown'), []);
  assert.ok(collectOpenCodeSessionSecrets(null, { extraUserIds: [owner.id] }).includes(OWNER_KEY));
  assert.deepEqual(collectOpenCodeSessionSecrets('ses_unknown', { extraUserIds: [reader.id] }), []);
});

test('fetchHistory, read by another member, never returns any sender, dir-owner or auth.json key', async () => {
  // The reader is a third member; under ADR-089 they can read this session.
  const history = await new OpenCodeSessionsProvider().fetchHistory(SESSION);
  assert.ok(history.messages.length >= 4, JSON.stringify(history));
  const text = JSON.stringify(history.messages);
  for (const key of [OWNER_KEY, PEER_KEY, PEER_GLM_KEY, LEGACY_KEY, DIR_OWNER_KEY, AUTH_JSON_KEY]) {
    assert.ok(!text.includes(key), 'no message carries a key');
  }
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(text.includes('your key is'), 'the surrounding text survives');
});
