/**
 * ADR-219 P2 §8 test seam: `POST /__test/peer-relay/dispatcher/{pause,resume,tick}`,
 * mounted only when NASSAJ_PEER_RELAY_TEST_SEAMS=1. Loopback is NOT a protection
 * here (the tunnel forwards from loopback), so the server refuses to start with
 * the seam unless DATABASE_PATH resolves (realpath) inside /var/tmp/peer-p2-<run>/,
 * differs from the operator's database, and NODE_ENV is not production (ش-4). The
 * operator's database is the resolver default load-env uses (no DATABASE_PATH) and,
 * when set, NASSAJ_LIVE_DATABASE_PATH; the run-dir rule is the primary fence.
 */

import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

// eslint-disable-next-line boundaries/dependencies -- the resolver load-env uses, as a leaf: the barrel would load DB code before the fence.
import { resolveDatabaseFilePath } from '../database/database-path.js';

import type { PeerDispatcher } from './peer-dispatcher.js';

export const PEER_RELAY_TEST_SEAMS_ENV = 'NASSAJ_PEER_RELAY_TEST_SEAMS';
const RUN_DIR = /^\/var\/tmp\/peer-p2-[A-Za-z0-9]+$/u;

function realpathOrParent(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
    } catch {
      return path.resolve(target);
    }
  }
}

/**
 * False when the seam is off. True when it is on and fenced. Throws (the server
 * must not start) when it is on and the fence fails.
 */
export function assertPeerRelayTestSeamsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[PEER_RELAY_TEST_SEAMS_ENV] !== '1') return false;
  const refuse = (why: string): never => { throw new Error(`peer relay test seams refused: ${why}`); };
  if (env.NODE_ENV === 'production') refuse('NODE_ENV is production');
  if (!env.DATABASE_PATH) refuse('DATABASE_PATH is not set');
  let resolved = '';
  try {
    resolved = realpathOrParent(path.resolve(env.DATABASE_PATH as string));
  } catch {
    refuse('DATABASE_PATH does not resolve');
  }
  if (!RUN_DIR.test(path.dirname(resolved))) refuse('DATABASE_PATH is not inside /var/tmp/peer-p2-<run>/');
  const operatorPaths = [resolveDatabaseFilePath({}), env.NASSAJ_LIVE_DATABASE_PATH]
    .filter((p): p is string => typeof p === 'string' && p.length > 0).map((p) => realpathOrParent(path.resolve(p)));
  if (operatorPaths.includes(resolved)) refuse('DATABASE_PATH is the operator database');
  return true;
}

/** The seam router over the running dispatcher (mount only after the fence passed). */
export function createPeerRelayTestSeamsRouter(dispatcher: PeerDispatcher) {
  const router = express.Router();
  router.post('/dispatcher/pause', (_req, res) => { dispatcher.pause(); res.json({ ok: true }); });
  router.post('/dispatcher/resume', (_req, res) => { dispatcher.resume(); res.json({ ok: true }); });
  router.post('/dispatcher/tick', async (_req, res) => { await dispatcher.tick(); res.json({ ok: true }); });
  return router;
}
