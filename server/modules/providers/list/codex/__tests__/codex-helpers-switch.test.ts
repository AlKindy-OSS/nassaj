/**
 * ADR-206 S1 §2.2/§3.2: the per-turn helpers switch B, the smoothed CPU signal, the
 * memory seam (S2) and the B = 0 notice in the T-1315 developer-instructions slot.
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODEX_HELPERS_OFF_REASONS,
  SmoothedCpuSampler,
  codexHelpersOffNotice,
  codexHelpersOffUserNotice,
  codexTurnDeveloperInstructions,
  decideCodexHelpers,
  type CodexHelpersDecision,
  type SmoothedCpu,
} from '../codex-helpers-switch.js';

const LOW: () => SmoothedCpu = () => ({ percent: 20, source: 'window' });
const HIGH: () => SmoothedCpu = () => ({ percent: 80, source: 'window' });
const noRoles = async (): Promise<null> => null;

async function decide(overrides: Partial<Parameters<typeof decideCodexHelpers>[0]> = {}): Promise<CodexHelpersDecision> {
  return decideCodexHelpers({ level: 'delegate', env: {}, projectRoles: noRoles, cpu: LOW, memoryOk: () => true, ...overrides });
}

test('S2 seam: the memory check receives the turn context; without one the real check gives B = 0', async () => {
  const seen: unknown[] = [];
  await decide({ memoryContext: { tag: 'pe-x', userId: 7 }, memoryOk: (context) => { seen.push(context); return true; } });
  assert.deepEqual(seen, [{ tag: 'pe-x', userId: 7 }]);
  const noContext = await decideCodexHelpers({ level: 'delegate', env: {}, projectRoles: noRoles, cpu: LOW });
  assert.deepEqual([noContext.helpers, noContext.reason], [false, 'measurement_unavailable']);
});

test('B = 1 by default: delegate level, no roles, CPU below 80, memory ok', async () => {
  const decision = await decide();
  assert.equal(decision.helpers, true);
  assert.equal(decision.reason, null);
  assert.equal((await decide({ level: undefined })).helpers, true, 'absent level is the product default');
  assert.equal((await decide({ level: 'delegate_review' })).helpers, true);
});

test('the coordination level «direct» gives B = 0, before any scan or sample', async () => {
  let scanned = false;
  let sampled = false;
  const decision = await decide({
    level: 'direct',
    projectRoles: async () => { scanned = true; return null; },
    cpu: () => { sampled = true; return { percent: 1, source: 'window' }; },
  });
  assert.deepEqual([decision.helpers, decision.reason], [false, 'coordination_level_direct']);
  assert.equal(scanned, false);
  assert.equal(sampled, false);
  // An unknown present level fails closed to direct (normalizeCoordinationLevel).
  assert.equal((await decide({ level: 'widen-please' })).reason, 'coordination_level_direct');
});

test('operator switch, project roles, CPU, memory and measurement each give B = 0 with their reason', async () => {
  assert.equal((await decide({ env: { NASSAJ_CODEX_MULTI_AGENT: 'off' } })).reason, 'disabled_by_operator');
  assert.equal((await decide({ env: { NASSAJ_CODEX_MULTI_AGENT: ' OFF ' } })).reason, 'disabled_by_operator');
  assert.equal((await decide({ env: { NASSAJ_CODEX_MULTI_AGENT: 'on' } })).helpers, true);
  assert.equal((await decide({ projectRoles: async () => ({ kind: 'agents_dir' }) })).reason, 'project_roles_present');
  assert.equal((await decide({ cpu: HIGH })).reason, 'host_cpu_busy', '80 is not below 80');
  assert.equal((await decide({ cpu: () => ({ percent: 79.99, source: 'loadavg' }) })).helpers, true);
  assert.equal((await decide({ memoryOk: () => false })).reason, 'host_memory_high');
  assert.equal((await decide({ memoryOk: async () => false })).reason, 'host_memory_high');
  for (const percent of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.equal((await decide({ cpu: () => ({ percent, source: 'window' }) })).reason, 'measurement_unavailable');
  }
});

test('no path refuses the turn: every throwing input resolves to B = 0, never a rejection', async () => {
  const boom = (): never => { throw new Error('boom'); };
  const cases: Array<[Partial<Parameters<typeof decideCodexHelpers>[0]>, string]> = [
    [{ projectRoles: async () => boom() }, 'project_roles_present'],
    [{ projectRoles: () => boom() }, 'project_roles_present'],
    [{ cpu: boom }, 'measurement_unavailable'],
    [{ memoryOk: boom }, 'measurement_unavailable'],
    [{ memoryOk: async () => boom() }, 'measurement_unavailable'],
    [{ env: new Proxy({}, { get: boom }) as NodeJS.ProcessEnv }, 'measurement_unavailable'],
  ];
  for (const [overrides, reason] of cases) {
    const decision = await decide(overrides);
    assert.deepEqual([decision.helpers, decision.reason], [false, reason]);
  }
});

/** A fake host whose cumulative CPU counters advance by `busy` (0..1) per 2 s tick. */
function fakeHost(busyPerTick: number[], load1 = 0.8) {
  let now = 0;
  let idle = 0;
  let total = 0;
  const sampler = new SmoothedCpuSampler({
    readCpuTimes: () => ({ idle, total }),
    loadavg: () => [load1, 0, 0],
    cpuCount: () => 8,
    now: () => now,
    startTimer: () => () => undefined,
  });
  sampler.record();
  for (const busy of busyPerTick) {
    now += 2_000;
    total += 2_000;
    idle += 2_000 * (1 - busy);
    sampler.record();
  }
  return sampler;
}

