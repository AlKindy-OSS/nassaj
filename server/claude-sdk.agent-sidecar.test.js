import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createClaudeAgentSidecarPoller } from './claude-sdk.js';
import { openArtifactDirAt } from './modules/providers/shared/session-transcript-reader.js';
import { readAgentMeta } from './modules/providers/list/claude/agent-transcript.reader.js';
import { createClaudeProgressFold } from './modules/providers/list/claude/claude-progress-fold.js';
import { buildProgressSubagent } from './shared/progress-normalize.js';
import { createNormalizedMessage } from './shared/utils.js';

// Optional local corpus of Claude project transcripts (a directory of session dirs with
// subagents/agent-*.jsonl). The test skips when it is unset or unreadable.
const REAL_DATA = process.env.CLAUDE_SIDECAR_TRANSCRIPT_DIR || '';
const IDENTIFIER_KEYS = new Set([
  'type', 'name', 'id', 'tool_use_id', 'toolUseId', 'agentId', 'agent_id', 'role',
]);

function scrub(value, key = '') {
  if (typeof value === 'string') return IDENTIFIER_KEYS.has(key) ? value : '[scrubbed]';
  if (Array.isArray(value)) return value.map((item) => scrub(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
    childKey, scrub(child, childKey),
  ]));
}

async function writeScrubbedJsonl(source, target) {
  const input = await readFile(source, 'utf8');
  const output = input.split('\n').filter(Boolean).map((line) => {
    try { return JSON.stringify(scrub(JSON.parse(line))); } catch { return ''; }
  }).filter(Boolean).join('\n');
  await writeFile(target, `${output}\n`);
}

async function findRealAgentTranscript() {
  let sessions;
  if (!REAL_DATA) return null;
  try { sessions = await readdir(REAL_DATA, { withFileTypes: true }); } catch { return null; }
  for (const session of sessions) {
    if (!session.isDirectory()) continue;
    const dir = path.join(REAL_DATA, session.name, 'subagents');
    let names;
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names.filter((item) => /^agent-.*\.jsonl$/.test(item))) {
      const file = path.join(dir, name);
      try {
        const lines = (await readFile(file, 'utf8')).split('\n');
        if (lines.some((line) => {
          try {
            const entry = JSON.parse(line);
            return entry.message?.content?.some((part) => part.type === 'tool_use');
          } catch { return false; }
        })) return { dir, name };
      } catch { /* Ignore files that changed during discovery. */ }
    }
  }
  return null;
}

test('sidecar poller emits tool progress from a copied real agent transcript', async (t) => {
  const source = await findRealAgentTranscript();
  if (!source) return t.skip('no real agent transcript with tools is available');

  const scratch = await mkdtemp('/var/tmp/claude-sidecar-real-');
  const agentName = source.name;
  const agentId = agentName.slice('agent-'.length, -'.jsonl'.length);
  const agentPath = path.join(scratch, agentName);
  const metaName = `agent-${agentId}.meta.json`;
  let poller;
  try {
    await writeScrubbedJsonl(path.join(source.dir, source.name), agentPath);
    const metaJson = JSON.parse(await readFile(path.join(source.dir, metaName), 'utf8'));
    await writeFile(path.join(scratch, metaName), JSON.stringify(scrub(metaJson)));
    const artifacts = await openArtifactDirAt(scratch);
    assert.ok('dir' in artifacts);
    const meta = await readAgentMeta(artifacts, agentId);
    assert.ok(meta.toolUseId);
    poller = createClaudeAgentSidecarPoller({
      openArtifacts: async () => artifacts,
    });
    const fold = createClaudeProgressFold('live', null);
    fold.observe({ type: 'assistant' }, [createNormalizedMessage({
      id: meta.toolUseId,
      sessionId: 'real-sidecar-test',
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'Agent',
      toolId: meta.toolUseId,
      subagent: buildProgressSubagent({
        id: meta.toolUseId,
        parentId: null,
        label: 'real agent',
        state: 'started',
      }),
    })]);
    // B-1696: the shape the SDK streams when an Agent task registers (SDKTaskStartedMessage);
    // a foreground agent names its id nowhere else until its final tool result.
    poller.observe({
      type: 'system', subtype: 'task_started', task_id: agentId, tool_use_id: meta.toolUseId,
      task_type: 'local_agent', is_backgrounded: false, description: 'real agent',
      session_id: 'real-sidecar-test',
    }, 'real-sidecar-test');
    const updates = [];
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('sidecar timer produced no output')), 3000);
      poller.start(Promise.resolve(fold), (row) => {
        updates.push(row);
        clearTimeout(timeout);
        resolve();
      }, null, {}, {});
    });
    assert.ok(updates.length > 0, 'poller must return progress rows from the copied agent file');
    assert.ok(updates.some((row) => row.subagent?.tools?.length));
    assert.ok(updates.every((row) => row.sessionId === 'real-sidecar-test'),
      'poller resolves session id after creation and attaches it to progress rows');
  } finally {
    await poller?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

// B-1696: synthetic artifacts — an agent file whose lines carry the resolved model.
const SESSION = 'b1696-session';
const AGENT_ID = 'a0123456789abcdef';
const TOOL_ID = 'toolu_b1696_agent';
const agentLine = (model, toolId) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model,
  content: [{ type: 'tool_use', id: toolId, name: 'Read', input: {} }] } });

