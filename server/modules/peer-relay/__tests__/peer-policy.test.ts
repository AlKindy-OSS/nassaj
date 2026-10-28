/**
 * ADR-219 S1 policy and CLI version gate — pure decisions (tests 10, 11, 13, 14).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createCliVersionReader, defaultExec, parseCliVersion } from '../peer-cli-version.js';
import {
  chargeFromTotals, decideS1Acl, effectiveHop, isThrottled, modeCategory, nextHop, quotaPercent, schedulingDenied,
} from '../peer-policy.js';

test('mode categories: bypass, auto, plan and acceptEdits are their own; default and dontAsk are prompting', () => {
  assert.equal(modeCategory('bypassPermissions'), 'bypass');
  assert.equal(modeCategory('auto'), 'auto');
  assert.equal(modeCategory('plan'), 'plan');
  assert.equal(modeCategory('acceptEdits'), 'acceptEdits');
  for (const mode of ['default', 'dontAsk', undefined, 'weird']) assert.equal(modeCategory(mode), 'prompting');
});

test('test 10: S1 ACL — only the same user in the same category is queued', () => {
  const base = { senderUserId: 1, senderMode: 'bypass', targetUserId: 1, targetMode: 'bypass', senderCanWriteTarget: true } as const;
  assert.deepEqual(decideS1Acl(base), { ok: true });
  assert.deepEqual(decideS1Acl({ ...base, targetUserId: 2 }), { ok: false, cause: 'cross_user' });
  assert.deepEqual(decideS1Acl({ ...base, targetUserId: null }), { ok: false, cause: 'cross_user' });
  assert.deepEqual(decideS1Acl({ ...base, targetMode: 'prompting' }), { ok: false, cause: 'mode_mismatch' });
  assert.deepEqual(decideS1Acl({ ...base, targetMode: null }), { ok: false, cause: 'mode_unknown' }, 'no record: fail closed');
  assert.deepEqual(decideS1Acl({ ...base, senderCanWriteTarget: false, targetUserId: 2 }), { ok: false, cause: 'unwritable' });
});

test('test 13: hop is max(run, agent origin) + 1, capped at 4; scheduling is denied whenever it is > 0', () => {
  assert.equal(nextHop(effectiveHop(0, 0)), 1);
  assert.equal(nextHop(effectiveHop(3, 0)), 4);
  assert.equal(nextHop(effectiveHop(4, 0)), null);
  assert.equal(nextHop(effectiveHop(0, 4)), null);
  assert.equal(schedulingDenied(effectiveHop(0, 0)), false);
  assert.equal(schedulingDenied(effectiveHop(0, 2)), true);
});

test('throttles 20/h per session and 60/h per member; quota uses the highest window', () => {
  assert.equal(isThrottled({ sessionLastHour: 19, userLastHour: 59 }), false);
  assert.equal(isThrottled({ sessionLastHour: 20, userLastHour: 0 }), true);
  assert.equal(isThrottled({ sessionLastHour: 0, userLastHour: 60 }), true);
  assert.equal(quotaPercent([{ utilization: 35 }, { utilization: 91 }]), 91);
  assert.equal(quotaPercent([null, undefined]), null);
});

test('test 11: the charge is the total_cost_usd delta; negative or missing is unmeasured (ledger fallback)', () => {
  assert.equal(chargeFromTotals(3.5, 3.0), 0.5);
  assert.equal(chargeFromTotals(3.0, 3.0), 0);
  assert.equal(chargeFromTotals(1.0, 3.0), null);
  assert.equal(chargeFromTotals(null, 3.0), null);
  assert.equal(chargeFromTotals(2.0, null), null);
});

test('CLI version reader: parses, caches a success, never caches a failure', async () => {
  assert.equal(parseCliVersion('2.1.306 (Claude Code)\n'), '2.1.306');
  assert.equal(parseCliVersion('garbage'), null);
  assert.equal(parseCliVersion('warning: node 1.2.3 is old\n2.1.306 (Claude Code)\n'), '2.1.306');
  assert.equal(parseCliVersion('v1.2.3-x 4.5.6'), null);
  let calls = 0;
  let fail = true;
  const read = createCliVersionReader(() => '/bin/claude', async () => {
    calls++;
    if (fail) throw new Error('ENOENT');
    return '2.1.306 (Claude Code)';
  });
  assert.equal(await read(), null);
  fail = false;
  assert.equal(await read(), '2.1.306');
  assert.equal(await read(), '2.1.306');
  assert.equal(calls, 2);
});

test('B-1713: the CLI version child runs under cleanSpawnEnv (secrets stripped, PATH kept)', async () => {
  const saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'b1713-sentinel-secret';
  try {
    const output = await defaultExec('/usr/bin/env', []);
    assert.ok(!output.includes('b1713-sentinel-secret'), 'JWT_SECRET must not reach the child');
    assert.ok(!/^JWT_SECRET=/mu.test(output));
    assert.ok(output.split('\n').includes(`PATH=${process.env.PATH}`), 'PATH is kept for the env-node shebang');
  } finally {
    if (saved === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = saved;
  }
});

test('qa ح-1: the spawn policy — refuse settings for SDK spawns, --settings plus no session tools for the CLI', async () => {
  const { relayCliPolicy, relayModeNow, relaySdkSpawnOptions, readActiveMembers } = await import('../peer-spawn-policy.js');
  assert.equal(relayModeNow(1, {}), 'native');
  assert.equal(relayModeNow(2, {}), 'relay');
  assert.equal(relayModeNow(1, { NASSAJ_PEER_RELAY_FORCE_MODE: 'relay' }), 'relay', 'test override');
  assert.equal(readActiveMembers(() => { throw new Error('db'); }), Number.POSITIVE_INFINITY, 'fail closed to relay');
  assert.deepEqual(relaySdkSpawnOptions('native'), {});
  assert.deepEqual(relaySdkSpawnOptions('relay'), { settings: { crossSessionInbound: 'refuse' } });
  assert.deepEqual(relayCliPolicy('native'), { settingsArgs: [], disallowedTools: [] });
  assert.deepEqual(relayCliPolicy('relay'), {
    settingsArgs: ['--settings', '{"crossSessionInbound":"refuse"}'],
    disallowedTools: ['SendMessage', 'ListAgents', 'ListPeers'],
  });
});

test('test 11 (real): a resumed query\'s first total_cost_usd includes earlier turns; the charge is the delta', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, '../__fixtures__/peer-relay.real.json'), 'utf8'));
  for (const run of [...fixture.resumedTurnObservations, ...fixture.nativeFramingRuns]) {
    assert.ok(run.resumedDeliveryFirstResultTotalCostUsd > run.seedTurnTotalCostUsd, 'cumulative across the resume');
    const charge = chargeFromTotals(run.resumedDeliveryFirstResultTotalCostUsd, run.seedTurnTotalCostUsd)!;
    assert.ok(Math.abs(charge - run.chargedUsd) < 1e-9);
    assert.equal(run.senderSendMessageCalls, 1, 'the sender did not retry after the success text');
  }
});

test('live (real): bypass ↔ bypass coordination requests were delivered in bypass and acted on', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, '../__fixtures__/peer-relay.real.json'), 'utf8'));
  assert.equal(fixture.bypassCoordinationRuns.length, 3);
  for (const run of fixture.bypassCoordinationRuns) {
    assert.equal(run.deliveryMode, 'bypassPermissions');
    assert.equal(run.state, 'delivered');
    assert.equal(run.senderSendMessageCalls, 1);
    assert.ok(run.chargedUsd > 0);
  }
});

test('live (real): with the final framing a bypass coordination request still acts', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, '../__fixtures__/peer-relay.real.json'), 'utf8'));
  assert.equal(fixture.finalFramingRun.framingHasNewSentence, true);
  assert.equal(fixture.finalFramingRun.targetActed, true);
  assert.equal(fixture.finalFramingRun.senderSendMessageCalls, 1);
});
