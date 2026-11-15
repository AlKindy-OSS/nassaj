/**
 * ADR-173 P2: shared-writer authority at the websocket launch boundary.
 *
 * isSharedSessionWriter is never wider than the send gate and needs explicit
 * project membership; the participant arm alone is insufficient. The resolver
 * gets access 'session_writer' only from that predicate (Claude only, flag on),
 * and the server always writes `sharedResume` after the client's options, so a
 * client can never inject it (qa-critic condition 1).
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
const PARTICIPANT_ONLY = 3;
const INACTIVE_MEMBER = 4;
const SESSION_ID = 'shared-writer-authority-1';

type SessionRow = { session_id: string; project_path: string; provider: string; created_by: number };
let sessionRow: SessionRow | null = null;
const registeredPaths = new Set<string>();
const members = new Set<number>([MEMBER, INACTIVE_MEMBER]);

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    ...chatImageStoreDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: (projectPath: string) => registeredPaths.has(projectPath)
        ? { project_id: 'project-shared', created_by: CREATOR } : null,
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: (_projectId: string, userId: number) => userId === CREATOR || members.has(userId),
    },
    projectMembersDb: {
      getRole: (_projectId: string, userId: number) => (members.has(userId) ? 'member' : null),
    },
    // ADR-104 participant arm: grants write with enforcement off, but is not membership.
    participantsDb: { isParticipant: (_sessionId: string, userId: number) => userId === PARTICIPANT_ONLY },
    sessionsDb: { getSessionById: (id: string) => (sessionRow?.session_id === id ? sessionRow : null) },
    sessionWorkspaceModesDb: {
      readLegacyEligibility: () => null,
      markOverlay: () => undefined,
      markShared: () => undefined,
    },
    sessionOutcomesDb: {},
    userDb: {
      getUserById: (id: number) => ([CREATOR, MEMBER, PARTICIPANT_ONLY].includes(id) ? { id, role: 'user' } : undefined),
      getFirstUser: () => null,
    },
  },
});

const service = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, service.dispatchProviderCommand as never);

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

type Frame = Record<string, unknown>;

function recordingRuntime(seen: { options?: Frame }) {
  return async (_command: string, options: Frame, runtimeWriter: WebSocketWriter) => {
    seen.options = options;
    runtimeWriter.send({ kind: 'session_created', sessionId: SESSION_ID });
    runtimeWriter.send({ kind: 'complete', success: true, sessionId: SESSION_ID });
  };
}

async function send(principalId: number, data: Frame, seen: { options?: Frame }, provider = 'claude') {
  const sent: Frame[] = [];
  const writer = { send: (frame: Frame) => sent.push(frame) } as unknown as WebSocketWriter;
  const dependencies = {
    getSessionProvider: () => (sessionRow ? provider : null),
    getActiveClaudeSDKSessions: () => [],
    queryClaudeSDK: recordingRuntime(seen),
  } as never;
  await dispatchProviderCommand('claude-command', data, writer, dependencies, principalId);
  return sent.find((frame) => frame.kind === 'complete' && frame.success === false);
}

/** One creator-owned overlay conversation per test, torn down afterwards. */
async function withCreatorConversation(run: (repo: string, overlayCwd: string) => Promise<void>) {
  const repo = fs.mkdtempSync(path.join(WORKSPACES, 'nassaj-shared-authority-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Shared Authority Test');
  git(repo, 'config', 'user.email', 'shared-authority@example.test');
  fs.writeFileSync(path.join(repo, 'source.txt'), 'base\n');
  git(repo, 'add', 'source.txt');
  git(repo, 'commit', '-m', 'chore: baseline');
  registeredPaths.add(repo);
  registeredPaths.add(fs.realpathSync(repo));
  try {
    const created: { options?: Frame } = {};
    await send(CREATOR, { command: 'start', options: { cwd: repo, clientMsgId: 'creator-start', sharedResume: true } }, created);
    assert.equal(created.options?.sharedResume, false, 'a new launch is never a shared resume, whatever the client says');
    sessionRow = { session_id: SESSION_ID, project_path: fs.realpathSync(repo), provider: 'claude', created_by: CREATOR };
    await run(repo, String(created.options?.cwd));
  } finally {
    sessionRow = null;
    registeredPaths.clear();
    delete process.env.NASSAJ_SHARED_SESSION_WRITING;
    git(repo, 'worktree', 'prune');
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

const resumeData = (repo: string, clientMsgId: string, extra: Frame = {}) => ({
  command: 'continue', options: { cwd: repo, sessionId: SESSION_ID, resume: true, clientMsgId, ...extra },
});

test('isSharedSessionWriter: explicit member with write only; participant arm and inactive users refused', async () => {
  await withCreatorConversation(async () => {
    assert.equal(service.isSharedSessionWriter(SESSION_ID, MEMBER), true, 'project_members row + write');
    assert.equal(service.isSharedSessionWriter(SESSION_ID, CREATOR), true, 'project creator');
    assert.equal(service.isSessionWritableByUser(SESSION_ID, PARTICIPANT_ONLY), true, 'participant arm writes');
    assert.equal(service.isSharedSessionWriter(SESSION_ID, PARTICIPANT_ONLY), false, 'participant arm alone is insufficient');
    assert.equal(service.isSharedSessionWriter(SESSION_ID, INACTIVE_MEMBER), false, 'inactive user');
    assert.equal(service.isSharedSessionWriter(SESSION_ID, null), false, 'anonymous');
    assert.equal(service.isSharedSessionWriter('unknown-session', MEMBER), false, 'unknown session');
    registeredPaths.clear();
    assert.equal(service.isSharedSessionWriter(SESSION_ID, MEMBER), false, 'unregistered project');
  });
});

test('member resume: creator overlay with a server-computed sharedResume=true', async () => {
  await withCreatorConversation(async (repo, overlayCwd) => {
    const seen: { options?: Frame } = {};
    const refusal = await send(MEMBER, resumeData(repo, 'member-1'), seen);
    assert.equal(refusal, undefined, JSON.stringify(refusal));
    assert.equal(seen.options?.cwd, overlayCwd);
    assert.equal(seen.options?.sharedResume, true);
  });
});

test('creator resume: client-injected sharedResume/sharedParticipant are overwritten with false', async () => {
  await withCreatorConversation(async (repo, overlayCwd) => {
    const seen: { options?: Frame } = {};
    const refusal = await send(CREATOR, resumeData(repo, 'creator-2', { sharedResume: true, sharedParticipant: true }), seen);
    assert.equal(refusal, undefined, JSON.stringify(refusal));
    assert.equal(seen.options?.cwd, overlayCwd);
    assert.equal(seen.options?.sharedResume, false);
    assert.equal(seen.options?.sharedParticipant, false, 'R3 field is server-written too');
  });
});

test('participant-only sender keeps the strict principal refusal', async () => {
  await withCreatorConversation(async (repo) => {
    const seen: { options?: Frame } = {};
    const refusal = await send(PARTICIPANT_ONLY, resumeData(repo, 'participant-1'), seen);
    assert.equal(refusal?.code, 'session_workspace_unavailable');
    assert.equal(seen.options, undefined, 'the provider never starts');
  });
});

test('flag NASSAJ_SHARED_SESSION_WRITING=0 restores the strict resolver', async () => {
  await withCreatorConversation(async (repo) => {
    process.env.NASSAJ_SHARED_SESSION_WRITING = '0';
    const seen: { options?: Frame } = {};
    const refusal = await send(MEMBER, resumeData(repo, 'member-flag-off'), seen);
    assert.equal(refusal?.code, 'session_workspace_unavailable');
    assert.equal(seen.options, undefined);
  });
});

test('a non-Claude conversation keeps the strict resolver for a shared writer', async () => {
  await withCreatorConversation(async (repo) => {
    sessionRow = { ...(sessionRow as SessionRow), provider: 'codex' };
    const seen: { options?: Frame } = {};
    const refusal = await send(MEMBER, resumeData(repo, 'member-codex'), seen, 'codex');
    assert.ok(refusal, 'a codex resume by a non-creator is refused before any launch');
    assert.equal(seen.options, undefined);
  });
});
