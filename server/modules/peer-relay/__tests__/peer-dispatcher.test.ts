/**
 * ADR-219 tests 8, 11, 14 — the dispatcher over the REAL repository, the REAL
 * shared delivery ledger (kind `peer`) and the REAL pinned transcript proof scan.
 * The CLI is simulated by appending exactly the row shape CLI 2.1.306 wrote for
 * an isSynthetic message (fixtures/peer-relay.real.json).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import { getConnection, peerMessagesDb } from '@/modules/database/index.js';
import { ledgerHasDelivery, readLedger } from '@/modules/workflow-supervisor/index.js';

import { createPeerDispatcher, type PeerTurnOutcome } from '../peer-dispatcher.js';
import { enqueuePeerMessage, resetPeerRelayForTests } from '../peer-relay.service.js';
import { buildPeerDispatcherDependencies } from '../peer-relay.runtime.js';
import { createPeerRunState, type PeerDeliveryTurn } from '../peer-run.js';
import { NON_USER_SOURCE_PREFIX } from '../peer-wire.js';

import { createPeerWorld, type PeerWorld } from './peer-world.test.fixture.js';

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../__fixtures__/peer-relay.real.json'), 'utf8'));

let world: PeerWorld;
before(async () => { world = await createPeerWorld(); });
after(async () => { await world.close(); });

type Turn = (turn: PeerDeliveryTurn, mode: string) => PeerTurnOutcome | Promise<PeerTurnOutcome>;
type Seams = {
  live?: boolean | (() => boolean); version?: string | null; percent?: number; ledgerUsd?: number[]; turn?: Turn;
  env?: NodeJS.ProcessEnv;
};

/**
 * The line the CLI writes for the delivered wrapper (real shape, this ref). The CLI
 * stamps the delivering turn's mode on it, which is the target's own mode.
 */
function commitSyntheticLine(turn: PeerDeliveryTurn): void {
  const line = { ...fixture.syntheticUserLine, sessionId: world.b, permissionMode: 'bypassPermissions',
    message: { role: 'user', content: NON_USER_SOURCE_PREFIX + turn.wrapped } };
  fs.appendFileSync(world.transcript(world.b), `${JSON.stringify(line)}\n`);
}

const deliveringTurn: Turn = (turn) => {
  turn.consumed = true;
  commitSyntheticLine(turn);
  turn.onResult({ subtype: 'success', totalCostUsd: 3.25, isError: false });
  return { started: true, code: null, permanent: false };
};

let turns = 0;
const modes: string[] = [];
function dispatcher(seams: Seams = {}) {
  const ledger = [...(seams.ledgerUsd ?? [])];
  const live = seams.live;
  return createPeerDispatcher(buildPeerDispatcherDependencies({
    env: seams.env ?? world.env,
    isSessionRunLive: () => (typeof live === 'function' ? live() : live ?? false),
    cliVersion: async () => (seams.version === undefined ? '2.1.306' : seams.version),
    readUsage: async () => ({ session: { utilization: seams.percent ?? 10 }, weeklyAllModels: { utilization: 5 } }),
    ledgerCostUsd: async () => (ledger.length > 0 ? ledger.shift()! : null),
    runTurn: async (_row, turn, mode) => { turns++; modes.push(mode); return (seams.turn ?? deliveringTurn)(turn, mode); },
  }));
}

function queue(): string {
  const run = createPeerRunState({ activeMemberCount: 2, userId: world.alice, sessionId: world.a, permissionMode: 'bypassPermissions' });
  const outcome = enqueuePeerMessage({ run, senderSessionId: world.a, senderAgentId: null, targetSessionId: world.b,
    message: 'run the suite', summary: null, hop: 1, notifyWhenIdle: false });
  assert.equal(outcome.status, 'queued', outcome.text);
  return outcome.id!;
}

beforeEach(() => {
  getConnection().prepare('DELETE FROM peer_messages').run();
  getConnection().prepare('DELETE FROM peer_session_cost_totals').run();
  fs.writeFileSync(world.transcript(world.b), `${JSON.stringify({ type: 'user', permissionMode: 'default', message: { role: 'user', content: 'hi' } })}\n`);
  fs.rmSync(path.join(world.root, 'supervisor'), { recursive: true, force: true });
  resetPeerRelayForTests({ canWriteSession: () => true });
  peerMessagesDb.setSessionMode(world.b, world.alice, 'bypassPermissions', Date.now());
  turns = 0;
  modes.length = 0;
});

/** A later spawn of the target recorded another effective mode. */
function setTargetMode(mode: string): void {
  peerMessagesDb.setSessionMode(world.b, world.alice, mode, Date.now());
}

