import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';

import {
  buildCodexBranchInput,
  CODEX_BRANCH_CONTEXT_MAX_BYTES,
  extractCodexBranchCommand,
  wrapCodexBranchInput,
} from '../codex-branch-context.js';

function row(id: string, role: 'user' | 'assistant', content: string): NormalizedMessage {
  return {
    id,
    sessionId: 'parent',
    timestamp: '2026-08-09T00:00:00.000Z',
    provider: 'codex',
    kind: 'text',
    role,
    content,
  };
}

describe('Codex cross-home branch context', () => {
  it('keeps a coherent text-only suffix and hides the transport envelope from history', () => {
    const messages: NormalizedMessage[] = [
      row('u1', 'user', 'original question'),
      { ...row('tool', 'assistant', 'secret tool output'), kind: 'tool_result' },
      row('a1', 'assistant', 'answer'),
    ];
    const result = buildCodexBranchInput('parent', messages, 'continue please');
    const wrapped = wrapCodexBranchInput(result.input);

    assert.equal(extractCodexBranchCommand(wrapped), 'continue please');
    assert.equal(result.includedMessages, 2);
    assert.doesNotMatch(wrapped, /secret tool output/);
  });

  it('never cuts into an assistant-only prefix and respects the 64 KiB budget', () => {
    const messages = [
      row('a0', 'assistant', 'orphan'),
      row('u1', 'user', 'x'.repeat(40_000)),
      row('a1', 'assistant', 'y'.repeat(20_000)),
      row('u2', 'user', 'latest'),
      row('a2', 'assistant', 'reply'),
    ];
    const result = buildCodexBranchInput('parent', messages, 'next');

    assert.ok(result.includedBytes <= CODEX_BRANCH_CONTEXT_MAX_BYTES);
    assert.equal(result.includedMessages, 4);
    assert.equal(result.omittedMessages, 1);
  });

  it('does not decode ordinary user text', () => {
    assert.equal(extractCodexBranchCommand('ordinary prompt'), null);
  });
});
