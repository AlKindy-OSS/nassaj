/**
 * B-1643 round 2: OpenCode token usage through the REAL database resolver with
 * opencode ISOLATED. Live data (2026-10-16) has 33 of 43 opencode sessions in
 * the operator DB and 10 in one member's DB; every member of a visible project
 * reads all its sessions (ADR-089), so the authorised row is looked up in every
 * known DB — and resolving those paths must not provision any member tree.
 *
 * Scratch lives under /var/tmp — never /tmp, which is tmpfs on this host.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { _resetProviderSharingCache, setProviderSharingConfig } from '@/services/provider-sharing.js';

import { readSessionTokenUsage, type TokenUsageDeps } from './session-token-usage.service.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_PATH = '/var/tmp/b1643/repo';
const OPERATOR_SESSION = 'ses_cccccccccccccccccccccccccc';
const MEMBER_SESSION = 'ses_dddddddddddddddddddddddddd';

function writeOpenCodeDb(dataHome: string, id: string, input: number): void {
  const dir = path.join(dataHome, 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'opencode.db'));
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, tokens_input INTEGER, tokens_output INTEGER,
    tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)`);
  db.prepare('INSERT INTO session VALUES (?, ?, 50, 5, 100, 10)').run(id, input);
  db.close();
}

test('isolated opencode: operator-DB and member-DB sessions are both read, with no provisioning', async () => {
  const scratch = await mkdtemp('/var/tmp/b1643-opencode-');
  const previous = { home: process.env.HOME, db: process.env.DATABASE_PATH, xdg: process.env.XDG_DATA_HOME };
  process.env.HOME = scratch;
  delete process.env.XDG_DATA_HOME;
  process.env.DATABASE_PATH = path.join(scratch, 'auth.db');
  closeConnection();
  await initializeDatabase();
  try {
    setProviderSharingConfig({ opencode: 'isolated' });
    userDb.createUser('b1643_owner', 'hash', 'owner');
    const spawner = userDb.createUser('b1643_spawner', 'hash', 'user').id;
    const reader = userDb.createUser('b1643_reader', 'hash', 'user').id;
    writeOpenCodeDb(path.join(scratch, '.local', 'share'), OPERATOR_SESSION, 1000);
    writeOpenCodeDb(path.join(scratch, '.nassaj-users', String(spawner), '.local', 'share'), MEMBER_SESSION, 2000);
    const usersBefore = fs.readdirSync(path.join(scratch, '.nassaj-users')).sort();

    const rows = [OPERATOR_SESSION, MEMBER_SESSION].map((session_id) => ({
      session_id, provider: 'opencode', project_path: PROJECT_PATH, jsonl_path: null,
    }));
    const deps: TokenUsageDeps = {
      getSessionById: (id) => rows.find((row) => row.session_id === id) ?? null,
      getProjectPathById: (id) => (id === PROJECT_ID ? PROJECT_PATH : null),
    };
    // The reply depends on the authorised row only, never on who asks: a member
    // who spawned neither session (`reader`) gets exactly these answers.
    const ask = (sessionId: string) => readSessionTokenUsage({ projectId: PROJECT_ID, sessionId, provider: 'opencode' }, deps);

    assert.deepEqual(await ask(OPERATOR_SESSION), {
      status: 200, body: { used: 1165, inputTokens: 1100, outputTokens: 50, breakdown: { input: 1100, output: 50 } },
    });
    assert.deepEqual(await ask(MEMBER_SESSION), {
      status: 200, body: { used: 2165, inputTokens: 2100, outputTokens: 50, breakdown: { input: 2100, output: 50 } },
    });

    assert.deepEqual(fs.readdirSync(path.join(scratch, '.nassaj-users')).sort(), usersBefore, 'no member tree was provisioned');
    assert.equal(fs.existsSync(path.join(scratch, '.nassaj-users', String(reader))), false);
  } finally {
    _resetProviderSharingCache();
    closeConnection();
    for (const [key, value] of [['HOME', previous.home], ['DATABASE_PATH', previous.db], ['XDG_DATA_HOME', previous.xdg]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
