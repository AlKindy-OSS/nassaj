/**
 * ADR-173 rev.3 P5: a non-starter of a Claude turn, against the real registrar,
 * resolver and run map of claude-sdk. Approvals: the answer is admitted only while
 * the member is a shared writer AT ANSWER TIME, reduced to allow/deny, a deny text
 * capped and attributed, and audited by hash; external-identity (mcp__*) prompts are
 * the starter's alone. Stop: starter / project owner / platform admin always, another
 * shared writer only when stuck, audited; the session_busy canStop follows the same
 * rule for the refused sender; NASSAJ_SHARED_SESSION_WRITING=0 restores today's gate.
 */
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import test, { afterEach, before, mock } from 'node:test';

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: { query: () => { throw new Error('not used'); }, createSdkMcpServer: () => ({}), tool: () => ({}) },
});

const { getConnection, initializeDatabase, userDb } = await import('@/modules/database/index.js');
const { configureClaudeSharedTurnAuthority, NON_STARTER_DENY_TEXT_MAX } = await import(
  '@/modules/providers/list/claude/claude-shared-turn-authority.js');
const sdk = (await import('./claude-sdk.js')) as unknown as Record<string, any>;

let STARTER = 0;
let WRITER = 0;
let PROJECT_OWNER = 0;
let VIEWER = 0;
const writers = new Set<number>();

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'use the isolated node test runner');
  await initializeDatabase();
  const user = (name: string) => (userDb.createUser(name, 'unused-hash', 'user') as { id: number }).id;
  STARTER = user('turn_starter');
  WRITER = user('sara');
  PROJECT_OWNER = user('project_owner');
  VIEWER = user('participant_viewer');
});

function configure() {
  writers.clear();
  writers.add(WRITER);
  writers.add(PROJECT_OWNER);
  configureClaudeSharedTurnAuthority({
    isSharedWriter: (_sid, uid) => writers.has(Number(uid)),
    isStopPrivileged: (_sid, uid) => Number(uid) === PROJECT_OWNER,
  });
}

afterEach(() => {
  delete process.env.NASSAJ_SHARED_SESSION_WRITING;
  configureClaudeSharedTurnAuthority({ isSharedWriter: () => false, isStopPrivileged: () => false });
});

function audits(action: string, sessionId: string): Array<Record<string, unknown>> {
  return (getConnection().prepare('SELECT user_id AS userId, metadata FROM audit_log WHERE action = ?')
    .all(action) as Array<{ userId: number | null; metadata: string }>)
    .map((row) => ({ userId: row.userId, ...JSON.parse(row.metadata) }))
    .filter((row) => row.sessionId === sessionId);
}

function pending(requestId: string, sessionId: string, toolName = 'Bash') {
  return sdk.waitForToolApproval(requestId, {
    timeoutMs: 5_000,
    metadata: { _sessionId: sessionId, _ownerUserId: STARTER, _toolName: toolName, _input: { command: 'ls' } },
  });
}

test('a shared writer\'s answer is allow/deny only, its deny text capped, attributed and audited by hash', async () => {
  configure();
  const allowed = pending('sw-allow', 'sw-session-1');
  assert.equal(sdk.resolveToolApproval('sw-allow', { allow: true, requesterUserId: WRITER,
    updatedInput: { command: 'rm -rf /' }, rememberEntry: 'Bash' }).resolved, true);
  assert.deepEqual(await allowed, { allow: true });

  const denied = pending('sw-deny', 'sw-session-1');
  const text = 'y'.repeat(NON_STARTER_DENY_TEXT_MAX + 50);
  assert.equal(sdk.resolveToolApproval('sw-deny', { allow: false, requesterUserId: WRITER, message: text })
    .resolved, true);
  const decision = await denied;
  assert.equal(decision.allow, false);
  assert.equal(decision.message, `sara: ${'y'.repeat(NON_STARTER_DENY_TEXT_MAX)}`);

  const rows = audits('shared_turn_approval', 'sw-session-1');
  assert.deepEqual(rows.map(({ userId, requestId, admitted, allow }) => ({ userId, requestId, admitted, allow })), [
    { userId: WRITER, requestId: 'sw-allow', admitted: true, allow: true },
    { userId: WRITER, requestId: 'sw-deny', admitted: true, allow: false },
  ]);
  assert.match(String(rows[1].textSha256), /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(rows).includes('yyyy'), false, 'the text itself is never stored');
});

test('a participant who is not a shared writer is refused; a writer removed before answering is refused', async () => {
  configure();
  const prompt = pending('sw-removed', 'sw-session-2');
  assert.equal(sdk.resolveToolApproval('sw-removed', { allow: true, requesterUserId: VIEWER }).resolved, false);
  writers.delete(WRITER);
  assert.equal(sdk.resolveToolApproval('sw-removed', { allow: true, requesterUserId: WRITER }).resolved, false,
    'membership is rechecked at answer time');
  assert.equal(sdk.resolveToolApproval('sw-removed', { allow: true, requesterUserId: STARTER }).resolved, true);
  assert.equal((await prompt).allow, true);
  assert.deepEqual(audits('shared_turn_approval', 'sw-session-2').map(r => [r.userId, r.admitted]),
    [[VIEWER, false], [WRITER, false]]);
});

