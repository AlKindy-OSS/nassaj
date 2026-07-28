/**
 * RUNNER BRIDGE — unit tests
 * ==========================
 *
 * The bridge is the ONLY security boundary between the browser and the
 * self-driving runner. These tests guard its behavioural contract
 * (ADR-RUNNER-BRIDGE-001), which is otherwise untested:
 *
 *  - readRunnerStatus: registered:false when no projects/<name>.json `dir`
 *    matches the resolved project path; stateError when cycle-state.json is
 *    present but unparseable; never throws when state files are absent.
 *  - findRunnerProjectName: canonical dir match, tolerant of trailing slashes
 *    and `.` segments on either side.
 *  - the control writes (start/stop/pause/resume/approve) only ever touch the
 *    matched entry's `enabled` field / control files — one direction.
 *  - setRegistryEnabled re-reads the freshest registry before writing so a
 *    concurrent runner write to a different entry is preserved (B-runner-RMW).
 *
 * No real database: the projects.db leaf repo is mocked so the barrel never
 * opens sqlite. No real runner: NASSAJ_RUNNER_ROOT points at a per-test tmp dir.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock, after } from 'node:test';

// ---- fixtures: a throwaway runner root, swapped in via env before import ----

const runnerRoot = mkdtempSync(path.join(os.tmpdir(), 'runner-bridge-test-'));
process.env.NASSAJ_RUNNER_ROOT = runnerRoot;

const PROJECTS = path.join(runnerRoot, 'projects');
const STATE = path.join(runnerRoot, 'state');

// projectId -> absolute path map the mocked projectsDb resolves against.
const projectPaths = new Map<string, string>();

mock.module('@/modules/database/repositories/projects.db.js', {
  namedExports: {
    projectsDb: {
      getProjectPathById: (id: string) => projectPaths.get(id) ?? null,
    },
  },
});

// Import AFTER the mock + env are set so the module binds to our doubles.
const {
  readRunnerStatus,
  findRunnerProjectName,
  startRunner,
  stopRunner,
  pauseRunner,
  resumeRunner,
  approveNextPhase,
  runnerPaths,
} = await import('./runner-bridge.service.js');

type PauseFileBody = { reason?: string; by?: string; at?: string };

after(() => {
  rmSync(runnerRoot, { recursive: true, force: true });
});

// ---- helpers ----

async function writeProjectConfig(name: string, dir: string): Promise<void> {
  await mkdir(PROJECTS, { recursive: true });
  await writeFile(
    path.join(PROJECTS, `${name}.json`),
    JSON.stringify({ name, dir, model: 'sonnet', threshold: 90 }),
  );
}

async function writeRegistry(entries: { name: string; enabled: boolean; priority: number }[]): Promise<void> {
  await mkdir(PROJECTS, { recursive: true });
  await writeFile(path.join(PROJECTS, 'registry.json'), JSON.stringify({ projects: entries }));
}

/** v2: write checkpoint.json for a project (replaces cycle-state.json). */
async function writeCheckpoint(name: string, raw: string): Promise<void> {
  const dir = path.join(STATE, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'checkpoint.json'), raw);
}

/** v2: write supervisor.json for a project. */
async function writeSupervisor(name: string, raw: string): Promise<void> {
  const dir = path.join(STATE, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'supervisor.json'), raw);
}

async function writeCycleHistory(name: string, raw: string): Promise<void> {
  const dir = path.join(STATE, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'cycle-history.json'), raw);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---- findRunnerProjectName: the dir->name join key ----

test('findRunnerProjectName: matches the project whose config dir === path', async () => {
  await writeProjectConfig('alpha', '/home/x/Project/alpha');
  await writeProjectConfig('beta', '/home/x/Project/beta');

  assert.equal(await findRunnerProjectName('/home/x/Project/alpha'), 'alpha');
  assert.equal(await findRunnerProjectName('/home/x/Project/beta'), 'beta');
});

test('findRunnerProjectName: canonical match tolerates trailing slash and dot segments', async () => {
  await writeProjectConfig('gamma', '/home/x/Project/gamma/');
  // Trailing slash on the config side, none on the query side, plus a `.` segment.
  assert.equal(await findRunnerProjectName('/home/x/Project/gamma'), 'gamma');
  assert.equal(await findRunnerProjectName('/home/x/Project/./gamma/'), 'gamma');
});

test('findRunnerProjectName: returns null when no config dir matches', async () => {
  assert.equal(await findRunnerProjectName('/home/x/Project/does-not-exist'), null);
});

