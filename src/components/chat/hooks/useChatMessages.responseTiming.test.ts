import { describe, expect, it } from 'vitest';

import { attachTurnDurations } from './useChatMessages';
import type { ChatMessage } from '../types/types';

const row = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: crypto.randomUUID(),
  type: 'assistant',
  content: 'نص',
  timestamp: '2026-08-25T10:00:00.000Z',
  sessionId: 'main',
  ...overrides,
});

const metric = (durationMs: number) => ({
  durationMs,
  startedAt: '2026-08-25T10:00:02.000Z',
  completedAt: '2026-08-25T10:00:07.000Z',
});

describe('attachTurnDurations', () => {
  it('copies durationMs directly from the persisted metric', () => {
    const [reply] = attachTurnDurations([row({ responseTurnMetric: metric(4_250) })]);
    expect(reply.turnDurationMs).toBe(4_250);
  });

  it('does not derive duration from audit timestamps', () => {
    const [reply] = attachTurnDurations([
      row({ responseTurnMetric: { ...metric(7_000), durationMs: 123 } }),
    ]);
    expect(reply.turnDurationMs).toBe(123);
  });

  it('does not time intermediate or non-assistant rows even if malformed history attaches a metric', () => {
    const timed = attachTurnDurations([
      row({ type: 'user', responseTurnMetric: metric(1_000) }),
      row({ isThinking: true, responseTurnMetric: metric(1_000) }),
      row({ isToolUse: true, responseTurnMetric: metric(1_000) }),
      row({ isTaskNotification: true, responseTurnMetric: metric(1_000) }),
    ]);
    expect(timed.every((message) => message.turnDurationMs === undefined)).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 2_592_000_001, 1.5])(
    'fails closed for an invalid persisted duration (%s)',
    (durationMs) => {
      const [reply] = attachTurnDurations([row({ responseTurnMetric: metric(durationMs) })]);
      expect(reply.turnDurationMs).toBeUndefined();
    },
  );

  it('preserves a persisted zero-duration metric', () => {
    const [reply] = attachTurnDurations([row({ responseTurnMetric: metric(0) })]);
    expect(reply.turnDurationMs).toBe(0);
  });

  it('stays silent when no persisted metric exists', () => {
    const [reply] = attachTurnDurations([row({})]);
    expect(reply.turnDurationMs).toBeUndefined();
  });
});
