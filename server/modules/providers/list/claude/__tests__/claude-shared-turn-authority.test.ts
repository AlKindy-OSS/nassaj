/**
 * ADR-173 rev.3 P5: the pure rules for a non-starter of a Claude turn — the bounded
 * approval answer (allow/deny only, capped and attributed deny text), external-identity
 * tools, and stop rights (starter / project owner / platform admin always, a shared
 * writer only when the turn is stuck). The authority predicates are injected.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  NON_STARTER_DENY_TEXT_MAX,
  boundNonStarterDecision,
  configureClaudeSharedTurnAuthority,
  decideTurnStop,
  hashDecisionText,
  isExternalIdentityTool,
  isSharedTurnWriter,
} from '../claude-shared-turn-authority.js';

afterEach(() => configureClaudeSharedTurnAuthority({ isSharedWriter: () => false, isStopPrivileged: () => false }));

test('unconfigured or throwing authority admits no shared writer (fail closed)', () => {
  assert.equal(isSharedTurnWriter('s1', 2), false);
  configureClaudeSharedTurnAuthority({ isSharedWriter: () => { throw new Error('db down'); } });
  assert.equal(isSharedTurnWriter('s1', 2), false);
  configureClaudeSharedTurnAuthority({ isSharedWriter: (sid, uid) => sid === 's1' && uid === 2 });
  assert.equal(isSharedTurnWriter('s1', 2), true);
  assert.equal(isSharedTurnWriter('', 2), false);
});

test('a non-starter answer keeps allow/deny only and never edited input or a remember rule', () => {
  const allowed = boundNonStarterDecision({ allow: true, updatedInput: { command: 'rm -rf /' },
    rememberEntry: 'Bash', message: 'ok' }, 'sara');
  assert.deepEqual(allowed, { allow: true });
  const denied = boundNonStarterDecision({ allow: false, rememberEntry: 'Bash' }, 'sara');
  assert.deepEqual(denied, { allow: false, message: 'sara denied this tool use.' });
});

test('a non-starter deny text is capped and prefixed with the author name', () => {
  const long = 'x'.repeat(NON_STARTER_DENY_TEXT_MAX + 200);
  const denied = boundNonStarterDecision({ allow: false, message: `  ${long}  ` }, 'sara');
  assert.equal(denied.message, `sara: ${'x'.repeat(NON_STARTER_DENY_TEXT_MAX)}`);
  assert.equal(NON_STARTER_DENY_TEXT_MAX, 500);
});

test('the audited text hash is a sha256 of the delivered text, null without text', () => {
  assert.match(hashDecisionText('sara: no') ?? '', /^[0-9a-f]{64}$/u);
  assert.equal(hashDecisionText(undefined), null);
});

test('MCP and connector tools act on the starter\'s external identity', () => {
  assert.equal(isExternalIdentityTool('mcp__github__create_issue'), true);
  assert.equal(isExternalIdentityTool('mcp__nassaj-connector-notion__search'), true);
  assert.equal(isExternalIdentityTool('Bash'), false);
  assert.equal(isExternalIdentityTool(undefined), false);
});

test('stop: the starter always; project owner / admin always; a shared writer only when stuck', () => {
  configureClaudeSharedTurnAuthority({
    isSharedWriter: (_sid, uid) => uid === 2 || uid === 3,
    isStopPrivileged: (_sid, uid) => uid === 3,
  });
  const stop = (requesterUserId: number | null, stuck: boolean) =>
    decideTurnStop({ sessionId: 's1', requesterUserId, starterUserId: 1, stuck });
  assert.deepEqual(stop(1, false), { allowed: true, role: 'starter' });
  assert.deepEqual(stop(3, false), { allowed: true, role: 'privileged' });
  assert.deepEqual(stop(2, false), { allowed: false, role: null });
  assert.deepEqual(stop(2, true), { allowed: true, role: 'stuck_writer' });
  assert.deepEqual(stop(4, true), { allowed: false, role: null }, 'a non-writer never, even stuck');
  assert.deepEqual(stop(null, true), { allowed: false, role: null });
});

test('user_turn: the shared writer\'s prompt as a live frame for the other viewers', async () => {
  const { sharedUserTurnFrame } = await import('../claude-shared-turn-authority.js');
  const frame = sharedUserTurnFrame({ sessionId: 's1', content: 'please refactor', authorUserId: 2,
    clientMsgId: 'cmid-2', imageCount: 1 }) as Record<string, unknown>;
  assert.deepEqual({
    kind: frame.kind, provider: frame.provider, sessionId: frame.sessionId, role: frame.role,
    content: frame.content, authorUserId: frame.authorUserId, clientMsgId: frame.clientMsgId,
    imageCount: frame.imageCount,
  }, {
    kind: 'user_turn', provider: 'claude', sessionId: 's1', role: 'user', content: 'please refactor',
    authorUserId: 2, clientMsgId: 'cmid-2', imageCount: 1,
  });
  assert.equal(typeof frame.authorName, 'string');
  assert.equal(typeof frame.id, 'string');
  const bare = sharedUserTurnFrame({ sessionId: 's1', content: 'x', authorUserId: 2, clientMsgId: 7, imageCount: 0 });
  assert.equal('clientMsgId' in bare, false);
  assert.equal('imageCount' in bare, false);
});

test('P8 B1: user_turn carries the transcript uuid of the prompt, so a live bubble is replaced by its row', async () => {
  const { sharedUserTurnFrame } = await import('../claude-shared-turn-authority.js');
  const messageUuid = '21111111-2222-4333-8444-555555555555';
  const frame = sharedUserTurnFrame({ sessionId: 's1', content: 'x', authorUserId: 1, clientMsgId: 'c1',
    imageCount: 0, messageUuid }) as Record<string, unknown>;
  assert.equal(frame.messageUuid, messageUuid);
  const unknown = sharedUserTurnFrame({ sessionId: 's1', content: 'x', authorUserId: 1, clientMsgId: 'c1', imageCount: 0 });
  assert.equal('messageUuid' in unknown, false, 'no invented id when the prompt carried none');
});

test('P8 B3: every turn is announced once the conversation has another viewer; a relayed turn never', async () => {
  const { shouldAnnounceUserTurn } = await import('../claude-shared-turn-authority.js');
  const base = { sharingEnabled: true, peerDelivery: false, bridgedSharedResume: false, otherViewers: false };
  assert.equal(shouldAnnounceUserTurn(base), false, 'alone in the conversation: nothing to announce');
  assert.equal(shouldAnnounceUserTurn({ ...base, otherViewers: true }), true, 'the creator\'s own turn too');
  assert.equal(shouldAnnounceUserTurn({ ...base, bridgedSharedResume: true }), true, 'a shared writer\'s turn, as before');
  assert.equal(shouldAnnounceUserTurn({ ...base, otherViewers: true, peerDelivery: true }), false);
  assert.equal(shouldAnnounceUserTurn({ ...base, otherViewers: true, sharingEnabled: false }), false, 'flag 0: today\'s behaviour');
});
