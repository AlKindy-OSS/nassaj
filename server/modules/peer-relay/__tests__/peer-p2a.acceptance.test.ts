/**
 * ADR-219 P2a-min acceptance (§8), in-process: the REAL authenticateToken, the
 * REAL holds routes over HTTP, the real hook → intake → hold → approve →
 * promotion → dispatcher → resume-turn path on a real migrated SQLite database
 * and on-disk transcripts. Only the model turn is a stand-in (it writes the
 * proof line the CLI writes); the model-dependent steps (AT-1/1b prompt answered
 * by A, F2) run in the live harness, scripts/smoke/peer-relay-p2.live.mjs.
 *
 * Covered here: AT-1 (delivery shape), AT-2, AT-9, AT-10, AT-11, N1–N8, N10.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { mintMutationCsrfToken } from '@/modules/account-wallet/index.js';
import {
  apiKeysDb, DEVICE_COOKIE, deviceAccountSessionsDb, getConnection, peerMessagesDb, userDb,
} from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/dependencies -- test reads the relay's own leaf repository.
import { peerHoldsDb } from '@/modules/database/repositories/peer-holds.db.js';

import { createPeerDispatcher, type PeerDispatcher } from '../peer-dispatcher.js';
import { decidePeerToolUse } from '../peer-hook.js';
import { createPeerHoldsRouter } from '../peer-holds.routes.js';
import { PEER_HOLD_TTL_MS } from '../peer-policy.js';
import { buildPeerDispatcherDependencies } from '../peer-relay.runtime.js';
import { createPeerHookDependencies, resetPeerRelayForTests } from '../peer-relay.service.js';
import { createPeerRunState } from '../peer-run.js';
import { NON_USER_SOURCE_PREFIX, sha256Hex } from '../peer-wire.js';
// eslint-disable-next-line boundaries/no-unknown -- the shared trusted-origin test helper (as the wallet tests use it).
import { useWalletOriginEnv } from '../../../utils/__tests__/wallet-origin-env.js';

import { createP2World, type P2World } from './peer-p2-world.test.fixture.js';

let w: P2World;
let server: Server;
let origin = '';
let jwtSecret = '';
let generateToken: (user: unknown) => string;
let restoreEnv = () => {};
let platform = false;
const previousFlag = process.env.MULTI_ACCOUNT_SWITCHING;
const live = new Set<string>();
type Frame = { sessionId: string; frame: Record<string, any> };
let frames: Frame[] = [];
let turns: Array<{ rowId: string; holdId: string | null; mode: string; wrapped: string; toSession: string }> = [];
let dispatcher: PeerDispatcher;

/** Stand-in for the CLI turn: records the call and writes the proof line the real CLI writes. */
async function fakeTurn(row: any, turn: any, mode: string) {
  turns.push({ rowId: row.id, holdId: row.hold_id ?? null, mode, wrapped: turn.wrapped, toSession: row.to_session_id });
  turn.consumed = true;
  fs.appendFileSync(w.transcript(row.to_session_id), `${JSON.stringify({ type: 'user', isMeta: true,
    turnOrigin: 'host_synthetic', promptSource: 'system', message: { role: 'user', content: NON_USER_SOURCE_PREFIX + turn.wrapped } })}\n`);
  turn.onResult({ subtype: 'success', totalCostUsd: 0.01, isError: false });
  return { started: true, code: null, permanent: false };
}

/** A route reached by a principal of a given authentication kind (ck, internal_service, …). */
const asKind = (kind: string, userId: () => number) => (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: userId(), authenticationKind: kind };
  next();
};
let kindUser = 0;

