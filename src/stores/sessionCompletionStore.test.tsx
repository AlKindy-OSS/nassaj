/**
 * T-1340 — عقد مؤشرات المحادثة المشتركة.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/stores/sessionCompletionStore.test.tsx
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const {
  acknowledgeOutcome,
  acknowledgeOutcomeWhenActive,
  applyOutcomeDelta,
  applyOutcomeSnapshot,
  canMarkOutcomeUnread,
  markOutcomeUnread,
  refreshOutcomes,
  releaseManualUnread,
  useSessionOutcome,
  useCanMarkOutcomeUnread,
} = await import('./sessionCompletionStore');

beforeEach(() => {
  authenticatedFetch.mockReset();
  applyOutcomeSnapshot([]);
  releaseManualUnread();
});

afterEach(() => {
  releaseManualUnread();
});

describe('T-1340 — القراءة العالمية', () => {
  it('لا يطفئ question عند فتح المحادثة', () => {
    applyOutcomeSnapshot([{
      sessionId: 'question-session',
      outcome: 'question',
      outcomeAt: '2026-08-10T10:00:00.000Z',
    }]);
    const { result } = renderHook(() => useSessionOutcome('question-session'));

    act(() => acknowledgeOutcome('question-session'));

    expect(result.current).toBe('question');
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('لا يقر المحادثة المختارة والصفحة مخفية، ويقرها عند نشاطها', () => {
    authenticatedFetch.mockResolvedValue({ ok: true });
    applyOutcomeSnapshot([{
      sessionId: 'visibility-session',
      outcome: 'done',
      outcomeAt: '2026-08-10T10:00:10.000Z',
    }]);

    acknowledgeOutcomeWhenActive('visibility-session', false);
    expect(authenticatedFetch).not.toHaveBeenCalled();

    acknowledgeOutcomeWhenActive('visibility-session', true);
    acknowledgeOutcomeWhenActive('visibility-session', true);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['done', 'error'] as const)('يرسل ختم %s الذي شاهده وينتظر دلتا CAS', (outcome) => {
    authenticatedFetch.mockResolvedValue({ ok: true });
    const sessionId = `${outcome}-session`;
    const outcomeAt = `2026-08-10T10:00:0${outcome === 'done' ? '1' : '2'}.000Z`;
    applyOutcomeSnapshot([{ sessionId, outcome, outcomeAt }]);
    const { result } = renderHook(() => useSessionOutcome(sessionId));

    act(() => acknowledgeOutcome(sessionId));

    // لا نخفيه تفاؤلياً: قد يكون الختم قديماً ويرفضه الخادم.
    expect(result.current).toBe(outcome);
    expect(authenticatedFetch).toHaveBeenCalledWith(
      `/api/providers/sessions/${sessionId}/outcome-seen`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedOutcomeAt: outcomeAt }),
      },
    );

    act(() => applyOutcomeDelta(sessionId, null, null));
    expect(result.current).toBeNull();
  });

  it('يعيد «غير مقروء» الحكم الذي يبثه الخادم', async () => {
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ outcome: 'done', outcomeAt: '2026-08-10T10:00:03.000Z' }),
    });
    const { result } = renderHook(() => useSessionOutcome('shared-session'));

    let restored = false;
    await act(async () => {
      restored = await markOutcomeUnread('shared-session');
    });

    expect(restored).toBe(true);
    expect(result.current).toBe('done');
    expect(authenticatedFetch).toHaveBeenCalledWith(
      '/api/providers/sessions/shared-session/outcome-seen',
      { method: 'DELETE' },
    );
  });

  it('يبقي حارس غير مقروء إذا سبق بث WebSocket استجابة DELETE', async () => {
    let resolveBody!: (value: { outcome: 'done'; outcomeAt: string }) => void;
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: () => new Promise((resolve) => {
        resolveBody = resolve;
      }),
    });

    const pending = markOutcomeUnread('ws-first');
    await vi.waitFor(() => expect(resolveBody).toBeTypeOf('function'));

    act(() => applyOutcomeDelta('ws-first', 'done', '2026-08-10T10:00:05.000Z'));
    // The selected-session effect can run in this exact gap. It must not undo
    // the user's DELETE before the response establishes the durable guard.
    act(() => acknowledgeOutcome('ws-first'));
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    resolveBody({ outcome: 'done', outcomeAt: '2026-08-10T10:00:05.000Z' });
    await expect(pending).resolves.toBe(true);

    act(() => acknowledgeOutcome('ws-first'));
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it('لا يحمي نتيجة أحدث وصلت أثناء طلب غير مقروء ولا يستبدلها بالاستجابة القديمة', async () => {
    let resolveBody!: (value: { outcome: 'done'; outcomeAt: string }) => void;
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: () => new Promise((resolve) => {
        resolveBody = resolve;
      }),
    });

    const pending = markOutcomeUnread('newer-result');
    await vi.waitFor(() => expect(resolveBody).toBeTypeOf('function'));
    act(() => applyOutcomeDelta('newer-result', 'done', '2026-08-10T10:00:05.000Z'));
    act(() => applyOutcomeDelta('newer-result', 'error', '2026-08-10T10:00:06.000Z'));

    resolveBody({ outcome: 'done', outcomeAt: '2026-08-10T10:00:05.000Z' });
    await expect(pending).resolves.toBe(true);

    act(() => acknowledgeOutcome('newer-result'));
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      '/api/providers/sessions/newer-result/outcome-seen',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedOutcomeAt: '2026-08-10T10:00:06.000Z' }),
      },
    );
  });

  it('يسقط حارس النتيجة القديمة إذا وصلت نتيجة أحدث عبر لقطة إعادة الاتصال', async () => {
    authenticatedFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ outcome: 'done', outcomeAt: '2026-08-10T10:00:05.000Z' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          outcomes: [{
            sessionId: 'rest-newer-result',
            outcome: 'error',
            outcomeAt: '2026-08-10T10:00:06.000Z',
          }],
        }),
      })
      .mockResolvedValueOnce({ ok: true });

    await expect(markOutcomeUnread('rest-newer-result')).resolves.toBe(true);
    await expect(refreshOutcomes()).resolves.toBe(true);
    act(() => acknowledgeOutcome('rest-newer-result'));

    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      '/api/providers/sessions/rest-newer-result/outcome-seen',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedOutcomeAt: '2026-08-10T10:00:06.000Z' }),
      },
    );
  });

  it.each(['قبل البث', 'بعد البث'] as const)(
    'يبطل الطلب المعلّق عند المغادرة %s ولا يعيد الحارس باستجابة متأخرة',
    async (leaveTiming) => {
      let resolveFetch!: (response: {
        ok: boolean;
        json: () => Promise<{ outcome: 'done'; outcomeAt: string }>;
      }) => void;
      authenticatedFetch
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveFetch = resolve;
        }))
        .mockResolvedValue({ ok: true });

      const pending = markOutcomeUnread('left-session');
      await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'));
      if (leaveTiming === 'قبل البث') releaseManualUnread();
      act(() => applyOutcomeDelta('left-session', 'done', '2026-08-10T10:00:07.000Z'));
      if (leaveTiming === 'بعد البث') releaseManualUnread();

      resolveFetch({
        ok: true,
        json: async () => ({ outcome: 'done', outcomeAt: '2026-08-10T10:00:07.000Z' }),
      });
      await expect(pending).resolves.toBe(true);

      act(() => acknowledgeOutcome('left-session'));
      expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    },
  );

  it('لا يترك حارساً يعطّل الإقرار إذا فشل طلب غير مقروء', async () => {
    authenticatedFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    applyOutcomeSnapshot([{
      sessionId: 'failed-unread',
      outcome: 'done',
      outcomeAt: '2026-08-10T10:00:04.000Z',
    }]);
    const { result } = renderHook(() => useSessionOutcome('failed-unread'));

    await expect(markOutcomeUnread('failed-unread')).resolves.toBe(false);
    act(() => acknowledgeOutcome('failed-unread'));

    expect(result.current).toBe('done');
    expect(authenticatedFetch).toHaveBeenLastCalledWith(
      '/api/providers/sessions/failed-unread/outcome-seen',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedOutcomeAt: '2026-08-10T10:00:04.000Z' }),
      },
    );
  });
});

describe('T-1340 — ظهور فعل غير مقروء', () => {
  it('يقتصر على done/error المقروءين عالمياً', () => {
    expect(canMarkOutcomeUnread('done', true)).toBe(true);
    expect(canMarkOutcomeUnread('error', true)).toBe(true);
    expect(canMarkOutcomeUnread('question', true)).toBe(false);
    expect(canMarkOutcomeUnread('done', false)).toBe(false);
    expect(canMarkOutcomeUnread(null, true)).toBe(false);
  });

  it('يتجاوز outcomeSeen القديم فوراً عند دلتا WebSocket', () => {
    const { result } = renderHook(() => useCanMarkOutcomeUnread(
      'stale-sidebar-row',
      'done',
      false,
    ));
    expect(result.current).toBe(false);

    act(() => applyOutcomeDelta(
      'stale-sidebar-row',
      null,
      null,
      'seen',
    ));
    expect(result.current).toBe(true);

    act(() => applyOutcomeDelta(
      'stale-sidebar-row',
      'done',
      '2026-08-10T10:00:11.000Z',
    ));
    expect(result.current).toBe(false);
  });
});

describe('T-1340 — تسلسل REST وWebSocket', () => {
  it('لا تستبدل لقطة REST المؤجلة دلتا WebSocket أحدث', async () => {
    let resolveBody!: (value: unknown) => void;
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: () => new Promise((resolve) => {
        resolveBody = resolve;
      }),
    });
    const pending = refreshOutcomes();
    await vi.waitFor(() => expect(resolveBody).toBeTypeOf('function'));

    act(() => applyOutcomeDelta(
      'racing-session',
      'error',
      '2026-08-10T10:00:20.000Z',
    ));
    resolveBody({
      outcomes: [{
        sessionId: 'racing-session',
        outcome: 'done',
        outcomeAt: '2026-08-10T10:00:19.000Z',
      }],
    });
    await pending;

    const { result } = renderHook(() => useSessionOutcome('racing-session'));
    expect(result.current).toBe('error');
  });

  it('يعالج غياب الحكم من اللقطة كغياب لا كقراءة مفترضة', async () => {
    applyOutcomeSnapshot([{
      sessionId: 'snapshot-cleared',
      outcome: 'done',
      outcomeAt: '2026-08-10T10:00:30.000Z',
    }]);
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ outcomes: [] }),
    });
    await refreshOutcomes();

    const outcome = renderHook(() => useSessionOutcome('snapshot-cleared'));
    const canMark = renderHook(() => useCanMarkOutcomeUnread(
      'snapshot-cleared',
      'done',
      false,
    ));
    expect(outcome.result.current).toBeNull();
    expect(canMark.result.current).toBe(false);
  });
});
