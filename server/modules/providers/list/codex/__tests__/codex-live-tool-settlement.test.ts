/**
 * codex-live-tool-settlement.test.ts — B-1482: proves that a LIVE Codex
 * tool-shaped item (command_execution, file_change, mcp_tool_call,
 * web_search, todo_list) normalizes with an inline `toolResult` attached,
 * matching what fetchHistory() already attaches for the persisted JSONL path.
 *
 * The bug: `transformCodexEvent` (server/openai-codex.js) only forwards
 * `item.completed` events to normalizeMessage() — `item.started`/
 * `item.updated` are filtered upstream — so every row this method builds for
 * these item types is already terminal. But normalizeMessage() never attached
 * a `toolResult`, and the live stream never emits a companion
 * `kind:'tool_result'` row the way the Claude SDK does. The client's generic
 * status derivation (ToolRenderer.deriveToolStatus / useChatMessages
 * toolResultMap lookup) therefore never saw a result and the "يعمل" (running)
 * badge stuck forever, clearing only once a full history refetch re-derived
 * it from the persisted tool_use/tool_result pair.
 *
 * Runner: node:test via tsx, no DB/filesystem fixtures needed — normalizeMessage
 * is a pure function of its input.
 *   npx tsx --tsconfig server/tsconfig.json --test <this file>
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { CodexSessionsProvider } = await import('../codex-sessions.provider.js');

describe('B-1482: live Codex tool items settle without a history refetch', () => {
  const provider = new CodexSessionsProvider();

  it('attaches a completed toolResult to a live command_execution row', () => {
    const [msg] = provider.normalizeMessage({
      type: 'item',
      itemType: 'command_execution',
      uuid: 'item_7',
      command: '/bin/bash -lc "echo hi"',
      output: 'hi\n',
      exitCode: 0,
      status: 'completed',
    }, 'sess-1');

    assert.equal(msg.kind, 'tool_use');
    assert.equal(msg.toolId, 'item_7');
    assert.ok(msg.toolResult, 'expected toolResult to be attached on the live row');
    assert.equal(msg.toolResult?.isError, false);
    assert.equal(msg.toolResult?.content, 'hi\n');
  });

  it('marks a failed live command_execution toolResult as an error', () => {
    const [msg] = provider.normalizeMessage({
      type: 'item',
      itemType: 'command_execution',
      uuid: 'item_8',
      command: 'false',
      output: '',
      exitCode: 1,
      status: 'failed',
    }, 'sess-1');

    assert.ok(msg.toolResult);
    assert.equal(msg.toolResult?.isError, true);
  });

  it('attaches a toolResult to live file_change / mcp_tool_call / web_search / todo_list rows', () => {
    const [fileChange] = provider.normalizeMessage({
      type: 'item', itemType: 'file_change', uuid: 'item_9', changes: [], status: 'completed',
    }, 'sess-1');
    assert.ok(fileChange.toolResult);
    assert.equal(fileChange.toolResult?.isError, false);

    const [mcp] = provider.normalizeMessage({
      type: 'item', itemType: 'mcp_tool_call', uuid: 'item_10', server: 's', tool: 't', status: 'completed',
    }, 'sess-1');
    assert.ok(mcp.toolResult);
    assert.equal(mcp.toolResult?.isError, false);

    const [search] = provider.normalizeMessage({
      type: 'item', itemType: 'web_search', uuid: 'item_11', query: 'q',
    }, 'sess-1');
    assert.ok(search.toolResult);

    const [todo] = provider.normalizeMessage({
      type: 'item', itemType: 'todo_list', uuid: 'item_12', items: [],
    }, 'sess-1');
    assert.ok(todo.toolResult);
  });

  it('uses the SDK item id as toolId instead of a fresh random id each call', () => {
    const [first] = provider.normalizeMessage({
      type: 'item', itemType: 'command_execution', uuid: 'item_stable', command: 'ls', status: 'completed',
    }, 'sess-1');
    const [second] = provider.normalizeMessage({
      type: 'item', itemType: 'command_execution', uuid: 'item_stable', command: 'ls', status: 'completed',
    }, 'sess-1');
    assert.equal(first.toolId, 'item_stable');
    assert.equal(first.toolId, second.toolId);
  });
});