before(async () => {
  process.env.MULTI_ACCOUNT_SWITCHING = 'true';
  w = await createP2World();
  // eslint-disable-next-line boundaries/no-unknown -- the REAL authenticateToken is what this suite proves (CSRF, kinds).
  const middleware = await import('../../../middleware/auth.js');
  jwtSecret = middleware.JWT_SECRET;
  generateToken = middleware.generateToken as (user: unknown) => string;
  const router = createPeerHoldsRouter({ canReadSession: () => true, isPlatform: () => platform });
  const app = express();
  app.use(express.json());
  app.use('/api/peer-relay', middleware.authenticateToken, router);
  app.use('/kind/:kind/api/peer-relay', (req, res, next) => asKind(String(req.params.kind), () => kindUser)(req, res, next), router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  ({ origin, restore: restoreEnv } = useWalletOriginEnv((server.address() as AddressInfo).port));
  dispatcher = createPeerDispatcher(buildPeerDispatcherDependencies({
    env: { ...process.env, WORKFLOW_SUPERVISOR_STATE_DIR: path.join(w.root, 'supervisor') },
    isSessionRunLive: (id) => live.has(id), cliVersion: async () => '2.1.312',
    readUsage: async () => ({ session: null, weeklyAllModels: null }), ledgerCostUsd: async () => null, runTurn: fakeTurn,
  }));
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  restoreEnv();
  if (previousFlag === undefined) delete process.env.MULTI_ACCOUNT_SWITCHING;
  else process.env.MULTI_ACCOUNT_SWITCHING = previousFlag;
  fs.rmSync(w.root, { recursive: true, force: true });
});

beforeEach(() => {
  getConnection().prepare('DELETE FROM peer_messages').run();
  getConnection().prepare('DELETE FROM peer_holds').run();
  frames = [];
  turns = [];
  live.clear();
  platform = false;
  w.setMode(w.a1, w.A, 'default');
  w.setMode(w.b1, w.B, 'default');
  resetPeerRelayForTests({
    canWriteSession: () => true,
    notifySession: (sessionId, serialized) => { frames.push({ sessionId, frame: JSON.parse(serialized) }); },
    kickDispatcher: () => undefined,
    platformMode: () => platform,
  });
});

/** A real bearer for the member, minted by the same generator the login route uses. */
const bearer = (userId: number) => ({ Authorization: `Bearer ${generateToken(userDb.getUserById(userId))}` });

/** A send through the REAL hook, as the sender's run (identity from the run entry). */
function send(fromUserId: number, fromSession: string, to: string, message: string, mode = 'default') {
  const run = createPeerRunState({ activeMemberCount: 4, userId: fromUserId, sessionId: fromSession, permissionMode: mode });
  const decision = decidePeerToolUse(run, { tool_name: 'SendMessage', session_id: fromSession,
    tool_input: { to: `nassaj:${to}`, message } }, createPeerHookDependencies(() => false)) as any;
  return String(decision.hookSpecificOutput?.permissionDecisionReason ?? '');
}

const holdsTo = (sessionId: string) => (getConnection().prepare(
  'SELECT * FROM peer_holds WHERE to_session_id = ? ORDER BY created_at').all(sessionId) as any[]);

async function call(method: string, route: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${origin}${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({})) as any;
  return { status: res.status, json };
}

function approveBody(hold: any, overrides: Record<string, unknown> = {}) {
  return { expectedHoldVersion: hold.hold_version, expectedTextHash: hold.body_sha256, expectedTargetMode: 'default', ...overrides };
}

const approve = (userId: number, hold: any, overrides = {}) =>
  call('POST', `/api/peer-relay/holds/${hold.id}/approve`, bearer(userId), approveBody(hold, overrides));

test('AT-1 (shape): b1 → a1 is held; A sees the card; approve ⇒ one queued row, resume turn under F2 in `default`', async () => {
  const text = send(w.B, w.b1, w.a1, 'create READY.txt with OK and reply done');
  assert.match(text, /^SUCCESS \(not an error\): nassaj held this message/u, text);
  const [hold] = holdsTo(w.a1);
  assert.equal(hold.state, 'held');
  assert.equal(hold.from_user_id, w.B);
  assert.equal(hold.to_user_id, w.A);
  assert.equal(hold.hold_causes, 'cross_member');
  const inbox = await call('GET', '/api/peer-relay/holds', bearer(w.A));
  assert.equal(inbox.status, 200);
  assert.equal(inbox.json.count, 1);
  const card = inbox.json.holds[0];
  assert.equal(card.fromMemberName, 'bob_p2');
  assert.equal(card.fromSessionId, w.b1);
  assert.equal(card.body, 'create READY.txt with OK and reply done');
  assert.equal(card.targetMode, 'default');
  assert.equal(card.targetModeLabel, 'default (this session\'s last run)');
  assert.ok(frames.some((f) => f.sessionId === w.a1 && f.frame.type === 'peer-hold' && f.frame.hold.state === 'held'));
  const ok = await approve(w.A, hold);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const row = peerMessagesDb.get(ok.json.messageId)!;
  assert.equal(row.state, 'queued');
  assert.equal(row.hold_id, hold.id);
  assert.equal(row.approved_by, w.A);
  assert.equal(peerHoldsDb.get(hold.id)!.state, 'promoted');
  await dispatcher.tick();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.mode, 'default', 'the delivery runs with the target\'s last run mode');
  assert.ok(turns[0]!.wrapped.includes('Another member, bob_p2, sent this. Your user read it and chose to deliver it'));
  assert.ok(!turns[0]!.wrapped.includes('same owner'));
  const delivered = peerMessagesDb.get(row.id)!;
  assert.equal(delivered.state, 'delivered');
  assert.equal(delivered.delivery_path, 'resume');
});

