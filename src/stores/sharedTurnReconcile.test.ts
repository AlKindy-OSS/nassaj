/**
 * ADR-173 P8 B1 — a colleague's live prompt (`user_turn`) and the saved
 * transcript row of the same turn show as ONE bubble on the other viewer's
 * screen, never two until reload. The saved row replaces the live bubble and
 * keeps its author; the key is the persisted transcript id the server names
 * (`messageUuid` on `user_turn`; the saved row is `<uuid>` or `<uuid>_text_<n>`), with a
 * conservative fallback (same author, same text, within a short window) when
 * no id ever arrives.
 *
 * Run: NODE_ENV=test npx vitest run src/stores/sharedTurnReconcile.test.ts
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { computeMerged, useSessionStore, type NormalizedMessage } from './useSessionStore';

type HistorySnapshot = Parameters<ReturnType<typeof useSessionStore>['applyHistorySnapshot']>[1];

const SID = 's-shared';
const T0 = '2026-11-15T12:55:27.526Z';
const T0_PLUS_2S = '2026-11-15T12:55:29.000Z';

function live(extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'user_turn_1', sessionId: SID, timestamp: T0, provider: 'claude', kind: 'text', role: 'user',
    content: 'سؤال من العضو', userId: 3, authorName: 'Member-test', sharedTurn: true,
    sharedClientMsgId: 'cmid_member', ...extra,
  };
}

function saved(id: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id, sessionId: SID, timestamp: T0_PLUS_2S, provider: 'claude', kind: 'text', role: 'user',
    content: 'سؤال من العضو', ...extra,
  };
}

const userRows = (rows: NormalizedMessage[]) => rows.filter(row => row.kind === 'text' && row.role === 'user');

const snapshot = (messages: NormalizedMessage[]): HistorySnapshot => ({
  messages, total: messages.length, hasMore: false, nextCursor: null, tokenUsage: null,
  responseTurnDurationTotalMs: null, historySchema: 1, payloadMode: 'full', revision: 'r1',
});

describe('computeMerged — shared live prompt vs its saved row', () => {
  it('replaces the live bubble with the saved row named by its transcript id, keeping the author', () => {
    const merged = computeMerged([saved('uuid-1', { timestamp: '2026-11-15T13:30:00.000Z' })],
      [live({ transcriptMessageId: 'uuid-1' })]);
    expect(userRows(merged)).toHaveLength(1);
    expect(userRows(merged)[0]).toMatchObject({ id: 'uuid-1', userId: 3, authorName: 'Member-test' });
  });

  it('also pairs the block-content form of the saved id (`<uuid>_text_<n>`)', () => {
    const merged = computeMerged([saved('uuid-1_text_0', { timestamp: '2026-11-15T13:30:00.000Z' })],
      [live({ transcriptMessageId: 'uuid-1' })]);
    expect(userRows(merged).map(row => row.id)).toEqual(['uuid-1_text_0']);
    expect(userRows(computeMerged([saved('uuid-10', { timestamp: '2026-11-15T13:30:00.000Z' })],
      [live({ transcriptMessageId: 'uuid-1' })]))).toHaveLength(2);
  });

  it('falls back to same author + same text within a short window when no id arrived', () => {
    const unstamped = computeMerged([saved('uuid-1')], [live()]);
    expect(userRows(unstamped).map(row => row.id)).toEqual(['uuid-1']);
    expect(userRows(unstamped)[0].userId).toBe(3);
    const stamped = computeMerged([saved('uuid-1', { userId: 3 })], [live()]);
    expect(userRows(stamped)).toHaveLength(1);
  });

  it('collapses the saved row also when it arrives on the live stream (both realtime)', () => {
    const merged = computeMerged([saved('older', { content: 'earlier', timestamp: '2026-11-15T12:00:00.000Z' })],
      [live(), saved('uuid-1')]);
    expect(userRows(merged).map(row => row.id)).toEqual(['older', 'uuid-1']);
  });

  it('never folds a different author, a different text, or a row far apart in time', () => {
    expect(userRows(computeMerged([saved('uuid-1', { userId: 2 })], [live()]))).toHaveLength(2);
    expect(userRows(computeMerged([saved('uuid-1', { content: 'other' })], [live()]))).toHaveLength(2);
    expect(userRows(computeMerged([saved('uuid-1', { timestamp: '2026-11-15T13:30:00.000Z' })], [live()])))
      .toHaveLength(2);
  });

  it('one saved row retires one live bubble only (a repeated prompt stays twice)', () => {
    const merged = computeMerged([saved('uuid-1')], [live(), live({ id: 'user_turn_2', sharedClientMsgId: 'cmid_2' })]);
    expect(userRows(merged)).toHaveLength(2);
  });

  it('a saved row that acknowledges another send never retires the live bubble by text', () => {
    const merged = computeMerged([saved('uuid-1', { clientMsgId: 'cmid_someone_else' })], [live()]);
    expect(userRows(merged)).toHaveLength(2);
  });
});

describe('useSessionStore — shared live prompt lifecycle', () => {
  it('an unstamped saved row keeps the live bubble hidden behind it, with the author it named', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => { result.current.appendRealtime(SID, live({ transcriptMessageId: 'uuid-9', timestamp: '2026-11-15T10:00:00.000Z' })); });
    act(() => { result.current.applyHistorySnapshot(SID, snapshot([saved('uuid-9_text_0')])); });
    const rows = userRows(result.current.getMessages(SID));
    expect(rows.map(row => row.id)).toEqual(['uuid-9_text_0']);
    expect(rows[0]).toMatchObject({ userId: 3, authorName: 'Member-test' });
  });

  it('a history read without the saved row keeps the live bubble; with it, one bubble remains', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => { result.current.appendRealtime(SID, live()); });
    act(() => { result.current.applyHistorySnapshot(SID, snapshot([])); });
    expect(userRows(result.current.getMessages(SID)).map(row => row.id)).toEqual(['user_turn_1']);
    act(() => { result.current.applyHistorySnapshot(SID, snapshot([saved('uuid-1', { userId: 3 })])); });
    expect(userRows(result.current.getMessages(SID)).map(row => row.id)).toEqual(['uuid-1']);
  });

  it('a shared live bubble is never treated as the viewer own optimistic send', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => { result.current.appendRealtime(SID, live()); });
    expect(result.current.hasOptimisticUserRow(SID, 'cmid_member')).toBe(false);
    expect(result.current.withdrawOptimisticUserRow(SID, 'cmid_member')).toBeNull();
    act(() => {
      result.current.appendRealtime(SID, { ...saved('cmid_mine'), userId: 2 });
    });
    expect(result.current.hasOptimisticUserRow(SID, 'cmid_mine')).toBe(true);
  });
});
