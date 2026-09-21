import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseCodexRolloutTranscript } from '../transcript-parser.js';
import { resolveCodexLinkedRollouts } from '../../modules/providers/list/codex/codex-rollout-links.js';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../modules/providers/services/cost/__fixtures__',
);

const ROOT_THREAD_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHILD_THREAD_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function customSpawnRows(agentId: string, callId = 'call-custom'): object[] {
  return [
    {
      timestamp: '2026-08-18T22:20:01.000Z', type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: 'ignored' },
    },
    {
      timestamp: '2026-08-18T22:20:01.100Z', type: 'response_item',
      payload: {
        type: 'custom_tool_call_output', call_id: callId,
        output: [{ type: 'input_text', text: JSON.stringify({ agent_id: agentId }) }],
      },
    },
  ];
}

function rootRows(extraRows: object[]): object[] {
  return [{
    timestamp: '2026-08-18T22:20:00.000Z', type: 'session_meta',
    payload: { session_id: ROOT_THREAD_ID, id: ROOT_THREAD_ID, thread_source: 'user' },
  }, ...extraRows];
}

function childRows(
  agentId: string,
  metadata: Record<string, unknown>,
  model: string,
  extraRows: object[] = [],
): object[] {
  return [
    {
      timestamp: '2026-08-18T22:20:01.050Z', type: 'session_meta',
      payload: {
        session_id: ROOT_THREAD_ID, id: agentId, parent_thread_id: ROOT_THREAD_ID,
        thread_source: 'subagent', ...metadata,
      },
    },
    { timestamp: '2026-08-18T22:20:01.060Z', type: 'turn_context', payload: { model } },
    ...extraRows,
  ];
}

const rowsText = (rows: object[]): string => `${rows.map(JSON.stringify).join('\n')}\n`;

