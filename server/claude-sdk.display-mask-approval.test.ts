/**
 * ADR-210 (T-2036) I1: a permission answer built from a masked view (a viewer
 * that saw `[masked:…]` in AskUserQuestion) must not feed the marker to the
 * model. resolveToolApproval keeps the recorded input and takes only answers.
 */
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: { query: () => { throw new Error('not used'); }, createSdkMcpServer: () => ({}), tool: () => ({}) },
});

const sdk = (await import('./claude-sdk.js')) as unknown as Record<string, any>;

const SK = 'sk-' + 'ant-api03-QqWwEeRrTtYyUuIiOoPpAaSs';

test('a masked AskUserQuestion answer keeps the recorded questions and merges only the answers', async () => {
  const input = { questions: [{ question: `Rotate ${SK}?`, options: [{ label: 'yes' }] }] };
  const decision = sdk.waitForToolApproval('approval-mask-1', {
    timeoutMs: 5_000, metadata: { _sessionId: 'mask-approval-session', _ownerUserId: 1, _toolName: 'AskUserQuestion', _input: input },
  });
  const fromMaskedView = { questions: [{ question: 'Rotate [masked:anthropic-openai-key]?', options: [{ label: 'yes' }] }], answers: { 'q': 'yes' } };
  assert.equal(sdk.resolveToolApproval('approval-mask-1', { allow: true, requesterUserId: 1, updatedInput: fromMaskedView }).resolved, true);
  const settled = await decision;
  assert.deepEqual(settled.updatedInput, { ...input, answers: { q: 'yes' } });
  assert.ok(!JSON.stringify(settled.updatedInput).includes('[masked:'));
});

test('an owner edit without markers is executed as sent', async () => {
  const decision = sdk.waitForToolApproval('approval-mask-2', {
    timeoutMs: 5_000, metadata: { _sessionId: 'mask-approval-session', _ownerUserId: 1, _toolName: 'Bash', _input: { command: 'ls' } },
  });
  sdk.resolveToolApproval('approval-mask-2', { allow: true, requesterUserId: 1, updatedInput: { command: 'ls -la' } });
  assert.deepEqual((await decision).updatedInput, { command: 'ls -la' });
});