test('delivered once: proof in the transcript ⇒ ledger (kind peer) ⇒ delivered; charge = total delta', async () => {
  const id = queue();
  peerMessagesDb.setCostTotal(world.b, 3.0, Date.now());
  await dispatcher().tick();
  const row = peerMessagesDb.get(id)!;
  assert.equal(row.state, 'delivered');
  assert.equal(row.delivery_path, 'resume');
  assert.ok(Math.abs((row.cost_usd_charged ?? -1) - 0.25) < 1e-9, String(row.cost_usd_charged));
  assert.equal(ledgerHasDelivery(readLedger(world.env, world.b), 'peer', id), true);
  assert.equal(ledgerHasDelivery(readLedger(world.env, world.b), 'handoff', id), false, 'kinds never collide');
  await dispatcher().tick();
  assert.equal(turns, 1, 'a delivered row is never claimed again');
});

test('test 8: crash between the turn commit and the ledger write ⇒ restart repairs, never re-runs', async () => {
  const id = queue();
  const row = peerMessagesDb.get(id)!;
  assert.equal(peerMessagesDb.claim(id, Date.now(), fs.statSync(world.transcript(world.b)).size), true); // claimed…
  commitSyntheticLine({ wrapped: (await wrapperOf(row)), ref: row.ref_token } as PeerDeliveryTurn); // …the CLI committed…
  // …and the process died. A new process boots:
  const restarted = dispatcher();
  assert.equal(restarted.repairOnBoot(), 1);
  await restarted.tick();
  assert.equal(peerMessagesDb.get(id)!.state, 'delivered');
  assert.equal(peerMessagesDb.get(id)!.cause, 'repaired');
  assert.equal(turns, 0, 'the turn is never run twice');
});

test('test 8: ref in assistant text or a tool result is NOT proof ⇒ requeued and delivered exactly once', async () => {
  const id = queue();
  const row = peerMessagesDb.get(id)!;
  peerMessagesDb.claim(id, Date.now(), fs.statSync(world.transcript(world.b)).size);
  const ref = row.ref_token;
  fs.appendFileSync(world.transcript(world.b), [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `ref="${ref}"` }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: `<nassaj-peer-message ref="${ref}">` }] } }),
    '{"type":"user","isMeta":true,"turnOrigin":"host_synthetic"', // torn line
  ].join('\n') + '\n');
  const restarted = dispatcher();
  restarted.repairOnBoot();
  assert.equal(peerMessagesDb.get(id)!.state, 'queued');
  await restarted.tick();
  assert.equal(peerMessagesDb.get(id)!.state, 'delivered');
  assert.equal(turns, 1);
});

test('test 8: ledger written but row still delivering ⇒ repaired from the ledger', async () => {
  const id = queue();
  peerMessagesDb.claim(id, Date.now(), 0);
  const deps = buildPeerDispatcherDependencies({ env: world.env, isSessionRunLive: () => false,
    cliVersion: async () => '2.1.306', readUsage: async () => ({ session: null, weeklyAllModels: null }),
    ledgerCostUsd: async () => null, runTurn: async () => ({ started: false, code: null, permanent: false }) });
  deps.ledgerCommit(world.b, peerMessagesDb.get(id)!);
  createPeerDispatcher(deps).repairOnBoot();
  assert.equal(peerMessagesDb.get(id)!.state, 'delivered');
});

test('test 14: drain — a paused dispatcher claims nothing; the next process delivers', async () => {
  const id = queue();
  const draining = dispatcher();
  draining.pause();
  await draining.tick();
  assert.equal(peerMessagesDb.get(id)!.state, 'queued');
  assert.equal(turns, 0);
  await dispatcher().tick();
  assert.equal(peerMessagesDb.get(id)!.state, 'delivered');
});

test('test 14: target quota ≥ 90 % defers (deferred_quota with a retry time), the turn never starts', async () => {
  const id = queue();
  await dispatcher({ percent: 90 }).tick();
  const row = peerMessagesDb.get(id)!;
  assert.equal(row.state, 'deferred_quota');
  assert.ok((row.next_attempt_at ?? 0) > Date.now());
  assert.equal(turns, 0);
});

test('a live target run, an unreadable CLI version: the row waits; an unverified CLI refuses it', async () => {
  const id = queue();
  await dispatcher({ live: true }).tick();
  await dispatcher({ version: null }).tick();
  assert.equal(peerMessagesDb.get(id)!.state, 'queued');
  await dispatcher({ version: '2.1.400' }).tick();
  assert.equal(peerMessagesDb.get(id)!.state, 'refused');
  assert.equal(peerMessagesDb.get(id)!.cause, 'unverified_cli');
  assert.equal(turns, 0);
});

test('test 11: a budget stop is delivered with cause budget_stop; a negative delta falls back to the cost ledger', async () => {
  const id = queue();
  peerMessagesDb.setCostTotal(world.b, 9.0, Date.now()); // baseline above the turn's total ⇒ unusable
  const budgetStop: Turn = (turn) => {
    turn.consumed = true;
    commitSyntheticLine(turn);
    turn.onResult({ subtype: fixture.budgetResult.subtype, totalCostUsd: 1.6, isError: true });
    return { started: true, code: null, permanent: false };
  };
  await dispatcher({ turn: budgetStop, ledgerUsd: [10.0, 11.25] }).tick();
  const row = peerMessagesDb.get(id)!;
  assert.equal(row.state, 'delivered');
  assert.equal(row.cause, 'budget_stop');
  assert.equal(row.cost_usd_charged, 1.25, 'negative total delta ⇒ the cost ledger delta, never a negative charge');
});

