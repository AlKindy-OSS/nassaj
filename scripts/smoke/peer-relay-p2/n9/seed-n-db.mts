/**
 * N9 step 1 (runs on the N build): migrates a fresh DB with N and seeds one held
 * hold, one promoted hold with its queued peer_messages row (hold_id set) and one
 * same-user S1 row. Prints the ids. DATABASE_PATH must be the run's n.db.
 */
import { getConnection, initializeDatabase, peerMessagesDb, sessionsDb, userDb } from '../../../../server/modules/database/index.ts';
import { peerHoldsDb } from '../../../../server/modules/database/repositories/peer-holds.db.ts';

await initializeDatabase();
const a = (userDb.createUser('n9_alice', 'h', 'owner') as { id: number }).id;
const b = (userDb.createUser('n9_bob', 'h', 'user') as { id: number }).id;
for (const [id, owner] of [['a1', a], ['b1', b]] as const) {
  sessionsDb.createSession(id, 'claude', process.env.N9_PROJECT!, id, undefined, undefined, `${process.env.N9_PROJECT}/${id}.jsonl`);
  getConnection().prepare("INSERT INTO session_participants (session_id, user_id, role, attribution) VALUES (?, ?, 'owner', 'spawn')").run(id, owner);
  peerMessagesDb.setSessionMode(id, owner, 'default', Date.now());
}
const now = Date.now();
const base = { chain_id: 'pc_n9', from_user_id: b, from_session_id: 'b1', from_agent_id: null, from_mode: 'prompting',
  to_user_id: a, to_session_id: 'a1', project_id: null, body: 'n9', body_sha256: 'x'.repeat(64), body_bytes: 2, summary: null,
  hop: 1, parent_id: null, hold_causes: 'cross_member', expires_at: now + 1e7, now };
const limits = { perTargetUser: 50, perSenderWithinTarget: 10, perSessionPair: 10 };
peerHoldsDb.insertHeldWithinLimits({ ...base, id: 'ph_held' }, limits);
peerHoldsDb.insertHeldWithinLimits({ ...base, id: 'ph_promoted' }, limits);
peerHoldsDb.promote('ph_promoted', 1, { userId: a, authKind: 'session', nowMs: now, targetMode: 'default' },
  { id: 'pm_from_hold', ref_token: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
peerMessagesDb.insert({ id: 'pm_s1', ref_token: 'ZYXWVUTSRQPONMLKJIHGFEDCBA', chain_id: 'pc_s1', from_user_id: a,
  from_session_id: 'a1', from_agent_id: null, from_mode: 'prompting', to_user_id: a, to_session_id: 'b1', project_id: null,
  body: 's1', body_sha256: 'y'.repeat(64), body_bytes: 2, summary: null, hop: 1, parent_id: null, notify_when_idle: 0,
  state: 'queued', cause: null, now });
const holdIds = getConnection().prepare('SELECT id, hold_id FROM peer_messages ORDER BY id').all();
console.log(JSON.stringify({ seeded: true, holds: peerHoldsDb.countHeldForUser(a), messages: holdIds }));
