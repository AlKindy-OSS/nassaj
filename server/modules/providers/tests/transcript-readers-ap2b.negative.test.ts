/**
 * ADR-201 A-P2b — negative tests per reader migrated in this stage, through each
 * reader's real entry point:
 *   agent roster (participantsService.listSessionAgents), steer delivery proof
 *   (steerTranscriptOpener + createTranscriptScanner), supervisor handoff target
 *   (verifyDeliveryTarget), command active model (executeModelsCommand, requester
 *   check), agy discovery (AntigravitySessionSynchronizer#synchronize), cost
 *   extraction (extractClaudeSessionUsage), Codex link metadata
 *   (readCodexRolloutMetadata), and the launch-time transcript record
 *   (recordClaudeLaunchTranscript → token usage of a not-yet-indexed session).
 *
 * Scenarios differ by one defect of the recorded path (fixtures: the real Claude
 * and Codex share headers, B-1520 redacted, re-keyed):
 *   - genuine:  `<id>.jsonl` in the operator tree, header bound to `<id>` (control);
 *   - forged:   the header names another session;
 *   - crossTree: the recorded path in member tree /1 is a symlink to /10 (prefix trap);
 *   - symlink:  the recorded path is a symlink to a file outside every provider root;
 *   - hardlink: the recorded path is a hardlink of member /10's file.
 * Cost and Codex link readers bind identity in their callers; for them the
 * pinned descriptor itself is under test (symlink/hardlink refused, control read).
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import { getConnection, initializeDatabase, participantsDb, projectsDb, userDb } from '@/modules/database/index.js';
import { AGY_BRAIN_UNDER_HOME } from '@/modules/providers/list/antigravity/agy-brain-layout.js';
import { AntigravitySessionSynchronizer } from '@/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.js';
import { recordClaudeLaunchTranscript } from '@/modules/providers/list/claude/claude-launch-transcript.js';
import { readClaudeTranscriptForSession } from '@/modules/providers/list/claude/claude-token-usage.js';
import { readCodexRolloutMetadata } from '@/modules/providers/list/codex/codex-rollout-links.js';
import { extractClaudeSessionUsage } from '@/modules/providers/services/cost/usage-extractors.js';
import { participantsService } from '@/modules/providers/services/participants.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { createTranscriptScanner, steerTranscriptOpener } from '@/modules/session-steer/index.js';
// eslint-disable-next-line boundaries/dependencies -- the supervisor's real target check (not in its barrel).
import { verifyDeliveryTarget } from '@/modules/workflow-supervisor/supervisor.js';
// eslint-disable-next-line boundaries/no-unknown -- shared test fixture helper (same seam as sandbox-home)
import { claudeHeaderLine, codexSessionMetaLine } from '@/shared/__tests__/provider-root-sandbox.js';
// eslint-disable-next-line boundaries/no-unknown -- the commands route module (JS)
import { executeModelsCommand } from '@/routes/commands.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
const PROJECT_PATH = '/workspace/ap2b';
const PROJECT = '-workspace-ap2b';
const OPERATOR_DIR = path.join(SANDBOX_HOME, '.claude', 'projects', PROJECT);
const memberDir = (member: string) => path.join(SANDBOX_HOME, '.nassaj-users', member, '.claude', 'projects', PROJECT);
const OUTSIDE_DIR = path.join(SANDBOX_HOME, 'outside-every-root');
const FORGED_MODEL = 'claude-planted-model-ap2b';
const STEER_UUID = '11111111-2222-4333-8444-555555555555';

await initializeDatabase();
const ownerId = userDb.createUser('ap2b-owner', 'hash-o', 'user').id;
const strangerId = userDb.createUser('ap2b-stranger', 'hash-s', 'user').id;
const projectId = projectsDb.ensureProjectPathForSession(PROJECT_PATH);
assert.ok(projectId, 'project row');
projectsDb.setProjectCreatedBy(projectId, ownerId);

type Scenario = 'genuine' | 'forged' | 'crossTree' | 'symlink' | 'hardlink';
const SCENARIOS: readonly Scenario[] = ['genuine', 'forged', 'crossTree', 'symlink', 'hardlink'];

let counter = 0;
const nextId = () => `00000000-0000-4000-b000-${String(++counter).padStart(12, '0')}`;

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function link(target: string, recorded: string, hard: boolean): void {
  fs.mkdirSync(path.dirname(recorded), { recursive: true });
  if (hard) fs.linkSync(target, recorded);
  else fs.symlinkSync(target, recorded);
}

/** Real header bound to `headerId`, a model-bearing reply, and a steer-proof line. */
function transcriptText(headerId: string): string {
  const reply = { type: 'assistant', sessionId: headerId, uuid: `${headerId}-a`, requestId: 'req_ap2b',
    timestamp: '2026-10-12T00:00:01.000Z',
    message: { id: 'msg_ap2b', role: 'assistant', model: FORGED_MODEL, content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 10, output_tokens: 5 } } };
  const steer = { type: 'attachment', attachment: { type: 'queued_command', prompt: 'p', source_uuid: STEER_UUID } };
  return [claudeHeaderLine(headerId), JSON.stringify(reply), JSON.stringify(steer)].join('\n') + '\n';
}

