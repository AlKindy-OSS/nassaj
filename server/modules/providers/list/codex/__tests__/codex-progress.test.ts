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
import path from 'node:path';
import { test } from 'node:test';

import { transformCodexEvent } from '../../../../../openai-codex.js';
import { createCodexLiveProgressPhases, stampCodexProgressPhase } from '../codex-progress.js';
import { CodexSessionsProvider } from '../codex-sessions.provider.js';

type Row = Record<string, any>;
const real = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '__fixtures__', 'codex-progress.real.json'), 'utf8')) as Row;
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

