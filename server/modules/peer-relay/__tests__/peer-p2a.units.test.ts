/**
 * ADR-219 P2a-min unit tests (ش-5): U1–U4, the other §4 rows (CAS races,
 * re-hold on an owner change at approve), the intake policy, the shared
 * interactive allowlist (ش-1 guard), the visible Cf tokens and the test-seam fence.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import express from 'express';

import { getConnection, peerMessagesDb } from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/dependencies -- test reads the relay's own leaf repository.
import { peerHoldsDb } from '@/modules/database/repositories/peer-holds.db.js';
import { isVerifiedActorKind, VERIFIED_ACTOR_KINDS } from '@/shared/verified-actor-kinds.js';

import { createPeerDispatcher } from '../peer-dispatcher.js';
import { approvePeerHold, rejectPeerHold, sweepPeerHolds, visibleBody } from '../peer-holds.service.js';
import { createPeerHoldsRouter, PEER_HOLD_WRITE_GUARD } from '../peer-holds.routes.js';
import { decideIntake, PEER_HOLD_TTL_MS } from '../peer-policy.js';
import { assertPeerRelayTestSeamsAllowed } from '../peer-relay.test-seams.js';
import { buildPeerDispatcherDependencies } from '../peer-relay.runtime.js';
import { enqueuePeerMessage, listPeerMessageViews, recordPeerPromptDecision, resetPeerRelayForTests } from '../peer-relay.service.js';
import { createPeerRunState } from '../peer-run.js';

import { createP2World, type P2World } from './peer-p2-world.test.fixture.js';

let w: P2World;
let turns = 0;

before(async () => { w = await createP2World(); });
after(() => { fs.rmSync(w.root, { recursive: true, force: true }); });
beforeEach(() => {
  getConnection().prepare('DELETE FROM peer_messages').run();
  getConnection().prepare('DELETE FROM peer_holds').run();
  getConnection().prepare("UPDATE users SET is_active = 1, status = 'active'").run();
  getConnection().prepare('UPDATE sessions SET isArchived = 0').run();
  setOwner(w.A);
  w.setMode(w.a1, w.A, 'default');
  turns = 0;
  resetPeerRelayForTests({ canWriteSession: () => true, platformMode: () => false });
});

/** Makes `userId` the single spawn owner of a1 (C stays a co-writer when not the owner). */
function setOwner(userId: number): void {
  const db = getConnection();
  db.prepare('DELETE FROM session_participants WHERE session_id = ?').run(w.a1);
  db.prepare(`INSERT INTO session_participants (session_id, user_id, role, attribution) VALUES (?, ?, 'owner', 'spawn')`)
    .run(w.a1, userId);
  if (userId !== w.C) {
    db.prepare(`INSERT INTO session_participants (session_id, user_id, role, attribution) VALUES (?, ?, 'participant', 'spawn')`)
      .run(w.a1, w.C);
  }
}

function hold(from = w.B, to = w.a1): string {
  const out = enqueuePeerMessage({ run: createPeerRunState({ activeMemberCount: 4, userId: from, sessionId: w.b1,
    permissionMode: 'default' }), senderSessionId: w.b1, senderAgentId: null, targetSessionId: to, message: 'hi',
  summary: null, hop: 1, notifyWhenIdle: false });
  assert.equal(out.status, 'held', out.text);
  return out.id!;
}

const caller = (userId: number) => ({ userId, authKind: 'session' });
const approveAs = (userId: number, id: string, version = peerHoldsDb.get(id)!.hold_version) => approvePeerHold({
  holdId: id, caller: caller(userId), expectedHoldVersion: version, expectedTextHash: peerHoldsDb.get(id)!.body_sha256,
  expectedTargetMode: 'default' });

