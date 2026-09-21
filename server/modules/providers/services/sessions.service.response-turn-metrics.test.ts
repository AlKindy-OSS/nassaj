import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';

import { applyResponseTurnMetrics } from './sessions.service.js';


const sessionId = 'timing-session';
const at = (seconds: number) => new Date(1_700_000_000_000 + seconds * 1000).toISOString();
const assistant = (id: string, timestamp: string, isFinalAnswer = false): NormalizedMessage => ({
  id,
  sessionId,
  timestamp,
  provider: 'codex',
  kind: 'text',
  role: 'assistant',
  content: id,
  ...(isFinalAnswer ? { isFinalAnswer: true } : {}),
});

describe('applyResponseTurnMetrics', () => {
  it('does not guess a legacy Codex item_N metric onto a persisted answer', () => {
    const commentary = assistant('msg_fixture_commentary', at(2));
    const final = assistant('msg_fixture_persisted_final', at(8), true);
    applyResponseTurnMetrics([commentary, final], [{
      assistantMessageId: 'item_16',
      startedAt: at(1),
      completedAt: at(10),
      durationMs: 9000,
    }]);
    assert.equal(commentary.responseTurnMetric, undefined);
    assert.equal(final.responseTurnMetric, undefined);
  });

  it('joins only the exact durable assistant message id', () => {
    const first = assistant('msg_first', at(4), true);
    const second = assistant('msg_second', at(8), true);
    applyResponseTurnMetrics([first, second], [{
      assistantMessageId: 'msg_second',
      startedAt: at(1),
      completedAt: at(10),
      durationMs: 9000,
    }]);
    assert.equal(first.responseTurnMetric, undefined);
    assert.deepEqual(second.responseTurnMetric, {
      durationMs: 9000,
      startedAt: at(1),
      completedAt: at(10),
    });
  });
});