function layout(sessionId: string, scenario: Scenario): { target: string; recorded: string } {
  const name = `${sessionId}.jsonl`;
  switch (scenario) {
    case 'crossTree': return { target: path.join(memberDir('10'), name), recorded: path.join(memberDir('1'), name) };
    case 'symlink': return { target: path.join(OUTSIDE_DIR, name), recorded: path.join(OPERATOR_DIR, name) };
    case 'hardlink': return { target: path.join(memberDir('10'), name), recorded: path.join(OPERATOR_DIR, name) };
    default: return { target: path.join(OPERATOR_DIR, name), recorded: path.join(OPERATOR_DIR, name) };
  }
}

/**
 * Runs `body` with project membership enforced (ADR-172), so a non-member is
 * refused; without it ADR-089 lets every authenticated member read every
 * registered project, and the requester check has nothing to refuse.
 */
async function asMembersOnly(body: () => Promise<void>): Promise<void> {
  const previous = process.env.PROJECT_MEMBERSHIP_ENFORCE;
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
    else process.env.PROJECT_MEMBERSHIP_ENFORCE = previous;
  }
}

/** A Claude session row (owner spawn) recording the planted path. */
function recordScenario(scenario: Scenario): { sessionId: string; jsonlPath: string } {
  const sessionId = nextId();
  const { target, recorded } = layout(sessionId, scenario);
  write(target, transcriptText(scenario === 'forged' ? nextId() : sessionId));
  if (recorded !== target) link(target, recorded, scenario === 'hardlink');
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, ?, ?)')
    .run(sessionId, 'claude', PROJECT_PATH, recorded);
  participantsDb.recordSpawn(sessionId, ownerId);
  return { sessionId, jsonlPath: recorded };
}

async function expectOnlyGenuine(name: string, probe: (row: { sessionId: string; jsonlPath: string }) => Promise<boolean>) {
  for (const scenario of SCENARIOS) {
    assert.equal(await probe(recordScenario(scenario)), scenario === 'genuine', `${name}: ${scenario}`);
  }
}

test('agent roster: the transcript model is listed only for a genuine transcript', async () => {
  await expectOnlyGenuine('agents', async ({ sessionId }) =>
    (await participantsService.listSessionAgents(sessionId)).agents.some((agent) => agent.agent_name === FORGED_MODEL));
});

test('steer delivery: a delivery is proven only from a genuine transcript', async () => {
  await expectOnlyGenuine('steer', async ({ sessionId }) =>
    createTranscriptScanner(steerTranscriptOpener(() => sessionId, ownerId)).has(STEER_UUID));
});

test('steer delivery: a requester who may not read the session proves nothing', async () => {
  await asMembersOnly(async () => {
    const { sessionId } = recordScenario('genuine');
    const proves = (userId: number) => createTranscriptScanner(steerTranscriptOpener(() => sessionId, userId)).has(STEER_UUID);
    assert.equal(await proves(ownerId), true, 'control');
    assert.equal(await proves(strangerId), false);
  });
});

test('handoff target: a delivery target is admitted only for a genuine transcript', async () => {
  await expectOnlyGenuine('handoff', async ({ sessionId }) => (await verifyDeliveryTarget(sessionId, ownerId)).ok);
});

test('L5: the handoff target requires the row provider to be claude, never a blank one', async () => {
  const sessionId = nextId();
  write(path.join(OPERATOR_DIR, `${sessionId}.jsonl`), transcriptText(sessionId));
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, ?, ?)')
    .run(sessionId, '', PROJECT_PATH, path.join(OPERATOR_DIR, `${sessionId}.jsonl`));
  participantsDb.recordSpawn(sessionId, ownerId);
  const target = await verifyDeliveryTarget(sessionId, ownerId);
  assert.equal(target.ok, false, 'a blank provider is not claude');
});

test('command model: the session model is read only for a requester who may read the session', async () => {
  const original = providerModelsService.getProviderModels;
  providerModelsService.getProviderModels = async () => ({
    models: { OPTIONS: [{ value: 'catalog-default', label: 'Default' }], DEFAULT: 'catalog-default' },
    cache: { updatedAt: '2026-10-12T00:00:00.000Z', expiresAt: '2026-10-15T00:00:00.000Z', source: 'fresh' },
  }) as Awaited<ReturnType<typeof original>>;
  try {
    await asMembersOnly(async () => {
      const { sessionId } = recordScenario('genuine');
      const modelFor = async (userId: number) =>
        (await executeModelsCommand([], { provider: 'claude', sessionId, userId })).data.current.model;
      assert.equal(await modelFor(ownerId), FORGED_MODEL, 'control: the owner reads the session model');
      assert.equal(await modelFor(strangerId), 'catalog-default', 'a stranger gets the catalog default');
    });
  } finally {
    providerModelsService.getProviderModels = original;
  }
});