test('smoothed CPU: a single 100% spike over a low 10 s average does not flip B', async () => {
  const sampler = fakeHost([0.1, 0.1, 0.1, 0.1, 0.1, 1]);
  const cpu = sampler.read();
  assert.equal(cpu.source, 'window');
  assert.ok(cpu.percent < 80, `10 s average ${cpu.percent}`);
  assert.equal((await decide({ cpu: () => sampler.read() })).helpers, true);
});

test('smoothed CPU: a sustained high value over 10 s does flip B to 0', async () => {
  const sampler = fakeHost([0.95, 0.9, 0.95, 0.9, 0.95, 0.9]);
  const cpu = sampler.read();
  assert.equal(cpu.source, 'window');
  assert.ok(cpu.percent >= 80, `10 s average ${cpu.percent}`);
  assert.equal((await decide({ cpu: () => sampler.read() })).reason, 'host_cpu_busy');
});

test('smoothed CPU: under 10 s of history it is loadavg[0] / ncpu, never one short sample', async () => {
  const quiet = fakeHost([1, 1], 2);
  assert.deepEqual(quiet.read(), { percent: 25, source: 'loadavg' }, 'a busy 4 s does not count');
  const busy = fakeHost([0, 0], 7);
  assert.deepEqual(busy.read(), { percent: 87.5, source: 'loadavg' });
  const broken = new SmoothedCpuSampler({
    readCpuTimes: () => ({ idle: 0, total: 0 }),
    loadavg: () => [Number.NaN, 0, 0],
    cpuCount: () => 0,
    now: () => 0,
    startTimer: () => () => undefined,
  });
  assert.throws(() => broken.read(), /unavailable/);
  assert.equal((await decide({ cpu: () => broken.read() })).reason, 'measurement_unavailable');
});

test('the sampler starts its 2 s ticker lazily on first read and stops it when idle', () => {
  let started = 0;
  let stopped = 0;
  let tick: (() => void) | null = null;
  let now = 0;
  const sampler = new SmoothedCpuSampler({
    readCpuTimes: () => ({ idle: now, total: now * 2 }),
    loadavg: () => [1, 0, 0],
    cpuCount: () => 8,
    now: () => now,
    startTimer: (fn) => { started += 1; tick = fn; return () => { stopped += 1; }; },
  });
  assert.equal(started, 0, 'no timer before a Codex turn needs one');
  sampler.read();
  sampler.read();
  assert.equal(started, 1);
  now += 11 * 60_000;
  tick!();
  assert.equal(stopped, 1, 'idle for over 10 min: the ticker stops');
  sampler.read();
  assert.equal(started, 2, 'and restarts on the next turn');
});

test('the B = 0 notice replaces the coordination directive in the T-1315 slot; absent when B = 1', () => {
  const runtime = (level: unknown): string => (level === 'direct' ? 'SHARING' : `DIRECTIVE(${String(level)})\n\nSHARING`);
  const on: CodexHelpersDecision = { helpers: true, reason: null, cpu: null };
  assert.equal(codexTurnDeveloperInstructions('delegate', on, runtime), 'DIRECTIVE(delegate)\n\nSHARING');
  for (const reason of CODEX_HELPERS_OFF_REASONS) {
    const text = codexTurnDeveloperInstructions('delegate', { helpers: false, reason, cpu: null }, runtime);
    assert.ok(text.startsWith(codexHelpersOffNotice(reason)), reason);
    assert.ok(text.endsWith('\n\nSHARING'), reason);
    assert.doesNotMatch(text, /DIRECTIVE/, `${reason}: the delegate directive is replaced, not kept`);
  }
  const notice = codexHelpersOffNotice('host_cpu_busy');
  assert.match(notice, /Delegation is unavailable this turn \(host CPU busy\)\. Execute the work directly; do not call spawn_agent\./);
  assert.match(notice, /التفويض غير متاح هذه الجولة؛ نفّذ العمل مباشرة/);
  assert.match(codexHelpersOffNotice('coordination_level_direct'), /\(coordination level direct\)/);
  assert.match(codexHelpersOffNotice('project_roles_present'), /\(project roles present\)/);
  assert.match(codexHelpersOffNotice('host_memory_high'), /\(host memory high\)/);
  assert.match(codexHelpersOffNotice('measurement_unavailable'), /\(measurement unavailable\)/);
  assert.match(codexHelpersOffNotice('disabled_by_operator'), /\(disabled by operator\)/);
  assert.equal(codexHelpersOffUserNotice('host_cpu_busy').includes('\n'), false, 'one line for the UI');
  assert.match(codexHelpersOffUserNotice('host_cpu_busy'), /^التفويض غير متاح هذه الجولة/);
});
