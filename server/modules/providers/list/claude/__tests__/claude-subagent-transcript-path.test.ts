/**
 * B-30: subagent transcript directory resolution.
 *
 * Claude writes subagent transcripts into a per-session `subagents`
 * subdirectory NEXT TO the main transcript:
 *   <projectDir>/<sessionId>/subagents/agent-<id>.jsonl
 * NOT into the project directory itself. The old lookup scanned
 * `path.dirname(jsonlPath)` (the project directory), where no `agent-*.jsonl`
 * ever exists, so subagent tool output was never attached to the Task tool's
 * result.
 *
 * Contract under test:
 * 1. fetchHistory attaches the parsed subagent tools when the agent file lives
 *    in the correct `<sessionId>/subagents` directory.
 * 2. An agent file placed in the WRONG (legacy) project directory is ignored —
 *    proving the lookup no longer reads the old location.
 * 3. A session with no `subagents` directory loads without error (no orphaned
 *    folder is treated as a failure).
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const SESSION_ID = 'sess-subagent-1';
const AGENT_ID = 'a1234567890abcdef';
const TOOL_USE_ID = 'toolu_task_1';

async function withIsolatedDatabase(
  runTest: (projectDir: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-subagent-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  const projectDir = path.join(tempDirectory, 'projects', '-home-user-demo');
  await mkdir(projectDir, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest(projectDir);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** Main transcript: one assistant Task tool_use + a user tool_result that
 *  references the spawned subagent via toolUseResult.agentId. */
async function writeMainTranscript(projectDir: string): Promise<string> {
  const jsonlPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
  const lines = [
    {
      type: 'assistant',
      uuid: 'asst-1',
      sessionId: SESSION_ID,
      timestamp: '2026-06-12T10:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'Task', input: { prompt: 'do work' } }],
      },
    },
    {
      type: 'user',
      uuid: 'user-1',
      sessionId: SESSION_ID,
      timestamp: '2026-06-12T10:00:30.000Z',
      toolUseResult: { agentId: AGENT_ID },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: 'subagent finished' }],
      },
    },
  ];
  await writeFile(jsonlPath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return jsonlPath;
}

/** Subagent transcript: one tool_use the parser should surface as subagentTools. */
function agentTranscriptContent(): string {
  const lines = [
    {
      type: 'assistant',
      timestamp: '2026-06-12T10:00:10.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_inner_1', name: 'Read', input: { file_path: '/tmp/x' } }],
      },
    },
  ];
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

async function loadHistory(jsonlPath: string) {
  sessionsDb.createSession(SESSION_ID, 'claude', '/home/user/demo', undefined, undefined, undefined, jsonlPath);
  const provider = new ClaudeSessionsProvider();
  return provider.fetchHistory(SESSION_ID, { limit: null, offset: 0 });
}

test('subagent tools are attached when the agent file lives in <sessionId>/subagents', async () => {
  await withIsolatedDatabase(async (projectDir) => {
    const jsonlPath = await writeMainTranscript(projectDir);
    const subagentsDir = path.join(projectDir, SESSION_ID, 'subagents');
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(path.join(subagentsDir, `agent-${AGENT_ID}.jsonl`), agentTranscriptContent(), 'utf8');

    const history = await loadHistory(jsonlPath);
    const toolResult = history.messages.find((m) => m.kind === 'tool_result');

    assert.ok(toolResult, 'tool_result message must be present');
    assert.ok(Array.isArray(toolResult?.subagentTools), 'subagentTools must be attached');
    assert.equal(toolResult?.subagentTools?.length, 1);
    assert.equal((toolResult?.subagentTools?.[0] as { toolName?: string }).toolName, 'Read');
  });
});

test('agent file in the legacy project directory (wrong location) is ignored', async () => {
  await withIsolatedDatabase(async (projectDir) => {
    const jsonlPath = await writeMainTranscript(projectDir);
    // Place the agent file in the OLD location (project dir root) only.
    await writeFile(path.join(projectDir, `agent-${AGENT_ID}.jsonl`), agentTranscriptContent(), 'utf8');

    const history = await loadHistory(jsonlPath);
    const toolResult = history.messages.find((m) => m.kind === 'tool_result');

    assert.ok(toolResult, 'tool_result message must be present');
    assert.ok(
      toolResult?.subagentTools === undefined || (toolResult?.subagentTools as unknown[]).length === 0,
      'an agent file in the wrong directory must not be read',
    );
  });
});

test('a session with no subagents directory loads without error', async () => {
  await withIsolatedDatabase(async (projectDir) => {
    const jsonlPath = await writeMainTranscript(projectDir);
    // No subagents directory created at all.
    const history = await loadHistory(jsonlPath);
    assert.ok(Array.isArray(history.messages), 'history must load even without a subagents folder');
    const toolResult = history.messages.find((m) => m.kind === 'tool_result');
    assert.ok(toolResult, 'tool_result still present');
  });
});
