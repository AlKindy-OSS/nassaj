import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shouldHideToolCallMessage } from './hideToolCalls.js';
import type { ChatMessage } from '../../types/types';

// "Hide tool calls" preference (opt-in). The guard suppresses ordinary tool
// cards and sub-agent containers from the transcript, but must NEVER hide:
//   - interactive tools the user has to act on (AskUserQuestion / ExitPlanMode),
//   - any errored tool result (failures must stay visible).
// Hiding an interactive prompt would soft-lock the run; this is the load-bearing
// behaviour the opus task called out, so it is the bulk of the coverage.

const toolMsg = (over: Partial<ChatMessage>): ChatMessage =>
  ({
    type: 'assistant',
    content: '',
    timestamp: Date.now(),
    isToolUse: true,
    ...over,
  }) as ChatMessage;

describe('shouldHideToolCallMessage', () => {
  it('returns false when the preference is off (no change to behaviour)', () => {
    assert.equal(shouldHideToolCallMessage(toolMsg({ toolName: 'Bash' }), false), false);
    assert.equal(shouldHideToolCallMessage(toolMsg({ toolName: 'Bash' }), undefined), false);
  });

  it('hides ordinary tool-use cards when on', () => {
    for (const toolName of ['Bash', 'Read', 'Grep', 'Edit', 'TodoWrite', 'Glob', 'Write']) {
      assert.equal(
        shouldHideToolCallMessage(toolMsg({ toolName }), true),
        true,
        `expected ${toolName} to be hidden`,
      );
    }
  });

  it('hides sub-agent containers (Task / Agent) when on', () => {
    assert.equal(
      shouldHideToolCallMessage(
        toolMsg({ toolName: 'Task', isSubagentContainer: true }),
        true,
      ),
      true,
    );
    assert.equal(
      shouldHideToolCallMessage(
        toolMsg({ toolName: 'Agent', isSubagentContainer: true }),
        true,
      ),
      true,
    );
  });

  it('keeps interactive tools visible even when on (would otherwise soft-lock)', () => {
    for (const toolName of ['AskUserQuestion', 'exit_plan_mode', 'ExitPlanMode']) {
      assert.equal(
        shouldHideToolCallMessage(toolMsg({ toolName }), true),
        false,
        `expected ${toolName} to stay visible`,
      );
    }
  });

  it('keeps errored tool results visible even when on (never hide a failure)', () => {
    assert.equal(
      shouldHideToolCallMessage(
        toolMsg({ toolName: 'Bash', toolResult: { content: 'boom', isError: true } }),
        true,
      ),
      false,
    );
  });

  it('does not affect non-tool messages (user / assistant / error / thinking)', () => {
    assert.equal(
      shouldHideToolCallMessage({ type: 'user', content: 'hi' } as ChatMessage, true),
      false,
    );
    assert.equal(
      shouldHideToolCallMessage(
        { type: 'assistant', isThinking: true } as ChatMessage,
        true,
      ),
      false,
    );
    assert.equal(
      shouldHideToolCallMessage({ type: 'error', content: 'x' } as ChatMessage, true),
      false,
    );
  });
});