function dispatcher(opts: { version?: string; noTranscript?: boolean } = {}) {
  const deps = buildPeerDispatcherDependencies({
    env: { ...process.env, WORKFLOW_SUPERVISOR_STATE_DIR: path.join(w.root, 'supervisor') },
    isSessionRunLive: () => false, cliVersion: async () => opts.version ?? '2.1.312',
    readUsage: async () => ({ session: null, weeklyAllModels: null }), ledgerCostUsd: async () => null,
    runTurn: async () => { turns++; return { started: false, code: 'not_started', permanent: false }; },
  });
  return createPeerDispatcher(opts.noTranscript ? { ...deps, transcriptPath: () => null } : deps);
}

test('U1: a disabled sender ⇒ all their held rows become cancelled sender_disabled', () => {
  const a = hold();
  const b = hold();
  const c = hold(w.C);
  getConnection().prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(w.B);
  sweepPeerHolds();
  for (const id of [a, b]) assert.deepEqual([peerHoldsDb.get(id)!.state, peerHoldsDb.get(id)!.cause], ['cancelled', 'sender_disabled']);
  assert.equal(peerHoldsDb.get(c)!.state, 'held');
});

test('U2: an archived target ⇒ its held rows become cancelled target_archived', () => {
  const id = hold();
  getConnection().prepare('UPDATE sessions SET isArchived = 1 WHERE session_id = ?').run(w.a1);
  sweepPeerHolds();
  assert.deepEqual([peerHoldsDb.get(id)!.state, peerHoldsDb.get(id)!.cause], ['cancelled', 'target_archived']);
});

test('U3: target owner changed after approval ⇒ message refused rehold; hold held, approval cleared, v+1', async () => {
  const id = hold();
  const res = approveAs(w.A, id);
  assert.equal(res.status, 200);
  const versionAfterApprove = peerHoldsDb.get(id)!.hold_version;
  setOwner(w.C);
  w.setMode(w.a1, w.C, 'default');
  await dispatcher().tick();
  const msg = peerMessagesDb.get(res.messageId!)!;
  assert.deepEqual([msg.state, msg.cause], ['refused', 'rehold']);
  const h = peerHoldsDb.get(id)!;
  assert.deepEqual([h.state, h.to_user_id, h.decided_by, h.decided_at, h.hold_version],
    ['held', w.C, null, null, versionAfterApprove + 1]);
  assert.equal(turns, 0);
});

test('U4: an approved row 72 h old ⇒ message failed approval_expired, hold expired', async () => {
  const id = hold();
  const res = approveAs(w.A, id);
  getConnection().prepare('UPDATE peer_holds SET decided_at = ? WHERE id = ?').run(Date.now() - PEER_HOLD_TTL_MS - 1, id);
  await dispatcher().tick();
  const msg = peerMessagesDb.get(res.messageId!)!;
  assert.deepEqual([msg.state, msg.cause], ['failed', 'approval_expired']);
  assert.equal(peerHoldsDb.get(id)!.state, 'expired');
  assert.equal(turns, 0);
});

test('§4: approve CAS — a stale version, a non-owner and a non-held state never promote', () => {
  const id = hold();
  assert.equal(approveAs(w.A, id, 99).status, 409);
  assert.equal(approveAs(w.B, id).status, 403);
  assert.equal(approveAs(w.A, id).status, 200);
  const again = approveAs(w.A, id);
  assert.deepEqual([again.status, again.code], [409, 'hold_not_held']);
  assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM peer_messages WHERE hold_id = ?').get(id) as any).n, 1);
});

test('§4: the CAS itself admits one winner (two promotes on the same version)', () => {
  const id = hold();
  const h = peerHoldsDb.get(id)!;
  const message = (n: string) => ({ id: `pm_${n}`, ref_token: `REF${n}AAAAAAAAAAAAAAAAAAAAAA`.slice(0, 26) });
  const decision = { userId: w.A, authKind: 'session', nowMs: Date.now(), targetMode: 'default' };
  assert.equal(peerHoldsDb.promote(id, h.hold_version, decision, message('1')), true);
  assert.equal(peerHoldsDb.promote(id, h.hold_version, decision, message('2')), false);
  assert.equal(peerMessagesDb.get('pm_2'), undefined);
});

