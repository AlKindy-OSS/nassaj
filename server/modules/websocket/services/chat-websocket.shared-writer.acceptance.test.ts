/**
 * ADR-173 rev.3 acceptance test #1 (shared writing in a Claude conversation).
 *
 * In the owner's terms: member user 2 sends a message in user 1's Claude
 * conversation and gets a reply on their own account; the turn is appended to
 * the conversation's one recorded transcript file, and the recorded jsonl_path
 * never changes.
 *
 * The CLI is emulated: it appends to `<writer CLAUDE_CONFIG_DIR>/projects/
 * <encoded cwd>/<sid>.jsonl`, exactly where the real CLI writes on resume. The
 * line reaches the creator's recorded file only through the production transcript
 * bridge (ADR-173 P3, proven live in P0), called as claude-sdk.js calls it before
 * the spawn. The member's tree holds a real projects dir (M7 drift), so a link is needed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';
import { chatImageStoreDatabaseLinkStubs } from '../../../../tests/helpers/chat-image-store-link-stubs.js';

import { dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

// Repos live under /var/tmp, never the real home (review, Low).
const WORKSPACES = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'nassaj-shared-workspaces-')));
process.env.WORKSPACES_ROOT = WORKSPACES;
test.after(() => fs.rmSync(WORKSPACES, { recursive: true, force: true }));

const CREATOR = 1;
const MEMBER = 2;
const SESSION_ID = 'shared-writer-session-1';
/** The CLI version the committed P0 proof admits (the installed binary is not probed here). */
const PROVEN_CLI = '2.1.325';

type SessionRow = {
  session_id: string; project_path: string; provider: string; jsonl_path: string; created_by: number;
};
let sessionRow: SessionRow | null = null;
const registeredPaths = new Set<string>();

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    ...chatImageStoreDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: (projectPath: string) => registeredPaths.has(projectPath)
        ? { project_id: 'project-shared', created_by: CREATOR } : null,
      isProjectVisibleToUser: () => true,
      // Both users are project members with write access.
      isProjectWritableByUser: (_projectPath: string, userId: number) => [CREATOR, MEMBER].includes(userId),
    },
    // User 1 created the project; user 2 is an explicit member (ADR-173 authority).
    projectMembersDb: { getRole: (_projectId: string, userId: number) => (userId === MEMBER ? 'member' : null) },
    participantsDb: { isParticipant: () => false },
    sessionsDb: { getSessionById: (id: string) => (sessionRow?.session_id === id ? sessionRow : null) },
    sessionWorkspaceModesDb: {
      readLegacyEligibility: () => null,
      markOverlay: () => undefined,
      markShared: () => undefined,
    },
    sessionOutcomesDb: {},
    userDb: {
      getUserById: (id: number) => ([CREATOR, MEMBER].includes(id) ? { id, role: 'user' } : undefined),
      getFirstUser: () => null,
    },
  },
});

const { dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
// After the mock, so the bridge reads the mocked session row; wired like server/index.js.
// eslint-disable-next-line boundaries/dependencies -- the full providers barrel needs exports this DB mock omits.
const { configureClaudeResumeBridge, ensureClaudeResumeReachable } = await import('../../providers/list/claude/claude-resume-bridge.js');
const { isSharedSessionWriter } = await import('./chat-websocket.service.js');
configureClaudeResumeBridge({ isSharedWriter: isSharedSessionWriter });
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function fixtureRepo(): string {
  const repo = fs.mkdtempSync(path.join(WORKSPACES, 'nassaj-shared-writer-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Shared Writer Test');
  git(repo, 'config', 'user.email', 'shared-writer@example.test');
  fs.writeFileSync(path.join(repo, 'source.txt'), 'base\n');
  git(repo, 'add', 'source.txt');
  git(repo, 'commit', '-m', 'chore: baseline');
  return repo;
}

/** The CLI's project-dir encoding: every non-alphanumeric character becomes '-'. */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/gu, '-');
}

type Frame = Record<string, unknown>;

/**
 * One emulated CLI turn on the writer's own CLAUDE_CONFIG_DIR: a resume first runs the
 * real bridge (as claude-sdk.js does on the final env), then appends where the CLI writes.
 */
