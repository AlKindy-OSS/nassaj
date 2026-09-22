/**
 * Regression test for: formatToolResultContent throws when toolResult.content
 * is undefined (image-only tool_results stripped by session-history-light).
 * session-history-light.service.ts lines 141-151: when content is not a plain
 * string (e.g. an array of image blocks), it is deferred and toolResult.content
 * is never set → tr.content is undefined at useChatMessages transform time.
 */
import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

function toolUseMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'msg-tool-use-1',
    sessionId: 'session-1',
    timestamp: '2026-09-22T00:00:00.000Z',
    provider: 'claude',
    kind: 'tool_use',
    role: 'assistant',
    toolId: 'tool-1',
    toolName: 'computer',
    content: '',
    ...overrides,
  };
}

describe('normalizedToChatMessages — toolResult stripped content', () => {
  it('لا يرمي خطأً عندما يكون toolResult.content غير معرَّف (صورة محذوفة)', () => {
    // Simulate what session-history-light produces for an image-only tool_result:
    // { isError: false } with no content key at all.
    const msg = toolUseMessage({
      toolResult: { isError: false } as unknown as { content: string; isError: boolean },
    });

    expect(() => normalizedToChatMessages([msg])).not.toThrow();
  });

  it('يُعيد سلسلة فارغة كمحتوى عندما يكون toolResult.content غير معرَّف', () => {
    const msg = toolUseMessage({
      toolResult: { isError: false } as unknown as { content: string; isError: boolean },
    });

    const result = normalizedToChatMessages([msg]);
    const toolMessage = result.find((m) => m.isToolUse);
    expect(toolMessage?.toolResult?.content).toBe('');
  });

  it('يعالج toolResult.content=null بنفس الأمان', () => {
    const msg = toolUseMessage({
      toolResult: {
        isError: false,
        content: null,
      } as unknown as { content: string; isError: boolean },
    });

    expect(() => normalizedToChatMessages([msg])).not.toThrow();
    const result = normalizedToChatMessages([msg]);
    const toolMessage = result.find((m) => m.isToolUse);
    expect(toolMessage?.toolResult?.content).toBe('');
  });
});
