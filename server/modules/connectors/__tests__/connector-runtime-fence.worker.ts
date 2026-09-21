import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';

import {
  ConnectorRuntimeAuthority,
  ConnectorRuntimeWriteGate,
} from '../connector-runtime-fence.js';

type WorkerInput = Readonly<{
  path: string;
  owner: string;
  barrier: SharedArrayBuffer;
  now: number;
  key: string;
}>;

const input = workerData as WorkerInput;
const database = new Database(input.path);
database.pragma('busy_timeout = 5000');
const authority = ConnectorRuntimeAuthority.create(Buffer.from(input.key, 'hex'));
const gate = new ConnectorRuntimeWriteGate(database, {
  runtimeVersion: 1, maximumPolicySchemaVersion: 2, supportsWriterFencing: true,
}, authority, () => input.now);

parentPort?.postMessage({ ready: true });
Atomics.wait(new Int32Array(input.barrier), 0, 0);
try {
  parentPort?.postMessage({ won: gate.acquire(input.owner, 5_000) !== null });
} catch (error) {
  parentPort?.postMessage({ error: String(error) });
} finally {
  database.close();
}
