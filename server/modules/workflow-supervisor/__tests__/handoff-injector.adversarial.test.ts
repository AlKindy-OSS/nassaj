/**
 * T-822 GATE (tester, adversarial) — two crash/race offsets the base injector
 * suite does not exercise, both proving exactly-once holds under coalescing:
 *
 *  (c) COALESCED crash at a NEW offset — the whole batch's turn COMMITTED (every
 *      ref is in the jsonl) but the process died BEFORE the single batch ledger
 *      write. A restart must REPAIR all of them (no re-run of the expensive turn),
 *      and the mixed case (some refs committed + one brand-new task) must inject
 *      ONLY the new one while repairing the rest — never a double for the batch.
 *
 *  (d) CONCURRENT injector race on ONE conversation — two injectForConversation
 *      calls racing on the same conversation (the "last budget unit" hazard) must
 *      be SERIALIZED by the per-conversation injector flock: exactly one delivers,
 *      the other DEFERS, so the turn runs once, the ledger has one entry, and the
 *      spend is charged once (no budget overrun, no double delivery).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  injectForConversation,
  type ConversationInjectInput,
  type InjectTaskInput,
  type ResumeTurnParams,
  type ResumeTurnResult,
} from '@/modules/workflow-supervisor/handoff-injector.js';
import {
  handoffId,
  injectionRefToken,
  readLedger,
  ledgerHasTask,
} from '@/modules/workflow-supervisor/handoff.js';
import { readSpend } from '@/modules/workflow-supervisor/handoff-budget.js';

function envFor(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, WORKFLOW_SUPERVISOR_STATE_DIR: root, ...extra };
}

function mkTask(root: string, taskId: string): InjectTaskInput {
  const taskDir = path.join(root, 'tasks', taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  return { taskId, userId: 7, outcome: 'SUCCEEDED', resultObj: { text: `result of ${taskId}` }, taskDir };
}

function inputFor(root: string, conv: string, tasks: InjectTaskInput[]): ConversationInjectInput {
  return { conversationId: conv, projectPath: path.join(root, 'proj'), jsonlPath: path.join(root, `${conv}.jsonl`), tasks };
}

/** Append a COMMITTED ref-anchored user line for a taskId, as the CLI would have
 * on a resumed turn that landed before the process died. */
function appendCommittedRef(jsonlPath: string, taskId: string): void {
  const ref = injectionRefToken(handoffId(taskId));
  fs.appendFileSync(
    jsonlPath,
    JSON.stringify({ type: 'user', message: { role: 'user', content: `<x ref="${ref}"/>` }, uuid: `u-${taskId}` }) + '\n',
  );
}