test('Codex roster uses native spawn lifecycle and resolves child models without double counting calls', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-roster-'));
  const root = path.join(directory, 'rollout-root-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
  try {
    await Promise.all([
      copyFile(path.join(FIXTURES, 'codex-linked-root.jsonl'), root),
      copyFile(
        path.join(FIXTURES, 'codex-linked-ui.jsonl'),
        path.join(directory, 'rollout-child-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'),
      ),
      copyFile(
        path.join(FIXTURES, 'codex-linked-front.jsonl'),
        path.join(directory, 'rollout-child-cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl'),
      ),
    ]);

    const agents = await parseCodexRolloutTranscript(root);
    assert.deepEqual(agents, [
      {
        agent_name: 'gpt-5.6-sol',
        agent_kind: 'model',
        invocation_count: 1,
        agent_model: 'gpt-5.6-sol',
        agent_provider: 'openai',
      },
      {
        agent_name: 'ui_designer',
        agent_kind: 'subagent',
        invocation_count: 1,
        agent_model: 'gpt-5.6-sol',
        agent_provider: 'openai',
      },
      {
        agent_name: 'frontend_dev',
        agent_kind: 'subagent',
        invocation_count: 1,
        agent_model: 'gpt-5.6-sol',
        agent_provider: 'openai',
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex roster lists every main-thread model used in first-seen order', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-roster-model-history-'));
  const root = path.join(directory, 'rollout-root-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
  try {
    const fixture = await readFile(path.join(FIXTURES, 'codex-linked-root.jsonl'), 'utf8');
    await writeFile(root, `${fixture}\n${[
      { timestamp: '2026-08-10T06:01:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.4-mini' } },
      { timestamp: '2026-08-10T06:02:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      { timestamp: '2026-08-10T06:03:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.5-codex' } },
    ].map(JSON.stringify).join('\n')}\n`);

    const agents = await parseCodexRolloutTranscript(root);
    assert.deepEqual(
      agents.filter((agent) => agent.agent_kind === 'model').map((agent) => agent.agent_name),
      ['gpt-5.6-sol', 'gpt-5.4-mini', 'gpt-5.5-codex'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex roster recognizes successful multi_agent_v1 spawns without lifecycle events', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-roster-multi-agent-v1-'));
  const root = path.join(directory, 'rollout-root-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
  try {
    const rows = [
      {
        timestamp: '2026-08-18T22:14:00.000Z',
        type: 'session_meta',
        payload: {
          session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          thread_source: 'user',
        },
      },
      { timestamp: '2026-08-18T22:14:00.001Z', type: 'turn_context', payload: { model: 'gpt-5.6' } },
      {
        timestamp: '2026-08-18T22:14:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call', name: 'spawn_agent', namespace: 'multi_agent_v1',
          arguments: JSON.stringify({ agent_type: 'qa-critic' }), call_id: 'call-rejected',
        },
      },
      {
        timestamp: '2026-08-18T22:14:01.100Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-rejected', output: 'spawn rejected' },
      },
      ...[
        ['call-ui', 'frontend-dev', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
        ['call-test', 'tester', 'cccccccc-cccc-cccc-cccc-cccccccccccc'],
      ].flatMap(([callId, agentType, agentId], index) => [
        {
          timestamp: `2026-08-18T22:14:0${index + 2}.000Z`,
          type: 'response_item',
          payload: {
            type: 'function_call', name: 'spawn_agent', namespace: 'multi_agent_v1',
            arguments: JSON.stringify({ agent_type: agentType }), call_id: callId,
          },
        },
        {
          timestamp: `2026-08-18T22:14:0${index + 2}.100Z`,
          type: 'response_item',
          payload: {
            type: 'function_call_output', call_id: callId,
            output: JSON.stringify({ agent_id: agentId, nickname: 'test' }),
          },
        },
      ]),
    ];
    await writeFile(root, `${rows.map(JSON.stringify).join('\n')}\n`);

    const agents = await parseCodexRolloutTranscript(root);
    assert.deepEqual(agents, [
      {
        agent_name: 'gpt-5.6', agent_kind: 'model', invocation_count: 1,
        agent_model: 'gpt-5.6', agent_provider: 'openai',
      },
      {
        agent_name: 'frontend-dev', agent_kind: 'subagent', invocation_count: 1,
        agent_model: null, agent_provider: null,
      },
      {
        agent_name: 'tester', agent_kind: 'subagent', invocation_count: 1,
        agent_model: null, agent_provider: null,
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex roster resolves a custom exec child role and model from the linked rollout', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-roster-custom-multi-agent-v1-'));
  const root = path.join(directory, 'rollout-root-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
  try {
    const source = [
      'const label = "agent_type: ignored-in-source";',
      '// agent_type: also-ignored',
    ].join('\n');
    const rows = [
      {
        timestamp: '2026-08-18T22:20:00.000Z', type: 'session_meta',
        payload: {
          session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', thread_source: 'user',
        },
      },
      { timestamp: '2026-08-18T22:20:00.001Z', type: 'turn_context', payload: { model: 'gpt-5.6' } },
      {
        timestamp: '2026-08-18T22:20:01.000Z', type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call-spawns', input: source },
      },
      {
        timestamp: '2026-08-18T22:20:01.100Z', type: 'response_item',
        payload: {
          type: 'custom_tool_call_output', call_id: 'call-spawns', output: [
            { type: 'input_text', text: 'Script completed' },
            { type: 'input_text', text: JSON.stringify({ agent_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }) },
          ],
        },
      },
    ];
    const child = path.join(directory, 'rollout-child-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl');
    await Promise.all([
      writeFile(root, `${rows.map(JSON.stringify).join('\n')}\n`),
      writeFile(child, [
        JSON.stringify({
          timestamp: '2026-08-18T22:20:01.050Z', type: 'session_meta',
          payload: {
            session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            parent_thread_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            thread_source: 'subagent',
            agent_role: 'backend-dev',
            source: { subagent: { thread_spawn: { agent_role: 'backend-dev' } } },
          },
        }),
        JSON.stringify({ timestamp: '2026-08-18T22:20:01.060Z', type: 'turn_context', payload: { model: 'gpt-5.6-mini' } }),
      ].join('\n') + '\n'),
    ]);

    const agents = await parseCodexRolloutTranscript(root);
    assert.deepEqual(
      agents.filter((agent) => agent.agent_kind === 'subagent'),
      [{
        agent_name: 'backend-dev', agent_kind: 'subagent', invocation_count: 1,
        agent_model: 'gpt-5.6-mini', agent_provider: 'openai',
      }],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex roster ignores agent_type text in custom exec comments and strings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-roster-custom-false-positive-'));
  const root = path.join(directory, 'rollout-root-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
  try {
    const rows = [
      {
        timestamp: '2026-08-18T22:30:00.000Z', type: 'session_meta',
        payload: {
          session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', thread_source: 'user',
        },
      },
      {
        timestamp: '2026-08-18T22:30:01.000Z', type: 'response_item',
        payload: {
          type: 'custom_tool_call', name: 'exec', call_id: 'call-source-text',
          input: [
            '// agent_type: "backend-dev"',
            'const message = "agent_type: frontend-dev";',
          ].join('\n'),
        },
      },
      {
        timestamp: '2026-08-18T22:30:01.100Z', type: 'response_item',
        payload: {
          type: 'custom_tool_call_output', call_id: 'call-source-text', output: [
            { type: 'input_text', text: JSON.stringify({ agent_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }) },
            { type: 'input_text', text: JSON.stringify({ agent_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }) },
          ],
        },
      },
    ];
    await writeFile(root, `${rows.map(JSON.stringify).join('\n')}\n`);

    const agents = await parseCodexRolloutTranscript(root);
    assert.equal(agents.filter((agent) => agent.agent_kind === 'subagent').length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex manifest keeps unresolved legacy actors but rejects missing or mismatched child paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-legacy-path-strict-'));
  try {
    for (const [name, spawnPath, childPath] of [
      ['missing', undefined, '/root/backend-dev'],
      ['mismatched', '/root/backend-dev', '/root/other-agent'],
    ] as const) {
      const root = path.join(directory, `rollout-${name}-${ROOT_THREAD_ID}.jsonl`);
      const child = path.join(directory, `rollout-child-${CHILD_THREAD_ID}.jsonl`);
      const lifecyclePayload: Record<string, unknown> = {
        type: 'sub_agent_activity', kind: 'started', event_id: `call-${name}`,
        agent_thread_id: CHILD_THREAD_ID,
      };
      if (spawnPath) lifecyclePayload.agent_path = spawnPath;
      await Promise.all([
        writeFile(root, rowsText(rootRows([{
          timestamp: '2026-08-18T22:20:01.000Z', type: 'event_msg', payload: lifecyclePayload,
        }]))),
        writeFile(child, rowsText(childRows(
          CHILD_THREAD_ID,
          { agent_path: childPath },
          `gpt-legacy-path-leak-${name}`,
        ))),
      ]);

      const tree = await resolveCodexLinkedRollouts(root);
      assert.equal(tree.root.spawns.length, 1);
      assert.equal(tree.spawns.length, 1);
      assert.equal(tree.spawnCount, 1);
      assert.equal(tree.linked.length, 0);
      assert.equal(tree.files.some((file) => file.model === `gpt-legacy-path-leak-${name}`), false);
      assert.equal(tree.complete, false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex manifest rejects unresolved custom actors, roles, and child identities without model leaks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-custom-manifest-rejections-'));
  try {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['wrong-parent', { parent_thread_id: '99999999-9999-9999-9999-999999999999', agent_role: 'backend-dev' }],
      ['wrong-session', { session_id: '99999999-9999-9999-9999-999999999999', agent_role: 'backend-dev' }],
      ['missing-role', {}],
      ['invalid-role', { agent_role: 'backend dev!' }],
      ['conflicting-role', {
        agent_role: 'backend-dev',
        source: { subagent: { thread_spawn: { agent_role: 'frontend-dev' } } },
      }],
    ];
    for (const [name, metadata] of cases) {
      const root = path.join(directory, `rollout-${name}-${ROOT_THREAD_ID}.jsonl`);
      const child = path.join(directory, `rollout-child-${CHILD_THREAD_ID}.jsonl`);
      const leakedModel = `gpt-custom-leak-${name}`;
      await Promise.all([
        writeFile(root, rowsText(rootRows(customSpawnRows(CHILD_THREAD_ID, `call-${name}`)))),
        writeFile(child, rowsText(childRows(CHILD_THREAD_ID, metadata, leakedModel))),
      ]);

      const tree = await resolveCodexLinkedRollouts(root);
      assert.equal(tree.root.spawns.length, 0, name);
      assert.equal(tree.spawns.length, 0, name);
      assert.equal(tree.spawnCount, 0, name);
      assert.equal(tree.linked.length, 0, name);
      assert.equal(tree.files.some((file) => file.model === leakedModel), false, name);
      assert.equal(tree.complete, false, name);
      assert.match(tree.limitReason ?? '', /could not be resolved safely/, name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex manifest removes a rejected nested custom spawn from the recursive tree contract', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-custom-nested-rejection-'));
  const grandchildId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const root = path.join(directory, `rollout-root-${ROOT_THREAD_ID}.jsonl`);
  try {
    await Promise.all([
      writeFile(root, rowsText(rootRows(customSpawnRows(CHILD_THREAD_ID)))),
      writeFile(
        path.join(directory, `rollout-child-${CHILD_THREAD_ID}.jsonl`),
        rowsText(childRows(
          CHILD_THREAD_ID,
          { agent_role: 'backend-dev' },
          'gpt-trusted-child',
          customSpawnRows(grandchildId, 'call-grandchild'),
        )),
      ),
      writeFile(
        path.join(directory, `rollout-grandchild-${grandchildId}.jsonl`),
        rowsText(childRows(
          grandchildId,
          { parent_thread_id: CHILD_THREAD_ID, agent_role: 'invalid role!' },
          'gpt-nested-model-leak',
        )),
      ),
    ]);

    const tree = await resolveCodexLinkedRollouts(root);
    assert.deepEqual(tree.spawns.map((spawn) => spawn.agentThreadId), [CHILD_THREAD_ID]);
    assert.equal(tree.spawnCount, 1);
    assert.deepEqual(tree.linked.map((entry) => entry.spawn.agentThreadId), [CHILD_THREAD_ID]);
    assert.equal(tree.files.some((file) => file.model === 'gpt-nested-model-leak'), false);
    assert.equal(tree.complete, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex roster ignores duplicate lifecycle activity for the same child thread', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-roster-duplicate-'));
  const root = path.join(directory, 'rollout-root-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
  try {
    await Promise.all([
      copyFile(path.join(FIXTURES, 'codex-linked-root.jsonl'), root),
      copyFile(
        path.join(FIXTURES, 'codex-linked-ui.jsonl'),
        path.join(directory, 'rollout-child-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'),
      ),
      copyFile(
        path.join(FIXTURES, 'codex-linked-front.jsonl'),
        path.join(directory, 'rollout-child-cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl'),
      ),
    ]);
    await appendFile(
      root,
      `${JSON.stringify({
        timestamp: '2026-08-10T06:00:03.500Z',
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          kind: 'started',
          event_id: 'call-ui',
          agent_thread_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          agent_path: '/root/ui_designer',
        },
      })}\n`,
    );

    const agents = await parseCodexRolloutTranscript(root);
    const subagents = agents.filter((agent) => agent.agent_kind === 'subagent');
    assert.deepEqual(
      subagents.map((agent) => [agent.agent_name, agent.invocation_count]),
      [['ui_designer', 1], ['frontend_dev', 1]],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex rollout resolver excludes children with the wrong parent/root and symlinks outside containment', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-roster-containment-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'codex-roster-outside-'));
  const root = path.join(directory, 'rollout-root-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
  try {
    const originalRoot = await readFile(path.join(FIXTURES, 'codex-linked-root.jsonl'), 'utf8');
    const extraSpawns = [
      ['call-parent', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'wrong_parent'],
      ['call-root', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'wrong_root'],
      ['call-outside', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'outside'],
    ].flatMap(([callId, threadId, taskName], index) => [
      JSON.stringify({
        timestamp: `2026-08-10T06:01:0${index}.000Z`,
        type: 'response_item',
        payload: {
          type: 'function_call', name: 'spawn_agent', namespace: 'collaboration',
          arguments: JSON.stringify({ task_name: taskName }), call_id: callId,
        },
      }),
      JSON.stringify({
        timestamp: `2026-08-10T06:01:1${index}.000Z`,
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity', kind: 'started', event_id: callId,
          agent_thread_id: threadId, agent_path: `/root/${taskName}`,
        },
      }),
    ]).join('\n');
    await writeFile(root, `${originalRoot}${extraSpawns}\n`);
    await Promise.all([
      copyFile(
        path.join(FIXTURES, 'codex-linked-ui.jsonl'),
        path.join(directory, 'rollout-child-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'),
      ),
      copyFile(
        path.join(FIXTURES, 'codex-linked-front.jsonl'),
        path.join(directory, 'rollout-child-cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl'),
      ),
    ]);
    const childTemplate = await readFile(path.join(FIXTURES, 'codex-linked-ui.jsonl'), 'utf8');
    await writeFile(
      path.join(directory, 'rollout-child-dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl'),
      childTemplate
        .replaceAll('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'dddddddd-dddd-dddd-dddd-dddddddddddd')
        .replace('"parent_thread_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"', '"parent_thread_id":"99999999-9999-9999-9999-999999999999"'),
    );
    await writeFile(
      path.join(directory, 'rollout-child-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jsonl'),
      childTemplate
        .replaceAll('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')
        .replace('"session_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"', '"session_id":"99999999-9999-9999-9999-999999999999"'),
    );
    const outsideChild = path.join(outside, 'outside.jsonl');
    await writeFile(
      outsideChild,
      childTemplate.replaceAll('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'ffffffff-ffff-ffff-ffff-ffffffffffff'),
    );
    await symlink(
      outsideChild,
      path.join(directory, 'rollout-child-ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl'),
    );

    const tree = await resolveCodexLinkedRollouts(root);
    assert.deepEqual(
      tree.linked.map((child) => child.spawn.agentThreadId),
      ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc'],
    );
  } finally {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test('Codex rollout resolver fails closed when the root identity is missing or is itself a subagent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-roster-invalid-root-'));
  try {
    const child = path.join(directory, 'rollout-child-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl');
    await copyFile(path.join(FIXTURES, 'codex-linked-ui.jsonl'), child);

    for (const [name, metadata] of [
      ['missing', {}],
      ['subagent', {
        session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        thread_source: 'subagent',
      }],
      ['source-marker', {
        session_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        thread_source: 'user',
        source: { subagent: { thread_spawn: { depth: 1 } } },
      }],
    ] as const) {
      const root = path.join(directory, `rollout-${name}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl`);
      await writeFile(root, [
        JSON.stringify({ timestamp: '2026-08-10T06:00:00.000Z', type: 'session_meta', payload: metadata }),
        JSON.stringify({
          timestamp: '2026-08-10T06:00:03.000Z', type: 'event_msg',
          payload: {
            type: 'sub_agent_activity', kind: 'started', event_id: 'call-ui',
            agent_thread_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', agent_path: '/root/ui_designer',
          },
        }),
      ].join('\n'));

      const tree = await resolveCodexLinkedRollouts(root);
      assert.equal(tree.linked.length, 0);
      assert.equal(tree.spawnCount, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex rollout resolver treats a manual user fork as its own valid coordinator root', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-roster-user-fork-'));
  const forkId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const root = path.join(directory, `rollout-root-${forkId}.jsonl`);
  try {
    const rootFixture = await readFile(path.join(FIXTURES, 'codex-linked-root.jsonl'), 'utf8');
    const forkRoot = rootFixture.replace(
      '"session_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","thread_source":"user"',
      `"session_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","id":"${forkId}","parent_thread_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","thread_source":"user"`,
    );
    const childFixture = await readFile(path.join(FIXTURES, 'codex-linked-ui.jsonl'), 'utf8');
    const forkChild = childFixture.replace(
      '"parent_thread_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"',
      `"parent_thread_id":"${forkId}"`,
    );
    await Promise.all([
      writeFile(root, forkRoot),
      writeFile(
        path.join(directory, 'rollout-child-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'),
        forkChild,
      ),
    ]);

    const tree = await resolveCodexLinkedRollouts(root);
    assert.deepEqual(tree.linked.map((entry) => entry.spawn.agentThreadId), [
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex rollout resolver finds real previous and next adjacent-day children', async () => {
  const sessionsRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-roster-adjacent-day-'));
  try {
    const rootFixture = await readFile(path.join(FIXTURES, 'codex-linked-root.jsonl'), 'utf8');
    const eventDatedRoot = rootFixture.replaceAll('2026-08-10T06:', '2026-08-10T12:');
    for (const [name, childDay] of [['previous', '09'], ['next', '11']] as const) {
      const caseRoot = path.join(sessionsRoot, name);
      const rootDirectory = path.join(caseRoot, '2026', '08', '10');
      const childDirectory = path.join(caseRoot, '2026', '08', childDay);
      const root = path.join(rootDirectory, `rollout-root-${ROOT_THREAD_ID}.jsonl`);
      await Promise.all([
        mkdir(rootDirectory, { recursive: true }),
        mkdir(childDirectory, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(root, eventDatedRoot),
        copyFile(
          path.join(FIXTURES, 'codex-linked-ui.jsonl'),
          path.join(childDirectory, `rollout-child-${CHILD_THREAD_ID}.jsonl`),
        ),
        copyFile(
          path.join(FIXTURES, 'codex-linked-front.jsonl'),
          path.join(childDirectory, 'rollout-child-cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl'),
        ),
      ]);

      const tree = await resolveCodexLinkedRollouts(root);
      assert.deepEqual(tree.linked.map((entry) => entry.spawn.agentThreadId), [
        CHILD_THREAD_ID,
        'cccccccc-cccc-cccc-cccc-cccccccccccc',
      ], name);
      assert.equal(tree.complete, true, name);
    }
  } finally {
    await rm(sessionsRoot, { recursive: true, force: true });
  }
});
