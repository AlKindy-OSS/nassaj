/**
 * ADR-201 A-P2 — negative tests per migrated Claude reader, through each
 * reader's real entry point (not the reader primitive):
 *   search (searchConversations), agent status (getAgentReport), workflow
 *   status (getActiveWorkflows), active model (getCurrentActiveModel), token
 *   usage (readClaudeTranscriptForSession), progress seed (seedClaudeProgressFold).
 *
 * Every scenario plants the SAME secret transcript content and differs by one
 * defect of the recorded path:
 *   - genuine:  `<id>.jsonl` in the operator tree, header bound to `<id>` (control);
 *   - forged:   `<id>.jsonl` whose header names another session (the victim);
 *   - crossTree: the recorded path in member tree /1 is a symlink to the same
 *                name in member tree /10 (the /1 vs /10 prefix trap);
 *   - symlink:  `<id>.jsonl` is a symlink to a file outside every provider root;
 *   - hardlink: `<id>.jsonl` is a hardlink of member /10's file of that name.
 * Fixtures are the real Claude share header (B-1520 redacted), re-keyed.
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getConnection, initializeDatabase, participantsDb, userDb } from '@/modules/database/index.js';
import { createClaudeProgressFold } from '@/modules/providers/list/claude/claude-progress-fold.js';
import { seedClaudeProgressFold } from '@/modules/providers/list/claude/claude-progress-seed.js';
import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { readClaudeTranscriptForSession } from '@/modules/providers/list/claude/claude-token-usage.js';
import { agentStatusService } from '@/modules/providers/services/agent-status.service.js';
import { searchConversations } from '@/modules/providers/services/session-conversations-search.service.js';
import { workflowStatusService } from '@/modules/providers/services/workflow-status.service.js';
// eslint-disable-next-line boundaries/no-unknown -- shared test fixture helper (same seam as sandbox-home)
import { claudeHeaderLine } from '@/shared/__tests__/provider-root-sandbox.js';
import type { ProviderModelsDefinition } from '@/shared/types.js';
// eslint-disable-next-line boundaries/no-unknown
import { forgetWorkflowPid, registerWorkflowPid } from '@/services/workflow-liveness.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
const PROJECT = '-home-operator-Project-General';
const OPERATOR_DIR = path.join(SANDBOX_HOME, '.claude', 'projects', PROJECT);
const memberDir = (member: string) => path.join(SANDBOX_HOME, '.nassaj-users', member, '.claude', 'projects', PROJECT);
const SECRET = 'qwxzplanted-secret-term';
const FORGED_MODEL = 'claude-planted-model-9';
const AGENT_ID = 'a0123456789abcdef';
const WF_ID = 'wf_aaaabbbb';

await initializeDatabase();
const ownerId = userDb.createUser('reader-owner', 'hash-o', 'user').id;

type Scenario = 'genuine' | 'forged' | 'crossTree' | 'symlink' | 'hardlink';
const SCENARIOS: readonly Scenario[] = ['genuine', 'forged', 'crossTree', 'symlink', 'hardlink'];
const OUTSIDE_DIR = path.join(SANDBOX_HOME, 'outside-every-root', PROJECT);

let counter = 0;
const nextId = () => `00000000-0000-4000-a000-${String(++counter).padStart(12, '0')}`;

/** Transcript text: real header bound to `headerId`, then a secret prompt and a model-bearing reply. */
function transcriptText(headerId: string): string {
  const prompt = { type: 'user', sessionId: headerId, uuid: `${headerId}-u`, timestamp: '2026-10-12T00:00:00.000Z',
    message: { role: 'user', content: `please look at ${SECRET}` } };
  const reply = { type: 'assistant', sessionId: headerId, uuid: `${headerId}-a`, timestamp: '2026-10-12T00:00:01.000Z',
    message: { role: 'assistant', model: FORGED_MODEL, content: [{ type: 'text', text: 'done' }] } };
  return [claudeHeaderLine(headerId), JSON.stringify(prompt), JSON.stringify(reply)].join('\n') + '\n';
}

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** Subagent + workflow artifacts beside `transcript` (so only the transcript check can refuse). */
function plantArtifacts(transcript: string): void {
  const sessionDir = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'));
  const agentRow = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: SECRET }] } };
  write(path.join(sessionDir, 'subagents', `agent-${AGENT_ID}.jsonl`), `${JSON.stringify(agentRow)}\n`);
  write(path.join(sessionDir, 'subagents', 'workflows', WF_ID, 'journal.jsonl'),
    `${JSON.stringify({ type: 'started', key: 'k1', agentId: 'w1' })}\n`);
}

