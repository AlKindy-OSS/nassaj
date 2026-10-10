/**
 * ADR-199 P5: agy plan (brain task.md) and subagents (invoke_subagent) at turn
 * end, live and history, on the LAST turn only.
 *
 * Fixture `agy-progress.real.json` (see its `_provenance`): a real agy smoke
 * transcript that invoked one subagent, and three real task.md files. The
 * brain tree is rebuilt under a temp root for each case.
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

// B-1564: history reads only brains under a provider root; numbered member trees are such roots.
const sandbox = path.join(os.homedir(), '.nassaj-users');
fs.mkdirSync(sandbox, { recursive: true });
let jsonlPath = '';
mock.module('@/modules/database/index.js', { namedExports: {
  sessionsDb: { getSessionById: () => ({ jsonl_path: jsonlPath }) },
  providerRunFailuresDb: { getFailure: () => null },
} });
const progress = await import('../agy-progress.js');
const { AGY_BRAIN_UNDER_HOME } = await import('../agy-brain-layout.js');
const { AntigravitySessionsProvider } = await import('../antigravity-sessions.provider.js');
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

type Row = Record<string, any>;
const real = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '__fixtures__', 'agy-progress.real.json'), 'utf8')) as Row;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const BRAIN: string = real.brainUUID;
const CHILD: string = real.childUUID;
const jsonl = (rows: Row[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
let counter = 0;

/** Writes `<root>/brain/<uuid>/{task.md, .system_generated/logs/transcript.jsonl}`; returns the brain root. */
function brainTree(rows: Row[], task: string | null, uuid = BRAIN): string {
  const root = path.join(sandbox, String(counter++), AGY_BRAIN_UNDER_HOME);
  const logs = path.join(root, uuid, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript.jsonl'), jsonl(rows));
  if (task !== null) fs.writeFileSync(path.join(root, uuid, 'task.md'), task);
  return root;
}

/** The real one-turn transcript followed by a second real-shaped turn (cloned steps). */
function twoTurns(): Row[] {
  const first = copy(real.transcript) as Row[];
  const userInput = { ...copy(first[0]), step_index: 6, created_at: '2026-09-27T21:20:00Z' };
  const reply = { ...copy(first[5]), step_index: 7, created_at: '2026-09-27T21:20:05Z' };
  return [...first, userInput, reply];
}

test('checklist: [x] done, [/] in progress, [ ] pending; backtick boxes and links read as text', () => {
  const plan = progress.agyChecklistPlan(real.taskInProgress);
  assert.deepEqual(plan?.items.map((item: Row) => item.status),
    ['completed', 'completed', 'in_progress', 'pending', 'pending']);
  assert.deepEqual(plan?.counts, { done: 2, total: 5 });
  assert.equal(plan?.source, 'artifact');
  assert.deepEqual(progress.agyChecklistPlan(real.taskBackticks)?.counts, { done: 7, total: 7 });
  const linked = progress.agyChecklistPlan(real.taskLinks);
  assert.ok(linked?.items.every((item: Row) => !item.label.includes('file://') && !item.label.includes('`')));
  assert.equal(linked?.items[0].label, 'file-1.ts step 1');
  assert.equal(progress.agyChecklistPlan('# heading only\nplain text'), null);
});

test('invoke_subagent: role label only, completed once the child reports back', () => {
  const steps = progress.summarizeAgyTranscript(jsonl(real.transcript));
  const rows = progress.buildAgyTurnProgressRows({ steps, afterStepIndex: -1, brainUUID: BRAIN, sessionId: BRAIN, plan: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'status');
  assert.deepEqual(rows[0].subagent, { id: `antigravity_${BRAIN}_progress_0_agent_0`, parentId: null, label: 'scribe', state: 'completed' });
  assert.ok(!JSON.stringify(rows).includes('prompt text'), 'the prompt never leaks into the label');

  const unreported = copy(real.transcript).filter((row: Row) => !String(row.content ?? '').includes(`sender=${CHILD}`));
  const [running] = progress.buildAgyTurnProgressRows({
    steps: progress.summarizeAgyTranscript(jsonl(unreported)), afterStepIndex: -1, brainUUID: BRAIN, sessionId: BRAIN, plan: null,
  });
  assert.equal(running.subagent.state, 'running');
});

test('history: plan and subagents land on the LAST turn only, after its steps', async () => {
  const rows = twoTurns();
  const root = brainTree(rows, real.taskInProgress);
  jsonlPath = path.join(root, BRAIN, '.system_generated', 'logs', 'transcript.jsonl');
  const { messages } = await new AntigravitySessionsProvider().fetchHistory(BRAIN);
  const progressRows = messages.filter((row: Row) => row.plan || row.subagent);
  assert.equal(progressRows.length, 1, 'the first turn\'s subagent is not re-stamped on the last turn');
  assert.equal(progressRows[0].id, `antigravity_${BRAIN}_progress_6_plan`);
  assert.deepEqual(progressRows[0].plan.counts, { done: 2, total: 5 });
  assert.equal(messages.indexOf(progressRows[0]), messages.length - 1);
  assert.equal(progressRows[0].timestamp, '2026-09-27T21:20:05Z');
});

test('history: a single-turn conversation carries its plan and subagent', async () => {
  const root = brainTree(copy(real.transcript), real.taskBackticks);
  jsonlPath = path.join(root, BRAIN, '.system_generated', 'logs', 'transcript.jsonl');
  const { messages } = await new AntigravitySessionsProvider().fetchHistory(BRAIN);
  const ids = messages.filter((row: Row) => row.plan || row.subagent).map((row: Row) => row.id);
  assert.deepEqual(ids, [`antigravity_${BRAIN}_progress_0_plan`, `antigravity_${BRAIN}_progress_0_agent_0`]);
});

test('live and history build the same ids for the same turn', () => {
  const steps = progress.summarizeAgyTranscript(jsonl(twoTurns()));
  const plan = progress.agyChecklistPlan(real.taskInProgress);
  const live = progress.buildAgyTurnProgressRows({ steps, afterStepIndex: 5, brainUUID: BRAIN, sessionId: 'agy_spawn', plan });
  const history = progress.buildAgyTurnProgressRows({
    steps, afterStepIndex: progress.lastAgyTurnBaseline(steps), brainUUID: BRAIN, sessionId: BRAIN, plan,
  });
  assert.deepEqual(live.map((row: Row) => row.id), history.map((row: Row) => row.id));
});

test('task.md is read only inside the given brain root', async () => {
  const root = brainTree(copy(real.transcript), real.taskInProgress);
  assert.ok(await progress.readAgyTaskFile(root, BRAIN));
  assert.equal(await progress.readAgyTaskFile(root, '../outside'), null, 'not a uuid');
  assert.equal(await progress.readAgyTaskFile(root, CHILD), null, 'absent brain');

  // A brain dir that is a symlink to another user's brain is refused.
  const other = brainTree(copy(real.transcript), real.taskBackticks, CHILD);
  const linkedRoot = path.join(sandbox, `case-${counter++}`, 'brain');
  fs.mkdirSync(linkedRoot, { recursive: true });
  fs.symlinkSync(path.join(other, CHILD), path.join(linkedRoot, CHILD));
  assert.equal(await progress.readAgyTaskFile(linkedRoot, CHILD), null);

  // A task.md that is itself a symlink is refused.
  fs.rmSync(path.join(root, BRAIN, 'task.md'));
  fs.symlinkSync(path.join(other, CHILD, 'task.md'), path.join(root, BRAIN, 'task.md'));
  assert.equal(await progress.readAgyTaskFile(root, BRAIN), null);

  // A symlinked ROOT (as on the operator's per-user tree) still resolves inside itself.
  const aliasRoot = path.join(sandbox, `case-${counter++}`);
  fs.mkdirSync(aliasRoot);
  fs.symlinkSync(other, path.join(aliasRoot, 'brain'));
  assert.ok(await progress.readAgyTaskFile(path.join(aliasRoot, 'brain'), CHILD));
});

test('a transcript path outside the brain layout yields no brain', () => {
  assert.equal(progress.agyBrainOfTranscript('/x/brain/not-a-uuid/.system_generated/logs/transcript.jsonl'), null);
  assert.equal(progress.agyBrainOfTranscript(`/x/brain/${BRAIN}/transcript.jsonl`), null);
  assert.equal(progress.agyBrainOfTranscript('relative/path'), null);
  assert.deepEqual(progress.agyBrainOfTranscript(`/x/brain/${BRAIN}/.system_generated/logs/transcript.jsonl`),
    { brainRoot: '/x/brain', brainUUID: BRAIN });
});
