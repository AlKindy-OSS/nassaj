import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

import {
  createConnectorOAuthPendingDb,
  migrateConnectorOAuthPending,
} from '@/modules/database/index.js';

import {
  createOAuthPendingStateStore,
  type OAuthPendingLink,
} from './oauth-pending-state.store.js';

const roots: string[] = [];
const KEY = Buffer.alloc(32, 7);
const execFileAsync = promisify(execFile);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-oauth-db-'));
  roots.push(root);
  return path.join(root, 'state.sqlite');
}

function open(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrateConnectorOAuthPending(db);
  return db;
}

function link(startedAt: number): OAuthPendingLink {
  return {
    userId: 42,
    connectorId: 'google-drive-u42',
    remoteUrl: 'https://example.test/mcp',
    redirectUri: 'https://nassaj.test/callback',
    codeVerifier: 'private-verifier-that-is-long-enough-for-a-valid-pkce-verifier-123456789',
    clientInfo: { client_id: 'client', redirect_uris: ['https://nassaj.test/callback'] },
    tokenEndpoint: 'https://example.test/token',
    includeResource: false,
    useBasicClientAuth: false,
    startedAt,
  };
}

function store(db: Database.Database, options: { now?: () => number; key?: Buffer; ttlMs?: number } = {}) {
  return createOAuthPendingStateStore({
    repository: createConnectorOAuthPendingDb(db),
    encryptionKey: options.key ?? KEY,
    now: options.now,
    ttlMs: options.ttlMs,
  });
}

describe('database OAuth pending state store', () => {
  it('survives restart and consumes exactly once', () => {
    const file = databasePath();
    const first = open(file);
    store(first).put('restart-state', link(Date.now()));
    first.close();
    const restarted = open(file);
    assert.match(store(restarted).consume('restart-state')?.codeVerifier ?? '', /^private-verifier/);
    assert.equal(store(restarted).consume('restart-state'), null);
    restarted.close();
  });

  it('uses a conditional transaction so two independent workers have one winner', async () => {
    const file = databasePath();
    const parentDb = open(file);
    store(parentDb).put('shared-state', link(Date.now()));
    const stateHash = (parentDb.prepare(
      'SELECT state_hash AS stateHash FROM connector_oauth_pending',
    ).get() as { stateHash: string }).stateHash;
    const repositoryUrl = new URL(
      '../database/index.ts', import.meta.url,
    ).href;
    const script = `
      const Database = (await import('better-sqlite3')).default;
      const { createConnectorOAuthPendingDb } = await import(${JSON.stringify(repositoryUrl)});
      const db = new Database(process.env.TEST_DATABASE_PATH);
      db.pragma('busy_timeout = 5000');
      const won = createConnectorOAuthPendingDb(db).consume(process.env.TEST_STATE_HASH, Date.now());
      db.close();
      process.stdout.write(won ? 'won' : 'lost');
    `;
    const run = () => execFileAsync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', script,
    ], { env: { ...process.env, TEST_DATABASE_PATH: file, TEST_STATE_HASH: stateHash } });
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(results.map((result) => result.stdout).sort(), ['lost', 'won']);
    assert.equal((parentDb.prepare(
      'SELECT COUNT(*) AS count FROM connector_oauth_pending WHERE consumed_at IS NOT NULL',
    ).get() as { count: number }).count, 1);
    parentDb.close();
  });

  it('expires and sweeps without ever returning plaintext', () => {
    const file = databasePath();
    const db = open(file);
    let now = 1_000;
    const current = store(db, { now: () => now, ttlMs: 100 });
    current.put('expiring-state', link(now));
    const row = db.prepare('SELECT * FROM connector_oauth_pending').get() as Record<string, unknown>;
    assert.equal(JSON.stringify(row).includes('private-verifier'), false);
    assert.equal(Object.hasOwn(row, 'state'), false);
    now = 1_100;
    assert.equal(current.consume('expiring-state'), null);
    current.sweep();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM connector_oauth_pending').get().count, 0);
    db.close();
  });

  it('fails closed for ciphertext/tag tampering and wrong keys', () => {
    const file = databasePath();
    const db = open(file);
    const current = store(db);
    current.put('tamper-state', link(Date.now()));
    db.prepare("UPDATE connector_oauth_pending SET tag = zeroblob(16)").run();
    assert.equal(current.consume('tamper-state'), null);

    store(db).put('wrong-key-state', link(Date.now()));
    assert.equal(store(db, { key: Buffer.alloc(32, 8) }).consume('wrong-key-state'), null);
    db.close();
  });

  it('binds the envelope to state_hash and rejects structural corruption in SQLite', () => {
    const file = databasePath();
    const db = open(file);
    store(db).put('bound-state', link(Date.now()));
    const row = db.prepare('SELECT * FROM connector_oauth_pending').get() as Record<string, unknown>;
    assert.equal(typeof row.state_hash, 'string');
    assert.equal((row.state_hash as string).length, 64);
    assert.throws(
      () => db.prepare('UPDATE connector_oauth_pending SET nonce = zeroblob(11)').run(),
      /CHECK constraint failed/,
    );
    db.close();
  });
});
