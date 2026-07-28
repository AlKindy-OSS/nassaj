/**
 * T-822 — the monitor's Tier-B pass (routing + coalescing orchestration). Proves,
 * with stubbed unit probe / C2 / resume runner and real on-disk task dirs:
 *  - policy routing: card-only is SKIPPED (owned by the Tier-A pass); auto-turn is
 *    eligible; on-demand is eligible ONLY with a `handoff-requested` trigger,
 *  - grouping: two SUCCEEDED auto-turn tasks on ONE conversation ⇒ ONE turn,
 *  - non-success (CRASHED) ⇒ a Tier-A card, NEVER a turn (no quota on failure),
 *  - C2 denial ⇒ no delivery to a non-owned conversation.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deliverTierBOnce, type TierBDeps } from '@/modules/workflow-supervisor/tierb-pass.js';
import type { ResumeTurnParams, ResumeTurnResult } from '@/modules/workflow-supervisor/handoff-injector.js';
import type { DeliveryTarget } from '@/modules/workflow-supervisor/monitor.js';
import type { HandoffPolicy } from '@/modules/workflow-supervisor/intent.js';

function envFor(root: string): NodeJS.ProcessEnv {
  return { ...process.env, WORKFLOW_SUPERVISOR_STATE_DIR: root, WORKFLOW_SUPERVISOR_RECONCILE_GRACE_MS: '0' };
}

/** Seed a terminal task dir (task.json + DONE + result.json/signal). */
function seedTask(
  root: string,
  opts: {
    taskId: string;
    conv: string;
    policy: HandoffPolicy;
    outcome: 'SUCCEEDED' | 'CRASHED';
    requested?: boolean;
  },
): void {
  const dir = path.join(root, 'tasks', opts.taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'task.json'),
    JSON.stringify({
      schema_version: '2',
      taskId: opts.taskId,
      userId: 7,
      projectPath: path.join(root, 'proj'),
      conversationId: opts.conv,
      originMessageId: 'm',
      spec: { scriptOrPrompt: 'x', model: null, effort: null, handoffPolicy: opts.policy, leafOnly: true },
      requestedAt: new Date(0).toISOString(),
    }),
  );
  if (opts.outcome === 'SUCCEEDED') {
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ok: true, task: opts.taskId }));
    fs.writeFileSync(path.join(dir, 'DONE'), JSON.stringify({ exit_code: 0, signal: null, finalizedAt: '' }));
  } else {
    fs.writeFileSync(path.join(dir, 'DONE'), JSON.stringify({ exit_code: null, signal: 'SIGKILL', finalizedAt: '' }));
  }
  if (opts.requested) {
    fs.writeFileSync(path.join(dir, 'handoff-requested'), '1');
  }
}

function makeDeps(root: string, jsonlByConv: Record<string, string>): {
  deps: TierBDeps;
  calls: ResumeTurnParams[];
  denied: Set<string>;
} {
  const calls: ResumeTurnParams[] = [];
  const denied = new Set<string>();
  const run = async (p: ResumeTurnParams): Promise<ResumeTurnResult> => {
    calls.push(p);
    fs.appendFileSync(
      jsonlByConv[p.conversationId]!,
      JSON.stringify({ type: 'user', message: { role: 'user', content: p.prompt }, uuid: 'u' }) + '\n',
    );
    return { ok: true, exitCode: 0, timedOut: false, resultObj: { usage: { input_tokens: 10, output_tokens: 5 } } };
  };
  const deps: TierBDeps = {
    env: envFor(root),
    probeUnitState: async () => 'gone',
    verifyDeliveryTarget: (conv): DeliveryTarget =>
      denied.has(conv)
        ? { ok: false, reason: 'not owned' }
        : { ok: true, jsonlPath: jsonlByConv[conv]!, projectPath: path.join(root, 'proj') },
    runResumeTurn: run,
    graceMs: 0,
  };
  return { deps, calls, denied };
}

test('routing: card-only skipped, auto-turn injects, on-demand needs a trigger', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tb-route-'));
  try {
    const jsonl = { convA: path.join(root, 'convA.jsonl') };
    seedTask(root, { taskId: 'card1', conv: 'convA', policy: 'card-only', outcome: 'SUCCEEDED' });
    seedTask(root, { taskId: 'auto1', conv: 'convA', policy: 'auto-turn', outcome: 'SUCCEEDED' });
    seedTask(root, { taskId: 'od-no', conv: 'convA', policy: 'on-demand', outcome: 'SUCCEEDED', requested: false });
    seedTask(root, { taskId: 'od-yes', conv: 'convA', policy: 'on-demand', outcome: 'SUCCEEDED', requested: true });
    const { deps, calls } = makeDeps(root, jsonl);

    const r = await deliverTierBOnce(deps);
    // card1 skipped (Tier-A owns it); od-no awaits trigger; auto1 + od-yes inject.
    assert.equal(calls.length, 1, 'a single coalesced turn');
    assert.equal(r.injected, 2, 'auto1 + od-yes injected; card1 + od-no not');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('grouping: two SUCCEEDED auto-turn tasks on one conversation ⇒ ONE turn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tb-group-'));
  try {
    const jsonl = { convG: path.join(root, 'convG.jsonl') };
    seedTask(root, { taskId: 'g1', conv: 'convG', policy: 'auto-turn', outcome: 'SUCCEEDED' });
    seedTask(root, { taskId: 'g2', conv: 'convG', policy: 'auto-turn', outcome: 'SUCCEEDED' });
    const { deps, calls } = makeDeps(root, jsonl);
    const r = await deliverTierBOnce(deps);
    assert.equal(calls.length, 1, 'coalesced into one turn');
    assert.equal(r.injected, 2);
    assert.equal(r.conversations, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('non-success (CRASHED) ⇒ Tier-A card, NEVER a turn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tb-crash-'));
  try {
    const jsonl = { convC: path.join(root, 'convC.jsonl') };
    seedTask(root, { taskId: 'x1', conv: 'convC', policy: 'auto-turn', outcome: 'CRASHED' });
    const { deps, calls } = makeDeps(root, jsonl);
    const r = await deliverTierBOnce(deps);
    assert.equal(calls.length, 0, 'no quota burned on a crash');
    assert.equal(r.cards, 1, 'delivered as a card instead');
    const line = fs.readFileSync(jsonl.convC, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))[0];
    assert.equal(line.kind, 'task_reconcile');
    assert.equal(line.backgroundTaskOutcome, 'CRASHED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('C2 denial ⇒ no delivery to a non-owned conversation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tb-deny-'));
  try {
    const jsonl = { convD: path.join(root, 'convD.jsonl') };
    seedTask(root, { taskId: 'y1', conv: 'convD', policy: 'auto-turn', outcome: 'SUCCEEDED' });
    const { deps, calls, denied } = makeDeps(root, jsonl);
    denied.add('convD');
    const r = await deliverTierBOnce(deps);
    assert.equal(calls.length, 0);
    assert.equal(r.denied, 1);
    assert.ok(!fs.existsSync(jsonl.convD), 'nothing written to the non-owned target');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
