import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { ReviewEvidenceError, reviewPayloadSha } from './agent-review-raw-evidence.js';
import { parseAgentReviewRawEvidence as parse } from './agent-review-raw-parser.js';

const workflow = { sessionId: 's', source: 'workflow' as const, workflowId: 'wf_1' };
const agent = { sessionId: 's', source: 'agent' as const };
const started = { type: 'started', key: 'key-1', agentId: 'agent-1' };
const result = { ...started, type: 'result', result: { output: 'completed' } };
const launch = (name = 'Agent'): object => ({ type: 'assistant', sessionId: 's', message: {
  role: 'assistant', content: [{ type: 'tool_use', name, id: 'tool-1', input: { taskId: 'not-authority' } }],
} });
const binding = { type: 'user', sessionId: 's', toolUseResult: { agentId: 'agent-1' }, message: {
  role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'not-authority' }],
} };
const notification = (taskId = 'agent-1', text = 'result'): object => ({ type: 'queue-operation', operation: 'enqueue', sessionId: 's',
  content: `<task-notification><task-id>${taskId}</task-id><tool-use-id>tool-1</tool-use-id><status>completed</status><result>${text}</result></task-notification>` });
const jsonl = (...rows: object[]): Buffer => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');

function rejected(run: () => unknown, reason: string): void {
  assert.throws(run, (error: unknown) => error instanceof ReviewEvidenceError && error.reason === reason);
}

test('C4-01/02/18 raw workflow consumes one prior matching launch and preserves resumed generations', () => {
  const bytes = jsonl(started, result, started, result);
  const parsed = parse(workflow, bytes);
  assert.equal(parsed.completions.length, 2);
  assert.deepEqual(parsed.completions.map(value => value.sourceSequence), [2, 4]);
  assert.notEqual(parsed.completions[0].launchEvidenceSha256, parsed.completions[1].launchEvidenceSha256);
  assert.notEqual(parsed.completions[0].completionEvidenceSha256, parsed.completions[1].completionEvidenceSha256);
  assert.deepEqual(parse(workflow, bytes), parsed);
  assert.equal(parsed.lastCompleteOffset, bytes.length);
  assert.equal(Object.isFrozen(parsed.completions[0]), true);
  bytes.fill(0); // Returned evidence is detached from mutable caller bytes.
  assert.equal(parsed.completions.length, 2);
});

test('C4-03/18 raw workflow rejects zero/multiple/reused or mismatched starts rather than matching metadata', () => {
  rejected(() => parse(workflow, jsonl(result)), 'reused_launch');
  rejected(() => parse(workflow, jsonl(started, started, result)), 'ambiguous_launch');
  rejected(() => parse(workflow, jsonl(started, result, result)), 'reused_launch');
  rejected(() => parse(workflow, jsonl(started, { ...result, key: 'wrong' })), 'reused_launch');
  rejected(() => parse(workflow, jsonl({ agentId: 'agent-1', status: 'done', label: 'metadata' })), 'invalid_shape');
});

test('workflow result requires a valid explicit payload and hashes payload separately from event metadata', () => {
  rejected(() => parse(workflow, jsonl(started, { ...started, type: 'result' })), 'invalid_shape');
  for (const malformed of [Number.MAX_SAFE_INTEGER + 1, '\uD800', 'x'.repeat(1_048_575)]) {
    rejected(() => parse(workflow, jsonl(started, { ...result, result: malformed })), 'invalid_shape');
  }
  const original = parse(workflow, jsonl(started, result)).completions[0];
  const changedMetadata = parse(workflow, jsonl(started, { ...result, label: 'new label', timestamp: 'later' })).completions[0];
  const changedPayload = parse(workflow, jsonl(started, { ...result, result: { output: 'different' } })).completions[0];
  assert.equal(original.resultPayloadSha256, reviewPayloadSha(result.result));
  assert.equal(changedMetadata.resultPayloadSha256, original.resultPayloadSha256);
  assert.notEqual(changedMetadata.completionEvidenceSha256, original.completionEvidenceSha256);
  assert.notEqual(changedPayload.resultPayloadSha256, original.resultPayloadSha256);
  // The accepted canonical JSON domain permits explicit null; missing result remains invalid.
  assert.equal(parse(workflow, jsonl(started, { ...result, result: null })).completions[0].resultPayloadSha256,
    reviewPayloadSha(null));
});

test('one launch row cannot select two Agent/Task blocks even with different tool ids', () => {
  for (const names of [['Agent', 'Agent'], ['Task', 'Task'], ['Agent', 'Task']]) {
    const multiple = { type: 'assistant', sessionId: 's', message: { role: 'assistant', content: [
      { type: 'tool_use', name: names[0], id: 'tool-1' }, { type: 'tool_use', name: names[1], id: 'tool-2' },
    ] } };
    rejected(() => parse(agent, jsonl(multiple, binding, notification())), 'ambiguous_launch');
    // Reject the launch itself, without waiting for any binding or completion.
    rejected(() => parse(agent, jsonl(multiple)), 'ambiguous_launch');
  }
});

