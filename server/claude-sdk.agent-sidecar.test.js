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
    poller.observe({
      type: 'assistant',
      message: { content: [{ id: meta.toolUseId, tool_use_result: { agentId } }] },
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
