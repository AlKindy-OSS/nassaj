/**
 * Origin-aware sender attribution (coordinator → subagent prompts).
 *
 * Bug: the live run path stamped `userId` on EVERY kind:'text' role:'user'
 * message streamed by the SDK — including coordinator prompts routed to
 * subagents via the Task tool (SDKMessageOrigin.kind === 'coordinator') — so
 * agent directives rendered as human-authored chat bubbles.
 *
 * Contract under test:
 * 1. The Claude adapter stamps `originKind` on user-role text whose SDK
 *    origin is non-human; absent or 'human' origin yields no `originKind`
 *    (legacy messages keep being treated as human — no regression).
 * 2. stampHumanUserId only stamps `userId` on human-origin user text.
 * 3. History attribution never matches a machine-routed prompt to a recorded
 *    human author row, even on a coincidental content-hash collision, and
 *    never adopts it as the running coordinator.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashMessageAuthorContent } from '@/modules/database/index.js';
import type { MessageAuthorRow } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { applyMessageAuthorAttribution } from '@/modules/providers/services/sessions.service.js';
import { stampHumanUserId } from '@/shared/utils.js';
import type { NormalizedMessage } from '@/shared/types.js';

const provider = new ClaudeSessionsProvider();

function sdkUserEvent(text: string, origin?: { kind: string }): Record<string, unknown> {
  return {
    type: 'user',
    uuid: 'evt-1',
    session_id: 'sess-1',
    timestamp: '2026-06-12T10:00:00.000Z',
    ...(origin ? { origin } : {}),
    message: {
      role: 'user',
      content: text,
    },
  };
}

function sdkUserArrayEvent(text: string, origin?: { kind: string }): Record<string, unknown> {
  return {
    type: 'user',
    uuid: 'evt-2',
    session_id: 'sess-1',
    timestamp: '2026-06-12T10:00:00.000Z',
    ...(origin ? { origin } : {}),
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
}

// ---------------- adapter: originKind stamping ----------------

test('coordinator-origin user text carries originKind and no userId', () => {
  const messages = provider.normalizeMessage(
    sdkUserEvent('انتقل إلى مجلد المشروع ونفّذ المهمة', { kind: 'coordinator' }),
    'sess-1',
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].originKind, 'coordinator');
  assert.equal(messages[0].userId, undefined);
});

test('coordinator origin is stamped on array-content user text too', () => {
  const messages = provider.normalizeMessage(
    sdkUserArrayEvent('subagent directive', { kind: 'coordinator' }),
    'sess-1',
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].originKind, 'coordinator');
});

test('peer origin (any non-human kind) is stamped as non-human', () => {
  const messages = provider.normalizeMessage(
    sdkUserEvent('message from a peer session', { kind: 'peer' }),
    'sess-1',
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].originKind, 'peer');
});

test('explicit human origin yields no originKind', () => {
  const messages = provider.normalizeMessage(
    sdkUserEvent('typed by a human', { kind: 'human' }),
    'sess-1',
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].originKind, undefined);
});

test('absent origin (legacy messages) yields no originKind — treated as human', () => {
  const messages = provider.normalizeMessage(sdkUserEvent('legacy prompt'), 'sess-1');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].originKind, undefined);
});

// ---------------- live stamping guard: stampHumanUserId ----------------

function normalizedUserText(extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'm1',
    sessionId: 'sess-1',
    timestamp: '2026-06-12T10:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: 'hello',
    ...extra,
  };
}

test('stampHumanUserId stamps human-origin user text (no originKind)', () => {
  const msg = normalizedUserText();
  stampHumanUserId(msg, 7);
  assert.equal(msg.userId, 7);
});

test('stampHumanUserId never stamps coordinator-routed user text', () => {
  const msg = normalizedUserText({ originKind: 'coordinator' });
  stampHumanUserId(msg, 7);
  assert.equal(msg.userId, undefined);
});

test('stampHumanUserId never stamps any non-human originKind (peer)', () => {
  const msg = normalizedUserText({ originKind: 'peer' });
  stampHumanUserId(msg, 7);
  assert.equal(msg.userId, undefined);
});

test('stampHumanUserId ignores non-user / non-text messages and bad userIds', () => {
  const assistant = normalizedUserText({ role: 'assistant' });
  stampHumanUserId(assistant, 7);
  assert.equal(assistant.userId, undefined);

  const tool = normalizedUserText({ kind: 'tool_use', role: undefined });
  stampHumanUserId(tool, 7);
  assert.equal(tool.userId, undefined);

  const anonymous = normalizedUserText();
  stampHumanUserId(anonymous, undefined);
  assert.equal(anonymous.userId, undefined);
});

// ---------------- history attribution guard ----------------

test('history attribution skips machine-routed prompts even on a hash match', () => {
  const sharedText = 'identical text';
  const coordinatorPrompt = normalizedUserText({
    id: 'coord',
    content: sharedText,
    originKind: 'coordinator',
  });
  const assistantReply: NormalizedMessage = {
    id: 'a1',
    sessionId: 'sess-1',
    timestamp: '2026-06-12T10:00:05.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: 'reply',
  };
  const rows: MessageAuthorRow[] = [
    {
      userId: 9,
      contentHash: hashMessageAuthorContent(sharedText),
      createdAt: '2026-06-12T10:00:00.000Z',
    },
  ];

  applyMessageAuthorAttribution([coordinatorPrompt, assistantReply], rows);

  // Not attributed to the human despite the content-hash collision,
  // and not adopted as the coordinator of the following assistant output.
  assert.equal(coordinatorPrompt.userId, undefined);
  assert.equal(assistantReply.coordinatorId, undefined);
});