async function sidecarFixture() {
  const scratch = await mkdtemp('/var/tmp/claude-sidecar-b1696-');
  await writeFile(path.join(scratch, `agent-${AGENT_ID}.meta.json`),
    JSON.stringify({ agentType: 'backend-dev', toolUseId: TOOL_ID, requestShape: 'foreground' }));
  await writeFile(path.join(scratch, `agent-${AGENT_ID}.jsonl`), `${agentLine('claude-opus-x', 'toolu_c1')}\n`);
  const artifacts = await openArtifactDirAt(scratch);
  assert.ok('dir' in artifacts);
  const opened = [];
  const openFile = artifacts.openFile.bind(artifacts);
  artifacts.openFile = (name) => {
    if (name.endsWith('.jsonl')) opened.push(name);
    return openFile(name);
  };
  const poller = createClaudeAgentSidecarPoller({ openArtifacts: async () => artifacts });
  const fold = createClaudeProgressFold('live', null);
  fold.observe({ type: 'assistant' }, [createNormalizedMessage({
    id: TOOL_ID, sessionId: SESSION, provider: 'claude', kind: 'tool_use', toolName: 'Agent', toolId: TOOL_ID,
    subagent: buildProgressSubagent({ id: TOOL_ID, parentId: null, label: 'agent', state: 'started' }),
  })]);
  return { scratch, poller, fold, opened };
}

const taskStarted = (extra = {}) => ({ type: 'system', subtype: 'task_started', task_id: AGENT_ID,
  tool_use_id: TOOL_ID, task_type: 'local_agent', is_backgrounded: false, subagent_type: 'backend-dev',
  spawn_depth: 1, description: 'agent', session_id: SESSION, ...extra });
// The SDK user message that carries an Agent tool's structured output (SDKUserMessage.tool_use_result).
const agentToolResult = (toolUseResult) => ({ type: 'user', parent_tool_use_id: null, session_id: SESSION,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: TOOL_ID, content: 'launched' }] },
  tool_use_result: toolUseResult });
const models = (rows) => rows.map((row) => row.subagent?.model).filter(Boolean);

test('B-1696: a foreground agent is tailed from task_started while it still runs', async () => {
  const { scratch, poller, fold, opened } = await sidecarFixture();
  try {
    poller.observe(taskStarted(), SESSION);
    const first = await poller.poll(null, SESSION, fold);
    assert.ok(models(first).includes('claude-opus-x'), 'resolvedModel reaches the agent row');
    assert.ok(first.some((row) => row.subagent?.tools?.length), 'child tools reach the agent row');
    await writeFile(path.join(scratch, `agent-${AGENT_ID}.jsonl`),
      `${agentLine('claude-opus-x', 'toolu_c1')}\n${agentLine('claude-opus-x', 'toolu_c2')}\n`);
    const second = await poller.poll(null, SESSION, fold);
    assert.ok(second.length > 0, 'later lines keep flowing before the agent settles');
    assert.deepEqual(opened, [`agent-${AGENT_ID}.jsonl`]);
  } finally {
    await poller.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('B-1696: task_started of other task types or unsafe ids is ignored', async () => {
  const { scratch, poller, fold, opened } = await sidecarFixture();
  try {
    poller.observe(taskStarted({ task_type: 'local_bash' }), SESSION);
    poller.observe(taskStarted({ task_id: '../agent-x' }), SESSION);
    poller.observe(taskStarted({ tool_use_id: undefined }), SESSION);
    assert.deepEqual(await poller.poll(null, SESSION, fold), []);
    assert.deepEqual(opened, []);
  } finally {
    await poller.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('B-1696: the background path (agentId in tool_use_result) is unchanged', async () => {
  const { scratch, poller, fold, opened } = await sidecarFixture();
  try {
    poller.observe(agentToolResult({ status: 'async_launched', agentId: AGENT_ID, isAsync: true }), SESSION);
    const rows = await poller.poll(null, SESSION, fold);
    assert.ok(models(rows).includes('claude-opus-x'));
    assert.deepEqual(opened, [`agent-${AGENT_ID}.jsonl`]);
  } finally {
    await poller.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test('B-1696: task_started plus a tool_use_result agentId tail the agent once', async () => {
  for (const pollBetween of [false, true]) {
    const { scratch, poller, fold, opened } = await sidecarFixture();
    try {
      poller.observe(taskStarted({ is_backgrounded: true }), SESSION);
      if (pollBetween) await poller.poll(null, SESSION, fold);
      poller.observe(agentToolResult({ status: 'async_launched', agentId: AGENT_ID, isAsync: true }), SESSION);
      await poller.poll(null, SESSION, fold);
      await poller.poll(null, SESSION, fold);
      assert.deepEqual(opened, [`agent-${AGENT_ID}.jsonl`], `opened once (poll between: ${pollBetween})`);
    } finally {
      await poller.close();
      await rm(scratch, { recursive: true, force: true });
    }
  }
});
