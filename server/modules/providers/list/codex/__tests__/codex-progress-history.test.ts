/**
 * ADR-199 P4a: Codex `plan`/`subagent` on the history path (live: codex-progress.test.ts).
 *
 * Fixture `codex-progress.real.json` (see its `_provenance`): a real
 * `codex exec --json` stream (collab_tool_call wait), the rollout of the same
 * thread (spawn_agent, wait_agent, SubAgentActivity, FINAL_ANSWER) and the one
 * real `update_plan` call on this host. No real `todo_list` stream item exists
 * here (update_plan is not offered under `codex exec`), so the live todo_list
 * case maps that real call's steps into the SDK `TodoListItem` shape.
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test, mock } from 'node:test';
import { codexSessionsSandbox, withPinnedTranscript } from '@/shared/__tests__/provider-root-sandbox.js';

const sandbox = codexSessionsSandbox('codex-progress-');
const transcript = path.join(sandbox, 'rollout.jsonl');
mock.module('@/modules/database/index.js', { namedExports: {
  sessionsDb: { getSessionById: () => ({ jsonl_path: transcript }) },
  appConfigDb: { getOrCreateJwtSecret: () => 'synthetic-history-cursor-key' },
} });
const { CodexSessionsProvider } = await import('../codex-sessions.provider.js');
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

type Row = Record<string, any>;
const real = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '__fixtures__', 'codex-progress.real.json'), 'utf8')) as Row;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const provider = new CodexSessionsProvider();
const planArgs = () => JSON.parse(real.updatePlan.payload.arguments) as { plan: Array<{ step: string; status: string }> };

async function history(lines: Row[]) {
  fs.writeFileSync(transcript, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const result = await withPinnedTranscript(transcript, 'codex-progress-session', 'codex',
    (pinned) => provider.fetchHistory('codex-progress-session', { transcript: pinned }));
  return result.messages as Row[];
}

test('history spawn_agent: the Task row carries the subagent, settled by its FINAL_ANSWER', async () => {
  const messages = await history(copy(real.rollout));
  const withSubagent = messages.filter((row) => row.subagent);
  assert.equal(withSubagent.length, 1, 'wait_agent and SubAgentActivity add no subagent rows');
  const [task] = withSubagent;
  assert.equal(task.kind, 'tool_use');
  assert.equal(task.toolId, 'call_e5656dae1b7a404980a968644f059dc3');
  assert.equal(task.subagent.id, task.toolId);
  assert.equal(task.subagent.label, JSON.parse(task.toolInput).description);
  assert.equal(task.subagent.state, 'completed', 'the folded result row settles it');
  assert.equal(task.toolResult.content, 'OK');
  assert.ok(!JSON.stringify(task.subagent).includes('gAAAA'), 'never the encrypted message');
});

test('history spawn_agent without its FINAL_ANSWER stays started', async () => {
  const rows = copy(real.rollout).filter((row: Row) => row.payload.type !== 'agent_message');
  const [task] = (await history(rows)).filter((row) => row.subagent);
  assert.equal(task.subagent.state, 'started');
  assert.equal(task.toolResult, undefined);
});

test('history update_plan: the real call becomes a plan; excluded steps leave, unknown is pending', async () => {
  const [plan] = (await history([copy(real.updatePlan)])).filter((row) => row.plan).map((row) => row.plan);
  assert.deepEqual(plan.items.map((item: Row) => item.status), ['in_progress', 'pending', 'pending', 'pending', 'pending']);
  assert.deepEqual(plan.counts, { done: 0, total: 5 });

  const edited = copy(real.updatePlan);
  const args = planArgs();
  args.plan[0].status = 'completed';
  args.plan[1].status = 'cancelled';
  args.plan[2].status = 'blocked';
  edited.payload.arguments = JSON.stringify(args);
  const [next] = (await history([edited])).filter((row) => row.plan).map((row) => row.plan);
  assert.deepEqual(next.items.map((item: Row) => item.status), ['completed', 'pending', 'pending', 'pending']);
  assert.deepEqual(next.counts, { done: 1, total: 4 });
});
