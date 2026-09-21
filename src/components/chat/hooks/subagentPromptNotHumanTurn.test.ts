/**
 * Live sub-agent prompt must not become a human turn (2026-09-11 incident).
 *
 * Fixtures are the real rows of session 0f0cd623 (main transcript rows 121/156/157
 * and sidechain agent-a435ba46cd770b45c / agent-a290ab4443eab33c5), in the live
 * shape the server forwards: the SDK streams the delegated prompt as a user
 * message with `parent_tool_use_id`, claude-sdk.js copies it to `parentToolUseId`,
 * stamps the socket `userId` (no `origin` on the wire) and the run `clientMsgId`.
 *
 * Pre-fix: both prompts rendered as user bubbles, the last one became the turn
 * boundary (agents=[]) and the `runStartedAt` anchor (timer restart).
 *
 * Run: npx tsx --tsconfig tsconfig.json --test \
 *        src/components/chat/hooks/subagentPromptNotHumanTurn.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';

import { normalizedToChatMessages } from './useChatMessages.js';
import { useRunProgress } from './useRunProgress.js';
import type { NormalizedMessage } from '../../../stores/useSessionStore.js';

function runHook<T>(fn: () => T): T {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const dispatcher = internals.ReactCurrentDispatcher;
  const prev = dispatcher.current;
  dispatcher.current = { useMemo: (factory: () => unknown) => factory() };
  try {
    return fn();
  } finally {
    dispatcher.current = prev;
  }
}

const FIXTURE_SESSION_ID = '0f0cd623-d77c-4333-9d69-d1924614aef6';
const CMID = 'cmid_owner_send';
const AGENT_A = 'toolu_01SXnF7Ja7V7qgAEM33mDVkg';
const AGENT_B = 'toolu_01RNLDbw3nGuURPdtFPXiLt7';

const base = { sessionId: FIXTURE_SESSION_ID, provider: 'claude' as const, clientMsgId: CMID };

const ownerPrompt: NormalizedMessage = {
  ...base, id: 'f49b44be-09c9-4c17-95e0-770af3b6a799', kind: 'text', role: 'user',
  content: 'سوي تجربة أبغا اشوف ', timestamp: '2026-09-11T09:41:47.920Z', userId: 1,
} as NormalizedMessage;

const agentContainer = (id: string, toolId: string, ts: string, description: string) => ({
  ...base, id, kind: 'tool_use', toolId, toolName: 'Agent', timestamp: ts,
  toolInput: { subagent_type: 'general-purpose', model: 'haiku', description },
}) as NormalizedMessage;

// Live sub-agent prompt as forwarded: role user, userId stamped, parentToolUseId set.
const subagentPrompt = (id: string, parent: string, ts: string, text: string) => ({
  ...base, id, kind: 'text', role: 'user', content: text, timestamp: ts,
  userId: 1, parentToolUseId: parent,
}) as NormalizedMessage;

const rows: NormalizedMessage[] = [
  ownerPrompt,
  agentContainer('ab48e75c-30d7-4b8c-ac0d-f21971a7f2f5', AGENT_A, '2026-09-11T09:44:00.008Z',
    'Status-bar test agent A (long)'),
  subagentPrompt('cc71842b-ca2b-4927-a6bd-b470f2bd6de1', AGENT_A, '2026-09-11T09:44:00.130Z',
    'UI visibility test — read-only, edit nothing. The goal is simply to stay running'),
  { ...base, id: '1540903d-1bea-4502-b840-391c3a306dd1_thinking', kind: 'thinking',
    content: 'planning the bash calls', timestamp: '2026-09-11T09:44:03.429Z',
    parentToolUseId: AGENT_A } as NormalizedMessage,
  agentContainer('e8962010-b0ae-4a2f-b68f-9ef0ee5602d3', AGENT_B, '2026-09-11T09:44:03.988Z',
    'Status-bar test agent B (skill, long)'),
  { ...base, id: '8a388905-7478-453d-9cca-5f573f2c367c_0', kind: 'tool_use',
    toolId: 'toolu_016b1PNWW9ckbGWAF2YvLFNg', toolName: 'Bash',
    toolInput: { command: 'git log --oneline -3' }, timestamp: '2026-09-11T09:44:04.056Z',
    parentToolUseId: AGENT_A } as NormalizedMessage,
  subagentPrompt('ee5fe9b0-295f-4e4c-a15e-b0c9a80642e6', AGENT_B, '2026-09-11T09:44:04.065Z',
    'UI visibility test — read-only, edit nothing. The goal is to stay running ~2.5 m'),
  { ...base, id: '28449cf0-12be-42f5-a080-48d63de303be_tr_toolu_016b1PNWW9ckbGWAF2YvLFNg',
    kind: 'tool_result', toolId: 'toolu_016b1PNWW9ckbGWAF2YvLFNg',
    content: '24ab6a7d chore: ignore the operator-owned config/ directory',
    timestamp: '2026-09-11T09:44:04.115Z', parentToolUseId: AGENT_A } as NormalizedMessage,
  { ...base, id: 'subagent_reply_text', kind: 'text', role: 'assistant', content: 'done',
    timestamp: '2026-09-11T09:46:30.000Z', parentToolUseId: AGENT_A } as NormalizedMessage,
];

describe('live sub-agent rows (parentToolUseId) are not human turns', () => {
  const chat = normalizedToChatMessages(rows);

  it('renders only the owner prompt as a user bubble', () => {
    const users = chat.filter(m => m.type === 'user');
    assert.deepEqual(users.map(m => m.id), [ownerPrompt.id]);
  });

  it('renders no sub-agent prose (prompt, thinking, reply) at top level', () => {
    const leaked = chat.filter(m => /UI visibility test|planning the bash|^done$/.test(
      String(m.content || '')));
    assert.deepEqual(leaked, []);
  });

  it('keeps the owner prompt as the runStartedAt anchor (last type:user row)', () => {
    const lastUser = [...chat].reverse().find(m => m.type === 'user');
    assert.equal(lastUser?.timestamp, ownerPrompt.timestamp);
  });

  it('keeps both Agent containers in the current turn and folds the child tool', () => {
    const progress = runHook(() => useRunProgress(chat, true));
    assert.deepEqual(progress.agents.map(a => a.id).sort(), [AGENT_A, AGENT_B].sort());
    const containerA = chat.find(m => m.toolId === AGENT_A);
    assert.deepEqual(containerA?.subagentState?.childTools.map(c => c.toolName), ['Bash']);
    assert.equal(chat.some(m => m.toolName === 'Bash'), false);
  });

  it('still renders top-level (non sub-agent) user and assistant text', () => {
    const plain = normalizedToChatMessages([
      ownerPrompt,
      { ...base, id: 'reply', kind: 'text', role: 'assistant', content: 'تم',
        timestamp: '2026-09-11T09:47:00.000Z' } as NormalizedMessage,
    ]);
    assert.deepEqual(plain.map(m => m.type), ['user', 'assistant']);
  });
});
