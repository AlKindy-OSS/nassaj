import { parentPort, workerData } from 'node:worker_threads';

import Database from 'better-sqlite3';
import { tsImport } from 'tsx/esm/api';

const { AgentReviewRepository } = await tsImport('./agent-review-lifecycle.db.ts', import.meta.url);
const db = new Database(workerData.filename, { timeout: 0 });
try {
  const repository = new AgentReviewRepository(db, {
    actorUserId: 1,
    assertCurrent: () => {
      if (workerData.barrier) {
        parentPort.postMessage({ kind: 'locked' });
        if (Atomics.wait(new Int32Array(workerData.barrier), 0, 0, 10_000) === 'timed-out') {
          throw new Error('review_race_barrier_timeout');
        }
      }
      return true;
    },
  });
  try {
    const result = repository.transition(workerData.command);
    parentPort.postMessage({ kind: 'success', revision: result.revision,
      writes: db.prepare('SELECT total_changes() AS n').get().n, inTransaction: db.inTransaction });
  } catch (error) {
    parentPort.postMessage({ kind: 'error', code: error.code ?? error.message,
      writes: db.prepare('SELECT total_changes() AS n').get().n, inTransaction: db.inTransaction });
  }
} finally { db.close(); }