test('(c) coalesced crash: WHOLE batch committed, ledger absent ⇒ all repaired, NO re-turn, no double', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inj-coalcrash-'));
  const env = envFor(root);
  try {
    const tasks = [mkTask(root, 'k1'), mkTask(root, 'k2'), mkTask(root, 'k3')];
    const input = inputFor(root, 'convK', tasks);
    // The coalesced turn committed ALL three refs, then the process was killed in
    // the commit→ledger window (the NEW offset): the ledger never landed.
    for (const t of tasks) appendCommittedRef(input.jsonlPath, t.taskId);

    let called = 0;
    const run = async (_p: ResumeTurnParams): Promise<ResumeTurnResult> => {
      called++;
      return { ok: true, exitCode: 0, timedOut: false, resultObj: {} };
    };

    const r = await injectForConversation({ env, runResumeTurn: run }, input);

    assert.equal(r.event, 'repaired-only', 'the committed batch is repaired, not re-injected');
    assert.deepEqual(r.repaired.sort(), ['k1', 'k2', 'k3']);
    assert.deepEqual(r.injected, [], 'no task re-injected');
    assert.equal(called, 0, 'the expensive coalesced turn is NEVER re-run');
    const ledger = readLedger(env, 'convK');
    assert.equal(ledger!.entries!.length, 3, 'ledger repaired to exactly three (no duplicate)');
    // Idempotent: a second pass on the same batch is a pure ledger-hit no-op.
    const r2 = await injectForConversation({ env, runResumeTurn: run }, inputFor(root, 'convK', [mkTask(root, 'k1'), mkTask(root, 'k2'), mkTask(root, 'k3')]));
    assert.equal(r2.event, 'nothing-pending');
    assert.equal(called, 0, 'still no turn on the second pass');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('(c) mixed crash: 2 refs committed + 1 NEW task ⇒ ONLY the new one injects, the rest repaired (no double)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inj-mixcrash-'));
  const env = envFor(root);
  try {
    const committed = [mkTask(root, 'm1'), mkTask(root, 'm2')];
    const fresh = mkTask(root, 'm3');
    const input = inputFor(root, 'convM', [...committed, fresh]);
    for (const t of committed) appendCommittedRef(input.jsonlPath, t.taskId);

    const calls: ResumeTurnParams[] = [];
    const run = async (p: ResumeTurnParams): Promise<ResumeTurnResult> => {
      calls.push(p);
      // simulate the CLI committing the fresh task's ref for THIS turn
      appendCommittedRef(input.jsonlPath, 'm3');
      return { ok: true, exitCode: 0, timedOut: false, resultObj: { usage: { input_tokens: 100, output_tokens: 20 } } };
    };

    const r = await injectForConversation({ env, runResumeTurn: run }, input);

    assert.equal(r.event, 'delivered');
    assert.deepEqual(r.repaired.sort(), ['m1', 'm2'], 'the two committed refs are repaired');
    assert.deepEqual(r.injected, ['m3'], 'only the genuinely-new task is injected');
    assert.equal(calls.length, 1, 'exactly one turn, carrying ONLY the new task');
    assert.ok(calls[0]!.prompt.includes(injectionRefToken(handoffId('m3'))), 'the turn prompt has the new ref');
    assert.ok(!calls[0]!.prompt.includes(injectionRefToken(handoffId('m1'))), 'the committed refs are NOT re-sent');
    const ledger = readLedger(env, 'convM');
    assert.equal(ledger!.entries!.length, 3, 'ledger has all three exactly once');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('(d) concurrent race on ONE conversation ⇒ injector flock serializes: one delivers, one defers, charged once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'inj-race-'));
  // Budget headroom for exactly ONE turn — the point is that the flock (not the
  // budget) is what prevents the second concurrent turn.
  const env = envFor(root, { WORKFLOW_SUPERVISOR_HANDOFF_TOKENS_CONV_MAX: '200000' });
  try {
    const jsonlPath = path.join(root, 'convR.jsonl');
    // Two DIFFERENT tasks, same conversation, racing.
    const inA = inputFor(root, 'convR', [mkTask(root, 'ra')]);
    const inB = inputFor(root, 'convR', [mkTask(root, 'rb')]);

    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    // A runner that HOLDS (sleeps) while "running the turn" so the racer collides
    // on the per-conversation lock, and that records the peak concurrency.
    const run = async (p: ResumeTurnParams): Promise<ResumeTurnResult> => {
      calls++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 250));
      fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'user', message: { role: 'user', content: p.prompt }, uuid: 'u' }) + '\n');
      concurrent--;
      return { ok: true, exitCode: 0, timedOut: false, resultObj: { usage: { input_tokens: 1000, output_tokens: 300 } } };
    };

    const [ra, rb] = await Promise.all([
      injectForConversation({ env, runResumeTurn: run }, inA),
      injectForConversation({ env, runResumeTurn: run }, inB),
    ]);

    const events = [ra.event, rb.event].sort();
    assert.deepEqual(events, ['deferred', 'delivered'], 'exactly one delivered + one deferred');
    assert.equal(calls, 1, 'the turn ran exactly ONCE (the flock blocked the racer)');
    assert.equal(maxConcurrent, 1, 'the two turns were never in flight at the same time');
    // Charged once, ledger holds exactly the delivered task.
    assert.equal(readSpend(env, 'conv', 'convR').tokens, 1300, 'spend charged for one turn only (no overrun)');
    const ledger = readLedger(env, 'convR');
    assert.equal(ledger!.entries!.length, 1, 'exactly one ledger entry (no double delivery)');
    const deliveredTask = ra.event === 'delivered' ? 'ra' : 'rb';
    assert.ok(ledgerHasTask(ledger, deliveredTask));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