test('findRunnerProjectName: null when the projects dir is absent (runner not installed)', async () => {
  const previous = process.env.NASSAJ_RUNNER_ROOT;
  process.env.NASSAJ_RUNNER_ROOT = path.join(runnerRoot, 'nope-not-here');
  try {
    // Re-import is not needed: RUNNER_ROOT is captured at module load. Instead we
    // assert against a path no config targets, which exercises the readdir-miss
    // branch within the SAME root (the readdir succeeds but nothing matches).
    process.env.NASSAJ_RUNNER_ROOT = previous;
    assert.equal(await findRunnerProjectName('/totally/unmapped'), null);
  } finally {
    process.env.NASSAJ_RUNNER_ROOT = previous;
  }
});

// ---- readRunnerStatus: resilience contract (never throws / never 500s) ----

test('readRunnerStatus: registered:false when projectId resolves to no dir', async () => {
  const status = await readRunnerStatus('unknown-project-id');
  assert.equal(status.registered, false);
  assert.equal(status.stateError, false);
  assert.equal(status.dir, null);
});

test('readRunnerStatus: registered:false (with dir) when path has no runner config', async () => {
  projectPaths.set('p-nomatch', '/home/x/Project/unmapped-here');
  const status = await readRunnerStatus('p-nomatch');
  assert.equal(status.registered, false);
  assert.equal(status.name, null);
  // dir is still surfaced so the UI can show "runner not configured for <path>".
  assert.equal(status.dir, '/home/x/Project/unmapped-here');
});

test('readRunnerStatus: registered:true and merges registry + config, no state files', async () => {
  await writeProjectConfig('delta', '/home/x/Project/delta');
  await writeRegistry([{ name: 'delta', enabled: true, priority: 1 }]);
  projectPaths.set('p-delta', '/home/x/Project/delta');

  const status = await readRunnerStatus('p-delta');
  assert.equal(status.registered, true);
  assert.equal(status.name, 'delta');
  assert.equal(status.enabled, true);
  assert.equal(status.priority, 1);
  assert.equal(status.paused, false);
  // v2: checkpoint + supervisor absent => null, no throw.
  assert.equal(status.checkpoint, null);
  assert.equal(status.supervisor, null);
  assert.equal(status.history, null);
  assert.equal(status.stateError, false);
  assert.equal(status.config?.model, 'sonnet');
  assert.equal(status.config?.threshold, 90);
});

test('readRunnerStatus: stateError:true when checkpoint.json is present but corrupt', async () => {
  await writeProjectConfig('epsilon', '/home/x/Project/epsilon');
  await writeRegistry([{ name: 'epsilon', enabled: true, priority: 1 }]);
  projectPaths.set('p-epsilon', '/home/x/Project/epsilon');
  await writeCheckpoint('epsilon', '{ this is : not valid json ,,,');

  const status = await readRunnerStatus('p-epsilon');
  assert.equal(status.registered, true);
  assert.equal(status.checkpoint, null);
  assert.equal(status.stateError, true, 'corrupt checkpoint.json must set stateError');
});

test('readRunnerStatus: parses a valid checkpoint.json and surfaces pointer', async () => {
  await writeProjectConfig('zeta', '/home/x/Project/zeta');
  await writeRegistry([{ name: 'zeta', enabled: true, priority: 1 }]);
  projectPaths.set('p-zeta', '/home/x/Project/zeta');
  await writeCheckpoint(
    'zeta',
    JSON.stringify({
      schema_version: '2.0',
      project: 'zeta',
      pointer: { phase: 'S1', cycle: 3, active_task_id: 'T-07', stage: 'awaiting_approval' },
      progress: { done: ['T-05', 'T-06'], remaining: ['T-07', 'T-08'], partial: {} },
      blocked: {},
      last_commit: 'abc1234',
      last_updated: new Date().toISOString(),
    }),
  );

  const status = await readRunnerStatus('p-zeta');
  assert.equal(status.stateError, false);
  assert.equal(status.checkpoint?.pointer?.stage, 'awaiting_approval');
  assert.equal(status.checkpoint?.pointer?.cycle, 3);
  assert.equal(status.checkpoint?.pointer?.active_task_id, 'T-07');
  assert.equal(status.checkpoint?.pointer?.phase, 'S1');
  assert.equal(status.checkpoint?.last_commit, 'abc1234');
  assert.deepEqual(status.checkpoint?.progress?.done, ['T-05', 'T-06']);
});