test('AT-1 (reply leg): a1\'s answer to b1 is itself held on B\'s side; B approves; it is delivered to b1', async () => {
  const text = send(w.A, w.a1, w.b1, 'done');
  assert.match(text, /held this message/u);
  const [hold] = holdsTo(w.b1);
  assert.equal(hold.to_user_id, w.B);
  assert.equal((await approve(w.A, hold)).status, 403, 'only B decides holds addressed to B');
  assert.equal((await approve(w.B, hold)).status, 200);
  await dispatcher.tick();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.toSession, w.b1);
  assert.ok(turns[0]!.wrapped.includes('Another member, alice_p2, sent this.'));
});

test('AT-2: reject ⇒ rejected, B\'s mirror shows it, a1 gains no bytes, no row, no turn', async () => {
  send(w.B, w.b1, w.a1, 'please do X');
  const [hold] = holdsTo(w.a1);
  const before = fs.statSync(w.transcript(w.a1)).size;
  const res = await call('POST', `/api/peer-relay/holds/${hold.id}/reject`, bearer(w.A), { expectedHoldVersion: 1, reason: 'not now' });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(peerHoldsDb.get(hold.id)!.state, 'rejected');
  assert.equal(peerHoldsDb.get(hold.id)!.reject_reason, 'not now');
  assert.ok(frames.some((f) => f.sessionId === w.b1 && f.frame.hold?.state === 'rejected'));
  const mirror = await call('GET', `/api/peer-relay/sessions/${w.b1}/holds`, bearer(w.B));
  assert.equal(mirror.json.holds[0].state, 'rejected');
  await dispatcher.tick();
  assert.equal(fs.statSync(w.transcript(w.a1)).size, before);
  assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM peer_messages').get() as any).n, 0);
  assert.equal(turns.length, 0);
});

test('AT-9: an approved row never answers a pending prompt: it stays queued while a1 waits, then resumes', async () => {
  send(w.B, w.b1, w.a1, 'write a file');
  const [hold] = holdsTo(w.a1);
  const { json } = await approve(w.A, hold);
  live.add(w.a1); // a1's human turn is waiting on a real Write prompt
  await dispatcher.tick();
  assert.equal(peerMessagesDb.get(json.messageId)!.state, 'queued');
  assert.equal(turns.length, 0, 'nothing ran while the prompt was pending');
  live.delete(w.a1); // A denied; the human turn ended
  await dispatcher.tick();
  assert.equal(turns.length, 1);
  assert.equal(peerMessagesDb.get(json.messageId)!.delivery_path, 'resume');
});

