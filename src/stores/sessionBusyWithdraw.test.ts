/**
 * B-518 / B-1078 — سحب الفقاعة المتفائلة بعد رفضٍ قاطع أو فشل نقل، ونقلها عند التفرّع.
 *
 * حين ترفض بوابة B-SEC-DUP-RUN إرسالاً (`session_busy`) أو يفشل نقله، الرسالة
 * **لم تصل المحرّك ولن تصل**. الصفّ المتفائل يُسحب من المخزن ويعود نصّه
 * للمُؤلِّف. B-1078: المعرّفات الحقيقية `cmid_` منذ c5402a71، وكانت اختبارات
 * `local_` المصطنعة تُخفي أن السحب لم يعد يصيب شيئاً؛ فالصفوف هنا بشكل الإنتاج.
 *
 * Run: npx vitest run src/stores/sessionBusyWithdraw.test.ts
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useSessionStore } from './useSessionStore';
import type { NormalizedMessage } from './useSessionStore';

const SID = 'sess-busy';
const FIRST = 'cmid_mf0a1b2c_k3j9x0qa';
const SECOND = 'cmid_mf0a1b3d_p8w2n7zt';

function userRow(id: string, content: string, timestamp: string, sessionId = SID): NormalizedMessage {
  return { id, sessionId, timestamp, provider: 'claude', kind: 'text', role: 'user', content };
}

function twoPending() {
  const hook = renderHook(() => useSessionStore());
  act(() => {
    hook.result.current.appendRealtime(SID, userRow(FIRST, 'أول', '2026-08-06T10:00:00.000Z'));
    hook.result.current.appendRealtime(SID, userRow(SECOND, 'ثانٍ', '2026-08-06T10:01:00.000Z'));
  });
  return hook;
}

function withdraw(
  store: ReturnType<typeof useSessionStore>,
  sessionId: string,
  clientMsgId?: string,
): string | null {
  let withdrawn: string | null = 'unset';
  // `as string`: exercises the runtime guard for an id-less frame despite the required type.
  act(() => { withdrawn = store.withdrawOptimisticUserRow(sessionId, clientMsgId as string); });
  return withdrawn;
}

describe('withdrawOptimisticUserRow (B-518, B-1078)', () => {
  it('session_busy: frame id withdraws that exact cmid_ row even when it is not the last', () => {
    const { result } = twoPending();
    expect(withdraw(result.current, SID, FIRST)).toBe('أول');
    expect(result.current.getMessages(SID).map(row => row.id)).toEqual([SECOND]);
  });

  it('transport failure: the composer id withdraws its own bubble among two pending rows', () => {
    const { result } = twoPending();
    expect(withdraw(result.current, SID, SECOND)).toBe('ثانٍ');
    expect(result.current.getMessages(SID).map(row => row.id)).toEqual([FIRST]);
  });

  it('an unknown id withdraws nothing instead of guessing a neighbour', () => {
    const { result } = twoPending();
    expect(withdraw(result.current, SID, 'cmid_not_here')).toBeNull();
    expect(result.current.getMessages(SID)).toHaveLength(2);
  });

  it('mirror tab: a busy frame without an id withdraws nothing, leaving the live pending row', () => {
    // Tab A holds its own live send M1; tab B's M2 was rejected by an id-less frame.
    const { result } = renderHook(() => useSessionStore());
    act(() => { result.current.appendRealtime(SID, userRow(FIRST, 'M1 حيّة', '2026-08-06T10:00:00.000Z')); });
    expect(withdraw(result.current, SID)).toBeNull();
    expect(withdraw(result.current, SID, '')).toBeNull();
    expect(result.current.getMessages(SID).map(row => row.id)).toEqual([FIRST]);
  });

  it('withdraws a legacy local_ row only by its exact id', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => { result.current.appendRealtime(SID, userRow('local_1', 'قديم', '2026-08-06T10:00:00.000Z')); });
    expect(withdraw(result.current, SID)).toBeNull();
    expect(withdraw(result.current, SID, 'local_1')).toBe('قديم');
    expect(result.current.getMessages(SID)).toHaveLength(0);
  });

  it('an exact id withdraws an attachment-only bubble and returns empty text (nothing to restore)', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime(SID, { ...userRow(FIRST, '', '2026-08-06T10:00:00.000Z'), images: ['/api/images/a'] });
    });
    expect(withdraw(result.current, SID, FIRST)).toBe('');
    expect(result.current.getMessages(SID)).toHaveLength(0);
  });

  it('never touches a server row, with or without an id', () => {
    const { result } = renderHook(() => useSessionStore());
    act(() => {
      result.current.appendRealtime(SID, { ...userRow('srv_9', 'من الخادم', '2026-08-06T10:00:00.000Z'), clientMsgId: FIRST });
    });
    expect(withdraw(result.current, SID, FIRST)).toBeNull();
    expect(withdraw(result.current, SID, 'srv_9')).toBeNull();
    expect(result.current.getMessages(SID)).toHaveLength(1);
  });

  it('a session missing from the store does not throw', () => {
    const { result } = renderHook(() => useSessionStore());
    expect(result.current.withdrawOptimisticUserRow('لا-أحد', FIRST)).toBeNull();
  });
});

describe('branchSessionId moves the pending cmid_ row (B-1078)', () => {
  const BRANCH = 'sess-branch';

  it('moves the row named by the fork frame id, leaving the other in the source', () => {
    const { result } = twoPending();
    act(() => result.current.branchSessionId(SID, BRANCH, FIRST));
    expect(result.current.getMessages(BRANCH).map(row => [row.id, row.sessionId])).toEqual([[FIRST, BRANCH]]);
    expect(result.current.getMessages(SID).map(row => row.id)).toEqual([SECOND]);
  });

  it('without an id moves the last optimistic cmid_ row (was skipped by the local_ check)', () => {
    const { result } = twoPending();
    act(() => result.current.branchSessionId(SID, BRANCH));
    expect(result.current.getMessages(BRANCH).map(row => row.id)).toEqual([SECOND]);
    expect(result.current.getMessages(SID).map(row => row.id)).toEqual([FIRST]);
  });
});
