/**
 * ADR-173 rev.3 P6 (server half): shared writing is Claude-only in v1. A member who
 * resumes a conversation another member created on Codex, antigravity (agy),
 * OpenCode or dsh, or a supervised Claude turn, is refused before anything starts
 * with one frame: code shared_writing_unsupported {notStarted, provider, creatorName,
 * canFork}. dsh also carries its former code as legacyCode. No determinable creator
 * keeps today's behaviour (no refusal from this rule).
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import type { LLMProvider } from '@/shared/types.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';
import { chatImageStoreDatabaseLinkStubs } from '../../../../tests/helpers/chat-image-store-link-stubs.js';

import { dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

const CREATOR = 1;
const MEMBER = 2;
const SID = 'shared-unsupported-session-1';
let owners: Array<{ sessionId: string; userId: number; username: string }> = [];

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    ...chatImageStoreDatabaseLinkStubs(),
    participantsDb: {
      getOwnersBySessionIds: (ids: string[]) => owners.filter((row) => ids.includes(row.sessionId)),
    },
    projectsDb: { getProjectPath: () => null, isProjectVisibleToUser: () => true },
    sessionsDb: { getSessionById: () => null },
    sessionOutcomesDb: { getOutcomeForBroadcast: () => null },
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});

const service = await import('./chat-websocket.service.js');

type Frame = Record<string, unknown>;

async function send(messageType: string, provider: string, principalId: number, extra: Frame = {}) {
  const sent: Frame[] = [];
  const writer = { send: (frame: Frame) => sent.push(frame) } as unknown as WebSocketWriter;
  const started: string[] = [];
  const runtime = async () => { started.push(provider); };
  const dependencies = {
    getSessionProvider: () => provider,
    queryClaudeSDK: runtime, spawnCodex: runtime, spawnAntigravity: runtime, spawnOpenCode: runtime,
    spawnDsh: runtime,
    ...extra,
  };
  await dispatchAuthorizedProviderCommand(service.dispatchProviderCommand as never, messageType,
    { command: 'continue', options: { sessionId: SID, resume: true, clientMsgId: `c-${provider}` } },
    writer, dependencies, principalId);
  return { refusal: sent.find((frame) => frame.code === 'shared_writing_unsupported'), started };
}

const CASES = [
  ['codex-command', 'codex', true],
  ['antigravity-command', 'antigravity', false],
  ['opencode-command', 'opencode', false],
  ['dsh-command', 'dsh', false],
] as const;

for (const [messageType, provider, canFork] of CASES) {
  test(`${provider}: a member resuming another member's conversation is refused before start`, async () => {
    owners = [{ sessionId: SID, userId: CREATOR, username: 'creator-name' }];
    const { refusal, started } = await send(messageType, provider, MEMBER);
    assert.ok(refusal, `refused for ${provider}`);
    assert.deepEqual({
      kind: refusal.kind, success: refusal.success, notStarted: refusal.notStarted, provider: refusal.provider,
      creatorName: refusal.creatorName, canFork: refusal.canFork, clientMsgId: refusal.clientMsgId,
    }, {
      kind: 'complete', success: false, notStarted: true, provider, creatorName: 'creator-name', canFork,
      clientMsgId: `c-${provider}`,
    });
    assert.equal(refusal.legacyCode, provider === 'dsh' ? 'dsh_shared_session_unsupported' : undefined);
    assert.deepEqual(started, [], 'no runtime was reached');
  });
}

test('the pure rule: creator, no creator, and unaffected providers are never refused', () => {
  owners = [{ sessionId: SID, userId: CREATOR, username: 'creator-name' }];
  const refuse = (provider: LLMProvider, userId: number | null, supervisedClaude = false) =>
    service.sharedWritingUnsupportedRefusal({ provider, resumeSessionId: SID, userId, supervisedClaude });
  assert.equal(refuse('codex', CREATOR), null, 'the creator resumes his own conversation');
  assert.equal(refuse('claude', MEMBER), null, 'plain Claude is the supported shared path');
  assert.equal(refuse('kimi', MEMBER), null, 'shared-store HTTP models are not refused by this rule');
  assert.equal(refuse('codex', null), null);
  assert.equal(service.sharedWritingUnsupportedRefusal({ provider: 'codex', resumeSessionId: null,
    userId: MEMBER, supervisedClaude: false }), null, 'a new conversation');
  owners = [];
  assert.equal(refuse('codex', MEMBER), null, 'no determinable creator: today\'s behaviour');
});

test('supervised Claude: a shared writer\'s turn is refused, the creator\'s is not', async () => {
  owners = [{ sessionId: SID, userId: CREATOR, username: 'creator-name' }];
  const supervisor = { hostedTurnSupervisor: { enabled: () => true, supports: () => true } };
  const { refusal } = await send('claude-command', 'claude', MEMBER, supervisor);
  assert.equal(refusal?.provider, 'claude');
  assert.equal(refusal?.canFork, true);
  assert.equal(service.sharedWritingUnsupportedRefusal({ provider: 'claude', resumeSessionId: SID,
    userId: CREATOR, supervisedClaude: true }), null);
});