test('AT-10: never steers: mid-human-turn the row stays queued; delivered by a resume turn after the turn ends', async () => {
  send(w.B, w.b1, w.a1, 'note this');
  const { json } = await approve(w.A, holdsTo(w.a1)[0]);
  live.add(w.a1);
  await dispatcher.tick();
  await dispatcher.tick();
  assert.equal(turns.length, 0);
  live.delete(w.a1);
  await dispatcher.tick();
  assert.equal(peerMessagesDb.get(json.messageId)!.state, 'delivered');
  assert.equal(peerMessagesDb.get(json.messageId)!.delivery_path, 'resume');
});

test('AT-11: B, D (admin) and an internal_service principal get 403; a 72 h old hold expires and B sees it', async () => {
  send(w.B, w.b1, w.a1, 'hello');
  const [hold] = holdsTo(w.a1);
  for (const user of [w.B, w.D]) {
    assert.equal((await approve(user, hold)).status, 403);
    assert.equal((await call('POST', `/api/peer-relay/holds/${hold.id}/reject`, bearer(user), { expectedHoldVersion: 1 })).status, 403);
  }
  kindUser = w.A;
  const svc = await call('POST', `/kind/internal_service/api/peer-relay/holds/${hold.id}/approve`, {}, approveBody(hold));
  assert.equal(svc.status, 403);
  assert.equal(svc.json.code, 'interactive_credential_required');
  assert.equal(peerHoldsDb.get(hold.id)!.state, 'held');
  const old = Date.now() - PEER_HOLD_TTL_MS - 60_000;
  getConnection().prepare('UPDATE peer_holds SET created_at = ?, expires_at = ? WHERE id = ?').run(old, old + PEER_HOLD_TTL_MS, hold.id);
  await dispatcher.tick();
  assert.equal(peerHoldsDb.get(hold.id)!.state, 'expired');
  assert.ok(frames.some((f) => f.sessionId === w.b1 && f.frame.hold?.state === 'expired'));
  assert.equal((await approve(w.A, peerHoldsDb.get(hold.id))).status, 409);
});

test('N1: A\'s own API key cannot approve (no interactive credential); the hold is unchanged', async () => {
  send(w.B, w.b1, w.a1, 'hello');
  const [hold] = holdsTo(w.a1);
  const key = apiKeysDb.createApiKey(w.A, 'n1').apiKey;
  for (const headers of [{ 'x-api-key': key }, { Authorization: `Bearer ${key}` }]) {
    const res = await call('POST', `/api/peer-relay/holds/${hold.id}/approve`, headers, approveBody(hold));
    assert.ok(res.status === 401 || res.status === 403, `status ${res.status}`);
  }
  kindUser = w.A;
  const ck = await call('POST', `/kind/ck/api/peer-relay/holds/${hold.id}/approve`, {}, approveBody(hold));
  assert.equal(ck.status, 403);
  assert.equal(ck.json.code, 'interactive_credential_required');
  const now = peerHoldsDb.get(hold.id)!;
  assert.equal(now.state, 'held');
  assert.equal(now.hold_version, 1);
});

