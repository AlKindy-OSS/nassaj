import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashMessageAuthorContent } from '@/modules/database/index.js';
import type { MessageAuthorRow } from '@/modules/database/index.js';
import { applyMessageAuthorAttribution } from '@/modules/providers/services/sessions.service.js';
import { stampCoordinatorId } from '@/shared/utils.js';
import type { NormalizedMessage } from '@/shared/types.js';

function userMsg(content: string, timestamp: string): NormalizedMessage {
  return {
    id: `u_${content}_${timestamp}`,
    sessionId: 's',
    timestamp,
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content,
  };
}

function assistantMsg(content: string, timestamp: string): NormalizedMessage {
  return {
    id: `a_${content}_${timestamp}`,
    sessionId: 's',
    timestamp,
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content,
  };
}

function toolUseMsg(timestamp: string): NormalizedMessage {
  return {
    id: `t_${timestamp}`,
    sessionId: 's',
    timestamp,
    provider: 'claude',
    kind: 'tool_use',
    toolName: 'Read',
  };
}

function row(userId: number, content: string, createdAt: string): MessageAuthorRow {
  return { userId, contentHash: hashMessageAuthorContent(content), createdAt };
}

// ---------------- applyMessageAuthorAttribution (history) ----------------

test('assistant output inherits the coordinator of the preceding attributed user prompt', () => {
  const messages = [
    userMsg('hello from jazari', '2026-06-12T10:00:00.000Z'),
    assistantMsg('reply A', '2026-06-12T10:00:05.000Z'),
    toolUseMsg('2026-06-12T10:00:06.000Z'),
    userMsg('follow up from nawras', '2026-06-12T10:01:00.000Z'),
    assistantMsg('reply B', '2026-06-12T10:01:05.000Z'),
  ];
  const rows = [
    row(1, 'hello from jazari', '2026-06-12T10:00:00.000Z'),
    row(2, 'follow up from nawras', '2026-06-12T10:01:00.000Z'),
  ];

  applyMessageAuthorAttribution(messages, rows);

  // user messages carry userId, not coordinatorId
  assert.equal(messages[0].userId, 1);
  assert.equal(messages[0].coordinatorId, undefined);
  assert.equal(messages[3].userId, 2);
  assert.equal(messages[3].coordinatorId, undefined);

  // assistant + tool output inherit the spawner of the run they belong to
  assert.equal(messages[1].coordinatorId, 1);
  assert.equal(messages[2].coordinatorId, 1);
  assert.equal(messages[4].coordinatorId, 2);
});

test('assistant output before any attributed prompt stays unattributed (owner fallback)', () => {
  const messages = [
    assistantMsg('orphan reply', '2026-06-12T09:00:00.000Z'),
    userMsg('known prompt', '2026-06-12T10:00:00.000Z'),
    assistantMsg('attributed reply', '2026-06-12T10:00:05.000Z'),
  ];
  const rows = [row(7, 'known prompt', '2026-06-12T10:00:00.000Z')];

  applyMessageAuthorAttribution(messages, rows);

  assert.equal(messages[0].coordinatorId, undefined);
  assert.equal(messages[1].userId, 7);
  assert.equal(messages[2].coordinatorId, 7);
});

test('unattributed prompt does not reassign the running coordinator', () => {
  const messages = [
    userMsg('attributed prompt', '2026-06-12T10:00:00.000Z'),
    assistantMsg('reply A', '2026-06-12T10:00:05.000Z'),
    // prompt with no recorded row (e.g. provider-rewritten) keeps no userId
    userMsg('unrecorded prompt', '2026-06-12T10:01:00.000Z'),
    assistantMsg('reply B', '2026-06-12T10:01:05.000Z'),
  ];
  const rows = [row(3, 'attributed prompt', '2026-06-12T10:00:00.000Z')];

  applyMessageAuthorAttribution(messages, rows);

  assert.equal(messages[0].userId, 3);
  assert.equal(messages[1].coordinatorId, 3);
  assert.equal(messages[2].userId, undefined);
  // reply B carries forward the last KNOWN coordinator rather than going null
  assert.equal(messages[3].coordinatorId, 3);
});

test('identical prompts from two users map to distinct coordinators by timestamp proximity', () => {
  const messages = [
    userMsg('ping', '2026-06-12T10:00:00.000Z'),
    assistantMsg('pong A', '2026-06-12T10:00:02.000Z'),
    userMsg('ping', '2026-06-12T10:05:00.000Z'),
    assistantMsg('pong B', '2026-06-12T10:05:02.000Z'),
  ];
  const rows = [
    row(1, 'ping', '2026-06-12T10:00:00.000Z'),
    row(2, 'ping', '2026-06-12T10:05:00.000Z'),
  ];

  applyMessageAuthorAttribution(messages, rows);

  assert.equal(messages[0].userId, 1);
  assert.equal(messages[1].coordinatorId, 1);
  assert.equal(messages[2].userId, 2);
  assert.equal(messages[3].coordinatorId, 2);
});

test('pre-existing coordinatorId on an assistant message is never overwritten', () => {
  const live = assistantMsg('live reply', '2026-06-12T10:00:05.000Z');
  live.coordinatorId = 99;
  const messages = [userMsg('known prompt', '2026-06-12T10:00:00.000Z'), live];
  const rows = [row(5, 'known prompt', '2026-06-12T10:00:00.000Z')];

  applyMessageAuthorAttribution(messages, rows);

  assert.equal(messages[1].coordinatorId, 99);
});

// ---------------- stampCoordinatorId (live) ----------------

test('stampCoordinatorId tags assistant-role messages with the integer userId', () => {
  const msg = assistantMsg('hi', '2026-06-12T10:00:00.000Z');
  stampCoordinatorId(msg, 4);
  assert.equal(msg.coordinatorId, 4);
});

test('stampCoordinatorId tags role-less assistant artifacts (tool_use/stream_delta)', () => {
  const tool = toolUseMsg('2026-06-12T10:00:00.000Z');
  stampCoordinatorId(tool, 4);
  assert.equal(tool.coordinatorId, 4);
});

test('stampCoordinatorId never tags user-role messages', () => {
  const msg = userMsg('typed by me', '2026-06-12T10:00:00.000Z');
  stampCoordinatorId(msg, 4);
  assert.equal(msg.coordinatorId, undefined);
});

test('stampCoordinatorId is a no-op for non-integer userId (anonymous/single-user)', () => {
  const a = assistantMsg('hi', '2026-06-12T10:00:00.000Z');
  stampCoordinatorId(a, null);
  assert.equal(a.coordinatorId, undefined);
  stampCoordinatorId(a, '4');
  assert.equal(a.coordinatorId, undefined);
  stampCoordinatorId(a, undefined);
  assert.equal(a.coordinatorId, undefined);
});
