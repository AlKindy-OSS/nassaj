/**
 * Steer duplicate after a page reload: one server steer row rendered as two
 * cards, the history copy ("delivered") and a live "queued" copy re-inserted
 * from the server's replay ring (check-session-status with lastSeq=0 replays
 * the run's `steer-queued`, and the page-scoped insertion guard is empty
 * again after the reload). The history row carries the same steerClientMsgId,
 * so the merge must let it retire the live copy.
 *
 * RUNNER: vitest.
 */

import { describe, expect, it } from 'vitest';

import { computeMerged, type NormalizedMessage } from './useSessionStore';

const SESSION = 's-steer';
const CLIENT_MSG_ID = 'steer-25cbb402';

function historySteerRow(): NormalizedMessage {
  return {
    id: 'msg-history-steer', sessionId: SESSION, kind: 'text', role: 'user', provider: 'claude',
    timestamp: '2026-10-20T11:29:49.000Z', content: 'تخط التجربة', injected: true, userId: 1,
    deliveryStatus: 'delivered', steerClientMsgId: CLIENT_MSG_ID,
  };
}

function liveSteerRow(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'local_live_steer', sessionId: SESSION, kind: 'text', role: 'user', provider: 'claude',
    timestamp: '2026-10-20T12:03:10.000Z', content: 'تخط التجربة', injected: true, userId: 1,
    deliveryStatus: 'queued', steerClientMsgId: CLIENT_MSG_ID, ...overrides,
  };
}

function assistantRow(id: string, second: number): NormalizedMessage {
  return {
    id, sessionId: SESSION, kind: 'text', role: 'assistant', provider: 'claude',
    timestamp: `2026-10-20T11:30:${String(second).padStart(2, '0')}.000Z`, content: id,
  };
}

describe('computeMerged — live steer bubble vs its history row', () => {
  it('drops the live queued copy once history holds the same steerClientMsgId', () => {
    const merged = computeMerged([historySteerRow(), assistantRow('reply', 5)], [liveSteerRow()]);
    const steerCards = merged.filter(m => m.steerClientMsgId === CLIENT_MSG_ID);
    expect(steerCards).toHaveLength(1);
    expect(steerCards[0].deliveryStatus).toBe('delivered');
  });

  it('keeps the live copy while history does not have that steer yet', () => {
    const merged = computeMerged([assistantRow('reply', 5)], [liveSteerRow()]);
    expect(merged.filter(m => m.steerClientMsgId === CLIENT_MSG_ID)).toHaveLength(1);
  });

  it('keeps a live steer whose id differs from every history steer', () => {
    const merged = computeMerged([historySteerRow()], [liveSteerRow({ steerClientMsgId: 'steer-other' })]);
    expect(merged.map(m => m.steerClientMsgId)).toEqual([CLIENT_MSG_ID, 'steer-other']);
  });
});