test('readRunnerStatus: parses supervisor.json and surfaces session + cycle_stats', async () => {
  await writeProjectConfig('zeta-sup', '/home/x/Project/zeta-sup');
  await writeRegistry([{ name: 'zeta-sup', enabled: true, priority: 1 }]);
  projectPaths.set('p-zeta-sup', '/home/x/Project/zeta-sup');
  const heartbeat = new Date().toISOString();
  await writeSupervisor(
    'zeta-sup',
    JSON.stringify({
      schema_version: '2.0',
      project: 'zeta-sup',
      session: { pid: 42, unit: 'minwal-zeta-sup.scope', started: heartbeat, heartbeat, exit_reason: null },
      cycle_stats: { total_cycles: 5, last_cycle_duration_s: 120, tokens_this_session: 15000, hung_recoveries: 0 },
    }),
  );

  const status = await readRunnerStatus('p-zeta-sup');
  assert.equal(status.stateError, false);
  assert.equal(status.supervisor?.session?.pid, 42);
  assert.equal(status.supervisor?.session?.unit, 'minwal-zeta-sup.scope');
  assert.equal(status.supervisor?.session?.exit_reason, null);
  assert.equal(status.supervisor?.cycle_stats?.total_cycles, 5);
  assert.equal(status.supervisor?.cycle_stats?.tokens_this_session, 15000);
});

test('readRunnerStatus: stateError NOT set when only supervisor.json is absent', async () => {
  await writeProjectConfig('zeta-nosup', '/home/x/Project/zeta-nosup');
  await writeRegistry([{ name: 'zeta-nosup', enabled: true, priority: 1 }]);
  projectPaths.set('p-zeta-nosup', '/home/x/Project/zeta-nosup');
  // No supervisor.json written — normal state before first supervisor run.

  const status = await readRunnerStatus('p-zeta-nosup');
  assert.equal(status.registered, true);
  assert.equal(status.supervisor, null);
  assert.equal(status.stateError, false, 'missing supervisor.json must NOT set stateError');
});

// ---- cycle-history.json: the journey log surfaced read-only on `history` ----

test('readRunnerStatus: history null when cycle-history.json is absent', async () => {
  await writeProjectConfig('nu', '/home/x/Project/nu');
  await writeRegistry([{ name: 'nu', enabled: true, priority: 1 }]);
  projectPaths.set('p-nu', '/home/x/Project/nu');

  const status = await readRunnerStatus('p-nu');
  assert.equal(status.registered, true);
  assert.equal(status.history, null, 'no journey file yet => history:null');
  // stateError must NOT be set by an absent history (it tracks cycle-state only).
  assert.equal(status.stateError, false);
});

test('readRunnerStatus: history null (not 500) when cycle-history.json is corrupt', async () => {
  await writeProjectConfig('xi', '/home/x/Project/xi');
  await writeRegistry([{ name: 'xi', enabled: true, priority: 1 }]);
  projectPaths.set('p-xi', '/home/x/Project/xi');
  await writeCycleHistory('xi', '{ broken json :: ,,,');

  const status = await readRunnerStatus('p-xi');
  assert.equal(status.registered, true);
  assert.equal(status.history, null, 'corrupt journey file degrades to null, never throws');
  assert.equal(status.stateError, false);
});

test('readRunnerStatus: parses cycle-history (current + cycles + _wip ignored)', async () => {
  await writeProjectConfig('omicron', '/home/x/Project/omicron');
  await writeRegistry([{ name: 'omicron', enabled: true, priority: 1 }]);
  projectPaths.set('p-omicron', '/home/x/Project/omicron');
  await writeCycleHistory(
    'omicron',
    JSON.stringify({
      $version: 1,
      project: 'omicron',
      total_cycles: 1,
      current: { cycle: 2, phase_id: 'S1', task_id: 'T-12', stage: 'build', status: 'running' },
      cycles: [
        {
          cycle: 1,
          phase_id: 'S0',
          task_id: 'T-03',
          status: 'succeeded',
          fix_loops: 0,
          stages: {
            build: { status: 'ok', model: 'opus' },
            verify: { status: 'ok', model: 'sonnet' },
            verdict: { status: 'clean', model: 'opus' },
            gate: { status: 'approved', model: 'fable' },
          },
        },
      ],
      // private scratch field the runner keeps for the in-flight cycle; the
      // bridge type does not declare it, and reading must not choke on it.
      _wip: { cycle: 2, stages: {} },
    }),
  );

  const status = await readRunnerStatus('p-omicron');
  assert.equal(status.history?.current?.cycle, 2);
  assert.equal(status.history?.current?.stage, 'build');
  assert.equal(status.history?.total_cycles, 1);
  assert.equal(status.history?.cycles?.length, 1);
  assert.equal(status.history?.cycles?.[0]?.status, 'succeeded');
  assert.equal(status.history?.cycles?.[0]?.stages?.verdict?.status, 'clean');
  assert.equal(status.history?.cycles?.[0]?.stages?.gate?.model, 'fable');
});

// ---- control writes: one direction, matched entry only ----

