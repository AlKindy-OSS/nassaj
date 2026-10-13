/**
 * B-1599 L8 / B-954 — the active-model and token-usage readers take a bounded
 * tail of the pinned transcript, never the whole file. Fixture: a genuine
 * transcript whose only model-bearing reply lies further than
 * TRANSCRIPT_TAIL_MAX_BYTES from the end (behind a long run of user records).
 *
 * Runner: TMPDIR=/var/tmp node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { getConnection, initializeDatabase, participantsDb, userDb } from '@/modules/database/index.js';
import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { readClaudeTranscriptForSession } from '@/modules/providers/list/claude/claude-token-usage.js';
import { readPinnedTail, TRANSCRIPT_TAIL_MAX_BYTES } from '@/modules/providers/shared/pinned-tail.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';
// eslint-disable-next-line boundaries/no-unknown -- shared test fixture helper (same seam as sandbox-home)
import { claudeHeaderLine } from '@/shared/__tests__/provider-root-sandbox.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
const DIR = path.join(SANDBOX_HOME, '.claude', 'projects', '-workspace-l8');
const HEAD_MODEL = 'claude-head-model-l8';
const TAIL_MODEL = 'claude-tail-model-l8';

await initializeDatabase();
const ownerId = userDb.createUser('l8-owner', 'hash-o', 'user').id;
let counter = 0;
const nextId = () => `00000000-0000-4000-a8a8-${String(++counter).padStart(12, '0')}`;

const reply = (sessionId: string, model: string) => JSON.stringify({ type: 'assistant', sessionId,
  message: { role: 'assistant', model, usage: { input_tokens: 7, output_tokens: 3 }, content: [{ type: 'text', text: 'ok' }] } });

/** A recorded genuine transcript: header, a reply naming HEAD_MODEL, then > the tail bound of user records. */
function recordLongTranscript(tail: string[] = []): { sessionId: string; file: string } {
  const sessionId = nextId();
  const user = JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: 'x'.repeat(1000) } });
  const filler = Array.from({ length: Math.ceil(TRANSCRIPT_TAIL_MAX_BYTES / user.length) + 64 }, () => user);
  const file = path.join(DIR, `${sessionId}.jsonl`);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, `${[claudeHeaderLine(sessionId), reply(sessionId, HEAD_MODEL), ...filler, ...tail].join('\n')}\n`);
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, ?, ?)')
    .run(sessionId, 'claude', null, file);
  participantsDb.recordSpawn(sessionId, ownerId);
  return { sessionId, file };
}

function models(): ClaudeProviderModels {
  const provider = new ClaudeProviderModels();
  provider.getSupportedModels = async (): Promise<ProviderModelsDefinition> => ({ OPTIONS: [], DEFAULT: 'catalog-default' });
  return provider;
}

test('readPinnedTail: whole small file; a cut tail starts at the next record and never splits a character', async () => {
  const file = path.join(SANDBOX_HOME, 'tail.jsonl');
  fs.writeFileSync(file, 'aaaa\nبببب\ncc\n');
  const handle = await fsp.open(file, 'r');
  try {
    assert.equal(await readPinnedTail(handle, 1024), 'aaaa\nبببب\ncc\n');
    assert.equal(await readPinnedTail(handle, 6), 'cc\n', 'the cut lands inside the Arabic record: it is dropped');
    assert.equal(await readPinnedTail(handle, 2), '', 'no record boundary inside the tail');
  } finally {
    await handle.close();
  }
});

test('active model: a reply beyond the tail bound is not read; one inside it is', async () => {
  assert.equal((await models().getCurrentActiveModel(recordLongTranscript().sessionId)).model, 'catalog-default');
  const withTail = recordLongTranscript();
  fs.appendFileSync(withTail.file, `${reply(withTail.sessionId, TAIL_MODEL)}\n`);
  assert.equal((await models().getCurrentActiveModel(withTail.sessionId)).model, TAIL_MODEL);
});

test('token usage: the reader returns at most the tail bound, starting at a record', async () => {
  const { sessionId, file } = recordLongTranscript();
  const text = await readClaudeTranscriptForSession(
    { session_id: sessionId, provider: 'claude', project_path: '/workspace/l8', jsonl_path: file }, '/workspace/l8');
  assert.ok(text !== null);
  assert.ok(Buffer.byteLength(text) <= TRANSCRIPT_TAIL_MAX_BYTES, `read ${Buffer.byteLength(text)} bytes`);
  assert.doesNotMatch(text, new RegExp(HEAD_MODEL));
  assert.ok(text.startsWith('{"type":"user"'), 'starts at a record boundary');
});