test('N2: replay ⇒ one 200, one 409; two parallel approves ⇒ exactly one peer_messages row', async () => {
  send(w.B, w.b1, w.a1, 'one');
  const [h1] = holdsTo(w.a1);
  assert.equal((await approve(w.A, h1)).status, 200);
  const replay = await approve(w.A, h1);
  assert.equal(replay.status, 409);
  send(w.B, w.b1, w.a1, 'two');
  const h2 = holdsTo(w.a1).find((h) => h.state === 'held');
  const results = await Promise.all([approve(w.A, h2), approve(w.A, h2)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM peer_messages WHERE hold_id = ?').get(h2.id) as any).n, 1);
});

test('N3: C writing in b1 is named as the sender; C, a co-writer of a1, cannot approve A\'s holds', async () => {
  send(w.C, w.b1, w.a1, 'from carol');
  const [hold] = holdsTo(w.a1);
  assert.equal(hold.from_user_id, w.C);
  const card = (await call('GET', '/api/peer-relay/holds', bearer(w.A))).json.holds[0];
  assert.equal(card.fromMemberName, 'carol_p2');
  assert.equal(card.fromUserId, w.C);
  const res = await approve(w.C, hold);
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'not_target_owner');
});

test('N4: Cf/bidi characters are shown as visible tokens, body in full; the hash of stripped text ⇒ 409', async () => {
  const body = `pay ‮ evil​ hidden⁦ x ${'y'.repeat(3000)}`;
  send(w.B, w.b1, w.a1, body);
  const [hold] = holdsTo(w.a1);
  const card = (await call('GET', '/api/peer-relay/holds', bearer(w.A))).json.holds[0];
  for (const token of ['⟨U+202E⟩', '⟨U+200B⟩', '⟨U+2066⟩']) assert.ok(card.bodyVisible.includes(token), token);
  assert.equal(card.body, body, 'full body, no truncation');
  const stripped = body.replace(/[‮​⁦]/gu, '');
  const res = await approve(w.A, hold, { expectedTextHash: sha256Hex(stripped) });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'text_hash_mismatch');
});

test('N5: a mode mismatch stays refused: b1 (default) → a2 (bypass) ⇒ refused mode_mismatch, no card', () => {
  const text = send(w.B, w.b1, w.a2, 'run it');
  assert.match(text, /^refused:/u);
  assert.equal(holdsTo(w.a2).length, 0);
  const row = getConnection().prepare('SELECT state, cause FROM peer_messages WHERE to_session_id = ?').get(w.a2) as any;
  assert.deepEqual({ ...row }, { state: 'refused', cause: 'mode_mismatch' });
});

test('N6: approved, then A switches a1 to acceptEdits by a human turn ⇒ refused rehold, held v+1, no peer turn', async () => {
  send(w.B, w.b1, w.a1, 'do it');
  const [hold] = holdsTo(w.a1);
  const { json } = await approve(w.A, hold);
  w.setMode(w.a1, w.A, 'acceptEdits'); // the next human turn's spawn record
  await dispatcher.tick();
  const msg = peerMessagesDb.get(json.messageId)!;
  assert.deepEqual([msg.state, msg.cause], ['refused', 'rehold']);
  const again = peerHoldsDb.get(hold.id)!;
  assert.equal(again.state, 'held');
  assert.equal(again.hold_version, hold.hold_version + 2, 'approve +1, re-hold +1');
  assert.equal(again.decided_by, null);
  assert.equal(turns.length, 0);
  assert.ok(frames.some((f) => f.frame.type === 'peer-hold' && f.frame.hold.id === hold.id && f.frame.hold.state === 'held'
    && f.frame.hold.holdVersion === again.hold_version));
});

test('N7: under IS_PLATFORM approve ⇒ 403 platform_mode and cross-member intake keeps the S1 refusal; null owner refused', async () => {
  send(w.B, w.b1, w.a1, 'pre');
  const [hold] = holdsTo(w.a1);
  platform = true;
  const res = await approve(w.A, hold);
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'platform_mode');
  const text = send(w.B, w.b1, w.a1, 'during platform');
  assert.match(text, /^refused: cross-member or mode-mismatch relay is not enabled/u);
  assert.equal(holdsTo(w.a1).length, 1);
  platform = false;
  const orphan = send(w.B, w.b1, w.z1, 'to nobody');
  assert.match(orphan, /^refused:/u);
  const row = getConnection().prepare('SELECT cause FROM peer_messages WHERE to_session_id = ?').get(w.z1) as any;
  assert.equal(row.cause, 'owner_unknown');
});

