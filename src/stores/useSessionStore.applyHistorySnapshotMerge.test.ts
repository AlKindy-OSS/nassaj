/**
 * B-1469 — `applyHistorySnapshot` merges the incoming tail by id instead of
 * replacing `slot.serverMessages` wholesale.
 *
 * A re-issued initial/light tail (session revisited within the same mounted
 * hook, or the load effect re-running for any other reason) used to shrink
 * an already-wider window back down to whatever this one request asked for,
 * dropping any row that fell outside it — including an already-confirmed
 * user bubble, which then left its optimistic `cmid_`/`local_` twin
 * un-deduped next to a hole where the canonical row used to be.
 *
 * Run: NODE_ENV=test npx vitest run \
 *   src/stores/useSessionStore.applyHistorySnapshotMerge.test.ts
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useSessionStore, type NormalizedMessage } from './useSessionStore';

type HistorySnapshot = Parameters<ReturnType<typeof useSessionStore>['applyHistorySnapshot']>[1];

const SID = 's-merge';

function assistantRow(id: string, timestamp: string): NormalizedMessage {
  return { id, sessionId: SID, timestamp, provider: 'claude', kind: 'text', role: 'assistant', content: `a-${id}` };
}

function userRow(id: string, timestamp: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { id, sessionId: SID, timestamp, provider: 'claude', kind: 'text', role: 'user', content: `u-${id}`, ...extra };
}

const snapshot = (messages: NormalizedMessage[], extra: Partial<HistorySnapshot> = {}): HistorySnapshot => ({
  messages, total: messages.length, hasMore: false, nextCursor: null, tokenUsage: null,
  responseTurnDurationTotalMs: null, historySchema: 1, payloadMode: 'full', revision: 'r1',
  ...extra,
});

describe('applyHistorySnapshot merges by id (B-1469)', () => {
  it('a narrower re-issued tail keeps an older row the first (wider) load already carried', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      // First load: a wide window carrying an old row plus the recent tail.
      result.current.applyHistorySnapshot(SID, snapshot([
        assistantRow('old-1', '2026-09-01T00:00:00.000Z'),
        ...Array.from({ length: 20 }, (_, i) => assistantRow(`tail-${i}`, `2026-09-29T00:${String(i).padStart(2, '0')}:00.000Z`)),
      ]));
    });
    expect(result.current.getMessages(SID)).toHaveLength(21);

    act(() => {
      // Re-issued initial tail (the bug's trigger): only the last 20, no `old-1`.
      result.current.applyHistorySnapshot(SID, snapshot(
        Array.from({ length: 20 }, (_, i) => assistantRow(`tail-${i}`, `2026-09-29T00:${String(i).padStart(2, '0')}:00.000Z`)),
      ), { merge: true });
    });

    const ids = result.current.getMessages(SID).map(row => row.id);
    expect(ids).toContain('old-1');
    expect(ids).toHaveLength(21);
  });

  it('an empty slot still behaves like a plain replace for the ordinary first load', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.applyHistorySnapshot(SID, snapshot([assistantRow('m1', '2026-09-29T00:00:00.000Z')]));
    });
    expect(result.current.getMessages(SID).map(row => row.id)).toEqual(['m1']);
  });

  it('a real session switch (different session id) is unaffected — new slot, no merge to reuse', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.applyHistorySnapshot(SID, snapshot([assistantRow('m1', '2026-09-29T00:00:00.000Z')]));
      result.current.applyHistorySnapshot('other-session', snapshot([assistantRow('m2', '2026-09-29T00:00:00.000Z')]));
    });
    expect(result.current.getMessages(SID).map(row => row.id)).toEqual(['m1']);
    expect(result.current.getMessages('other-session').map(row => row.id)).toEqual(['m2']);
  });

  it('"take the larger": hasMore/offset/historyCursor never shrink pagination reach already established', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      // First (widened) load already paged further back: hasMore=false, a cursor set.
      result.current.applyHistorySnapshot(SID, snapshot(
        Array.from({ length: 30 }, (_, i) => assistantRow(`m-${i}`, `2026-09-29T00:${String(i).padStart(2, '0')}:00.000Z`)),
        { hasMore: false, nextCursor: 'deep-cursor' },
      ));
    });
    const wideSlot = result.current.getSessionSlot(SID)!;
    expect(wideSlot.hasMore).toBe(false);
    expect(wideSlot.historyCursor).toBe('deep-cursor');

    act(() => {
      // Re-issued narrow tail claims hasMore=true and a shallower cursor —
      // must not look like pagination regressed.
      result.current.applyHistorySnapshot(SID, snapshot(
        Array.from({ length: 20 }, (_, i) => assistantRow(`m-${i + 10}`, `2026-09-29T00:${String(i + 10).padStart(2, '0')}:00.000Z`)),
        { hasMore: true, nextCursor: 'shallow-cursor' },
      ), { merge: true });
    });
    const afterSlot = result.current.getSessionSlot(SID)!;
    expect(afterSlot.hasMore).toBe(false);
    expect(afterSlot.historyCursor).toBe('deep-cursor');
    expect(afterSlot.offset).toBeGreaterThanOrEqual(30);
  });

  it('dedupes an optimistic row once the merged (superset) server rows include its canonical twin', () => {
    const { result } = renderHook(() => useSessionStore());
    const local = userRow('cmid_a', '2026-09-29T00:00:00.500Z', { content: 'hello' });
    const canonical = userRow('uuid-a', '2026-09-29T00:00:00.000Z', { content: 'hello', displayClientMsgId: 'cmid_a' });

    act(() => {
      // Wide load already carries the canonical row.
      result.current.applyHistorySnapshot(SID, snapshot([canonical]));
      // The optimistic twin arrives (or was never cleaned up yet).
      result.current.appendRealtime(SID, local);
    });
    // Re-issued narrow tail that (by itself) would not include `canonical` —
    // but the merge keeps it from the previous load, so dedup still works.
    act(() => {
      result.current.applyHistorySnapshot(SID, snapshot([]), { merge: true });
    });

    const rows = result.current.getMessages(SID);
    expect(rows.map(row => row.id)).toEqual(['uuid-a']);
  });
});
