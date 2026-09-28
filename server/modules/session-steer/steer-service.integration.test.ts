/**
 * T-1903 admission matrix against a real database: ordered fail-closed checks,
 * policy + consent, persistence of the injection (sender-bound uuid, full text),
 * audit, limits, policy/consent storage and migration reversibility.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import {
  appConfigDb, closeConnection, getConnection, initializeDatabase, messageCoordinationDb,
  reverseSessionSteerIngress, uiPreferencesDb,
} from '@/modules/database/index.js';

import { createSteerRun, type SteerRun } from './steer-run.js';
import { registerMidTurnInjection, __resetMidTurnInjectionForTests } from './steer-registry.js';
import { __recordSteerRateForTests, __resetSteerRateLimitForTests, __steerRateKeysForTests, handleSessionSteer } from './steer-service.js';
import { getSteerConsent, getSteerPolicy, setSteerConsent, setSteerPolicy } from './steer-policy.js';

const TURN = '51111111-2222-4333-8444-555555555555';
const SID = 'steer-session-1';
let dir = '';
let run: SteerRun;
let mode = 'bypassPermissions';
let armed = true;
let now = 1_000_000;
const writers = new Set([1, 2]);

function ctx(senderUserId: number | null) {
  return {
    senderUserId,
    isWritable: (_s: string, user: number) => writers.has(user),
    getSessionProvider: (s: string) => (s === 'codex-session' ? 'codex' : 'claude'),
    getDisplayName: (user: number) => (user === 2 ? 'bob' : 'carol'),
    now: () => now,
  };
}

const req = (n: number, extra: Record<string, unknown> = {}) => ({
  type: 'session-steer', sessionId: SID, turnId: TURN, clientMsgId: `steer-${n}`, text: `please also check ${n}`, ...extra,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP || tmpdir(), 'steer-svc-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  const db = getConnection();
  for (const [id, name] of [[1, 'alice'], [2, 'bob'], [3, 'carol']] as const) {
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'h', 'user')").run(id, name);
  }
  mode = 'bypassPermissions'; armed = true; now = 1_000_000;
  __resetSteerRateLimitForTests();
  __resetMidTurnInjectionForTests();
  run = createSteerRun({
    sessionId: () => SID, turnId: TURN, starterUserId: 1, permissionMode: () => mode, hooksArmed: () => armed,
    broadcast: () => {}, persistStatus: (item, status) => { messageCoordinationDb.updateSteerStatus(item.clientMsgId, item.senderUserId, status); },
    confirmDelivery: async () => true,
  });
  registerMidTurnInjection('claude', { findRun: s => (s === SID ? run : null), payloadHash: w => createHash('sha256').update(w).digest('hex') });
  setSteerConsent(1, { allowSteerOnMyRuns: true });
});

afterEach(async () => {
  closeConnection();
  await rm(dir, { recursive: true, force: true });
});

const code = (r: ReturnType<typeof handleSessionSteer>) => (r.ok ? `ok:${r.status}` : `${r.code}:${r.status}`);

test('permission matrix: every refusal in the approved order, each fail-closed', () => {
  assert.equal(code(handleSessionSteer({ ...req(1), turnId: 'x' }, ctx(2))), 'invalid_request:400');
  assert.equal(code(handleSessionSteer(req(1), ctx(null))), 'invalid_request:400');
  assert.equal(code(handleSessionSteer(req(1), ctx(3))), 'not_writable:403');
  assert.equal(code(handleSessionSteer(req(1, { sessionId: 'codex-session' }), ctx(2))), 'steer_unsupported:409');
  assert.equal(code(handleSessionSteer(req(1, { sessionId: 'no-run' }), ctx(2))), 'turn_not_active:409');
  assert.equal(code(handleSessionSteer(req(1), ctx(1))), 'steer_self:409', 'the starter cannot steer his own turn');
  mode = 'plan';
  assert.equal(code(handleSessionSteer(req(1), ctx(2))), 'plan_mode:409');
  mode = 'default'; armed = false;
  assert.equal(code(handleSessionSteer(req(1), ctx(2))), 'steer_unavailable:409', 'no-hook run');
  armed = true;
  setSteerPolicy({ mode: 'off' }, 1);
  assert.equal(code(handleSessionSteer(req(1), ctx(2))), 'steer_disabled:403');
  setSteerPolicy({ mode: 'per_user' }, 1);
  setSteerConsent(1, { allowSteerOnMyRuns: false });
  assert.equal(code(handleSessionSteer(req(1), ctx(2))), 'steer_not_consented:403', 'consent read at injection time');
  setSteerConsent(1, { allowSteerOnMyRuns: true });
  assert.equal(code(handleSessionSteer(req(1, { turnId: '61111111-2222-4333-8444-555555555555' }), ctx(2))), 'turn_not_active:409');
  assert.equal(code(handleSessionSteer(req(1, { text: '\u0000 ' }), ctx(2))), 'text_empty:400');
  assert.equal(code(handleSessionSteer(req(1, { text: 'y'.repeat(4001) }), ctx(2))), 'text_too_long:413');
  assert.equal(run.everInjected(), false, 'no refusal touched the run');
});

test('admitted steer: 202, sender-bound ingress row with full text, audit, duplicate refused', () => {
  const result = handleSessionSteer(req(7), ctx(2));
  assert.deepEqual([result.ok, result.status, result.deliveryStatus], [true, 202, 'queued']);
  const [row] = messageCoordinationDb.listSteerBySession(SID);
  assert.equal(row.userId, 2);
  assert.equal(row.text, 'please also check 7');
  assert.equal(row.turnId, TURN);
  assert.equal(row.deliveryStatus, 'queued');
  assert.match(row.uuid, /^[0-9a-f-]{36}$/u);
  const stored = getConnection().prepare('SELECT delivery_kind, provider, coordination_level FROM message_coordination_ingress WHERE client_msg_id = ?').get('steer-7');
  assert.deepEqual(stored, { delivery_kind: 'steer', provider: 'claude', coordination_level: 'direct' });
  assert.equal(messageCoordinationDb.listBySession(SID).length, 0, 'steer rows never reach the message coordination stamp');
  assert.equal(messageCoordinationDb.readClaudeIdentities(2, SID).length, 0, 'nor the outbox receipt projection');
  const audit = getConnection().prepare("SELECT user_id, metadata FROM audit_log WHERE action = 'session_steer_injection'").all() as Array<{ user_id: number; metadata: string }>;
  const meta = JSON.parse(audit.at(-1)!.metadata);
  assert.deepEqual([audit.at(-1)!.user_id, meta.starterUserId, meta.turnId, meta.permissionMode, meta.result], [2, 1, TURN, 'bypassPermissions', 'queued']);
  assert.equal(code(handleSessionSteer(req(7), ctx(2))), 'duplicate:409');
  const results = (getConnection().prepare("SELECT metadata FROM audit_log WHERE action = 'session_steer_injection'").all() as Array<{ metadata: string }>)
    .map(row => JSON.parse(row.metadata).result);
  assert.deepEqual(results, ['queued', 'duplicate'], 'one consistent record per request');
});

test('rate window counts persisted injections only; key map evicts stale keys, never live ones', async () => {
  assert.equal(code(handleSessionSteer(req(1), ctx(2))), 'ok:202');
  for (let i = 0; i < 6; i++) assert.equal(code(handleSessionSteer(req(1), ctx(2))), 'duplicate:409');
  await run.take();
  assert.equal(code(handleSessionSteer(req(2), ctx(2))), 'ok:202', 'duplicates did not consume the window');
  __resetSteerRateLimitForTests();
  __recordSteerRateForTests('live', now);
  for (let k = 0; k < 9_999; k++) __recordSteerRateForTests(`stale-${k}`, now - 120_000);
  __recordSteerRateForTests('fresh', now);
  assert.equal(__steerRateKeysForTests(), 2, 'at the cap every stale key went, the live ones stayed');
  __resetSteerRateLimitForTests();
  for (let k = 0; k < 10_001; k++) __recordSteerRateForTests(`live-${k}`, now);
  assert.equal(__steerRateKeysForTests(), 10_000, 'all live: bounded by dropping the oldest');
});

test('limits: queue ≤3 → 429 queue_full; 5/min per sender per session → 429 rate_limited', async () => {
  for (let i = 0; i < 3; i++) assert.equal(code(handleSessionSteer(req(i), ctx(2))), 'ok:202');
  assert.equal(code(handleSessionSteer(req(3), ctx(2))), 'steer_queue_full:429');
  await run.take(); await run.take(); await run.take();
  assert.equal(code(handleSessionSteer(req(4), ctx(2))), 'ok:202');
  await run.take();
  assert.equal(code(handleSessionSteer(req(5), ctx(2))), 'ok:202');
  await run.take();
  assert.equal(code(handleSessionSteer(req(6), ctx(2))), 'steer_rate_limited:429');
  now += 61_000;
  assert.equal(code(handleSessionSteer(req(6), ctx(2))), 'ok:202');
});

test('closed input or abort: later injections refused; abort marks queued rows rejected', () => {
  assert.equal(code(handleSessionSteer(req(1), ctx(2))), 'ok:202');
  run.close('turn_aborted');
  assert.equal(messageCoordinationDb.listSteerBySession(SID)[0].deliveryStatus, 'rejected');
  assert.equal(code(handleSessionSteer(req(2), ctx(2))), 'turn_not_active:409');
});

test('policy/consent storage: defaults, corruption fails closed, generic UI prefs cannot grant consent', () => {
  appConfigDb.set('session_steer_policy', '');
  assert.deepEqual(getSteerPolicy(), { mode: 'per_user' });
  appConfigDb.set('session_steer_policy', '{"mode":"everyone"}');
  assert.deepEqual(getSteerPolicy(), { mode: 'off' });
  assert.equal(setSteerPolicy({ mode: 'on' }, 1).ok, false);
  assert.equal(setSteerPolicy({ mode: 'off', extra: 1 }, 1).ok, false);
  assert.equal(getSteerConsent(3), false, 'missing consent is false');
  uiPreferencesDb.updateUiPreferences(3, { collab: { allowSteerOnMyRuns: true, other: 1 } });
  assert.equal(getSteerConsent(3), false, 'generic PUT cannot write consent');
  assert.deepEqual(uiPreferencesDb.getUiPreferences(3).collab, { other: 1 });
  assert.equal(setSteerConsent(3, { allowSteerOnMyRuns: 'yes' }).ok, false);
  assert.equal(setSteerConsent(3, { allowSteerOnMyRuns: true, x: 1 }).ok, false);
  setSteerConsent(3, { allowSteerOnMyRuns: true });
  uiPreferencesDb.updateUiPreferences(3, { collab: { allowSteerOnMyRuns: false } });
  assert.equal(getSteerConsent(3), true, 'generic PUT cannot revoke it either');
  const corrupt = uiPreferencesDb.getUiPreferences(3);
  getConnection().prepare('UPDATE user_ui_preferences SET preferences_json = ? WHERE user_id = 3')
    .run(JSON.stringify({ ...corrupt, collab: { allowSteerOnMyRuns: 'true' } }));
  assert.equal(getSteerConsent(3), false, 'non-boolean consent is false');
});

test('migration: reverse refuses while steer rows exist, then drops the columns', () => {
  assert.equal(code(handleSessionSteer(req(1), ctx(2))), 'ok:202');
  const db = getConnection();
  assert.throws(() => reverseSessionSteerIngress(db), /refuses/u);
  db.prepare("DELETE FROM message_coordination_ingress WHERE delivery_kind = 'steer'").run();
  reverseSessionSteerIngress(db);
  const columns = (db.prepare('PRAGMA table_info(message_coordination_ingress)').all() as Array<{ name: string }>).map(c => c.name);
  assert.ok(!columns.includes('delivery_kind') && !columns.includes('turn_id') && !columns.includes('delivery_status'));
});
