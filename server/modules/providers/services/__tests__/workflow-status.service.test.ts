/**
 * ADR-053 / T-53-B3 — workflowStatusService.getActiveWorkflows.
 *
 * The app-level B-103 visibility endpoint's service. Proves:
 *   - fail-closed: userId=null => empty envelope, NO scan (no leak).
 *   - ownership: only the caller's own sessions are inspected; an unowned
 *     session's workflow never appears (no cross-user leak).
 *   - liveness: RUNNING (pid alive) vs ORPHAN (pid dead, quiet, unfinished) on
 *     the REAL incident journal; COMPLETED is excluded from the "active" set.
 *   - declared scan cap surfaced (eligible/scanned/capped) so "no active
 *     workflow" is never confused with "did not look".
 *
 * Runs against a real migrated DB + real journal files on disk. pid liveness is
 * driven deterministically through the shared workflow-liveness registry
 * (register this live test process = alive; forget = dead).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { workflowStatusService } from '@/modules/providers/services/workflow-status.service.js';
// JS module (allowJs) + test fixtures outside the modules tree — same blessed
// cross-cutting seam as participants.service.ts → transcript-parser.js.
// eslint-disable-next-line boundaries/no-unknown
import { forgetWorkflowPid, registerWorkflowPid } from '@/services/workflow-liveness.js';
// eslint-disable-next-line boundaries/no-unknown
import { COMPLETED_JOURNAL_LINES, INCIDENT_JOURNAL_LINES, toJsonl } from '@/services/__tests__/__fixtures__/wf-real-journals.js';

const NOW_MS = Date.parse('2026-06-27T15:00:00.000Z');
const QUIET_MTIME_MS = NOW_MS - 6 * 60_000; // past the quiet window
const QUIET_MS = 5000;

/**
 * Spawns a process, waits for it to exit + be reaped, and returns its now-dead
 * pid. Registering this pid models a workflow whose recorded child pid DIED — the
 * confirmed-orphan case (known:true, alive:false), distinct from a survivor whose
 * pid was never recorded (forgetWorkflowPid => known:false => UNKNOWN).
 */
async function spawnDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  await new Promise((r) => setTimeout(r, 50));
  return pid;
}

/**
 * Full harness: an isolated migrated DB whose transcript paths point INTO a temp
 * project tree, so the service's on-disk derivation
 * (<projectDir>/<sessionId>/subagents/workflows/wf_*) resolves to real journals
 * we write. Returns helpers to register sessions + workflows for a user.
 */