/** Where the real content of `scenario` lives, and where the recorded path points. */
function layout(sessionId: string, scenario: Scenario): { target: string; recorded: string } {
  const name = `${sessionId}.jsonl`;
  switch (scenario) {
    case 'crossTree': return { target: path.join(memberDir('10'), name), recorded: path.join(memberDir('1'), name) };
    case 'symlink': return { target: path.join(OUTSIDE_DIR, name), recorded: path.join(OPERATOR_DIR, name) };
    case 'hardlink': return { target: path.join(memberDir('10'), name), recorded: path.join(OPERATOR_DIR, name) };
    default: return { target: path.join(OPERATOR_DIR, name), recorded: path.join(OPERATOR_DIR, name) };
  }
}

/** Plants `scenario` for a fresh session (artifacts beside every real file); returns the recorded path. */
function plant(sessionId: string, scenario: Scenario): string {
  const { target, recorded } = layout(sessionId, scenario);
  write(target, transcriptText(scenario === 'forged' ? nextId() : sessionId));
  plantArtifacts(target);
  if (recorded === target) return recorded;
  fs.mkdirSync(path.dirname(recorded), { recursive: true });
  if (scenario === 'hardlink') fs.linkSync(target, recorded);
  else fs.symlinkSync(target, recorded);
  plantArtifacts(recorded);
  return recorded;
}

/** A session row (owner spawn) recording the planted path. */
function recordScenario(scenario: Scenario): { sessionId: string; jsonlPath: string } {
  const sessionId = nextId();
  const jsonlPath = plant(sessionId, scenario);
  getConnection().prepare('INSERT INTO sessions (session_id, provider, jsonl_path) VALUES (?, ?, ?)')
    .run(sessionId, 'claude', jsonlPath);
  participantsDb.recordSpawn(sessionId, ownerId);
  return { sessionId, jsonlPath };
}

/** Runs `probe` per scenario: the genuine control must expose the content, every defect nothing. */
async function expectOnlyGenuine(name: string, probe: (row: { sessionId: string; jsonlPath: string }) => Promise<boolean>) {
  for (const scenario of SCENARIOS) {
    const row = recordScenario(scenario);
    assert.equal(await probe(row), scenario === 'genuine', `${name}: ${scenario}`);
  }
}

test('search: only the genuine transcript is searched', async () => {
  await expectOnlyGenuine('search', async ({ sessionId }) => {
    const { results } = await searchConversations(SECRET, ownerId, 200);
    return results.some((project) => project.sessions.some((session) => session.sessionId === sessionId));
  });
});

test('agent status: an agent report is recovered only through a genuine transcript', async () => {
  // The report lookup walks every owned session for the agent id; earlier cases own it too.
  getConnection().prepare('DELETE FROM session_participants').run();
  await expectOnlyGenuine('agent-status', async ({ sessionId }) => {
    const report = await agentStatusService.getAgentReport(ownerId, AGENT_ID);
    const found = report?.sessionId === sessionId && report.report === SECRET;
    getConnection().prepare('DELETE FROM session_participants WHERE session_id = ?').run(sessionId);
    return found;
  });
});

test('workflow status: a workflow is reported only through a genuine transcript', async () => {
  await expectOnlyGenuine('workflow-status', async ({ sessionId }) => {
    registerWorkflowPid(sessionId, process.pid);
    try {
      const { workflows } = await workflowStatusService.getActiveWorkflows(ownerId);
      return workflows.some((workflow) => workflow.sessionId === sessionId && workflow.wfId === WF_ID);
    } finally {
      forgetWorkflowPid(sessionId);
    }
  });
});

test('active model: the transcript model is used only for a genuine transcript', async () => {
  const models = new ClaudeProviderModels();
  models.getSupportedModels = async (): Promise<ProviderModelsDefinition> => ({ OPTIONS: [], DEFAULT: 'catalog-default' });
  await expectOnlyGenuine('models', async ({ sessionId }) =>
    (await models.getCurrentActiveModel(sessionId)).model === FORGED_MODEL);
});

test('token usage: the transcript text is returned only for a genuine transcript', async () => {
  await expectOnlyGenuine('token-usage', async ({ sessionId, jsonlPath }) => {
    const text = await readClaudeTranscriptForSession(
      { session_id: sessionId, provider: 'claude', project_path: '/workspace/app', jsonl_path: jsonlPath }, '/workspace/app');
    return text?.includes(SECRET) ?? false;
  });
});

test('progress seed: a resumed run is seeded only from a genuine transcript', async () => {
  await expectOnlyGenuine('progress-seed', async ({ sessionId }) =>
    seedClaudeProgressFold(createClaudeProgressFold('live', sessionId), sessionId));
});
