/**
 * ADR-219 P2a-min fixture world: an isolated migrated database (the runner's
 * DATABASE_PATH), members A (owner), B and C (members), D (admin, owns no target
 * session), and sessions with on-disk transcripts and recorded last-run modes:
 * a1 (A, default), a2 (A, bypassPermissions), b1 (B, default), z1 (no spawn owner).
 * C co-writes a1 and b1 (ADR-173 participant rows, never the spawn owner).
 */

import fs from 'node:fs';
import path from 'node:path';

import { getConnection, initializeDatabase, peerMessagesDb, sessionsDb, userDb } from '@/modules/database/index.js';

export type P2World = {
  root: string;
  A: number; B: number; C: number; D: number;
  a1: string; a2: string; b1: string; z1: string;
  transcript: (sessionId: string) => string;
  setMode: (sessionId: string, ownerUserId: number, mode: string) => void;
};

function addSession(root: string, sessionId: string, ownerId: number | null, mode: string | null, title: string): void {
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const jsonl = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(jsonl, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
  sessionsDb.createSession(sessionId, 'claude', project, title, undefined, undefined, jsonl);
  if (ownerId === null) return;
  getConnection().prepare(`INSERT INTO session_participants (session_id, user_id, role, attribution)
    VALUES (?, ?, 'owner', 'spawn')`).run(sessionId, ownerId);
  if (mode) peerMessagesDb.setSessionMode(sessionId, ownerId, mode, Date.now());
}

function addCoWriter(sessionId: string, userId: number): void {
  getConnection().prepare(`INSERT INTO session_participants (session_id, user_id, role, attribution)
    VALUES (?, ?, 'participant', 'spawn')`).run(sessionId, userId);
}

/** Builds the world in the runner's isolated database and a /var/tmp root (never a project dir). */
export async function createP2World(): Promise<P2World> {
  if (!process.env.DATABASE_PATH) throw new Error('use the isolated node test runner');
  await initializeDatabase();
  const root = fs.mkdtempSync('/var/tmp/peer-p2-world-');
  const make = (name: string, role: string) => (userDb.createUser(name, 'unused-hash', role) as { id: number }).id;
  const A = make('alice_p2', 'owner');
  const B = make('bob_p2', 'user');
  const C = make('carol_p2', 'user');
  const D = make('dave_p2', 'admin');
  addSession(root, 'a1', A, 'default', 'Alpha one');
  addSession(root, 'a2', A, 'bypassPermissions', 'Alpha two');
  addSession(root, 'b1', B, 'default', 'Bravo one');
  addSession(root, 'z1', null, null, 'Orphan');
  addCoWriter('a1', C);
  addCoWriter('b1', C);
  return {
    root, A, B, C, D, a1: 'a1', a2: 'a2', b1: 'b1', z1: 'z1',
    transcript: (sessionId) => path.join(root, `${sessionId}.jsonl`),
    setMode: (sessionId, ownerUserId, mode) => peerMessagesDb.setSessionMode(sessionId, ownerUserId, mode, Date.now()),
  };
}
