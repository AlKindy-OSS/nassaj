import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getRunningActivityGap } from './runningActivityGap.js';
import type { ChatMessage } from '../../types/types';

// T-836: while a reply is in flight and every event so far is tool_use (no
// assistant text yet — the exact case "hideToolCalls" makes look empty), the
// message list must surface a light "agent is working — last activity Y ago"
// card. It must disappear the instant real assistant text appears, or the
// moment the run ends, and must never fire on an idle/non-running transcript.

const BASE_TS = Date.parse('2026-07-16T10:00:00.000Z');

const userMsg = (over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ type: 'user', content: 'do it', timestamp: BASE_TS, ...over }) as ChatMessage;

const toolMsg = (offsetMs: number, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    type: 'assistant',
    content: '',
    isToolUse: true,
    toolName: 'Bash',
    timestamp: BASE_TS + offsetMs,
    ...over,
  }) as ChatMessage;

const textMsg = (offsetMs: number, content = 'here is the answer'): ChatMessage =>
  ({ type: 'assistant', content, timestamp: BASE_TS + offsetMs }) as ChatMessage;

describe('getRunningActivityGap', () => {
  it('is hidden when not loading, even with a tool-only tail', () => {
    const messages = [userMsg(), toolMsg(1000), toolMsg(2000)];
    assert.deepEqual(getRunningActivityGap(messages, false), {
      visible: false,
      lastActivityAt: null,
    });
  });

  it('is hidden on an empty transcript', () => {
    assert.deepEqual(getRunningActivityGap([], true), {
      visible: false,
      lastActivityAt: null,
    });
  });

  it('shows once loading with only tool_use since the last prompt, timestamped at the latest one', () => {
    const messages = [userMsg(), toolMsg(1000), toolMsg(3000)];
    const result = getRunningActivityGap(messages, true);
    assert.equal(result.visible, true);
    assert.equal(result.lastActivityAt, BASE_TS + 3000);
  });

  it('is hidden the instant real assistant text appears in the current reply', () => {
    const messages = [userMsg(), toolMsg(1000), textMsg(2000), toolMsg(3000)];
    assert.deepEqual(getRunningActivityGap(messages, true), {
      visible: false,
      lastActivityAt: null,
    });
  });

  it('ignores thinking-only rows as "text" (thinking is not the assistant reply)', () => {
    const messages = [
      userMsg(),
      { type: 'assistant', isThinking: true, content: 'pondering…', timestamp: BASE_TS + 500 } as ChatMessage,
      toolMsg(1000),
    ];
    const result = getRunningActivityGap(messages, true);
    assert.equal(result.visible, true);
    assert.equal(result.lastActivityAt, BASE_TS + 1000);
  });

  it('is hidden when the current reply has no tool_use at all (nothing to anchor to)', () => {
    const messages = [userMsg()];
    assert.deepEqual(getRunningActivityGap(messages, true), {
      visible: false,
      lastActivityAt: null,
    });
  });

  it('is bounded to the current reply: a prior turn full of tool_use does not leak in', () => {
    const messages = [
      userMsg({ timestamp: BASE_TS - 10000 }),
      toolMsg(-9000),
      textMsg(-8000),
      userMsg({ timestamp: BASE_TS }),
      // new reply has started delegating but has not emitted anything yet
    ];
    assert.deepEqual(getRunningActivityGap(messages, true), {
      visible: false,
      lastActivityAt: null,
    });
  });

  it('picks up a sub-agent\'s child tool calls as activity, not just the container row', () => {
    const messages = [
      userMsg(),
      toolMsg(500, {
        toolName: 'Agent',
        isSubagentContainer: true,
        subagentState: {
          isComplete: false,
          currentToolIndex: 1,
          childTools: [
            { toolId: 'c1', toolName: 'Read', toolInput: '{}', timestamp: new Date(BASE_TS + 4000) },
          ],
        },
      }),
    ];
    const result = getRunningActivityGap(messages, true);
    assert.equal(result.visible, true);
    assert.equal(result.lastActivityAt, BASE_TS + 4000);
  });
});