test('launch record: a just-launched session is readable before the synchronizer indexes it', async () => {
  const sessionId = nextId();
  write(path.join(OPERATOR_DIR, `${sessionId}.jsonl`), transcriptText(sessionId));
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path) VALUES (?, ?, ?)')
    .run(sessionId, 'claude', PROJECT_PATH);
  participantsDb.recordSpawn(sessionId, ownerId);
  const row = () => ({ session_id: sessionId, provider: 'claude', project_path: PROJECT_PATH,
    jsonl_path: getConnection().prepare('SELECT jsonl_path FROM sessions WHERE session_id = ?')
      .pluck().get(sessionId) as string | null });
  assert.equal(await readClaudeTranscriptForSession(row(), PROJECT_PATH), null, 'before: no recorded path');
  assert.equal(recordClaudeLaunchTranscript(sessionId, { cwd: PROJECT_PATH, configDir: process.env.CLAUDE_CONFIG_DIR }), 'refreshed');
  assert.ok((await readClaudeTranscriptForSession(row(), PROJECT_PATH))?.includes(FORGED_MODEL), 'after: read pinned');
});

test('launch record: a config dir outside every participant tree is not recorded', async () => {
  const sessionId = nextId();
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path) VALUES (?, ?, ?)')
    .run(sessionId, 'claude', PROJECT_PATH);
  participantsDb.recordSpawn(sessionId, ownerId);
  const foreign = path.join(SANDBOX_HOME, '.nassaj-users', '999', '.claude');
  assert.notEqual(recordClaudeLaunchTranscript(sessionId, { cwd: PROJECT_PATH, configDir: foreign }), 'refreshed');
  const stored = getConnection().prepare('SELECT jsonl_path FROM sessions WHERE session_id = ?').pluck().get(sessionId);
  assert.equal(stored, null);
});

const BRAIN = path.join(SANDBOX_HOME, AGY_BRAIN_UNDER_HOME);
const brainTranscript = (brain: string, uuid: string) =>
  path.join(brain, uuid, '.system_generated', 'logs', 'transcript.jsonl');
const agyText = (title: string) => `${JSON.stringify({ type: 'USER_INPUT', created_at: '2026-10-12T00:00:00Z',
  content: `<USER_REQUEST>${title}</USER_REQUEST>` })}\n`;

test('agy discovery: a title is indexed only from a genuine brain transcript', async () => {
  const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const planted: Record<Scenario, string> = {
    genuine: uuid(1), forged: uuid(2), crossTree: uuid(3), symlink: uuid(4), hardlink: uuid(5),
  };
  const decoy = uuid(9);
  write(brainTranscript(BRAIN, planted.genuine), agyText('secret-genuine'));
  write(brainTranscript(BRAIN, decoy), agyText('secret-decoy'));
  link(brainTranscript(BRAIN, decoy), brainTranscript(BRAIN, planted.forged), false);
  const memberBrain = path.join(SANDBOX_HOME, '.nassaj-users', '10', AGY_BRAIN_UNDER_HOME);
  link(write(brainTranscript(memberBrain, planted.crossTree), agyText('secret-cross')), brainTranscript(BRAIN, planted.crossTree), false);
  link(write(path.join(OUTSIDE_DIR, 'agy-out.jsonl'), agyText('secret-outside')), brainTranscript(BRAIN, planted.symlink), false);
  link(write(path.join(OUTSIDE_DIR, 'agy-hard.jsonl'), agyText('secret-hard')), brainTranscript(BRAIN, planted.hardlink), true);
  await new AntigravitySessionSynchronizer().synchronize();
  const titleOf = (id: string) => getConnection().prepare('SELECT custom_name FROM sessions WHERE session_id = ?')
    .pluck().get(id) as string | undefined;
  for (const scenario of SCENARIOS) {
    assert.equal(Boolean(titleOf(planted[scenario])?.startsWith('secret')), scenario === 'genuine', `agy: ${scenario}`);
  }
});

test('cost extraction: only the genuine transcript is measured (A-P2c: tree- and id-bound)', async () => {
  await expectOnlyGenuine('cost', async ({ sessionId, jsonlPath }) => {
    const usage = await extractClaudeSessionUsage({ sessionId, transcriptPath: jsonlPath });
    return usage.perModel.some((row) => row.model === FORGED_MODEL);
  });
});

test('Codex link metadata: a symlinked or hardlinked rollout is refused', async () => {
  const sessions = path.join(SANDBOX_HOME, '.codex', 'sessions', '2026', '10', '12');
  for (const scenario of ['genuine', 'symlink', 'hardlink'] as const) {
    const id = nextId();
    const recorded = path.join(sessions, `rollout-2026-10-12T00-00-00-${id}.jsonl`);
    const text = `${codexSessionMetaLine(id)}\n`;
    if (scenario === 'genuine') write(recorded, text);
    else link(write(path.join(OUTSIDE_DIR, `codex-${scenario}-${id}.jsonl`), text), recorded, scenario === 'hardlink');
    const threadId = await readCodexRolloutMetadata(recorded).then((meta) => meta.threadId, () => null);
    assert.equal(threadId === id, scenario === 'genuine', `codex-links: ${scenario}`);
  }
});
