import { parentPort, workerData } from 'node:worker_threads';

import { openOrCreateConnectorRuntimeAuthorityRoot } from '../connector-runtime-authority-root.js';

try {
  parentPort?.postMessage({ ok: true,
    rotationId: openOrCreateConnectorRuntimeAuthorityRoot(String(workerData)).rotationId });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
