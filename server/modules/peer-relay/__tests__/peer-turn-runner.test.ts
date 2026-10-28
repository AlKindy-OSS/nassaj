/**
 * ADR-219 S1 delivery path — the resume turn goes through the normal provider
 * dispatch under the sanctioned internal-service principal (scheduled-message
 * pattern), the target owner's own identity and the target session's mode.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { PeerMessageRow } from '@/modules/database/index.js';

import { createPeerDeliveryTurn, PEER_DELIVERY_TURN, readPeerDeliveryTurn } from '../peer-run.js';
import { createPeerTurnRunner, type PeerTurnRunnerDependencies } from '../peer-turn-runner.js';

type Writer = { send(payload: unknown): void };
const row = { id: 'pm_x', to_user_id: 7, to_session_id: 'sess-b', attempts: 1, updated_at: 123 } as PeerMessageRow;
const user = { id: 7, role: 'user', authorization_generation: 3, status: 'active' };

function deps(overrides: Partial<PeerTurnRunnerDependencies<Writer>> = {}) {
  const calls: Array<{ data: Record<string, any>; userId: number; principal: Record<string, unknown> }> = [];
  const base: PeerTurnRunnerDependencies<Writer> = {
    getUser: () => user,
    getSession: () => ({ project_path: '/var/tmp/proj', provider: 'claude' }),
    createWriter: () => ({ send: () => undefined }),
    dispatchProviderCommand: async (_type, data, writer, userId, principal) => {
      calls.push({ data, userId, principal: principal as Record<string, unknown> });
      const turn = readPeerDeliveryTurn(data.options);
      if (turn) turn.consumed = true;
      writer.send({ kind: 'complete', success: true });
    },
    acquireWriterLease: async () => ({ release: () => undefined }),
    runOutsideWriterContext: (fn) => fn(),
    isUnsupportedPath: () => false,
    abortSession: () => undefined,
    ...overrides,
  };
  return { base, calls };
}

const newTurn = () => createPeerDeliveryTurn({ peerMessageId: row.id, chainId: 'pc', hop: 1, ref: 'REF', fromMode: 'prompting', wrapped: 'W', onResult: () => undefined });

test('dispatches as the target owner with an internal_service principal bound to the row', async () => {
  const { base, calls } = deps();
  const outcome = await createPeerTurnRunner(base)(row, newTurn(), 'bypassPermissions');
  assert.deepEqual(outcome, { started: true, code: null, permanent: false });
  const [call] = calls;
  assert.equal(call!.userId, 7);
  assert.equal(call!.principal.authenticationKind, 'internal_service');
  assert.equal(call!.principal.authenticationCredentialId, 'peer-message:pm_x');
  assert.equal(call!.principal.authorizationGeneration, 3);
  assert.equal(call!.data.command, 'W');
  assert.equal(call!.data.options.sessionId, 'sess-b', 'a resume turn of the target');
  assert.equal(call!.data.options.permissionMode, 'bypassPermissions', 'the gate\'s single mode read');
  assert.equal(call!.data.options.clientMsgId, 'peer:pm_x:123', 'unique per claim');
  assert.ok(call!.data.options[PEER_DELIVERY_TURN], 'the descriptor rides under the Symbol key');
  assert.equal(JSON.parse(JSON.stringify(call!.data.options))[String(PEER_DELIVERY_TURN)], undefined);
});

test('refuses before dispatch: unsupported path, inactive owner, missing session (all permanent)', async () => {
  for (const [overrides, code] of [
    [{ isUnsupportedPath: () => true }, 'unsupported_dispatch_path'],
    [{ getUser: () => ({ ...user, status: 'disabled' }) }, 'target_owner_inactive'],
    [{ getSession: () => null }, 'session_unavailable'],
  ] as const) {
    const { base, calls } = deps(overrides as Partial<PeerTurnRunnerDependencies<Writer>>);
    assert.deepEqual(await createPeerTurnRunner(base)(row, newTurn(), 'bypassPermissions'), { started: false, code, permanent: true });
    assert.equal(calls.length, 0);
  }
});

test('update maintenance and a not-consumed turn are retryable not-started outcomes', async () => {
  const closed = deps({ acquireWriterLease: async () => { throw new Error('update_maintenance_active'); } });
  assert.deepEqual(await createPeerTurnRunner(closed.base)(row, newTurn(), 'bypassPermissions'),
    { started: false, code: 'update_maintenance_active', permanent: false });
  const busy = deps({ dispatchProviderCommand: async (_t, _d, writer) => {
    writer.send({ kind: 'error', code: 'session_busy', notStarted: true });
  } });
  assert.deepEqual(await createPeerTurnRunner(busy.base)(row, newTurn(), 'bypassPermissions'), { started: false, code: 'session_busy', permanent: false });
});

test('qa م-6: the wall-clock cap stops the turn; qa م-3: peer_delivery_unavailable is permanent', async () => {
  const aborted: string[] = [];
  const slow = deps({ maxTurnMs: 20, abortSession: (sid) => { aborted.push(sid); },
    dispatchProviderCommand: async (_t, data) => {
      const turn = readPeerDeliveryTurn(data.options);
      if (turn) turn.consumed = true;
      await new Promise((resolve) => setTimeout(resolve, 60));
    } });
  const outcome = await createPeerTurnRunner(slow.base)(row, newTurn(), 'default');
  assert.deepEqual(aborted, ['sess-b']);
  assert.deepEqual(outcome, { started: true, code: 'wall_clock_cap', permanent: false });
  const native = deps({ dispatchProviderCommand: async (_t, _d, writer) => {
    writer.send({ kind: 'complete', code: 'peer_delivery_unavailable', notStarted: true });
  } });
  assert.deepEqual(await createPeerTurnRunner(native.base)(row, newTurn(), 'default'),
    { started: false, code: 'peer_delivery_unavailable', permanent: true });
});

test('coordinator 3c: every frame of the delivery carries the server marker; the proof ref is stripped', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const marked = deps({ createWriter: () => ({ send: (p: unknown) => { seen.push(p as Record<string, unknown>); } }),
    dispatchProviderCommand: async (_t, data, writer) => {
      const turn = readPeerDeliveryTurn(data.options);
      if (turn) turn.consumed = true;
      writer.send({ kind: 'text', role: 'assistant', content: 'PELICAN', peerProofRef: 'REF' });
      writer.send({ type: 'session-agents' });
      writer.send({ kind: 'complete', success: true });
    } });
  await createPeerTurnRunner(marked.base)(row, newTurn(), 'bypassPermissions');
  assert.deepEqual(seen.map((f) => f.peerDeliveryId ?? null), ['pm_x', null, 'pm_x']);
  assert.equal(seen[0]!.peerProofRef, undefined);
});