function emulatedClaude(configDirOf: (userId: number) => string, userId: number, seen: { options?: Frame; writtenAt?: string }) {
  return async (_command: string, options: Frame, runtimeWriter: WebSocketWriter) => {
    seen.options = options;
    if (options.resume && typeof options.sessionId === 'string') {
      await ensureClaudeResumeReachable({
        sessionId: options.sessionId, recordedJsonlPath: sessionRow?.jsonl_path ?? null, runCwd: String(options.cwd),
        configDir: configDirOf(userId), sharedResume: options.sharedResume === true, userId,
      }, { cliVersion: async () => PROVEN_CLI });
    }
    const projectDir = path.join(configDirOf(userId), 'projects', encodeProjectDir(String(options.cwd)));
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${String(options.sessionId ?? SESSION_ID)}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify({ type: 'user', author: userId })}\n`);
    seen.writtenAt = file;
    runtimeWriter.send({ kind: 'session_created', sessionId: SESSION_ID });
    runtimeWriter.send({ kind: 'text', role: 'assistant', content: `reply to user ${userId}` });
    runtimeWriter.send({ kind: 'complete', success: true, sessionId: SESSION_ID });
  };
}

async function send(principalId: number, data: Frame, runtime: ReturnType<typeof emulatedClaude>): Promise<Frame[]> {
  const sent: Frame[] = [];
  const writer = { send: (frame: Frame) => sent.push(frame) } as unknown as WebSocketWriter;
  const dependencies = {
    getSessionProvider: () => (sessionRow ? 'claude' : null),
    getActiveClaudeSDKSessions: () => [],
    queryClaudeSDK: runtime,
  } as never;
  await dispatchProviderCommand('claude-command', data, writer, dependencies, principalId);
  return sent;
}

test('ADR-173 #1: member 2 writes in user 1\'s Claude conversation, into the one recorded file', async () => {
  const repo = fixtureRepo();
  const homes = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-shared-writer-homes-'));
  const configDirOf = (userId: number) => path.join(homes, String(userId), '.claude');
  registeredPaths.add(repo);
  registeredPaths.add(fs.realpathSync(repo));
  try {
    const created: { options?: Frame } = {};
    await send(CREATOR, { command: 'start', options: { cwd: repo, clientMsgId: 'creator-msg-1' } },
      emulatedClaude(configDirOf, CREATOR, created));
    const overlayCwd = String(created.options?.cwd);
    assert.match(overlayCwd, /nassaj-session-overlays\/instances\//u, 'creator runs in an overlay');
    const recorded = path.join(configDirOf(CREATOR), 'projects', encodeProjectDir(overlayCwd), `${SESSION_ID}.jsonl`);
    sessionRow = {
      session_id: SESSION_ID, project_path: fs.realpathSync(repo), provider: 'claude',
      jsonl_path: recorded, created_by: CREATOR,
    };
    const linesBefore = fs.readFileSync(recorded, 'utf8').split('\n').filter(Boolean).length;
    // User 2's provisioned tree with a real projects dir (M7 drift): only a bridge link reaches user 1's file.
    fs.mkdirSync(path.join(configDirOf(MEMBER), 'projects'), { recursive: true });

    const resumed: { options?: Frame; writtenAt?: string } = {};
    const frames = await send(MEMBER, {
      command: 'hello from member', options: { cwd: repo, sessionId: SESSION_ID, resume: true, clientMsgId: 'member-msg-1' },
    }, emulatedClaude(configDirOf, MEMBER, resumed));

    const refusal = frames.find((frame) => frame.kind === 'complete' && frame.success === false);
    assert.equal(refusal, undefined, `member's send was refused: ${JSON.stringify(refusal)}`);
    assert.equal(resumed.options?.cwd, overlayCwd, 'member resumes in the creator\'s overlay');
    assert.ok(frames.some((frame) => frame.kind === 'text' && frame.content === `reply to user ${MEMBER}`), 'member gets a reply');
    const lines = fs.readFileSync(recorded, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, linesBefore + 1, 'member\'s turn is appended to the recorded file');
    assert.deepEqual(JSON.parse(lines.at(-1) ?? '{}'), { type: 'user', author: MEMBER });
    assert.equal(sessionRow.jsonl_path, recorded, 'jsonl_path is never rebound');
    assert.ok(resumed.writtenAt?.startsWith(`${configDirOf(MEMBER)}${path.sep}`), 'the run wrote through user 2\'s tree');
    assert.equal(resumed.options?.sharedResume, true, 'server-computed sharedResume reached the run');
    const bridged = path.join(configDirOf(MEMBER), 'projects', encodeProjectDir(overlayCwd));
    assert.ok(fs.lstatSync(bridged).isDirectory(), 'M-d: a real writer dir, never a dir link');
    assert.ok(fs.lstatSync(String(resumed.writtenAt)).isSymbolicLink(), 'user 2 reaches the file by a file link');
    assert.equal(fs.realpathSync(String(resumed.writtenAt)), recorded);
  } finally {
    sessionRow = null;
    registeredPaths.clear();
    git(repo, 'worktree', 'prune');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(homes, { recursive: true, force: true });
  }
});
