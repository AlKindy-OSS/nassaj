/**
 * ADR-210 (T-2036): the agent report and orphan listing reach viewers masked.
 * Same chain as the ADR-201 e2e: a real Claude transcript and a subagent file
 * in a member tree, synced by the real synchronizer, read by the real service.
 *
 * Runner: TMPDIR=/var/tmp node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getConnection, initializeDatabase, participantsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { encodeClaudeProjectDir } from '@/modules/providers/list/claude/claude-transcript-path.js';
import { agentStatusService } from '@/modules/providers/services/agent-status.service.js';
// eslint-disable-next-line boundaries/no-unknown -- ADR-210 test seam of the display masking leaf service.
import { configureDisplayMaskForTests } from '@/services/display-secret-mask.js';

import { claudeTranscript } from './helpers/adr201-real-headers.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
process.env.NASSAJ_GOVERNANCE_DIR = path.join(SANDBOX_HOME, 'nassaj-core');

const USER = 1;
const PROJECT = path.join(SANDBOX_HOME, 'work', 'mask-project');
const AGENT_ID = 'a0123456789abcdef';
const ORPHAN_ID = 'b0123456789abcdef';
const SESSION_ID = '00000000-0000-4000-a210-000000000001';
const SK = 'sk-' + 'ant-api03-MnBvCxZaLkJhGfDsPoIuYt';

await initializeDatabase();
getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(USER, 'member-1', 'x');
fs.mkdirSync(PROJECT, { recursive: true });
configureDisplayMaskForTests({ env: () => undefined, readSetting: () => null, serviceLiterals: () => [], allUserIds: () => [] });
test.after(() => configureDisplayMaskForTests(null));

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const transcript = path.join(SANDBOX_HOME, '.nassaj-users', String(USER), '.claude', 'projects',
  encodeClaudeProjectDir(PROJECT), `${SESSION_ID}.jsonl`);
participantsDb.recordSpawn(SESSION_ID, USER, { provider: 'claude', projectPath: PROJECT });
write(transcript, claudeTranscript(SESSION_ID, PROJECT, 'ordinary text'));
const agentDir = path.join(path.dirname(transcript), SESSION_ID, 'subagents');
const reportRow = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Done. Key: ${SK}` }] } };
write(path.join(agentDir, `agent-${AGENT_ID}.jsonl`), `${JSON.stringify(reportRow)}\n`);
// An agent that narrated, called a tool and never got the result back: an orphan.
const orphanRow = { type: 'assistant', message: { role: 'assistant', content: [
  { type: 'text', text: `${'progress '.repeat(65)}token ${SK}` }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } };
write(path.join(agentDir, `agent-${ORPHAN_ID}.jsonl`), `${JSON.stringify(orphanRow)}\n`);
write(path.join(agentDir, `agent-${AGENT_ID}.meta.json`), JSON.stringify({ agentType: 'x', description: `uses ${SK}` }));
const originalWarn = console.warn;
console.warn = () => {};
await new ClaudeSessionSynchronizer().synchronize();
console.warn = originalWarn;

test('the agent report is masked for its viewer', async () => {
  const report = await agentStatusService.getAgentReport(USER, AGENT_ID);
  assert.ok(report, 'control: the report is found');
  assert.match(report.report ?? '', /^Done\. Key: \[masked:[a-z-]+\]$/);
  assert.match(report.description ?? '', /^uses \[masked:anthropic-openai-key\]$/);
  assert.ok(!JSON.stringify(report).includes('MnBvCxZa'));
});

test('the orphan listing preview is masked before it is cut', async () => {
  const result = await agentStatusService.getOrphanedAgents(USER, { quietMs: 0, now: Date.now() + 60_000 });
  assert.ok(!JSON.stringify(result).includes('MnBvCxZa'));
  const agent = result.agents.find((row) => row.agentId === ORPHAN_ID);
  assert.ok(agent, 'control: the stopped agent is listed');
  // The secret straddles the 600-char preview edge: masked first, so no fragment survives the cut.
  assert.ok(!(agent.reportPreview ?? '').includes('sk-ant'));
});
