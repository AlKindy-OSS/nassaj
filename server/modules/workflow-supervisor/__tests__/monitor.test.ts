/**
 * T-821 — the monitor DELIVERY cycle on server code. Proves reconcile/monitor/
 * deliver end-to-end over real on-disk task dirs + jsonl:
 *   - a terminal task delivers exactly one card, idempotent across repeated passes,
 *   - the C2 ownership gate refuses a conversation the requester does not own
 *     (zero card written),
 *   - a still-running task is not delivered,
 *   - the authoritative jsonl path comes from verifyDeliveryTarget (the DB), not
 *     from the web-supplied conversationId.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { reconcileAndDeliverOnce, type MonitorDeps, type DeliveryTarget } from '@/modules/workflow-supervisor/monitor.js';
import { handoffId } from '@/modules/workflow-supervisor/handoff.js';
import type { DurableTask } from '@/modules/workflow-supervisor/intent.js';

function envFor(root: string): NodeJS.ProcessEnv {
  return { ...process.env, WORKFLOW_SUPERVISOR_STATE_DIR: root };
}

function seedTask(root: string, taskId: string, files: Record<string, string>): DurableTask {
  const dir = path.join(root, 'tasks', taskId);
  fs.mkdirSync(dir, { recursive: true });
  const task: DurableTask = {
    schema_version: '2',
    taskId,
    userId: 1,
    projectPath: '/home/owner/proj',
    conversationId: 'conv1',
    originMessageId: 'm1',
    spec: { scriptOrPrompt: 'run', model: null, effort: null, handoffPolicy: 'card-only', leafOnly: true },
    requestedAt: new Date(0).toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify(task));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return task;
}

function validCards(jsonl: string, hId: string): unknown[] {
  if (!fs.existsSync(jsonl)) {
    return [];
  }
  return fs
    .readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((o): o is { handoffId?: string } => !!o && (o as { handoffId?: string }).handoffId === hId);
}

test('terminal task delivers exactly one card, idempotent across passes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mon-ok-'));
  const env = envFor(root);
  const jsonl = path.join(root, 'conv1.jsonl');
  try {
    const task = seedTask(root, 'taskOK', {
      'result.json': '{"ok":true}',
      DONE: JSON.stringify({ exit_code: 0, signal: null }),
    });
    const deps: MonitorDeps = {
      env,
      probeUnitState: async () => 'inactive',
      verifyDeliveryTarget: (): DeliveryTarget => ({ ok: true, jsonlPath: jsonl, projectPath: task.projectPath }),
      graceMs: 0,
      sleep: async () => {},
    };
    const p1 = await reconcileAndDeliverOnce(deps);
    assert.equal(p1.delivered, 1);
    await reconcileAndDeliverOnce(deps);
    await reconcileAndDeliverOnce(deps);
    assert.equal(validCards(jsonl, handoffId('taskOK')).length, 1, 'exactly one card across 3 passes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('C2 ownership denial ⇒ no card written', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mon-deny-'));
  const env = envFor(root);
  const jsonl = path.join(root, 'conv1.jsonl');
  try {
    seedTask(root, 'taskDeny', {
      'result.json': '{"ok":true}',
      DONE: JSON.stringify({ exit_code: 0, signal: null }),
    });
    const deps: MonitorDeps = {
      env,
      probeUnitState: async () => 'inactive',
      verifyDeliveryTarget: (): DeliveryTarget => ({ ok: false, reason: 'not owned' }),
      graceMs: 0,
      sleep: async () => {},
    };
    const p = await reconcileAndDeliverOnce(deps);
    assert.equal(p.delivered, 0);
    assert.equal(fs.existsSync(jsonl), false, 'no card jsonl created for a denied target');
    // The denial is audited.
    const audit = fs.readFileSync(path.join(root, 'tasks', 'taskDeny', 'audit.log'), 'utf8');
    assert.match(audit, /delivery-denied/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a still-running task is not delivered', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mon-run-'));
  const env = envFor(root);
  const jsonl = path.join(root, 'conv1.jsonl');
  try {
    seedTask(root, 'taskRun', { 'result.json.partial': 'streaming' });
    const deps: MonitorDeps = {
      env,
      probeUnitState: async () => 'active',
      verifyDeliveryTarget: (): DeliveryTarget => ({ ok: true, jsonlPath: jsonl, projectPath: '/p' }),
      sleep: async () => {},
    };
    const p = await reconcileAndDeliverOnce(deps);
    assert.equal(p.delivered, 0);
    assert.equal(p.pending, 1);
    assert.equal(fs.existsSync(jsonl), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('T-822 routing: shouldDeliverTierA=false skips a Tier-B task (no card); card-only still delivered', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mon-route-'));
  const env = envFor(root);
  const jsonl = path.join(root, 'conv1.jsonl');
  try {
    // Two terminal tasks: one card-only, one auto-turn (Tier-B).
    seedTask(root, 'cardTask', {
      'result.json': '{"ok":true}',
      DONE: JSON.stringify({ exit_code: 0, signal: null }),
    });
    const autoDir = path.join(root, 'tasks', 'autoTask');
    fs.mkdirSync(autoDir, { recursive: true });
    fs.writeFileSync(
      path.join(autoDir, 'task.json'),
      JSON.stringify({
        schema_version: '2',
        taskId: 'autoTask',
        userId: 1,
        projectPath: '/p',
        conversationId: 'conv1',
        originMessageId: 'm',
        spec: { scriptOrPrompt: 'x', model: null, effort: null, handoffPolicy: 'auto-turn', leafOnly: true },
        requestedAt: new Date(0).toISOString(),
      }),
    );
    fs.writeFileSync(path.join(autoDir, 'result.json'), '{"ok":true}');
    fs.writeFileSync(path.join(autoDir, 'DONE'), JSON.stringify({ exit_code: 0, signal: null }));

    const deps: MonitorDeps = {
      env,
      probeUnitState: async () => 'inactive',
      verifyDeliveryTarget: (): DeliveryTarget => ({ ok: true, jsonlPath: jsonl, projectPath: '/p' }),
      graceMs: 0,
      sleep: async () => {},
      // The routing predicate the supervisor uses when the T-822 flag is on.
      shouldDeliverTierA: (task) => task.spec.handoffPolicy === 'card-only',
    };
    const p = await reconcileAndDeliverOnce(deps);
    assert.equal(p.delivered, 1, 'only the card-only task delivered a card');
    assert.equal(validCards(jsonl, handoffId('cardTask')).length, 1);
    assert.equal(validCards(jsonl, handoffId('autoTask')).length, 0, 'Tier-B task left for the injector pass');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('crashed task (DONE with signal) delivers a settled card exactly once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mon-crash-'));
  const env = envFor(root);
  const jsonl = path.join(root, 'conv1.jsonl');
  try {
    seedTask(root, 'taskCrash', { DONE: JSON.stringify({ exit_code: null, signal: 'SIGKILL' }) });
    const deps: MonitorDeps = {
      env,
      probeUnitState: async () => 'failed',
      verifyDeliveryTarget: (): DeliveryTarget => ({ ok: true, jsonlPath: jsonl, projectPath: '/p' }),
      graceMs: 0,
      sleep: async () => {},
    };
    await reconcileAndDeliverOnce(deps);
    const cards = validCards(jsonl, handoffId('taskCrash')) as Array<{ taskStatus?: string; backgroundTaskOutcome?: string }>;
    assert.equal(cards.length, 1);
    assert.equal(cards[0]!.taskStatus, 'settled');
    assert.equal(cards[0]!.backgroundTaskOutcome, 'CRASHED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
