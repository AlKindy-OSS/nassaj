/** T-2095: a live `turn_checkpoint` frame becomes one chip row, never a text bubble. */
import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

describe('normalizedToChatMessages turn_checkpoint', () => {
  it('carries the checkpoint fields onto a chip row', () => {
    const rows = normalizedToChatMessages([{
      id: 'turn_checkpoint_1', sessionId: 's-1', timestamp: '2026-11-18T00:00:00.000Z', provider: 'claude',
      kind: 'turn_checkpoint', turnSeq: 7, status: 'captured',
      counts: { added: 1, modified: 0, deleted: 2 }, withheldCount: 1,
    } as unknown as NormalizedMessage]);
    expect(rows).toHaveLength(1);
    expect(rows[0].turnCheckpoint).toEqual({
      turnSeq: 7, status: 'captured', counts: { added: 1, modified: 0, deleted: 2 }, withheldCount: 1,
    });
    expect(rows[0].sessionId).toBe('s-1');
    expect(rows[0].content).toBe('');
  });

  it('keeps a skip reason and tolerates missing counts', () => {
    const rows = normalizedToChatMessages([{
      id: 'turn_checkpoint_2', sessionId: 's-1', timestamp: '2026-11-18T00:00:00.000Z',
      kind: 'turn_checkpoint', turnSeq: null, status: 'skipped', reason: 'not_overlay',
    } as unknown as NormalizedMessage]);
    expect(rows[0].turnCheckpoint).toEqual({
      turnSeq: null, status: 'skipped', reason: 'not_overlay', counts: { added: 0, modified: 0, deleted: 0 }, withheldCount: 0,
    });
  });
});
