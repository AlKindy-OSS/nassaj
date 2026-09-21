import assert from 'node:assert/strict';
import test from 'node:test';

import { claudeDelegationProfile, createClaudeDelegationResourceHook } from './claude-delegation-admission.js';

const good = { cpuPercent: 20, memoryPercent: 30, measuredAt: 1000 };
for (const [label, sample] of Object.entries({
  cpuAt80: { ...good, cpuPercent: 80 }, memoryAt80: { ...good, memoryPercent: 80 },
  cpuAbove80: { ...good, cpuPercent: 95 }, missing: undefined,
  stale: { ...good, measuredAt: -1 }, future: { ...good, measuredAt: 1001 },
  nan: { ...good, cpuPercent: NaN }, negative: { ...good, memoryPercent: -1 },
})) {
  test(`resource admission denies ${label}`, async () => {
    const hook = createClaudeDelegationResourceHook({ sample: async () => sample as typeof good, now: () => 1000 });
    const result = await hook({ tool_name: 'Agent', tool_input: {} });
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput!.permissionDecisionReason, /DELEGATION_RESOURCE_ADMISSION_DENIED/);
  });
}
for (const tool of ['Agent', 'Task']) {
  test(`${tool} success returns no permission override`, async () => {
    const hook = createClaudeDelegationResourceHook({ sample: async () => good, now: () => 1000 });
    assert.deepEqual(await hook({ tool_name: tool, tool_input: {} }), {});
  });
}
test('failure and abort deny, unrelated tool does not sample', async () => {
  let calls = 0;
  const hook = createClaudeDelegationResourceHook({ sample: async () => { calls++; throw Error('private detail'); } });
  assert.deepEqual(await hook({ tool_name: 'TaskCreate' }), {});
  assert.equal(calls, 0);
  assert.equal((await hook({ tool_name: 'Task', tool_input: {} })).hookSpecificOutput?.permissionDecision, 'deny');
  const abort = new AbortController(); abort.abort();
  assert.equal((await hook({ tool_name: 'Agent', tool_input: {} }, 'id', { signal: abort.signal })).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(calls, 1);
});
test('queued launches obtain independent serialized samples', async () => {
  let active = 0; let maxActive = 0; let calls = 0;
  const hook = createClaudeDelegationResourceHook({ now: () => 1000, sample: async () => {
    active++; maxActive = Math.max(maxActive, active); calls++;
    await Promise.resolve(); active--; return good;
  } });
  await Promise.all([hook({ tool_name: 'Agent', tool_input: {} }), hook({ tool_name: 'Task', tool_input: {} })]);
  assert.equal(calls, 2); assert.equal(maxActive, 1);
});
test('activation stays off and unattested launch remains at baseline', () => {
  assert.deepEqual(claudeDelegationProfile('delegate_review'), { depth: '2', concurrent: '20', expandedDepthEnabled: false });
  for (const level of ['direct', 'delegate', 'unexpected', undefined, { verified: true }]) {
    assert.equal(claudeDelegationProfile(level).depth, '1');
  }
});

test('team paths and malformed launch inputs fail closed before sampling', async () => {
  let calls = 0;
  const hook = createClaudeDelegationResourceHook({ sample: async () => { calls++; return good; }, now: () => 1000 });
  for (const payload of [undefined, null, [], '', { name: '' }, { team_name: null }, { name: undefined }]) {
    assert.equal((await hook({ tool_name: 'Agent', tool_input: payload })).hookSpecificOutput?.permissionDecision, 'deny');
  }
  assert.equal((await hook({ tool_name: 'TeamCreate', tool_input: {} })).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(calls, 0);
});