async function withHarness(
  run: (h: {
    projectDir: string;
    createUser: (name: string) => number;
    addSessionWithWorkflow: (args: {
      userId: number;
      sessionId: string;
      wfId: string;
      lines: Array<Record<string, unknown>> | null;
      mtimeMs?: number;
    }) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'wf-status-'));
  const databasePath = path.join(tempRoot, 'db.sqlite');
  const projectDir = path.join(tempRoot, 'project-encoded');
  await mkdir(projectDir, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const registeredSessionIds: string[] = [];

  const createUser = (name: string): number => userDb.createUser(name, 'hash', 'user').id;

  const addSessionWithWorkflow = async (args: {
    userId: number;
    sessionId: string;
    wfId: string;
    lines: Array<Record<string, unknown>> | null;
    mtimeMs?: number;
  }): Promise<void> => {
    const { userId, sessionId, wfId, lines, mtimeMs = QUIET_MTIME_MS } = args;
    // transcript path: <projectDir>/<sessionId>.jsonl  =>  service derives
    // <projectDir>/<sessionId>/subagents/workflows/<wfId>/journal.jsonl
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    await writeFile(jsonlPath, '', 'utf8');

    // createSession upserts the projects row (project_path FK) + the sessions
    // row (which session_participants FKs to) transactionally, so the participant
    // insert below satisfies its FK. jsonl_path is what the service derives from.
    sessionsDb.createSession(sessionId, 'claude', projectDir, undefined, undefined, undefined, jsonlPath);
    getConnection()
      .prepare('INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, ?)')
      .run(sessionId, userId, 'owner');

    const wfDir = path.join(projectDir, sessionId, 'subagents', 'workflows', wfId);
    await mkdir(wfDir, { recursive: true });
    if (lines !== null) {
      const journalPath = path.join(wfDir, 'journal.jsonl');
      await writeFile(journalPath, toJsonl(lines), 'utf8');
      const secs = mtimeMs / 1000;
      await utimes(journalPath, secs, secs);
    }
    registeredSessionIds.push(sessionId);
  };

  try {
    await run({ projectDir, createUser, addSessionWithWorkflow });
  } finally {
    for (const sid of registeredSessionIds) forgetWorkflowPid(sid);
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('fail-closed: userId=null returns an empty envelope and does not scan', async () => {
  await withHarness(async ({ createUser, addSessionWithWorkflow }) => {
    const u = createUser('u1');
    await addSessionWithWorkflow({ userId: u, sessionId: 's-x', wfId: 'wf_aaaa', lines: INCIDENT_JOURNAL_LINES });
    forgetWorkflowPid('s-x'); // dead pid

    const result = await workflowStatusService.getActiveWorkflows(null, { now: NOW_MS, quietMs: QUIET_MS });
    assert.deepEqual(result, { workflows: [], eligible: 0, scanned: 0, capped: false });
  });
});

test('RUNNING: a live child pid surfaces the workflow as running', async () => {
  await withHarness(async ({ createUser, addSessionWithWorkflow }) => {
    const u = createUser('u1');
    await addSessionWithWorkflow({ userId: u, sessionId: 's-run', wfId: 'wf_run1', lines: INCIDENT_JOURNAL_LINES });
    registerWorkflowPid('s-run', process.pid); // ALIVE

    const result = await workflowStatusService.getActiveWorkflows(u, { now: NOW_MS, quietMs: QUIET_MS });
    assert.equal(result.eligible, 1);
    assert.equal(result.scanned, 1);
    assert.equal(result.capped, false);
    assert.equal(result.workflows.length, 1);
    assert.equal(result.workflows[0].wfId, 'wf_run1');
    assert.equal(result.workflows[0].status, 'running', 'live pid => running');
    assert.equal(result.workflows[0].sessionId, 's-run');
  });
});

test('ORPHAN: recorded-then-DEAD pid + quiet incident journal surfaces as orphan with real progress', async () => {
  await withHarness(async ({ createUser, addSessionWithWorkflow }) => {
    const u = createUser('u1');
    await addSessionWithWorkflow({ userId: u, sessionId: 's-orph', wfId: 'wf_orph1', lines: INCIDENT_JOURNAL_LINES });
    // A pid WAS recorded and then died => known:true, alive:false => real B-103 orphan.
    registerWorkflowPid('s-orph', await spawnDeadPid());

    const result = await workflowStatusService.getActiveWorkflows(u, { now: NOW_MS, quietMs: QUIET_MS });
    assert.equal(result.workflows.length, 1);
    const wf = result.workflows[0];
    assert.equal(wf.status, 'orphan', 'known-dead pid + quiet + unfinished => orphan');
    assert.equal(wf.agentsDone, 15, 'real incident: 15 results landed');
    assert.equal(wf.agentsTotal, 16, 'real incident: 16 started');
    assert.equal(typeof wf.updatedAt, 'string');
  });
});

test('UNKNOWN (M1): restart survivor — no recorded pid + quiet incident journal surfaces as unknown, not orphan', async () => {
  await withHarness(async ({ createUser, addSessionWithWorkflow }) => {
    const u = createUser('u1');
    await addSessionWithWorkflow({ userId: u, sessionId: 's-surv', wfId: 'wf_surv1', lines: INCIDENT_JOURNAL_LINES });
    forgetWorkflowPid('s-surv'); // no pid EVER recorded (in-memory map cleared by restart)

    const result = await workflowStatusService.getActiveWorkflows(u, { now: NOW_MS, quietMs: QUIET_MS });
    assert.equal(result.workflows.length, 1);
    const wf = result.workflows[0];
    assert.equal(wf.status, 'unknown', 'no recorded pid => liveness unproven => UNKNOWN, never a false orphan');
    assert.equal(wf.agentsDone, 15, 'same real incident progress is still surfaced');
    assert.equal(wf.agentsTotal, 16);
  });
});

test('COMPLETED is excluded from the active set', async () => {
  await withHarness(async ({ createUser, addSessionWithWorkflow }) => {
    const u = createUser('u1');
    await addSessionWithWorkflow({ userId: u, sessionId: 's-done', wfId: 'wf_done1', lines: COMPLETED_JOURNAL_LINES });
    forgetWorkflowPid('s-done'); // dead + quiet + all resulted => COMPLETED

    const result = await workflowStatusService.getActiveWorkflows(u, { now: NOW_MS, quietMs: QUIET_MS });
    assert.equal(result.eligible, 1, 'the session is still eligible/scanned');
    assert.equal(result.scanned, 1);
    assert.deepEqual(result.workflows, [], 'a completed workflow is not "active"');
  });
});

test('ownership: a caller never sees another user\'s workflow', async () => {
  await withHarness(async ({ createUser, addSessionWithWorkflow }) => {
    const alice = createUser('alice');
    const bob = createUser('bob');
    await addSessionWithWorkflow({ userId: alice, sessionId: 's-alice', wfId: 'wf_alice', lines: INCIDENT_JOURNAL_LINES });
    forgetWorkflowPid('s-alice');

    // Bob owns nothing => empty, and Alice's orphan never leaks to him.
    const bobResult = await workflowStatusService.getActiveWorkflows(bob, { now: NOW_MS, quietMs: QUIET_MS });
    assert.deepEqual(bobResult, { workflows: [], eligible: 0, scanned: 0, capped: false });

    // Alice sees her own orphan.
    const aliceResult = await workflowStatusService.getActiveWorkflows(alice, { now: NOW_MS, quietMs: QUIET_MS });
    assert.equal(aliceResult.workflows.length, 1);
    assert.equal(aliceResult.workflows[0].sessionId, 's-alice');
  });
});

test('a session with no workflows dir is scanned but contributes nothing (no false orphan)', async () => {
  await withHarness(async ({ projectDir, createUser, addSessionWithWorkflow }) => {
    const u = createUser('u1');
    await addSessionWithWorkflow({ userId: u, sessionId: 's-empty', wfId: 'wf_placeholder', lines: COMPLETED_JOURNAL_LINES });
    forgetWorkflowPid('s-empty');

    // Remove the workflows dir to model "session exists, no workflows".
    await rm(path.join(projectDir, 's-empty', 'subagents', 'workflows'), { recursive: true, force: true });

    const result = await workflowStatusService.getActiveWorkflows(u, { now: NOW_MS, quietMs: QUIET_MS });
    assert.equal(result.eligible, 1);
    assert.equal(result.scanned, 1, 'the session was scanned');
    assert.deepEqual(result.workflows, [], 'no workflows dir => nothing active, no throw');
  });
});
