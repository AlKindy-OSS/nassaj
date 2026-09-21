import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

function startWorker(databasePath: string, barrier: SharedArrayBuffer) {
  const worker = new Worker(new URL('./__tests__/scheduled-messages-migration.worker.ts', import.meta.url), {
    workerData: { databasePath, barrier },
  });
  let readyResolve: (() => void) | undefined;
  let resultResolve: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  const result = new Promise<void>((resolve, reject) => {
    resultResolve = resolve;
    worker.on('error', reject);
    worker.on('message', (message: { ready?: boolean; migrated?: boolean; error?: string }) => {
      if (message.ready) readyResolve?.();
      if (message.error) reject(new Error(message.error));
      if (message.migrated) resultResolve?.();
    });
  });
  return { ready, result };
}

test('two processes atomically upgrade the legacy scheduled_messages column shape', async () => {
  const directory = await mkdtemp('/var/tmp/nassaj-scheduled-migration-');
  const databasePath = path.join(directory, 'auth.db');
  const database = new Database(databasePath);
  try {
    database.exec(`CREATE TABLE scheduled_messages (
      id TEXT PRIMARY KEY NOT NULL, user_id INTEGER NOT NULL, session_id TEXT NOT NULL,
      content TEXT NOT NULL, options_json TEXT NOT NULL DEFAULT '{}', scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3, lease_token TEXT, lease_expires_at TEXT,
      last_error_code TEXT, sent_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const barrier = new SharedArrayBuffer(4);
    const workers = [startWorker(databasePath, barrier), startWorker(databasePath, barrier)];
    // Both workers signal readiness before either is allowed to inspect the legacy columns.
    await Promise.all(workers.map(worker => worker.ready));
    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0, 2);
    await Promise.all(workers.map(worker => worker.result));
    const columns = database.prepare('PRAGMA table_info(scheduled_messages)').all() as Array<{ name: string }>;
    assert.equal(columns.filter(column => column.name === 'available_at').length, 1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