test('ت-8: owner changed while held ⇒ the OLD owner gets 403 with no write and no body; the new owner gets 409 owner_changed', () => {
  const id = hold();
  setOwner(w.C);
  const stale = approveAs(w.A, id);
  assert.deepEqual([stale.status, stale.code, stale.hold], [403, 'not_target_owner', undefined]);
  assert.deepEqual([peerHoldsDb.get(id)!.to_user_id, peerHoldsDb.get(id)!.hold_version], [w.A, 1], 'no redirect write by a non-owner');
  const res = approvePeerHold({ holdId: id, caller: caller(w.C), expectedHoldVersion: 1,
    expectedTextHash: peerHoldsDb.get(id)!.body_sha256, expectedTargetMode: 'default' });
  assert.deepEqual([res.status, res.code], [409, 'owner_changed']);
  assert.equal(peerHoldsDb.get(id)!.to_user_id, w.C);
  assert.equal(peerHoldsDb.get(id)!.hold_version, 2);
});

test('sweep: a held row whose target owner changed is re-pointed to the new owner (a fresh card)', () => {
  const id = hold();
  setOwner(w.C);
  sweepPeerHolds();
  assert.deepEqual([peerHoldsDb.get(id)!.to_user_id, peerHoldsDb.get(id)!.hold_version, peerHoldsDb.get(id)!.state], [w.C, 2, 'held']);
});

/** The newest audit rows of an action, as parsed metadata. */
function audits(action: string): Array<Record<string, unknown>> {
  return (getConnection().prepare('SELECT metadata FROM audit_log WHERE action = ? ORDER BY id').all(action) as Array<{ metadata: string }>)
    .map((row) => JSON.parse(row.metadata));
}

test('qa r2 #2: both repoint paths audit peer_relay_hold_repointed {holdId, fromOwner, toOwner}', () => {
  getConnection().prepare("DELETE FROM audit_log WHERE action = 'peer_relay_hold_repointed'").run();
  const viaSweep = hold();
  setOwner(w.C);
  sweepPeerHolds();
  assert.deepEqual(audits('peer_relay_hold_repointed'), [{ holdId: viaSweep, fromOwner: w.A, toOwner: w.C }]);
  setOwner(w.A);
  getConnection().prepare('DELETE FROM peer_holds').run();
  getConnection().prepare("DELETE FROM audit_log WHERE action = 'peer_relay_hold_repointed'").run();
  const viaDecision = hold();
  setOwner(w.C);
  const res = approvePeerHold({ holdId: viaDecision, caller: caller(w.C), expectedHoldVersion: 1,
    expectedTextHash: peerHoldsDb.get(viaDecision)!.body_sha256, expectedTargetMode: 'default' });
  assert.equal(res.code, 'owner_changed');
  assert.deepEqual(audits('peer_relay_hold_repointed'), [{ holdId: viaDecision, fromOwner: w.A, toOwner: w.C }]);
});

test('qa r2 #3c: a promoted row whose delivery fails permanently (settle → failed) returns its hold to held', async () => {
  const id = hold();
  const res = approveAs(w.A, id);
  const version = peerHoldsDb.get(id)!.hold_version;
  const deps = buildPeerDispatcherDependencies({
    env: { ...process.env, WORKFLOW_SUPERVISOR_STATE_DIR: path.join(w.root, 'supervisor') },
    isSessionRunLive: () => false, cliVersion: async () => '2.1.312',
    readUsage: async () => ({ session: null, weeklyAllModels: null }), ledgerCostUsd: async () => null,
    runTurn: async () => { turns++; return { started: false, code: 'session_unavailable', permanent: true }; },
  });
  await createPeerDispatcher(deps).tick();
  assert.equal(turns, 1, 'the turn was attempted (the row reached settle)');
  const msg = peerMessagesDb.get(res.messageId!)!;
  assert.deepEqual([msg.state, msg.cause], ['failed', 'session_unavailable']);
  const h = peerHoldsDb.get(id)!;
  assert.deepEqual([h.state, h.cause, h.message_id, h.decided_by, h.hold_version], ['held', 'session_unavailable', null, null, version + 1]);
});

