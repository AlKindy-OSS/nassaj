/**
 * ADR-173 review fixes on a legacy_shared conversation (a shared cwd, no overlay
 * manifest), at the websocket launch boundary with the production transcript bridge.
 *
 * CRIT-1: a member removed after writing (enforcement off: still a participant through
 * message_authors, so the legacy resolver and attestation admit him) or any resume
 * under the kill switch must not write into the creator's file through the bridge link
 * an earlier shared turn left in his tree.
 *
 * R3 (qa condition 4): a row-less legacy conversation never makes a resuming sender
 * its owner unless he is its creator: the creator is the owner row, else the sender's
 * own earlier spawn row, else the member whose own tree holds the recorded file.
 * Not inferable: the sender is recorded as a participant (shared_write), never owner.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';
import { chatImageStoreDatabaseLinkStubs } from '../../../../tests/helpers/chat-image-store-link-stubs.js';

import { dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

const BASE = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'nassaj-shared-legacy-')));
process.env.WORKSPACES_ROOT = BASE;
// Member trees are `<home>/.nassaj-users/<n>/` (session-source-tree); the home is this sandbox.
(os as { homedir: () => string }).homedir = () => BASE;

const CREATOR = 1;
const MEMBER = 2;
const SESSION_ID = 'shared-writer-legacy-1';
const PROVEN_CLI = '2.1.325';

type SessionRow = { session_id: string; project_path: string; provider: string; jsonl_path: string | null };
let sessionRow: SessionRow | null = null;
let projectPath = '';
const members = new Set<number>([MEMBER]);
const participants = new Set<number>([MEMBER]);
const owners: Array<{ userId: number; username: string }> = [];
const spawnRows = new Set<number>();

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    ...chatImageStoreDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: (candidate: string) => (candidate === projectPath
        ? { project_id: 'project-legacy', created_by: CREATOR } : null),
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: (_projectId: string, userId: number) => userId === CREATOR || members.has(userId),
    },
    projectMembersDb: { getRole: (_projectId: string, userId: number) => (members.has(userId) ? 'member' : null) },
    // ADR-104 participant arm (enforcement off): a removed member who wrote stays a participant.
    participantsDb: {
      isParticipant: (_sessionId: string, userId: number) => participants.has(userId),
      getOwnersBySessionIds: () => owners.map((owner) => ({ sessionId: SESSION_ID, avatarUrl: null, ...owner })),
      hasSpawnConsent: (_sessionId: string, userId: number) => spawnRows.has(userId),
    },
    sessionsDb: { getSessionById: (id: string) => (sessionRow?.session_id === id ? sessionRow : null) },
    sessionWorkspaceModesDb: {
      readLegacyEligibility: () => ({ mode: 'legacy_shared' }),
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

const service = await import('./chat-websocket.service.js');
// eslint-disable-next-line boundaries/dependencies -- the full providers barrel needs exports this DB mock omits.
const bridge = await import('../../providers/list/claude/claude-resume-bridge.js');
bridge.configureClaudeResumeBridge({ isSharedWriter: service.isSharedSessionWriter });
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, service.dispatchProviderCommand as never);

type Frame = Record<string, unknown>;
type Seen = { options?: Frame; refusal?: string; wrote?: boolean };

const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/gu, '-');
const configDirOf = (userId: number) => path.join(BASE, '.nassaj-users', String(userId), '.claude');

/** Emulated CLI turn: the real bridge as claude-sdk.js calls it, then an append where the CLI writes. */
function emulatedClaude(userId: number, seen: Seen) {
  return async (_command: string, options: Frame, runtimeWriter: WebSocketWriter) => {
    seen.options = options;
    try {
      await bridge.ensureClaudeResumeReachable({
        sessionId: SESSION_ID, recordedJsonlPath: sessionRow?.jsonl_path ?? null, runCwd: String(options.cwd),
        configDir: configDirOf(userId), sharedResume: options.sharedResume === true, userId,
      }, { cliVersion: async () => PROVEN_CLI });
    } catch (error) {
      seen.refusal = (error as { code?: string }).code;
      return;
    }
    const dir = path.join(configDirOf(userId), 'projects', encode(String(options.cwd)));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${SESSION_ID}.jsonl`), `${JSON.stringify({ author: userId })}\n`);
    seen.wrote = true;
    runtimeWriter.send({ kind: 'complete', success: true, sessionId: SESSION_ID });
  };
}

async function resume(userId: number): Promise<Seen> {
  const seen: Seen = {};
  const writer = { send: () => undefined } as unknown as WebSocketWriter;
  const dependencies = {
    getSessionProvider: () => (sessionRow ? 'claude' : null),
    getActiveClaudeSDKSessions: () => [],
    queryClaudeSDK: emulatedClaude(userId, seen),
  } as never;
  await dispatchProviderCommand('claude-command', {
    command: 'continue', options: { cwd: projectPath, sessionId: SESSION_ID, resume: true, clientMsgId: `m-${userId}-${Date.now()}` },
  }, writer, dependencies, userId);
  return seen;
}

/** A legacy_shared Claude conversation of user 1 whose recorded file sits in user 1's tree. */
function withLegacyConversation(run: (recorded: string) => Promise<void>, home = configDirOf(CREATOR)) {
  return async () => {
    projectPath = fs.mkdtempSync(path.join(BASE, 'project-'));
    const recorded = path.join(home, 'projects', encode(projectPath), `${SESSION_ID}.jsonl`);
    fs.mkdirSync(path.dirname(recorded), { recursive: true });
    fs.writeFileSync(recorded, '{"author":1}\n');
    fs.mkdirSync(path.join(configDirOf(MEMBER), 'projects'), { recursive: true });
    sessionRow = { session_id: SESSION_ID, project_path: projectPath, provider: 'claude', jsonl_path: recorded };
    owners.splice(0, owners.length, { userId: CREATOR, username: 'creator' });
    spawnRows.clear();
    members.add(MEMBER);
    try {
      await run(recorded);
    } finally {
      sessionRow = null;
      delete process.env.NASSAJ_SHARED_SESSION_WRITING;
      fs.rmSync(path.join(BASE, '.nassaj-users'), { recursive: true, force: true });
      fs.rmSync(path.join(BASE, 'operator'), { recursive: true, force: true });
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
  };
}

test.after(() => fs.rmSync(BASE, { recursive: true, force: true }));

test('CRIT-1: member removed after a shared turn is refused through the stale link (enforcement off)',
  withLegacyConversation(async (recorded) => {
    const first = await resume(MEMBER);
    assert.equal(first.options?.sharedResume, true, 'a member\'s turn is a shared resume');
    assert.equal(first.wrote, true);
    const before = fs.readFileSync(recorded, 'utf8');
    members.delete(MEMBER);
    const after = await resume(MEMBER);
    assert.equal(after.options?.sharedResume, false, 'no longer a shared writer');
    assert.equal(after.refusal, 'shared_writing_forbidden');
    assert.equal(fs.readFileSync(recorded, 'utf8'), before, 'nothing written into the creator\'s file');
  }));

test('CRIT-1: kill switch 0 with a stale link is refused for the member', withLegacyConversation(async (recorded) => {
  await resume(MEMBER);
  const before = fs.readFileSync(recorded, 'utf8');
  process.env.NASSAJ_SHARED_SESSION_WRITING = '0';
  const after = await resume(MEMBER);
  assert.equal(after.refusal, 'shared_writing_forbidden');
  assert.equal(fs.readFileSync(recorded, 'utf8'), before);
}));

test('the creator keeps resuming his own legacy conversation', withLegacyConversation(async (recorded) => {
  const seen = await resume(CREATOR);
  assert.equal(seen.options?.sharedResume, false);
  assert.equal(seen.refusal, undefined);
  assert.match(fs.readFileSync(recorded, 'utf8'), /"author":1\}\n\{"author":1\}/u);
}));

const { claudeParticipantContext } = await import(
  // eslint-disable-next-line boundaries/dependencies -- the run path's own recordSpawn context.
  '../../providers/list/claude/claude-participant-context.js'
);
/** Whether the run would record the sender as a shared_write participant (never owner). */
const recordedAsParticipant = (seen: Seen) => claudeParticipantContext(seen.options ?? {}, '/').sharedWriter;

test('R3: row-less session, recorded in user 1\'s tree: member 2 is a shared writer, never owner',
  withLegacyConversation(async (recorded) => {
    owners.length = 0;
    const seen = await resume(MEMBER);
    assert.equal(seen.options?.sharedResume, true, 'creator inferred from the recorded tree');
    assert.equal(recordedAsParticipant(seen), true);
    assert.equal(seen.wrote, true);
    assert.match(fs.readFileSync(recorded, 'utf8'), /"author":2/u, 'the turn reached the one recorded file');
  }));

test('R3: row-less session, the creator resumes his own (inferred from his own tree): owner path',
  withLegacyConversation(async () => {
    owners.length = 0;
    const seen = await resume(CREATOR);
    assert.equal(seen.options?.sharedResume, false);
    assert.equal(recordedAsParticipant(seen), false, 'today\'s spawn row: the real creator becomes owner');
  }));

test('R3: row-less session, the sender already holds a spawn row (owner row gone): owner path',
  withLegacyConversation(async () => {
    owners.length = 0;
    spawnRows.add(MEMBER);
    const seen = await resume(MEMBER);
    assert.equal(seen.options?.sharedResume, false);
    assert.equal(recordedAsParticipant(seen), false);
  }));

test('R3: row-less session in a shared (operator) tree: creator not inferable, sender is a participant',
  withLegacyConversation(async () => {
    owners.length = 0;
    const seen = await resume(MEMBER);
    assert.equal(seen.options?.sharedResume, false, 'no shared writing without a determinable creator');
    assert.equal(recordedAsParticipant(seen), true, 'never owner');
    const creatorSeen = await resume(CREATOR);
    assert.equal(recordedAsParticipant(creatorSeen), true, 'not inferable for anyone');
  }, path.join(BASE, 'operator', '.claude')));

test('qa r2 #2: a non-writer sender in another member\'s conversation is a participant, never owner',
  withLegacyConversation(async () => {
    // Removed member (enforcement off: author arm) on an owner-row conversation. Recorded as
    // 'spawn' he could demote a provenance owner and take ownership (B-477 demote path).
    members.delete(MEMBER);
    const seen = await resume(MEMBER);
    assert.equal(seen.options?.sharedResume, false, 'no shared resume for a non-writer');
    assert.equal(recordedAsParticipant(seen), true, 'shared_write participant: no ownership, no consent');
  }));

test('qa r2 #2: kill switch 0 does not let a non-creator take a spawn row either', withLegacyConversation(async () => {
  process.env.NASSAJ_SHARED_SESSION_WRITING = '0';
  const seen = await resume(MEMBER);
  assert.equal(seen.options?.sharedResume, false);
  assert.equal(recordedAsParticipant(seen), true);
}));