test('C4-04/22 raw Agent and Task launch→tool result binding→original enqueue establish matching task identity', () => {
  for (const tool of ['Agent', 'Task']) {
    const parsed = parse(agent, jsonl(launch(tool), binding, notification(), notification('agent-1', 'later result')));
    assert.equal(parsed.bindings.length, 1);
    assert.equal(parsed.bindings[0].agentId, 'agent-1');
    assert.equal(parsed.bindings[0].launchSequence, 1);
    assert.equal(parsed.bindings[0].bindingSequence, 2);
    assert.deepEqual(parsed.completions.map(value => [value.taskId, value.sourceSequence]), [['agent-1', 3], ['agent-1', 4]]);
    assert.equal(parsed.completions[0].launchEvidenceSha256, parsed.bindings[0].launchEvidenceSha256);
  }
});

test('C4-05/22 delivered history copies, task labels and normalized cache rows cannot manufacture completion', () => {
  const copy = { type: 'user', origin: { kind: 'task-notification' }, message: { content: notification() } };
  const normalized = { role: 'assistant', status: 'done', agentId: 'agent-1', taskId: 'agent-1', model: 'claimed' };
  assert.equal(parse(agent, jsonl(copy, normalized)).completions.length, 0);
  rejected(() => parse(agent, jsonl(notification())), 'conflicting_binding');
  rejected(() => parse(agent, jsonl(launch(), notification())), 'conflicting_binding');
  rejected(() => parse(agent, jsonl(launch(), binding, notification('wrong'))), 'conflicting_binding');
  rejected(() => parse(agent, jsonl(binding, launch(), notification())), 'conflicting_binding');
});

test('raw binding ambiguity, wrong parent session, reused tool id and wrong selected block fail closed', () => {
  rejected(() => parse(agent, jsonl(launch(), launch(), binding)), 'ambiguous_launch');
  rejected(() => parse(agent, jsonl(launch(), binding, binding)), 'conflicting_binding');
  rejected(() => parse(agent, jsonl({ ...binding, sessionId: 'other' })), 'invalid_shape');
  rejected(() => parse(agent, jsonl(launch('Bash'), binding, notification())), 'conflicting_binding');
  rejected(() => parse(agent, jsonl(launch(), { ...binding, message: { content: [
    { type: 'tool_result', tool_use_id: 'tool-1' }, { type: 'tool_result', tool_use_id: 'tool-1' },
  ] } })), 'conflicting_binding');
});

test('C4-11/21 partial final line stays unconsumed; UTF-8, line size and source topology are bounded', () => {
  const full = jsonl(started);
  const partial = Buffer.from(JSON.stringify(result));
  const parsed = parse(workflow, Buffer.concat([full, partial]));
  assert.equal(parsed.lastCompleteOrdinal, 1); assert.equal(parsed.lastCompleteOffset, full.length);
  assert.equal(parsed.completions.length, 0);
  rejected(() => parse(workflow, Buffer.from([0xff, 0x0a])), 'invalid_shape');
  rejected(() => parse(workflow, Buffer.alloc(2_097_153, 0x61)), 'line_too_large');
  rejected(() => parse({ ...workflow, workflowId: 'wf_../escape' }, full), 'invalid_shape');
});

test('C4-21 result canonicalization independently accepts over 64 KiB up to 1 MiB and rejects oversized payload', () => {
  const large = 'x'.repeat(65_537);
  const parsed = parse(agent, jsonl(launch(), binding, notification('agent-1', large)));
  assert.equal(parsed.completions[0].resultPayloadSha256, reviewPayloadSha(large));
  assert.equal(reviewPayloadSha('x'.repeat(1_048_574)).length, 64); // JSON quotes count toward the cap.
  rejected(() => reviewPayloadSha('x'.repeat(1_048_575)), 'invalid_shape');
  rejected(() => parse(agent, jsonl(launch(), binding, notification('agent-1', '   '))), 'invalid_shape');
});

test('C4-21 completion and complete-line caps deny the entire parsed fold', () => {
  const rows: object[] = [];
  for (let i = 0; i < 4097; i++) rows.push(started, result);
  rejected(() => parse(workflow, jsonl(...rows)), 'completion_cap');
  rejected(() => parse(agent, Buffer.from('{}\n'.repeat(200_001))), 'line_cap');
});

test('ambiguous duplicate JSON keys, including escaped spellings, never become trusted evidence', () => {
  rejected(() => parse(workflow, Buffer.from('{"type":"started","type":"result","key":"k","agentId":"a"}\n')), 'invalid_shape');
  rejected(() => parse(agent, Buffer.from('{"message":{"role":"user","\\u0072ole":"assistant"}}\n')), 'invalid_shape');
});

test('database barrel and raw parser import neither opens a SQLite connection nor copies a legacy DB', () => {
  const url = new URL('./agent-review-raw-parser.ts', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    import fs from 'node:fs';
    const require = createRequire(import.meta.url);
    const NativeDatabase = require('better-sqlite3');
    let opened = 0, copied = 0;
    require.cache[require.resolve('better-sqlite3')].exports = new Proxy(NativeDatabase, {
      construct() { opened++; throw new Error('unexpected_database_open'); }
    });
    fs.copyFileSync = () => { copied++; throw new Error('unexpected_database_copy'); };
    fs.promises.copyFile = async () => { copied++; throw new Error('unexpected_database_copy'); };
    syncBuiltinESMExports();
    const parser = await import(${JSON.stringify(url)});
    parser.parseAgentReviewRawEvidence({sessionId:'s',source:'agent'}, Buffer.from('{}\\n'));
    assert.equal(opened, 0); assert.equal(copied, 0);
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    env: { ...process.env, TSX_TSCONFIG_PATH: 'server/tsconfig.json' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
});
