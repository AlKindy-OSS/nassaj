/**
 * Shared fixture world for the relay's DB-backed tests: an isolated migrated
 * database, an isolated delivery-ledger root, two members and their sessions,
 * each with an on-disk transcript file and (except `e`) a recorded effective mode —
 * the record a spawn writes, which is the relay's only mode source.
 */

import fs from 'node:fs';
import path from 'node:path';

import { closeConnection, getConnection, initializeDatabase, peerMessagesDb, sessionsDb, userDb } from '@/modules/database/index.js';

export type PeerWorld = {
  root: string;
  alice: number;
  bob: number;
  /** alice, recorded bypassPermissions */ a: string;
  /** alice, recorded bypassPermissions */ b: string;
  /** bob, recorded bypassPermissions */ c: string;
  /** alice, recorded default (prompting) */ d: string;
  /** alice, transcript says bypassPermissions but NO recorded spawn */ e: string;
  transcript: (sessionId: string) => string;
  env: NodeJS.ProcessEnv;
  close: () => Promise<void>;
};

function addSession(root: string, sessionId: string, ownerId: number, mode: string, title: string, recorded = true): void {
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const jsonl = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(jsonl, `${JSON.stringify({ type: 'user', permissionMode: mode, message: { role: 'user', content: 'hi' } })}\n`);
  sessionsDb.createSession(sessionId, 'claude', project, title, undefined, undefined, jsonl);
  getConnection().prepare(`INSERT INTO session_participants (session_id, user_id, role, attribution)
    VALUES (?, ?, 'owner', 'spawn')`).run(sessionId, ownerId);
  if (recorded) peerMessagesDb.setSessionMode(sessionId, ownerId, mode, Date.now());
}

/** Builds the world under a fresh root on disk (never a project cwd). */
export async function createPeerWorld(): Promise<PeerWorld> {
  const root = fs.mkdtempSync('/var/tmp/peer-relay-world-');
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'db.sqlite');
  await initializeDatabase();
  const alice = (userDb.createUser('alice_peer', 'hash', 'user') as { id: number }).id;
  const bob = (userDb.createUser('bob_peer', 'hash', 'user') as { id: number }).id;
  addSession(root, 'sess-a', alice, 'bypassPermissions', 'Alpha');
  addSession(root, 'sess-b', alice, 'bypassPermissions', 'Beta');
  addSession(root, 'sess-c', bob, 'bypassPermissions', 'Gamma');
  addSession(root, 'sess-d', alice, 'default', 'Delta');
  addSession(root, 'sess-e', alice, 'bypassPermissions', 'Epsilon', false);
  const env = { ...process.env, WORKFLOW_SUPERVISOR_STATE_DIR: path.join(root, 'supervisor') };
  return {
    root, alice, bob, a: 'sess-a', b: 'sess-b', c: 'sess-c', d: 'sess-d', e: 'sess-e', env,
    transcript: (sessionId) => path.join(root, `${sessionId}.jsonl`),
    close: async () => {
      closeConnection();
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
