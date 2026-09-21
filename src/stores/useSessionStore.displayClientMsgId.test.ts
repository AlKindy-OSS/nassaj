/**
 * B-1078 — mid-turn duplicate user bubble.
 *
 * The server stamps `clientMsgId` on a transcript user row only after a
 * successful terminal turn, so a history read during the turn (or after an
 * error turn) left the optimistic `cmid_` bubble unpaired beside its own
 * transcript row. The server now adds `displayClientMsgId` once the row is
 * bound to the send by identity (uuid + payload hash). Pairing stays exact:
 * equal text never hides a bubble (B-985/B-997).
 *
 * Run: npx vitest run src/stores/useSessionStore.displayClientMsgId.test.ts
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../utils/api', () => ({ authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args) }));

import { normalizedToChatMessages } from '../components/chat/hooks/useChatMessages';

import {
  computeMerged,
  retainUnsyncedOptimisticRows,
  useSessionStore,
  type NormalizedMessage,
} from './useSessionStore';

type HistorySnapshot = Parameters<ReturnType<typeof useSessionStore>['applyHistorySnapshot']>[1];

const SID = 'b1078-session';
const snapshot = (messages: NormalizedMessage[]): HistorySnapshot => ({
  messages, total: messages.length, hasMore: false, nextCursor: null, tokenUsage: null,
  responseTurnDurationTotalMs: null, historySchema: 1, payloadMode: 'light', revision: 'r1',
});

function optimistic(id: string, content: string, timestamp: string): NormalizedMessage {
  return { id, sessionId: SID, timestamp, provider: 'claude', kind: 'text', role: 'user', content, userId: 1 };
}

/** A canonical transcript user row as the light history API returns it mid-turn. */
function transcriptRow(id: string, content: string, timestamp: string, displayClientMsgId?: string): NormalizedMessage {
  return {
    id, sessionId: SID, timestamp, provider: 'claude', kind: 'text', role: 'user', content, userId: 1,
    coordinationLevel: 'direct',
    ...(displayClientMsgId ? { displayClientMsgId } : {}),
  };
}

beforeEach(() => { authenticatedFetch.mockReset(); });

describe('displayClientMsgId pairs the optimistic row with its transcript row', () => {
  it('retainUnsyncedOptimisticRows drops the optimistic row once the display id names it', () => {
    const local = optimistic('cmid_a', 'مرحبا', '2026-09-11T09:41:00.000Z');
    const saved = transcriptRow('uuid-a', 'مرحبا', '2026-09-11T09:41:00.500Z', 'cmid_a');
    expect(retainUnsyncedOptimisticRows([local], [])).toEqual([local]);
    expect(retainUnsyncedOptimisticRows([local], [saved])).toEqual([]);
    expect(computeMerged([saved], [local]).map(row => row.id)).toEqual(['uuid-a']);
  });

  it('a display id for another send does not hide this bubble', () => {
    const local = optimistic('cmid_a', 'مرحبا', '2026-09-11T09:41:00.000Z');
    const saved = transcriptRow('uuid-b', 'مرحبا', '2026-09-11T09:41:00.500Z', 'cmid_b');
    expect(retainUnsyncedOptimisticRows([local], [saved])).toEqual([local]);
  });

  it('two identical texts: each bubble is hidden only by its own id, never by text', () => {
    const text = 'نفس النص';
    const first = optimistic('cmid_first', text, '2026-09-11T09:41:00.000Z');
    const second = optimistic('cmid_second', text, '2026-09-11T09:42:00.000Z');
    const savedFirst = transcriptRow('uuid-first', text, '2026-09-11T09:41:00.500Z', 'cmid_first');
    const savedSecond = transcriptRow('uuid-second', text, '2026-09-11T09:42:00.500Z', 'cmid_second');
    const unbound = transcriptRow('uuid-unbound', text, '2026-09-11T09:40:00.000Z');

    expect(retainUnsyncedOptimisticRows([first, second], [savedFirst])).toEqual([second]);
    expect(retainUnsyncedOptimisticRows([first, second], [savedSecond])).toEqual([first]);
    expect(retainUnsyncedOptimisticRows([first, second], [unbound])).toEqual([first, second]);
    expect(retainUnsyncedOptimisticRows([first, second], [savedFirst, savedSecond])).toEqual([]);
  });

  it('one canonical row cannot acknowledge two sends', () => {
    const local = optimistic('cmid_a', 'x', '2026-09-11T09:41:00.000Z');
    const saved = transcriptRow('uuid-a', 'x', '2026-09-11T09:41:00.500Z', 'cmid_a');
    expect(retainUnsyncedOptimisticRows([local, { ...local }], [saved])).toHaveLength(1);
  });

  it('ignores the display id on non-user rows', () => {
    const local = optimistic('cmid_a', 'x', '2026-09-11T09:41:00.000Z');
    const reply = { ...transcriptRow('uuid-r', 'x', '2026-09-11T09:41:01.000Z', 'cmid_a'), role: 'assistant' as const };
    expect(retainUnsyncedOptimisticRows([local], [reply])).toEqual([local]);
  });
});

describe('production-shaped row (B-1078 incident)', () => {
  const TEXT = 'سوي تجربة أبغا اشوف ';
  const CMID = 'cmid_mfe8t1q2_7h3k9d0s';
  const local = () => optimistic(CMID, TEXT, '2026-09-11T09:41:03.120Z');
  // Mid-turn: bound by uuid + hash, so the display id is present; clientMsgId is not yet.
  const saved = transcriptRow('3f6c2a1e-8d4b-4c7a-9e21-5b0f7d3a9c12', TEXT, '2026-09-11T09:41:03.412Z', CMID);

  const visibleUserBubbles = (rows: NormalizedMessage[]) =>
    normalizedToChatMessages(rows).filter(message => message.type === 'user');

  it('applyHistorySnapshot during the turn shows exactly one user bubble', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime(SID, local());
      result.current.applyHistorySnapshot(SID, snapshot([saved]));
    });
    const rows = result.current.getMessages(SID);
    expect(rows.map(row => row.id)).toEqual([saved.id]);
    expect(visibleUserBubbles(rows)).toHaveLength(1);
    expect(visibleUserBubbles(rows)[0].content).toBe(TEXT);
  });

  it('mergeTailFromServer (reload/reconnect tail read) shows exactly one user bubble', async () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => result.current.appendRealtime(SID, local()));
    authenticatedFetch.mockResolvedValue({ ok: true, json: async () => snapshot([saved]) });
    await act(async () => { await result.current.mergeTailFromServer(SID); });
    expect(visibleUserBubbles(result.current.getMessages(SID))).toHaveLength(1);
  });

  it('without the display id the same row stays duplicated (text is never identity)', () => {
    const { result } = renderHook(() => useSessionStore());
    const { displayClientMsgId: _omitted, ...unbound } = saved;
    act(() => {
      result.current.appendRealtime(SID, local());
      result.current.applyHistorySnapshot(SID, snapshot([unbound]));
    });
    expect(visibleUserBubbles(result.current.getMessages(SID))).toHaveLength(2);
  });
});
