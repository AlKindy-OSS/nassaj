/**
 * ADR-053 §ج-2 (حرج-3) — scope is-active liveness PRECEDES the Layer-1 pid path.
 *
 * TWO LAYERS OF PROOF, ALL AGAINST REAL SYSTEMD (no synthetic is-active):
 *
 *  A) classifyScopeLiveness — the pure verdict mapping, with an injected probe,
 *     covering every state (active/activating => RUNNING, failed => ORPHAN,
 *     inactive/deactivating => COMPLETED, error/unknown => conservative RUNNING).
 *
 *  B) End-to-end through workflowStatusService.getActiveWorkflows, driving REAL
 *     transient user units so the is-active verdict is genuine:
 *       - a workflow whose scope is ACTIVE is RUNNING even when its child pid is
 *         DEAD (a scope grandchild is invisible to the pid registry — the exact
 *         blind spot §ج-2 fixes),
 *       - a workflow whose scope is INACTIVE is COMPLETED (dropped) even when its
 *         child pid is ALIVE (scope verdict wins over pid),
 *       - FLAG OFF => resolver is null => byte-identical pid-only behavior
 *         (the no-op guarantee).
 *
 * Requires a working systemd --user session; the end-to-end cases self-skip if
 * transient units cannot be started in the sandbox (the classifier cases always
 * run — they inject the probe).
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/dependencies -- test exercises the real providers service (no public barrel export)
import { workflowStatusService } from '@/modules/providers/services/workflow-status.service.js';
import { classifyScopeLiveness } from '@/modules/workflow-supervisor/scope-liveness.js';
// eslint-disable-next-line boundaries/no-unknown
import { forgetWorkflowPid, registerWorkflowPid } from '@/services/workflow-liveness.js';
// eslint-disable-next-line boundaries/no-unknown
import { INCIDENT_JOURNAL_LINES, toJsonl } from '@/services/__tests__/__fixtures__/wf-real-journals.js';

const execFileAsync = promisify(execFile);

const NOW_MS = Date.parse('2026-06-27T15:00:00.000Z');
const QUIET_MTIME_MS = NOW_MS - 6 * 60_000;
const QUIET_MS = 5000;

// ---------------------------------------------------------------------------
// A) Pure classifier — injected probe, every branch.
// ---------------------------------------------------------------------------

test('classifyScopeLiveness: active/activating/reloading => RUNNING', async () => {
  for (const v of ['active', 'activating', 'reloading']) {
    assert.equal(await classifyScopeLiveness('u.service', async () => v), 'RUNNING', `${v} => RUNNING`);
  }
});

test('classifyScopeLiveness: failed => ORPHAN', async () => {
  assert.equal(await classifyScopeLiveness('u.service', async () => 'failed'), 'ORPHAN');
});

test('classifyScopeLiveness: inactive/deactivating => COMPLETED', async () => {
  for (const v of ['inactive', 'deactivating']) {
    assert.equal(await classifyScopeLiveness('u.service', async () => v), 'COMPLETED', `${v} => COMPLETED`);
  }
});

test('classifyScopeLiveness: unknown state or a throwing probe => conservative RUNNING (never a false COMPLETED)', async () => {
  assert.equal(await classifyScopeLiveness('u.service', async () => 'weird'), 'RUNNING');
  assert.equal(
    await classifyScopeLiveness('u.service', async () => {
      throw new Error('probe blew up');
    }),
    'RUNNING',
    'a monitoring blip must not declare a scope dead',
  );
});

// ---------------------------------------------------------------------------
// B) End-to-end through the status service with REAL transient units.
// ---------------------------------------------------------------------------

/** Best-effort check that we can drive transient --user units in this sandbox. */
async function systemdUserAvailable(): Promise<boolean> {
  try {
    await execFileAsync('systemd-run', ['--user', '--version']);
    const probe = `wf-selfcheck-${process.pid}.service`;
    await execFileAsync('systemd-run', ['--user', '--quiet', `--unit=${probe}`, '--', 'sleep', '2']);
    await execFileAsync('systemctl', ['--user', 'stop', probe]).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Harness mirroring workflow-status.service.test.ts, PLUS a supervisor
 * state-dir with a supervisor.json whose `projectPath` == the session's
 * project_path, so buildScopeLivenessResolver picks the unit as authoritative.
 */
async function withScopeHarness(
  run: (h: {
    projectDir: string;
    stateDir: string;
    createUser: (name: string) => number;
    addSession: (args: {
      userId: number;
      sessionId: string;
      wfId: string;
      mtimeMs?: number;
    }) => Promise<void>;
    writeScopeRecord: (wfLaunchId: string, unit: string, projectPath: string) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const prevDb = process.env.DATABASE_PATH;
  const prevFlag = process.env.WORKFLOW_SUPERVISOR;
  const prevStateDir = process.env.WORKFLOW_SUPERVISOR_STATE_DIR;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'wf-scope-'));
  const databasePath = path.join(tempRoot, 'db.sqlite');
  const projectDir = path.join(tempRoot, 'project-encoded');
  const stateDir = path.join(tempRoot, 'supervisor-state');
  await mkdir(projectDir, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  process.env.WORKFLOW_SUPERVISOR = '1';
  process.env.WORKFLOW_SUPERVISOR_STATE_DIR = stateDir;
  await initializeDatabase();

  const registered: string[] = [];
  const createUser = (name: string): number => userDb.createUser(name, 'hash', 'user').id;

  const addSession = async (args: {
    userId: number;
    sessionId: string;
    wfId: string;
    mtimeMs?: number;
  }): Promise<void> => {
    const { userId, sessionId, wfId, mtimeMs = QUIET_MTIME_MS } = args;
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    await writeFile(jsonlPath, '', 'utf8');
    sessionsDb.createSession(sessionId, 'claude', projectDir, undefined, undefined, undefined, jsonlPath);
    getConnection()
      .prepare('INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, ?)')
      .run(sessionId, userId, 'owner');
    const wfDir = path.join(projectDir, sessionId, 'subagents', 'workflows', wfId);
    await mkdir(wfDir, { recursive: true });
    const journalPath = path.join(wfDir, 'journal.jsonl');
    await writeFile(journalPath, toJsonl(INCIDENT_JOURNAL_LINES), 'utf8');
    const secs = mtimeMs / 1000;
    await utimes(journalPath, secs, secs);
    registered.push(sessionId);
  };

  const writeScopeRecord = async (wfLaunchId: string, unit: string, projectPath: string): Promise<void> => {
    const dir = path.join(stateDir, 'scopes', wfLaunchId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'supervisor.json'),
      JSON.stringify({
        schema_version: '1',
        wfLaunchId,
        projectPath,
        session: { unit, started: new Date(NOW_MS).toISOString(), heartbeat: new Date(NOW_MS).toISOString(), exit_reason: null },
      }),
      'utf8',
    );
  };

  try {
    await run({ projectDir, stateDir, createUser, addSession, writeScopeRecord });
  } finally {
    for (const sid of registered) forgetWorkflowPid(sid);
    closeConnection();
    if (prevDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDb;
    if (prevFlag === undefined) delete process.env.WORKFLOW_SUPERVISOR;
    else process.env.WORKFLOW_SUPERVISOR = prevFlag;
    if (prevStateDir === undefined) delete process.env.WORKFLOW_SUPERVISOR_STATE_DIR;
    else process.env.WORKFLOW_SUPERVISOR_STATE_DIR = prevStateDir;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('E2E: an ACTIVE scope makes a DEAD-pid workflow RUNNING (scope beats the pid blind spot)', async (t) => {
  if (!(await systemdUserAvailable())) {
    t.skip('systemd --user transient units unavailable in this sandbox');
    return;
  }
  const unit = `wf-e2e-active-${process.pid}.service`;
  await execFileAsync('systemd-run', ['--user', '--quiet', `--unit=${unit}`, '--', 'sleep', '30']);
  try {
    await withScopeHarness(async ({ projectDir, createUser, addSession, writeScopeRecord }) => {
      const u = createUser('u1');
      await addSession({ userId: u, sessionId: 's-active', wfId: 'wf_incident' });
      forgetWorkflowPid('s-active'); // pid DEAD — Layer-1 alone would say ORPHAN
      await writeScopeRecord('launch-active', unit, projectDir); // scope ACTIVE

      const res = await workflowStatusService.getActiveWorkflows(u, { now: NOW_MS, quietMs: QUIET_MS });
      assert.equal(res.workflows.length, 1, 'the workflow is surfaced');
      assert.equal(res.workflows[0].status, 'running', 'ACTIVE scope => RUNNING despite a dead pid');
    });
  } finally {
    await execFileAsync('systemctl', ['--user', 'stop', unit]).catch(() => {});
  }
});

test('E2E: an INACTIVE scope makes an ALIVE-pid workflow COMPLETED/dropped (scope verdict PRECEDES pid)', async (t) => {
  if (!(await systemdUserAvailable())) {
    t.skip('systemd --user transient units unavailable in this sandbox');
    return;
  }
  // A unit name that is NOT loaded => is-active reports "inactive".
  const unit = `wf-e2e-inactive-${process.pid}.service`;
  await withScopeHarness(async ({ projectDir, createUser, addSession, writeScopeRecord }) => {
    const u = createUser('u1');
    await addSession({ userId: u, sessionId: 's-inactive', wfId: 'wf_incident' });
    registerWorkflowPid('s-inactive', process.pid); // pid ALIVE — Layer-1 alone => RUNNING
    await writeScopeRecord('launch-inactive', unit, projectDir); // scope INACTIVE (unit never started)

    const res = await workflowStatusService.getActiveWorkflows(u, { now: NOW_MS, quietMs: QUIET_MS });
    assert.deepEqual(res.workflows, [], 'INACTIVE scope => COMPLETED/dropped even though the pid is alive');
    assert.equal(res.scanned, 1, 'the session was still scanned');
  });
});

test('NO-OP: with WORKFLOW_SUPERVISOR OFF the resolver is null => pid path decides (byte-identical Layer-1)', async () => {
  // Same shape as the ACTIVE case, but flag OFF: even a real active unit and a
  // scope record must be IGNORED — forgetWorkflowPid('s-off') removes the pid
  // entry entirely, so probeWorkflowLiveness returns known:false.
  // classifyWorkflowLiveness (M1): known:false means "no pid was ever recorded"
  // (the restart-survivor case), which MUST NOT be announced as a death =>
  // UNKNOWN, not ORPHAN. ORPHAN is reserved for known:true (pid was recorded
  // and died). The flag-OFF guarantee is therefore: the scope record is ignored
  // AND the pure pid path returns UNKNOWN (no false orphan).
  const prevFlag = process.env.WORKFLOW_SUPERVISOR;
  await withScopeHarness(async ({ projectDir, createUser, addSession, writeScopeRecord }) => {
    process.env.WORKFLOW_SUPERVISOR = ''; // OFF within the harness (overrides the harness's '1')
    const u = createUser('u1');
    await addSession({ userId: u, sessionId: 's-off', wfId: 'wf_incident' });
    forgetWorkflowPid('s-off'); // no pid ever recorded => known:false
    await writeScopeRecord('launch-off', `wf-would-be-active-${process.pid}.service`, projectDir);

    const res = await workflowStatusService.getActiveWorkflows(u, { now: NOW_MS, quietMs: QUIET_MS });
    assert.equal(res.workflows.length, 1, 'workflow surfaces via the untouched pid path');
    assert.equal(
      res.workflows[0].status,
      'unknown',
      'flag OFF: scope record ignored; known:false + quiet incident => UNKNOWN (M1: no false orphan)',
    );
    assert.equal(res.workflows[0].agentsDone, 15, 'real incident progress preserved');
    assert.equal(res.workflows[0].agentsTotal, 16);
  });
  // restored by the harness finally; re-assert for clarity
  if (prevFlag === undefined) delete process.env.WORKFLOW_SUPERVISOR;
  else process.env.WORKFLOW_SUPERVISOR = prevFlag;
});