test('م-3: a held row past expires_at that the sweep has not reached cannot be approved or rejected', () => {
  const id = hold();
  getConnection().prepare('UPDATE peer_holds SET expires_at = ? WHERE id = ?').run(Date.now() - 1, id);
  const approved = approveAs(w.A, id);
  assert.equal(approved.status, 409);
  assert.ok(['hold_expired', 'hold_not_held'].includes(String(approved.code)), String(approved.code));
  assert.equal(rejectPeerHold({ holdId: id, caller: caller(w.A), expectedHoldVersion: 1 }).status, 409);
  const decision = { userId: w.A, authKind: 'session', nowMs: Date.now(), targetMode: 'default' };
  assert.equal(peerHoldsDb.promote(id, 1, decision, { id: 'pm_late', ref_token: 'LATEAAAAAAAAAAAAAAAAAAAAAA' }), false,
    'the CAS itself refuses an expired hold');
  assert.equal(peerHoldsDb.reject(id, 1, decision, null), false);
  assert.equal(peerMessagesDb.get('pm_late'), undefined);
  assert.equal(peerHoldsDb.get(id)!.state, 'held');
});

test('ت-6: re-hold aborts (message untouched) when the hold is no longer promoted', () => {
  const id = hold();
  const res = approveAs(w.A, id);
  getConnection().prepare("UPDATE peer_holds SET state = 'expired' WHERE id = ?").run(id);
  assert.equal(peerHoldsDb.rehold(id, res.messageId!, w.A, Date.now(), PEER_HOLD_TTL_MS), false);
  assert.equal(peerMessagesDb.get(res.messageId!)!.state, 'queued', 'the message refusal was rolled back');
  assert.equal(peerHoldsDb.expireApproved(id, res.messageId!, Date.now()), false);
  assert.equal(peerMessagesDb.get(res.messageId!)!.state, 'queued');
});

for (const [label, overrides, cause] of [
  ['unverified_cli', { version: '9.9.9' }, 'unverified_cli'],
  ['mode_unknown', { dropMode: true }, 'mode_unknown'],
  ['no_transcript', { noTranscript: true }, 'no_transcript'],
] as const) {
  test(`ت-9: an approved row refused for ${label} returns its hold to held with that cause (no dead promoted hold)`, async () => {
    const id = hold();
    const res = approveAs(w.A, id);
    const version = peerHoldsDb.get(id)!.hold_version;
    if ('dropMode' in overrides) getConnection().prepare('DELETE FROM session_permission_modes WHERE session_id = ?').run(w.a1);
    await dispatcher({ version: 'version' in overrides ? overrides.version : '2.1.312',
      noTranscript: 'noTranscript' in overrides }).tick();
    const msg = peerMessagesDb.get(res.messageId!)!;
    assert.equal(msg.cause, cause);
    assert.ok(['refused', 'failed'].includes(msg.state));
    const h = peerHoldsDb.get(id)!;
    assert.deepEqual([h.state, h.cause, h.decided_by, h.message_id, h.hold_version], ['held', cause, null, null, version + 1]);
    assert.equal(turns, 0);
  });
}