test('an external-identity (mcp__*) prompt is the starter\'s alone, and every answer is audited', async () => {
  configure();
  const prompt = pending('sw-mcp', 'sw-session-3', 'mcp__github__create_issue');
  assert.equal(sdk.resolveToolApproval('sw-mcp', { allow: true, requesterUserId: WRITER }).resolved, false);
  assert.equal(sdk.resolveToolApproval('sw-mcp', { allow: true, requesterUserId: STARTER,
    rememberEntry: 'mcp__github__create_issue' }).resolved, true);
  const answer = await prompt;
  assert.deepEqual([answer.allow, answer.rememberEntry], [true, 'mcp__github__create_issue'],
    'the starter keeps his full answer');
  assert.deepEqual(audits('shared_turn_approval', 'sw-session-3').map(r => [r.userId, r.admitted, r.externalIdentity]),
    [[WRITER, false, true], [STARTER, true, true]]);
  const listed = pending('sw-mcp-listed', 'sw-session-3b', 'mcp__github__create_issue');
  assert.equal(sdk.getPendingApprovalsForSession('sw-session-3b')[0]?.externalIdentity, true);
  sdk.resolveToolApproval('sw-mcp-listed', { allow: false, requesterUserId: STARTER });
  await listed;
});

test('M-c: an AskUserQuestion prompt is the starter\'s alone; his answers pass intact', async () => {
  configure();
  const prompt = pending('sw-ask', 'sw-session-ask', 'AskUserQuestion');
  assert.equal(sdk.resolveToolApproval('sw-ask', { allow: true, requesterUserId: WRITER,
    updatedInput: { answers: { q: 'writer' } } }).resolved, false, 'a non-starter cannot answer it');
  const answers = { questions: [], answers: { q: 'starter' } };
  assert.equal(sdk.resolveToolApproval('sw-ask', { allow: true, requesterUserId: STARTER, updatedInput: answers })
    .resolved, true);
  assert.deepEqual((await prompt).updatedInput, answers, 'the starter\'s answers reach the tool');
  assert.deepEqual(audits('shared_turn_approval', 'sw-session-ask').map(r => [r.userId, r.admitted]),
    [[WRITER, false]]);
});

test('qa r2 #3: a plan approval (ExitPlanMode) is the starter\'s alone, as the read-only plan card shows', async () => {
  configure();
  const prompt = pending('sw-plan', 'sw-session-plan', 'ExitPlanMode');
  assert.equal(sdk.resolveToolApproval('sw-plan', { allow: true, requesterUserId: WRITER }).resolved, false,
    'a non-starter cannot build the plan');
  assert.equal(sdk.resolveToolApproval('sw-plan', { allow: false, requesterUserId: WRITER, message: 'no' }).resolved,
    false, 'nor send it back for revision');
  assert.equal(sdk.resolveToolApproval('sw-plan', { allow: true, requesterUserId: STARTER }).resolved, true);
  assert.equal((await prompt).allow, true);
});

function liveRun(sessionId: string, lastEventAt: number) {
  const token = Symbol(sessionId);
  const activity = { observe: () => undefined,
    snapshot: () => ({ lastEventAt, openToolUses: 0, quiet: false, pendingTasks: 0 }) };
  const writer = { userId: STARTER, isPrimarySocketAlive: () => true, send: () => undefined };
  assert.equal(sdk.addSession(sessionId, {}, [], null, writer, null, null, token, null, null, activity), true);
  return () => sdk.removeSession(sessionId, token);
}

test('stop: starter and project owner always, another shared writer only when stuck, all audited', () => {
  configure();
  const end = liveRun('sw-stop-running', Date.now());
  try {
    const stop = (uid: number | null) => sdk.authorizeClaudeTurnStop('sw-stop-running', uid);
    assert.equal(stop(STARTER).allowed, true);
    assert.deepEqual(stop(PROJECT_OWNER), { allowed: true, role: 'privileged', stuck: false, starterUserId: STARTER });
    assert.deepEqual(stop(WRITER), { allowed: false, role: null, stuck: false, starterUserId: STARTER });
    assert.equal(stop(VIEWER).allowed, false);
  } finally {
    end();
  }
  process.env.CLAUDE_RUN_STUCK_AFTER_MS = '1';
  const endStuck = liveRun('sw-stop-stuck', Date.now() - 1_000);
  try {
    assert.deepEqual(sdk.authorizeClaudeTurnStop('sw-stop-stuck', WRITER),
      { allowed: true, role: 'stuck_writer', stuck: true, starterUserId: STARTER });
  } finally {
    endStuck();
    delete process.env.CLAUDE_RUN_STUCK_AFTER_MS;
  }
  assert.deepEqual(audits('shared_turn_stop', 'sw-stop-running').map(r => [r.userId, r.allowed, r.role]),
    [[PROJECT_OWNER, true, 'privileged'], [WRITER, false, null], [VIEWER, false, null]]);
  assert.deepEqual(audits('shared_turn_stop', 'sw-stop-stuck').map(r => [r.userId, r.allowed, r.role]),
    [[WRITER, true, 'stuck_writer']]);
});

test('stop: no active run is nothing to refuse; flag 0 restores today\'s abort gate', () => {
  configure();
  assert.equal(sdk.authorizeClaudeTurnStop('sw-no-run', WRITER).allowed, true);
  const end = liveRun('sw-stop-flag', Date.now());
  try {
    process.env.NASSAJ_SHARED_SESSION_WRITING = '0';
    assert.equal(sdk.authorizeClaudeTurnStop('sw-stop-flag', WRITER).allowed, true);
  } finally {
    end();
  }
});