test('test 11: with no baseline the cost ledger delta is charged, clamped at ≥ 0', async () => {
  const id = queue();
  await dispatcher({ ledgerUsd: [4.0, 4.5] }).tick();
  assert.equal(peerMessagesDb.get(id)!.cost_usd_charged, 0.5);
  const id2 = queue();
  await dispatcher({ ledgerUsd: [4.5, 4.0] }).tick();
  assert.equal(peerMessagesDb.get(id2)!.cost_usd_charged, 0);
});

test('an unsupported dispatch path fails the row; a not-started turn is retried with back-off', async () => {
  const id = queue();
  await dispatcher({ turn: () => ({ started: false, code: 'unsupported_dispatch_path', permanent: true }) }).tick();
  assert.equal(peerMessagesDb.get(id)!.state, 'failed');
  const id2 = queue();
  await dispatcher({ turn: () => ({ started: false, code: 'session_busy', permanent: false }) }).tick();
  const row = peerMessagesDb.get(id2)!;
  assert.equal(row.state, 'queued');
  assert.equal(row.cause, 'session_busy');
  assert.ok((row.next_attempt_at ?? 0) > Date.now());
});

/** The wrapper the dispatcher would build for `row` (same builder, same inputs). */
async function wrapperOf(row: { from_session_id: string; from_mode: string; ref_token: string; body: string }): Promise<string> {
  const { buildPeerWrapper } = await import('../peer-wire.js');
  return buildPeerWrapper({ fromSessionId: row.from_session_id, fromName: 'Alpha', fromMode: row.from_mode,
    ref: row.ref_token, body: row.body })!;
}

test('qa ح-2: the mode is read once at the gate and is the mode the turn runs under', async () => {
  queue();
  await dispatcher().tick();
  assert.deepEqual(modes, ['bypassPermissions'], 'bypass ↔ bypass for the same user is delivered in bypass');
  const id = queue();
  setTargetMode('default'); // the target's next spawn ran in default after the send was accepted
  await dispatcher().tick();
  assert.equal(peerMessagesDb.get(id)!.state, 'refused');
  assert.equal(peerMessagesDb.get(id)!.cause, 'mode_mismatch_at_delivery');
  assert.equal(turns, 1, 'no turn for the mismatched row');
});

test('qa م-2: a human run starting during the async checks wins (no claim); session_busy spends no attempt', async () => {
  const id = queue();
  let calls = 0;
  await dispatcher({ live: () => ++calls > 1 }).tick(); // idle at the gate, live right before the claim
  assert.equal(peerMessagesDb.get(id)!.state, 'queued');
  assert.equal(peerMessagesDb.get(id)!.attempts, 0);
  assert.equal(turns, 0);
  await dispatcher({ turn: () => ({ started: false, code: 'session_busy', permanent: false }) }).tick();
  const row = peerMessagesDb.get(id)!;
  assert.equal(row.state, 'queued');
  assert.equal(row.cause, 'session_busy');
  assert.equal(row.attempts, 0, 'a busy target never counts as an attempt');
});

test('qa م-9: NASSAJ_PEER_RELAY_DELIVERY=0 claims nothing', async () => {
  const id = queue();
  await dispatcher({ env: { ...world.env, NASSAJ_PEER_RELAY_DELIVERY: '0' } }).tick();
  assert.equal(peerMessagesDb.get(id)!.state, 'queued');
  assert.equal(turns, 0);
});

test('qa م-7: the proof scan reads only what follows the claim offset', async () => {
  const id = queue();
  const row = peerMessagesDb.get(id)!;
  const wrapped = await wrapperOf(row);
  commitSyntheticLine({ wrapped, ref: row.ref_token } as PeerDeliveryTurn); // a proof BEFORE the claim (forged/stale)
  peerMessagesDb.claim(id, Date.now(), fs.statSync(world.transcript(world.b)).size);
  const restarted = dispatcher();
  restarted.repairOnBoot();
  assert.equal(peerMessagesDb.get(id)!.state, 'queued', 'a line before the offset proves nothing');
});

test('qa م-6: one row per target, at most three deliveries at once', async () => {
  for (let i = 0; i < 2; i++) queue();
  let inFlight = 0;
  let peak = 0;
  await dispatcher({ turn: async (turn) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return deliveringTurn(turn, 'bypassPermissions');
  } }).tick();
  assert.equal(turns, 1, 'the second row of the same target waits for the next pass');
  assert.equal(peak, 1);
});

test('a target whose mode record vanished is refused at delivery (mode_unknown), never guessed', async () => {
  const id = queue();
  getConnection().prepare('DELETE FROM session_permission_modes WHERE session_id = ?').run(world.b);
  await dispatcher().tick();
  assert.equal(peerMessagesDb.get(id)!.state, 'refused');
  assert.equal(peerMessagesDb.get(id)!.cause, 'mode_unknown');
  assert.equal(turns, 0);
});
