import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { migrateScheduledMessages } from '../migrations.js';

const input = workerData as { databasePath: string; barrier: SharedArrayBuffer };
const database = new Database(input.databasePath);
database.pragma('busy_timeout = 5000');
parentPort?.postMessage({ ready: true });
Atomics.wait(new Int32Array(input.barrier), 0, 0);
try {
  migrateScheduledMessages(database);
  parentPort?.postMessage({ migrated: true });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
  database.close();
}