test('§4: approve with a stale expectedTargetMode ⇒ 409 target_mode_changed; reject validates its reason', () => {
  const id = hold();
  const stale = approvePeerHold({ holdId: id, caller: caller(w.A), expectedHoldVersion: 1,
    expectedTextHash: peerHoldsDb.get(id)!.body_sha256, expectedTargetMode: 'acceptEdits' });
  assert.deepEqual([stale.status, stale.code], [409, 'target_mode_changed']);
  assert.equal(rejectPeerHold({ holdId: id, caller: caller(w.A), expectedHoldVersion: 1, reason: 'x'.repeat(201) }).status, 400);
  assert.equal(rejectPeerHold({ holdId: id, caller: caller(w.A), expectedHoldVersion: 1 }).status, 200);
  assert.equal(rejectPeerHold({ holdId: id, caller: caller(w.A), expectedHoldVersion: 2 }).status, 409);
});

test('§4: a held row past 72 h expires on the sweep; an unexpired one stays', () => {
  const a = hold();
  const b = hold();
  getConnection().prepare('UPDATE peer_holds SET expires_at = ? WHERE id = ?').run(Date.now() - 1, a);
  sweepPeerHolds();
  assert.equal(peerHoldsDb.get(a)!.state, 'expired');
  assert.equal(peerHoldsDb.get(b)!.state, 'held');
});

test('م-4: a relay-turn prompt answer is recorded with the member, the credential kind and ownership; no text', () => {
  recordPeerPromptDecision({ sessionId: w.a1, requestId: 'req-1', toolName: 'Write', allowed: true, allow: true,
    requesterUserId: w.A, requesterAuthKind: 'session', ownerUserId: w.A });
  const row = getConnection().prepare("SELECT user_id, metadata FROM audit_log WHERE action = 'peer_relay_prompt_decided' ORDER BY id DESC LIMIT 1")
    .get() as { user_id: number; metadata: string };
  assert.equal(row.user_id, w.A);
  assert.deepEqual(JSON.parse(row.metadata), { sessionId: w.a1, requestId: 'req-1', toolName: 'Write', admitted: true, allow: true,
    requesterAuthKind: 'session', requesterIsOwner: true });
});

test('م-4: the message view carries deliveryPath (resume once claimed)', async () => {
  const id = hold();
  const res = approveAs(w.A, id);
  assert.equal(listPeerMessageViews(w.a1).find((m) => m.id === res.messageId)!.deliveryPath, null);
  peerMessagesDb.claim(res.messageId!, Date.now(), 0);
  assert.equal(listPeerMessageViews(w.a1).find((m) => m.id === res.messageId)!.deliveryPath, 'resume');
});

test('intake policy: same user unchanged; cross-member holds only when modes match; platform/null owner refused', () => {
  const base = { senderUserId: 2, senderMode: 'prompting' as const, targetUserId: 2, targetMode: 'prompting' as const,
    senderCanWriteTarget: true, platform: false };
  assert.deepEqual(decideIntake(base), { kind: 'queue' });
  assert.deepEqual(decideIntake({ ...base, targetUserId: 1 }), { kind: 'hold', causes: 'cross_member' });
  assert.deepEqual(decideIntake({ ...base, targetUserId: 1, targetMode: 'bypass' }), { kind: 'refuse', cause: 'mode_mismatch' });
  assert.deepEqual(decideIntake({ ...base, targetUserId: 1, targetMode: null }), { kind: 'refuse', cause: 'mode_unknown' });
  assert.deepEqual(decideIntake({ ...base, targetUserId: 1, platform: true }), { kind: 'refuse', cause: 'cross_user' });
  assert.deepEqual(decideIntake({ ...base, targetUserId: null }), { kind: 'refuse', cause: 'owner_unknown' });
  assert.deepEqual(decideIntake({ ...base, senderCanWriteTarget: false }), { kind: 'refuse', cause: 'unwritable' });
  assert.deepEqual(decideIntake({ ...base, targetMode: 'bypass' }), { kind: 'refuse', cause: 'mode_mismatch' });
});

