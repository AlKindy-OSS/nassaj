/**
 * ADR-199 Addendum B (B-1560, P3): OpenCode tool parts, plan and subagent.
 *
 * The fixture is the real `opencode run --format json` capture (OpenCode
 * 1.18.34) plus the same session's message/part rows, scrubbed. Live and
 * history both go through `openCodeToolPart`, so they must agree.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { OpenCodeSessionsProvider } from './opencode-sessions.provider.js';
import { openCodeToolPart } from './opencode-tool-part.js';

type AnyRecord = Record<string, any>;

const fixture = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '__fixtures__', 'opencode-progress.real.json'), 'utf8')) as AnyRecord;
const provider = new OpenCodeSessionsProvider();
const SESSION = fixture.sessionId as string;

const live = () => (fixture.stream as AnyRecord[]).flatMap((line) => provider.normalizeMessage(line, null));
const historyOf = (rows: AnyRecord[]) => (provider as any).normalizeHistoryRows(rows.map((row) => ({
  ...row,
  message_data: JSON.stringify(row.message_data),
  part_data: row.part_data ? JSON.stringify(row.part_data) : null,
})), SESSION) as AnyRecord[];
const tools = (messages: AnyRecord[]) => messages.filter((m) => m.kind === 'tool_use');

const toolLine = (tool: string, state: AnyRecord, callID = 'call_x'): AnyRecord => ({
  type: 'tool_use', timestamp: 1, sessionID: SESSION, part: { callID, tool, type: 'tool', state },
});

describe('OpenCode live tool parts — real capture (B-1560)', () => {
  it('shows the real tool name, call id and input', () => {
    const cards = tools(live());
    assert.deepEqual(cards.map((c) => c.toolName), ['todowrite', 'task', 'todowrite']);
    for (const card of cards) {
      assert.match(card.toolId, /^call_/);
      assert.ok(Object.keys(card.toolInput).length > 0);
      assert.equal(card.toolResult.isError, false);
      assert.ok(card.toolResult.content.length > 0);
    }
    assert.equal(cards[1].toolInput.description, 'Read a.txt content');
  });

  it('emits two todowrite plan snapshots with shared-mapper counts', () => {
    const plans = tools(live()).filter((c) => c.plan).map((c) => c.plan);
    assert.equal(plans.length, 2);
    assert.deepEqual(plans[0], {
      source: 'tool',
      items: [
        { id: '0', label: 'read file', status: 'in_progress' },
        { id: '1', label: 'report', status: 'pending' },
      ],
      counts: { done: 0, total: 2 },
    });
    assert.deepEqual(plans[1].counts, { done: 2, total: 2 });
  });

  it('emits one settled subagent from task', () => {
    const subagents = tools(live()).filter((c) => c.subagent).map((c) => c.subagent);
    assert.deepEqual(subagents, [{
      id: 'call_1eb88656fe0840c4937553d3', parentId: null, label: 'Read a.txt content', state: 'completed',
    }]);
  });
});

describe('OpenCode history parity — same session part rows', () => {
  it('yields the same tools, final plan and subagent as live', () => {
    const liveCards = tools(live());
    const historyCards = tools(historyOf(fixture.rows));
    assert.deepEqual(historyCards.map((c) => [c.toolName, c.toolId]), liveCards.map((c) => [c.toolName, c.toolId]));
    assert.deepEqual(historyCards.map((c) => c.toolInput), liveCards.map((c) => c.toolInput));
    assert.deepEqual(historyCards.map((c) => c.subagent), liveCards.map((c) => c.subagent));
    // One turn: history stamps only its last todowrite, equal to live's latest.
    const historyPlans = historyCards.filter((c) => c.plan);
    assert.equal(historyPlans.length, 1);
    assert.equal(historyPlans[0], historyCards[2]);
    assert.deepEqual(historyPlans[0].plan, liveCards[2].plan);
  });

  it('stamps the last todowrite of each turn', () => {
    const rows = fixture.rows as AnyRecord[];
    const userRows = rows.filter((r) => r.message_data.role === 'user');
    const secondTurn = [
      ...userRows.map((r) => ({ ...r, message_id: `${r.message_id}_2`, part_id: `${r.part_id}_2` })),
      ...rows.filter((r) => r.message_data.role !== 'user')
        .map((r) => ({ ...r, message_id: `${r.message_id}_2`, part_id: r.part_id && `${r.part_id}_2` })),
    ];
    const stamped = tools(historyOf([...rows, ...secondTurn])).filter((c) => c.plan);
    assert.equal(stamped.length, 2);
    assert.ok(stamped.every((c) => c.plan.counts.done === 2));
  });
});

describe('openCodeToolPart edge cases', () => {
  it('maps an error task part to a failed subagent and an error result', () => {
    const [card] = provider.normalizeMessage(toolLine('task', {
      status: 'error', input: { subagent_type: 'general' }, error: 'boom',
    }, 'call_err'), null);
    assert.deepEqual(card.subagent, { id: 'call_err', parentId: null, label: 'general', state: 'failed' });
    assert.deepEqual(card.toolResult, { content: 'boom', isError: true });
  });

  it('never emits a running subagent and falls back to the child session id', () => {
    assert.equal(openCodeToolPart({ tool: 'task', callID: 'c', state: { status: 'running', input: {} } }).subagent, undefined);
    const settled = openCodeToolPart({ tool: 'task', state: { status: 'completed', metadata: { sessionId: 'ses_child' } } });
    assert.equal(settled.subagent?.id, 'ses_child');
  });

  it('drops cancelled todos, maps unknown status to pending and ignores title', () => {
    const { plan } = openCodeToolPart({
      tool: 'todowrite',
      state: {
        status: 'completed',
        title: '0 todos',
        input: { todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'cancelled' },
          { content: 'c', status: 'mystery' },
        ] },
      },
    });
    assert.deepEqual(plan?.items.map((i) => [i.label, i.status]), [['a', 'completed'], ['c', 'pending']]);
    assert.deepEqual(plan?.counts, { done: 1, total: 2 });
  });

  it('prefers metadata.todos over input.todos', () => {
    const { plan } = openCodeToolPart({ tool: 'todowrite', state: {
      status: 'completed',
      input: { todos: [{ content: 'input', status: 'pending' }] },
      metadata: { todos: [{ content: 'stored', status: 'completed' }] },
    } });
    assert.deepEqual(plan?.items, [{ id: '0', label: 'stored', status: 'completed' }]);
  });

  it('emits no plan for an errored todowrite', () => {
    const tool = openCodeToolPart({ tool: 'todowrite', state: { status: 'error', input: { todos: [{ content: 'a' }] } } });
    assert.equal(tool.plan, undefined);
    assert.equal(tool.toolResult?.isError, true);
  });

  it('survives malformed parts without a plan or subagent', () => {
    for (const part of [null, 'x', [], { state: [] }, { tool: 'todowrite', state: { status: 'completed', input: { todos: 'no' } } }]) {
      const [card] = provider.normalizeMessage({ type: 'tool_use', part }, SESSION);
      assert.equal(card.kind, 'tool_use');
      assert.equal(card.plan, undefined);
      assert.equal(card.subagent, undefined);
    }
  });

  it('keeps the legacy flat event shape as a fallback', () => {
    const [card] = provider.normalizeMessage({ type: 'tool_use', tool: 'bash', callID: 'c1', input: { cmd: 'ls' }, output: 'ok' }, SESSION);
    assert.equal(card.toolName, 'bash');
    assert.equal(card.toolId, 'c1');
    assert.deepEqual(card.toolInput, { cmd: 'ls' });
    assert.deepEqual(card.toolResult, { content: 'ok', isError: false });
  });
});
