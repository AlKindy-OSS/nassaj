/**
 * ADR-199 P4a: Codex `plan`/`subagent` on the live path (history: codex-progress-history.test.ts).
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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { transformCodexEvent } from '../../../../../openai-codex.js';
import { codexSpawnSubagent, createCodexLiveProgressPhases, stampCodexProgressPhase } from '../codex-progress.js';
import { CodexSessionsProvider } from '../codex-sessions.provider.js';
import { readCodexRolloutMetadata } from '../codex-rollout-links.js';

type Row = Record<string, any>;
const real = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '__fixtures__', 'codex-progress.real.json'), 'utf8')) as Row;
const spawnArgsPath = path.join(import.meta.dirname, '__fixtures__',
  'codex-spawn-agent-args.real.json');
const realSpawnArgs = JSON.parse(fs.readFileSync(spawnArgsPath, 'utf8')) as Row;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const provider = new CodexSessionsProvider();
const NONCE = 'nonce-test';

/** Mirrors the openai-codex.js loop: transform, phase gate, normalize. */
function runLive(events: Row[]) {
  const phases = createCodexLiveProgressPhases();
  const rows: Row[] = [];
  for (const event of events) {
    const transformed = transformCodexEvent(event, NONCE) as Row;
    if (!event.type.startsWith('item.')) continue;
    if (!stampCodexProgressPhase(phases, event.type, event.item, transformed)) continue;
    rows.push(...provider.normalizeMessage(transformed, 'sess'));
  }
  return rows;
}

const collabEvents = (): Row[] => copy(real.stream).filter((event: Row) => event.item?.type === 'collab_tool_call');
const planArgs = () => JSON.parse(real.updatePlan.payload.arguments) as { plan: Array<{ step: string; status: string }> };

test('spawn_agent task_name remains a fallback description, not a role name', () => {
  const spawn = real.rollout.find((entry: Row) => entry.type === 'response_item'
    && entry.payload?.type === 'function_call' && entry.payload.name === 'spawn_agent');
  const args = JSON.parse(spawn.payload.arguments) as { task_name: string };
  const normalized = codexSpawnSubagent(spawn.payload.call_id, args.task_name, 'started');
  assert.equal(normalized?.label, 'agent_1');
  assert.equal(normalized?.agentName, undefined);
  const captured = codexSpawnSubagent(spawn.payload.call_id, args.task_name, 'started', {
    agentType: realSpawnArgs.agent_type,
    effort: realSpawnArgs.reasoning_effort,
  });
  assert.equal(captured?.agentName, 'brand-marketer');
  assert.equal(captured?.effort, 'medium');
});

test('child rollout reads model, effort and post-fork tool calls from real rows', async () => {
  const rows = JSON.parse(fs.readFileSync(path.join(import.meta.dirname,
    '__fixtures__/codex-child-rollout.real.json'), 'utf8')) as Row[];
  const tempRoot = process.env.TMPDIR || os.tmpdir();
  const directory = await mkdtemp(path.join(tempRoot, 'codex-child-rollout-'));
  const rollout = path.join(directory,
    'rollout-11111111-1111-4111-8111-111111111111.jsonl');
  try {
    await writeFile(rollout, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const child = await readCodexRolloutMetadata(rollout);
    assert.equal(child.parentThreadId, '33333333-3333-4333-8333-333333333333');
    assert.equal(child.agentPath, '/root/agent_1');
    assert.equal(child.model, 'gpt-6-luna');
    assert.equal(child.effort, 'high');
    assert.deepEqual(child.tools, [{
      id: 'call_scrubbed', name: 'send_message', status: 'completed',
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Real update_plan steps in the SDK TodoListItem shape (the SDK carries only `completed`). */
function todoEvent(type: string, doneCount: number): Row {
  const items = planArgs().plan.map((step, index) => ({ text: step.step, completed: index < doneCount }));
  return { type, item: { id: 'item_9', type: 'todo_list', items } };
}

test('live collab_tool_call: started opens a running card, completed settles it by toolId', () => {
  const rows = runLive(collabEvents());
  assert.equal(rows.length, 2);
  const [open, settle] = rows;
  const id = `codex-${NONCE}-item_5`;
  assert.equal(open.kind, 'tool_use');
  assert.equal(open.id, id);
  assert.equal(open.toolResult, undefined, 'no inline result while agents work');
  assert.deepEqual(open.subagent, { id, parentId: null, label: '', state: 'running' });
  assert.equal(settle.kind, 'tool_result');
  assert.equal(settle.toolId, id);
  assert.notEqual(settle.id, id, 'a distinct id, since the client keeps the first row per id');
  assert.deepEqual(settle.subagent, { id, parentId: null, label: '', state: 'completed' });
});

test('live collab_tool_call: a completion without a seen start keeps one settled card', () => {
  const rows = runLive(collabEvents().filter((event) => event.type === 'item.completed'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'tool_use');
  assert.deepEqual(rows[0].toolResult, { content: '', isError: false });
  assert.equal(rows[0].subagent.state, 'completed');
});

test('live collab_tool_call: a failed status fails the record', () => {
  const events = collabEvents();
  events[1].item.status = 'failed';
  assert.equal(runLive(events)[1].subagent.state, 'failed');
});

test('live: other items still forward only item.completed', () => {
  const started = { type: 'item.started', item: { id: 'item_2', type: 'command_execution', status: 'in_progress' } };
  const phases = createCodexLiveProgressPhases();
  assert.equal(stampCodexProgressPhase(phases, 'item.started', started.item, transformCodexEvent(started, NONCE)), false);
  assert.equal(stampCodexProgressPhase(phases, 'item.completed', started.item, transformCodexEvent(started, NONCE)), true);
});

test('live todo_list: start, update and completion carry the newest plan with full counts', () => {
  const rows = runLive([todoEvent('item.started', 0), todoEvent('item.updated', 2), todoEvent('item.completed', 5)]);
  assert.deepEqual(rows.map((row) => row.kind), ['tool_use', 'tool_result', 'tool_result']);
  assert.equal(new Set(rows.map((row) => row.id)).size, 3);
  assert.ok(rows.every((row) => row.toolId === `codex-${NONCE}-item_9`));
  assert.deepEqual(rows.map((row) => row.plan.counts), [{ done: 0, total: 5 }, { done: 2, total: 5 }, { done: 5, total: 5 }]);
  assert.equal(rows[0].plan.items[0].label, planArgs().plan[0].step);
  assert.equal(rows[0].plan.source, 'tool');
});