test('visible body: every Cf, line/paragraph separator and C0 control becomes a token; newline and tab stay', () => {
  assert.equal(visibleBody('a‮b​c⁦d e\u0007f\n\tg'),
    'a⟨U+202E⟩b⟨U+200B⟩c⟨U+2066⟩d⟨U+2028⟩e⟨U+0007⟩f\n\tg');
});

test('ش-1: one shared allowlist; the fence routes and every P2 write route use it', async () => {
  assert.deepEqual([...VERIFIED_ACTOR_KINDS].sort(), ['device_session', 'session']);
  for (const kind of ['ck', 'verified_proxy', 'internal_service', 'platform_unverified', 'password_change', '', undefined]) {
    assert.equal(isVerifiedActorKind(kind), false, String(kind));
  }
  const root = path.resolve(import.meta.dirname, '../../../..');
  const fence = fs.readFileSync(path.join(root, 'server/modules/providers/session-permission-fence.routes.ts'), 'utf8');
  assert.match(fence, /from '@\/shared\/verified-actor-kinds\.js'/u);
  assert.doesNotMatch(fence, /new Set\(\['session', 'device_session'\]\)/u, 'no local copy remains');
  const router = createPeerHoldsRouter({ canReadSession: () => true, isPlatform: () => false });
  const writes = (router.stack as any[]).filter((l) => l.route && Object.keys(l.route.methods).some((m) => m !== 'get'));
  assert.ok(writes.length >= 2);
  for (const layer of writes) {
    const handlers = (layer.route.stack as any[]).map((s) => s.handle);
    assert.ok(handlers.includes(PEER_HOLD_WRITE_GUARD), `${layer.route.path} must run the shared guard`);
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: w.A, authenticationKind: 'ck' }; next(); });
  app.use('/api/peer-relay', router);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => srv.once('listening', r));
  const port = (srv.address() as any).port;
  for (const layer of writes) {
    const url = `http://127.0.0.1:${port}/api/peer-relay${String(layer.route.path).replace(':holdId', 'ph_x')}`;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403, url);
    assert.equal(((await res.json()) as any).code, 'interactive_credential_required');
  }
  srv.close();
});

test('test seams: refused under production, outside /var/tmp/peer-p2-*, or on the operator database', () => {
  const run = fs.mkdtempSync('/var/tmp/peer-p2-');
  try {
    const ok = { NASSAJ_PEER_RELAY_TEST_SEAMS: '1', DATABASE_PATH: path.join(run, 'db.sqlite') };
    assert.equal(assertPeerRelayTestSeamsAllowed(ok), true);
    assert.equal(assertPeerRelayTestSeamsAllowed({ DATABASE_PATH: '/x' }), false, 'off unless asked');
    assert.throws(() => assertPeerRelayTestSeamsAllowed({ ...ok, NODE_ENV: 'production' }), /refused/u);
    assert.throws(() => assertPeerRelayTestSeamsAllowed({ ...ok, DATABASE_PATH: '/var/tmp/db.sqlite' }), /refused/u);
    assert.throws(() => assertPeerRelayTestSeamsAllowed({ ...ok, DATABASE_PATH: undefined }), /refused/u);
    assert.throws(() => assertPeerRelayTestSeamsAllowed({ ...ok, NASSAJ_LIVE_DATABASE_PATH: ok.DATABASE_PATH }), /refused/u);
    const elsewhere = fs.mkdtempSync('/var/tmp/p2-elsewhere-');
    fs.writeFileSync(path.join(elsewhere, 'operator.sqlite'), '');
    fs.symlinkSync(path.join(elsewhere, 'operator.sqlite'), path.join(run, 'evil.sqlite'));
    assert.throws(() => assertPeerRelayTestSeamsAllowed({ ...ok, DATABASE_PATH: path.join(run, 'evil.sqlite') }), /refused/u,
      'a symlink out of the run dir is resolved and refused');
    fs.rmSync(elsewhere, { recursive: true, force: true });
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
  }
});