test('N8: overflow is atomic: 9 held B→A, two sends ⇒ one held, one refused overflow; C can still send', () => {
  const insert = getConnection().prepare(`INSERT INTO peer_holds (id, chain_id, from_user_id, from_session_id,
    from_mode, to_user_id, to_session_id, body, body_sha256, body_bytes, hop, hold_causes, state, expires_at,
    created_at, updated_at) VALUES (?, 'c', ?, 'bx', 'prompting', ?, ?, 'b', 'h', 1, 1, 'cross_member', 'held', ?, ?, ?)`);
  const now = Date.now();
  for (let i = 0; i < 9; i++) insert.run(`seed${i}`, w.B, w.A, w.a1, now + PEER_HOLD_TTL_MS, now, now);
  const outcomes = [send(w.B, w.b1, w.a1, 'ten'), send(w.B, w.b1, w.a1, 'eleven')];
  assert.equal(outcomes.filter((t) => /held this message/u.test(t)).length, 1);
  assert.equal(outcomes.filter((t) => /the recipient's inbox is full/u.test(t)).length, 1);
  assert.equal((getConnection().prepare("SELECT COUNT(*) AS n FROM peer_holds WHERE from_user_id = ? AND state = 'held'")
    .get(w.B) as any).n, 10);
  assert.match(send(w.C, w.b1, w.a1, 'carol still can'), /held this message/u);
});

type Device = { secret: string; deviceSessionId: string; slotId: string; generation: number };

function deviceFor(userId: number): Device {
  const issued = deviceAccountSessionsDb.create(userId, 60 * 60_000);
  return { secret: issued.secret, ...issued.principal };
}

function csrf(d: Device, method: string, route: string) {
  const minted = mintMutationCsrfToken(jwtSecret, `device:${d.deviceSessionId}:${d.slotId}:${d.generation}`, method, route);
  return { Origin: origin, 'X-CSRF-Token': minted!.csrfToken };
}

test('N10: device-cookie approve/reject without a valid CSRF token or Origin ⇒ 403; nothing changes', async () => {
  send(w.B, w.b1, w.a1, 'csrf');
  const [hold] = holdsTo(w.a1);
  const d = deviceFor(w.A);
  const cookie = { Cookie: `${DEVICE_COOKIE}=${encodeURIComponent(d.secret)}` };
  for (const action of ['approve', 'reject']) {
    const route = `/api/peer-relay/holds/${hold.id}/${action}`;
    const body = action === 'approve' ? approveBody(hold) : { expectedHoldVersion: 1 };
    const bad = [
      { ...cookie, Origin: origin },
      { ...cookie, ...csrf(d, 'POST', route), Origin: 'https://evil.example' },
      { ...cookie, ...csrf(d, 'POST', `/api/peer-relay/holds/${hold.id}/${action === 'approve' ? 'reject' : 'approve'}`) },
    ];
    for (const headers of bad) {
      const res = await call('POST', route, headers, body);
      assert.equal(res.status, 403, `${action}: ${JSON.stringify(res.json)}`);
    }
  }
  const now = peerHoldsDb.get(hold.id)!;
  assert.deepEqual([now.state, now.hold_version, now.decided_by, now.decided_at], ['held', 1, null, null]);
  assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM peer_messages').get() as any).n, 0);
  const route = `/api/peer-relay/holds/${hold.id}/approve`;
  const good = await call('POST', route, { ...cookie, ...csrf(d, 'POST', route) }, approveBody(hold));
  assert.equal(good.status, 200, 'positive control: the same cookie with a bound token works');
  assert.equal(peerHoldsDb.get(hold.id)!.decided_auth_kind, 'device_session');
});