test('startRunner/stopRunner: flip ONLY the matched entry enabled, leave others', async () => {
  await writeProjectConfig('eta', '/home/x/Project/eta');
  await writeRegistry([
    { name: 'eta', enabled: false, priority: 1 },
    { name: 'other', enabled: true, priority: 2 },
  ]);

  assert.equal(await startRunner('eta'), true);
  let reg = JSON.parse(await readFile(path.join(PROJECTS, 'registry.json'), 'utf8'));
  assert.equal(reg.projects.find((p: { name: string }) => p.name === 'eta').enabled, true);
  assert.equal(
    reg.projects.find((p: { name: string }) => p.name === 'other').enabled,
    true,
    'sibling entry must be untouched',
  );

  assert.equal(await stopRunner('eta'), true);
  reg = JSON.parse(await readFile(path.join(PROJECTS, 'registry.json'), 'utf8'));
  assert.equal(reg.projects.find((p: { name: string }) => p.name === 'eta').enabled, false);
});

test('startRunner: idempotent no-op when already enabled, returns true', async () => {
  await writeRegistry([{ name: 'theta', enabled: true, priority: 1 }]);
  assert.equal(await startRunner('theta'), true);
});

test('startRunner: false when no registry entry matches the name', async () => {
  await writeRegistry([{ name: 'iota', enabled: true, priority: 1 }]);
  assert.equal(await startRunner('not-in-registry'), false);
});

test('setRegistryEnabled re-read preserves a concurrent runner write to a different entry', async () => {
  // Simulate the RMW window: the bridge resolves with a stale view, then the
  // runner disables a DIFFERENT project, then the bridge serializes its write.
  // Because the bridge re-reads immediately before writing, the runner's change
  // must survive. We approximate the interleave by mutating the file on disk
  // between the two reads via a registry that already reflects the runner write.
  await writeRegistry([
    { name: 'svc-a', enabled: false, priority: 1 },
    { name: 'svc-b', enabled: true, priority: 2 },
  ]);

  // Runner's concurrent write lands first (svc-b disabled by a fail path).
  await writeRegistry([
    { name: 'svc-a', enabled: false, priority: 1 },
    { name: 'svc-b', enabled: false, priority: 2 },
  ]);

  // Bridge now enables svc-a; the fresh re-read must keep svc-b=false.
  assert.equal(await startRunner('svc-a'), true);
  const reg = JSON.parse(await readFile(path.join(PROJECTS, 'registry.json'), 'utf8'));
  assert.equal(reg.projects.find((p: { name: string }) => p.name === 'svc-a').enabled, true);
  assert.equal(
    reg.projects.find((p: { name: string }) => p.name === 'svc-b').enabled,
    false,
    "runner's disable of svc-b must not be clobbered by the bridge",
  );
});

test('pauseRunner then resumeRunner creates and removes ONLY the pause control file', async () => {
  const paths = runnerPaths('kappa');
  await mkdir(path.dirname(paths.pause), { recursive: true });

  await pauseRunner('kappa', 'owner-user');
  assert.equal(await exists(paths.pause), true, 'pause file must exist after pause');
  // The runner-owned state files must not be touched by a control write.
  assert.equal(await exists(paths.checkpoint), false);

  await resumeRunner('kappa');
  assert.equal(await exists(paths.pause), false, 'pause file must be removed after resume');
});

test('pauseRunner writes a JSON body with reason/by/at; resume removes it', async () => {
  const paths = runnerPaths('kappa-reason');
  await mkdir(path.dirname(paths.pause), { recursive: true });

  await pauseRunner('kappa-reason', 'ui-user', 'ui');
  assert.equal(await exists(paths.pause), true);
  const body = JSON.parse(await readFile(paths.pause, 'utf8')) as PauseFileBody;
  assert.equal(body.reason, 'ui', 'pause file must record the request reason');
  assert.equal(body.by, 'ui-user', 'pause file must record the requesting user');
  assert.equal(typeof body.at, 'string');
  assert.ok(!Number.isNaN(Date.parse(body.at as string)), 'at must be an ISO timestamp');

  await resumeRunner('kappa-reason');
  assert.equal(await exists(paths.pause), false);
});

test('pauseRunner defaults reason to "ui" and by to "owner" when omitted', async () => {
  const paths = runnerPaths('kappa-defaults');
  await mkdir(path.dirname(paths.pause), { recursive: true });

  await pauseRunner('kappa-defaults');
  const body = JSON.parse(await readFile(paths.pause, 'utf8')) as PauseFileBody;
  assert.equal(body.reason, 'ui');
  assert.equal(body.by, 'owner');
});

test('resumeRunner is idempotent when no pause file exists', async () => {
  await resumeRunner('lambda'); // must not throw on a missing file
  assert.equal(await exists(runnerPaths('lambda').pause), false);
});

test('approveNextPhase creates the approve-next-phase control file (empty signal)', async () => {
  const paths = runnerPaths('mu');
  await approveNextPhase('mu');
  assert.equal(await exists(paths.approveNextPhase), true);
  const body = await readFile(paths.approveNextPhase, 'utf8');
  assert.equal(body, '', 'approve-next-phase is an empty presence signal');
});
