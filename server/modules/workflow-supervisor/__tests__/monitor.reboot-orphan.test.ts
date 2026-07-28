/**
 * T-823 item 2 — reboot semantics: a transient wf-*.service does NOT survive a
 * reboot and is NEVER auto-resumed. reportRebootOrphansOnce makes that VISIBLE:
 *   - an interrupted task (unit gone/terminal + NO DONE + undelivered) is surfaced
 *     as a reboot-orphan (audit line, resumed:false), and LAUNCHES NOTHING,
 *   - a task that actually finished (DONE present) is NOT an orphan,
 *   - an already-delivered task (in the ledger) is NOT an orphan,
 *   - a still-active unit is NOT an orphan,
 *   - "visible": a subsequent reconcile delivers the orphan's CRASHED card,
 *   - "not resumed": the report has no launch dep — structurally cannot relaunch.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  reportRebootOrphansOnce,
  reconcileAndDeliverOnce,
  type MonitorDeps,
  type DeliveryTarget,
} from '@/modules/workflow-supervisor/monitor.js';
import { handoffId, writeLedgerEntries } from '@/modules/workflow-supervisor/handoff.js';
import type { DurableTask } from '@/modules/workflow-supervisor/intent.js';
import type { UnitState } from '@/modules/workflow-supervisor/result-capture.js';

function envFor(root: string): NodeJS.ProcessEnv {
  return { ...process.env, WORKFLOW_SUPERVISOR_STATE_DIR: root };
}

/** Seed a task dir. `conv` lets each task target its own conversation. */
function seedTask(root: string, taskId: string, conv: string, files: Record<string, string>): void {
  const dir = path.join(root, 'tasks', taskId);
  fs.mkdirSync(dir, { recursive: true });
  const task: DurableTask = {
    schema_version: '2',
    taskId,
    userId: 1,
    projectPath: '/home/owner/proj',
    conversationId: conv,
    originMessageId: 'm1',
    spec: { scriptOrPrompt: 'run', model: null, effort: null, handoffPolicy: 'card-only', leafOnly: true },
    requestedAt: new Date(0).toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
}

/** Probe stub keyed by task id embedded in the unit name (wf-<taskId>.service). */
function probeFor(map: Record<string, UnitState>): MonitorDeps['probeUnitState'] {
  return async (unit: string) => {
    const id = unit.replace(/^wf-/, '').replace(/\.service$/, '');
    return map[id] ?? 'gone';
  };
}

test('interrupted task (unit gone, no DONE, undelivered) ⇒ reboot-orphan, launches nothing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 't823-orph-'));
  const env = envFor(root);
  try {
    // The reboot orphan: launched (task.json) but killed mid-run — no DONE.
    seedTask(root, 'orphan1', 'convA', { 'result.json.partial': 'half streamed' });
    const deps: MonitorDeps = {
      env,
      probeUnitState: probeFor({ orphan1: 'gone' }),
      verifyDeliveryTarget: (): DeliveryTarget => ({ ok: true, jsonlPath: path.join(root, 'convA.jsonl'), projectPath: '/p' }),
    };

    const before = fs.readdirSync(path.join(root, 'tasks')).sort();
    const rep = await reportRebootOrphansOnce(deps);
    assert.equal(rep.orphans, 1);
    assert.deepEqual(rep.taskIds, ['orphan1']);

    // Audit records it as surfaced-not-resumed.
    const audit = fs.readFileSync(path.join(root, 'tasks', 'orphan1', 'audit.log'), 'utf8');
    assert.match(audit, /"event":"reboot-orphan"/);
    assert.match(audit, /"resumed":false/);

    // NO relaunch: no new intent file, no new task dir — the tasks tree is unchanged
    // (only audit.log was appended inside the existing dir).
    const after = fs.readdirSync(path.join(root, 'tasks')).sort();
    assert.deepEqual(after, before, 'no new task dir created (no relaunch)');
    assert.equal(fs.existsSync(path.join(root, 'intents')), false, 'no intent written (no relaunch)');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('orphan is VISIBLE: a following reconcile delivers exactly one CRASHED card', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 't823-orph-vis-'));
  const env = envFor(root);
  const jsonl = path.join(root, 'convA.jsonl');
  try {
    seedTask(root, 'orphan1', 'convA', {}); // no DONE, no result ⇒ CRASHED after grace
    const deps: MonitorDeps = {
      env,
      probeUnitState: probeFor({ orphan1: 'gone' }),
      verifyDeliveryTarget: (): DeliveryTarget => ({ ok: true, jsonlPath: jsonl, projectPath: '/p' }),
      graceMs: 0,
      sleep: async () => {},
    };
    await reportRebootOrphansOnce(deps);
    await reconcileAndDeliverOnce(deps);

    const cards = fs
      .readFileSync(jsonl, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { handoffId?: string; taskStatus?: string; backgroundTaskOutcome?: string })
      .filter((o) => o.handoffId === handoffId('orphan1'));
    assert.equal(cards.length, 1, 'exactly one card surfaced for the orphan (visible)');
    assert.equal(cards[0]!.backgroundTaskOutcome, 'CRASHED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('finished/delivered/active tasks are NOT reboot-orphans', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 't823-orph-neg-'));
  const env = envFor(root);
  try {
    // (a) actually finished before reboot: DONE present ⇒ not an orphan.
    seedTask(root, 'finished', 'convF', {
      'result.json': '{"ok":true}',
      DONE: JSON.stringify({ exit_code: 0, signal: null }),
    });
    // (b) already delivered on a prior boot: in the ledger ⇒ not an orphan.
    seedTask(root, 'delivered', 'convD', {});
    writeLedgerEntries(env, 'convD', [{ taskId: 'delivered', handoffId: handoffId('delivered'), outcome: 'CRASHED' }]);
    // (c) still running (unit active) ⇒ not an orphan.
    seedTask(root, 'running', 'convR', { 'result.json.partial': 'streaming' });

    const deps: MonitorDeps = {
      env,
      probeUnitState: probeFor({ finished: 'inactive', delivered: 'gone', running: 'active' }),
      verifyDeliveryTarget: (): DeliveryTarget => ({ ok: true, jsonlPath: path.join(root, 'x.jsonl'), projectPath: '/p' }),
    };
    const rep = await reportRebootOrphansOnce(deps);
    assert.equal(rep.scanned, 3);
    assert.equal(rep.orphans, 0, 'none of finished/delivered/active is a reboot orphan');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
