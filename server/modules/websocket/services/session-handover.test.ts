/**
 * The declared-handover gate (qa C1/C2): every acceptance condition, each
 * hijack attempt, and the single-use / idempotent-repeat rule.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  createSessionHandoverGate,
  type SessionHandoverGateInput,
} from '@/modules/websocket/services/session-handover.js';

const FROM = 'agy_1790531982349_26187fb5';
const TO = 'e70cd70d-8a4f-4694-9304-37f6e440249e';
const PROJECT = '/var/tmp/handover-gate-project';
const RULES = Object.freeze({
  antigravity: { spawnKey: /^agy_\d+_[a-z0-9]+$/, durableId: /^[0-9a-f-]{36}$/ },
});

type Harness = {
  gate: ReturnType<typeof createSessionHandoverGate>;
  brainDir: string;
  ledgerCalls: number;
  rebindCalls: number;
};

function harness(overrides: Partial<SessionHandoverGateInput> = {}, rowOverride: Record<string, unknown> = {}): Harness {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'handover-gate-'));
  const brainDir = path.join(home, 'brain');
  const h = { brainDir, ledgerCalls: 0, rebindCalls: 0 } as Harness;
  const launchStartedAtMs = Date.now();
  fs.mkdirSync(path.join(brainDir, TO), { recursive: true });
  h.gate = createSessionHandoverGate({
    provider: 'antigravity',
    isolation: 'legacy_shared',
    logicalProjectPath: PROJECT,
    launchKey: 'launch-1',
    principalId: 7,
    principalUserId: 7,
    launchStartedAtMs: launchStartedAtMs - 1000,
    boundSessionId: () => FROM,
    rules: RULES,
    brainDirForUser: () => brainDir,
    rekeyLedger: (ledger) => {
      h.ledgerCalls += 1;
      ledger.verifyTarget({
        provider: 'antigravity',
        project_path: PROJECT,
        jsonl_path: path.join(brainDir, TO, '.system_generated', 'logs', 'transcript.jsonl'),
        ...rowOverride,
      } as never);
    },
    ...overrides,
  });
  return h;
}

test('a well-formed handover from the bound spawn key is accepted once', () => {
  const h = harness();
  assert.deepEqual(h.gate.request({ from: FROM, to: TO }), { accepted: true, reason: 'accepted' });
  assert.equal(h.ledgerCalls, 1);
  assert.deepEqual(h.gate.accepted(), { from: FROM, to: TO, generation: null, forwarded: false });
  // An identical repeat (a replayed request after reconnect) is idempotent.
  assert.deepEqual(h.gate.request({ from: FROM, to: TO }), { accepted: true, reason: 'idempotent_repeat' });
  assert.equal(h.ledgerCalls, 1, 'no second write');
  // Any other second handover is refused.
  assert.equal(h.gate.request({ from: FROM, to: '11111111-2222-4333-8444-555555555555' }).accepted, false);
  assert.equal(h.gate.request({ from: TO, to: FROM }).accepted, false);
});

test('no supersede: a missing or malformed request is refused', () => {
  for (const request of [{}, { from: FROM }, { to: TO }, { from: 1, to: 2 }]) {
    const h = harness();
    assert.equal(h.gate.request(request as never).accepted, false);
    assert.equal(h.ledgerCalls, 0);
  }
});

test('foreign `from`: not the bound id, or not a spawn key', () => {
  const notBound = harness();
  assert.equal(notBound.gate.request({ from: 'agy_1_zzz', to: TO }).reason, 'source_not_bound_spawn_key');
  const durableBound = harness({ boundSessionId: () => TO });
  assert.equal(durableBound.gate.request({ from: TO, to: TO }).accepted, false);
  const unbound = harness({ boundSessionId: () => null });
  assert.equal(unbound.gate.request({ from: FROM, to: TO }).accepted, false);
});

test('the target must be a brain id: no path segments, no self-handover', () => {
  for (const to of ['../../etc', `${TO}/x`, FROM, 'E70CD70D-8A4F-4694-9304-37F6E440249E']) {
    const h = harness();
    assert.equal(h.gate.request({ from: FROM, to }).accepted, false, to);
    assert.equal(h.ledgerCalls, 0, to);
  }
});

test('non-agy provider is not on the allow-list', () => {
  const h = harness({ provider: 'claude' });
  assert.equal(h.gate.request({ from: FROM, to: TO }).reason, 'provider_not_allowed');
});

test('a refused handover cannot be retried in the same launch', () => {
  let fail = true;
  const h = harness({
    rekeyLedger: () => { if (fail) throw new Error('target already has a workspace binding'); },
  });
  assert.equal(h.gate.request({ from: FROM, to: TO }).accepted, false);
  fail = false;
  assert.equal(h.gate.request({ from: FROM, to: TO }).reason, 'handover_already_refused');
});

test('C2: a transcript outside THIS user brain dir is refused', () => {
  const h = harness({}, { jsonl_path: `/home/dev/.gemini/antigravity-cli/brain/${TO}/t.jsonl` });
  assert.match(h.gate.request({ from: FROM, to: TO }).reason, /outside this user brain dir/);
  const sibling = harness({}, { jsonl_path: '/var/tmp/brain-evil/x.jsonl' });
  assert.equal(sibling.gate.request({ from: FROM, to: TO }).accepted, false);
});

test('C2: a brain born before the spawn started (out-of-process, pre-existing) is refused', () => {
  const h = harness({ launchStartedAtMs: Date.now() + 60_000 });
  assert.match(h.gate.request({ from: FROM, to: TO }).reason, /predates this launch/);
  // The provider's own spawn clock can only tighten the bound, never loosen it.
  const claimedEarly = harness({ launchStartedAtMs: Date.now() + 60_000 });
  assert.equal(claimedEarly.gate.request({ from: FROM, to: TO, spawnStartedAtMs: 0 }).accepted, false);
  const claimedLate = harness();
  assert.equal(claimedLate.gate.request({ from: FROM, to: TO, spawnStartedAtMs: Date.now() + 60_000 }).accepted,
    true, 'a future claim is clamped to now');
});

test('C2: a symlinked or missing brain dir is refused', () => {
  const h = harness();
  const real = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'handover-foreign-brain-'));
  fs.rmSync(path.join(h.brainDir, TO), { recursive: true });
  fs.symlinkSync(real, path.join(h.brainDir, TO), 'dir');
  assert.match(h.gate.request({ from: FROM, to: TO }).reason, /not a plain directory/);
  const missing = harness();
  fs.rmSync(path.join(missing.brainDir, TO), { recursive: true });
  assert.equal(missing.gate.request({ from: FROM, to: TO }).accepted, false);
});

test('overlay launches rebind the workspace and commit the ledger inside it', () => {
  const order: string[] = [];
  const h = harness({
    isolation: 'overlay',
    rebindWorkspace: (input) => {
      order.push('rebind');
      input.commitLedger();
      order.push('rebind-done');
      return { generation: 'gen-1' };
    },
    rekeyLedger: () => { order.push('ledger'); },
  });
  assert.equal(h.gate.request({ from: FROM, to: TO }).accepted, true);
  assert.deepEqual(order, ['rebind', 'ledger', 'rebind-done']);
  assert.equal(h.gate.accepted()?.generation, 'gen-1');
});

test('overlay launches without a rebind seam or launch key fail closed', () => {
  assert.equal(harness({ isolation: 'overlay' }).gate.request({ from: FROM, to: TO }).accepted, false);
  const noKey = harness({ isolation: 'overlay', launchKey: null, rebindWorkspace: () => ({ generation: null }) });
  assert.equal(noKey.gate.request({ from: FROM, to: TO }).accepted, false);
});
