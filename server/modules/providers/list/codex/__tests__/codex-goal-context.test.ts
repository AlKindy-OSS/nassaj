import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, it, mock } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'codex-goal-context-'));
const transcript = path.join(sandbox, 'synthetic.jsonl');
mock.module('@/modules/database/index.js', { namedExports: {
  sessionsDb: { getSessionById: () => ({ jsonl_path: transcript }) },
  appConfigDb: { getOrCreateJwtSecret: () => 'synthetic-history-cursor-key' },
} });
const { CodexSessionsProvider } = await import('../codex-sessions.provider.js');
const { projectCodexHistoryIdentities } = await import('../codex-receipt-identity.js');
const { codexReceiptPayloadHash } = await import('../codex-receipt-proof.js');
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const goal = '<codex_internal_context source="goal">\nContinue working toward the active thread goal.\n</codex_internal_context>';
const sessionId = 'synthetic-goal-session';
const provider = new CodexSessionsProvider();
const text = (value: string) => ({ type: 'input_text', text: value });
const native = (id: string, content: unknown[], kinds?: unknown) => ({
  type: 'response_item', payload: {
    type: 'message', role: 'user', id, content,
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-fixture', content_item_kinds: kinds },
  },
});
async function history(rows: unknown[], limit?: number) {
  fs.writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return provider.fetchHistory(sessionId, { limit });
}

it('hides provider-attested goal-only messages anywhere in history before pagination', async () => {
  const result = await history([
    native('goal-first', [text(goal)], ['goal.internal_context']),
    native('human', [text('request')]),
    native('goal-later', [text('provider may change wording')], ['goal.internal_context']),
    native('goal-many', [text(goal), text(goal)], ['goal.internal_context', 'goal.internal_context']),
  ], 1);
  assert.deepEqual(result.messages.map(row => row.content), ['request']);
  assert.equal(result.total, 1);
  assert.equal(result.hasMore, false);
});

it('preserves literal, quoted, fenced and mixed user prompts without internal provenance', async () => {
  const prompts = [goal, `> ${goal}`, `\`\`\`xml\n${goal}\n\`\`\``, `${goal}\nايش الموضوع`, `ايش الموضوع\n${goal}`];
  const result = await history(prompts.map((prompt, index) => native(`human-${index}`, [text(prompt)])));
  assert.deepEqual(result.messages.map(row => row.content), prompts);
});

it('preserves mixed human/internal blocks, images and malformed or unfamiliar metadata', async () => {
  const cases = [
    native('mixed', [text(goal), text('ايش الموضوع')], ['goal.internal_context', 'user']),
    native('missing-kind', [text(goal), text('question')], ['goal.internal_context']),
    native('extra-kind', [text(goal)], ['goal.internal_context', 'goal.internal_context']),
    native('wrong-kind', [text(goal)], ['user']),
    native('wrong-type', [text(goal)], 'goal.internal_context'),
    native('null-kind', [text(goal)], null),
    native('image', [text(goal), { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }],
      ['goal.internal_context', 'goal.internal_context']),
  ];
  const result = await history(cases);
  assert.equal(result.messages.length, cases.length);
  assert.equal(result.messages[0].content, `${goal}\nايش الموضوع`);
  assert.deepEqual(result.messages.at(-1)?.images, ['data:image/png;base64,aGVsbG8=']);
});

it('retains unmarked legacy user echoes and suppresses already typed internal events', async () => {
  const result = await history([
    { type: 'event_msg', payload: { type: 'user_message', kind: 'internal', message: goal } },
    { type: 'event_msg', payload: { type: 'user_message', kind: 'plain', message: goal } },
  ]);
  assert.deepEqual(result.messages.map(row => row.content), [goal]);
});

it('does not expose an internal record or let its receipt bind to a literal human wrapper', async () => {
  const result = await history([
    native('goal-native', [text(goal)], ['goal.internal_context']),
    native('human-native', [text(goal)]),
  ]);
  const projected = projectCodexHistoryIdentities(result, sessionId, 1, undefined, () => [{
    clientMsgId: 'client-goal', verdictJson: JSON.stringify({
      kind: 'complete', provider: 'codex', sessionId, clientMsgId: 'client-goal',
      codexUserProof: { version: 'codex_user_v1', userMessageId: 'goal-native', turnId: 'turn-fixture',
        payloadSha256: codexReceiptPayloadHash(goal, []) },
    }),
  }]);
  assert.equal(projected.messages.length, 1);
  assert.equal(projected.messages[0].content, goal);
  assert.equal(projected.messages[0].clientMsgId, undefined);
});

it('live normalization has no native user bubble and retains assistant quotations', () => {
  assert.deepEqual(provider.normalizeMessage(native('goal', [text(goal)], ['goal.internal_context']), sessionId), []);
  const messages = provider.normalizeMessage({ type: 'item', itemType: 'agent_message',
    message: { role: 'assistant', content: goal } }, sessionId);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].content, goal);
});
