/**
 * تسرّب نصّ البثّ بين محادثتين تعملان معاً.
 *
 * `accumulatedStreamRef` كان **سلسلة واحدة للتطبيق كله**: كل `stream_delta`
 * يُضاف إليها أياً كانت جلسته، ثم تُكتب كاملةً في صفّ بثّ الجلسة صاحبة آخر
 * دفعة. فمتى عملت محادثتان معاً — وهو الشائع هنا — ظهر نصّ إحداهما داخل
 * الأخرى، و`stream_end` لإحداهما يمسح المخزن فيبتر بثّ الأخرى. والعرض لا
 * يتعافى إلا بتحديث الصفحة لأن سجلّ الخادم سليم أصلاً.
 *
 * هذا الحارس يقود الخطّاف بدفعات متشابكة من جلستين ويطالب بأن يكون ما كُتب
 * لكل جلسة نصَّها هي وحده.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, it, vi } from 'vitest';

vi.mock('../../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ refreshProjects: () => Promise.resolve() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { resetSessionActivityEpochs } from './sessionActivity';
import {
  persistedTurnFromControlEvent,
  useChatRealtimeHandlers,
  type StreamBuffer,
} from './useChatRealtimeHandlers';

const VIEWED = 'sess-viewed';
const OTHER = 'sess-other';

type Written = { sessionId: string; text: string; responseToMessageId?: string };

function harness() {
  const written: Written[] = [];
  const attributions: Array<{ sessionId: string; attribution: any }> = [];
  const finalized: string[] = [];
  const sessionStore = {
    recordSeq: () => {},
    appendRealtime: () => {},
    updateStreaming: (
      sessionId: string,
      text: string,
      _provider: string,
      _attribution: unknown,
      responseToMessageId?: string,
    ) => {
      written.push({ sessionId, text, responseToMessageId });
      attributions.push({ sessionId, attribution: _attribution });
    },
    finalizeStreaming: (sessionId: string) => finalized.push(sessionId),
    replaceSessionId: () => {},
  } as any;

  const streamTimerRef = { current: null as number | null };
  const accumulatedStreamRef = { current: new Map<string, StreamBuffer>() };

  const props = {
    controlFrames: new Map() as any,
    provider: 'claude' as const,
    selectedSession: { id: VIEWED } as any,
    currentSessionId: VIEWED,
    setCurrentSessionId: () => {},
    setIsLoading: () => {},
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setTokenBudget: () => {},
    setPendingPermissionRequests: () => {},
    pendingViewSessionRef: { current: null } as any,
    streamTimerRef: streamTimerRef as any,
    accumulatedStreamRef: accumulatedStreamRef as any,
    sessionStore,
  };

  const { rerender } = renderHook(
    (latestMessage: any) => useChatRealtimeHandlers({ ...props, latestMessage }),
    { initialProps: null as any },
  );

  return {
    written,
    attributions,
    finalized,
    delta: (sessionId: string, content: string, clientMsgId?: string) =>
      rerender({ kind: 'stream_delta', sessionId, content, clientMsgId }),
    activity: (message: any) => rerender(message),
    end: (sessionId: string) => rerender({ kind: 'stream_end', sessionId }),
  };
}

beforeEach(() => {
  resetSessionActivityEpochs();
  vi.useFakeTimers();
});

describe('مخزن البثّ لكل جلسة على حدة', () => {
  it('يحفظ النموذج الموثق مع دفعات الدور نفسه ولا يخلطه بجلسة أخرى', () => {
    const h = harness();
    h.activity({ kind: 'stream_delta', sessionId: VIEWED, content: 'أ', responseToMessageId: 'one', model: 'gpt-6-astra' });
    h.activity({ kind: 'stream_delta', sessionId: OTHER, content: 'ب', responseToMessageId: 'two', model: 'claude-opus-5' });
    h.activity({ kind: 'stream_delta', sessionId: VIEWED, content: 'ج' });
    vi.runOnlyPendingTimers();
    assert.equal(h.attributions.find(row => row.sessionId === VIEWED)?.attribution.model, 'gpt-6-astra');
    assert.equal(h.attributions.find(row => row.sessionId === OTHER)?.attribution.model, 'claude-opus-5');
  });
  it('يرفع lastSeq من مسار streamFrames فلا يُعاد الإطار القديم بعد reconnect', () => {
    let lastSeq = 0;
    const written: Written[] = [];
    const recordSeq = vi.fn((_sessionId: string, sequence: unknown) => {
      if (typeof sequence === 'number' && Number.isFinite(sequence)) {
        lastSeq = Math.max(lastSeq, sequence);
      }
    });
    const sessionStore = {
      recordSeq,
      appendRealtime: () => {},
      updateStreaming: (sessionId: string, text: string) => written.push({ sessionId, text }),
      finalizeStreaming: () => {},
    } as any;
    const base = {
      controlFrames: new Map() as any,
      provider: 'claude' as const,
      selectedSession: { id: VIEWED } as any,
      currentSessionId: VIEWED,
      setCurrentSessionId: () => {}, setIsLoading: () => {}, setCanAbortSession: () => {},
      setClaudeStatus: () => {}, setTokenBudget: () => {}, setPendingPermissionRequests: () => {},
      pendingViewSessionRef: { current: null } as any,
      streamTimerRef: { current: null } as any,
      accumulatedStreamRef: { current: new Map() } as any,
      sessionStore,
    };
    const delivered = new Map([[VIEWED, {
      seq: 1,
      text: 'الجزء الحي',
      ended: false,
      frame: {
        kind: 'stream_delta', sessionId: VIEWED, content: 'الجزء الحي', sequence: 41,
      },
    }]]);
    const { rerender } = renderHook(
      (input: any) => useChatRealtimeHandlers({ ...base, ...input }),
      { initialProps: { latestMessage: null, streamFrames: new Map() } as any },
    );

    rerender({
      latestMessage: delivered.get(VIEWED)!.frame,
      streamFrames: delivered,
    });

    assert.equal(lastSeq, 41, 'هذه القيمة هي التي يرسلها reconnect لمنع replay');
    assert.deepEqual(recordSeq.mock.calls, [[VIEWED, 41]]);
    assert.deepEqual(written, [{ sessionId: VIEWED, text: 'الجزء الحي' }]);

    // React may rerender the same cumulative snapshot while reconnecting. Its
    // local seq is already consumed, so neither text nor replay floor repeats.
    rerender({
      latestMessage: delivered.get(VIEWED)!.frame,
      streamFrames: new Map(delivered),
    });
    assert.equal(recordSeq.mock.calls.length, 1);
    assert.equal(written.length, 1);
  });

  it('يعالج لقطة نصّ مساعد غير فارغة منذ أول mount بلا انتظار إطار تالٍ', () => {
    const appended: any[] = [];
    const sessionStore = {
      recordSeq: () => {}, updateStreaming: () => {}, finalizeStreaming: () => {},
      appendRealtime: (_sessionId: string, message: any) => appended.push(message),
    } as any;
    const streamFrames = new Map([[VIEWED, {
      seq: 7,
      text: 'النص الموجود قبل تركيب الشاشة',
      ended: true,
      frame: {
        id: 'assistant-existing', kind: 'text', role: 'assistant', sessionId: VIEWED,
        content: 'النص الموجود قبل تركيب الشاشة', provider: 'codex',
      },
    }]]);

    renderHook(() => useChatRealtimeHandlers({
      latestMessage: { kind: 'complete', sessionId: VIEWED },
      streamFrames,
      controlFrames: new Map() as any,
      provider: 'codex' as const,
      selectedSession: { id: VIEWED } as any,
      currentSessionId: VIEWED,
      setCurrentSessionId: () => {}, setIsLoading: () => {}, setCanAbortSession: () => {},
      setClaudeStatus: () => {}, setTokenBudget: () => {}, setPendingPermissionRequests: () => {},
      pendingViewSessionRef: { current: null } as any,
      streamTimerRef: { current: null } as any,
      accumulatedStreamRef: { current: new Map() } as any,
      sessionStore,
    }));

    assert.equal(appended.length, 1);
    assert.equal(appended[0].id, 'assistant-existing');
  });

  it('يستهلك لقطة WebSocket المجمعة كاملةً حتى لو كانت latestMessage هي النهاية فقط', () => {
    const written: Written[] = [];
    const finalized: string[] = [];
    const sessionStore = {
      recordSeq: () => {},
      appendRealtime: () => {},
      updateStreaming: (sessionId: string, text: string) => written.push({ sessionId, text }),
      finalizeStreaming: (sessionId: string) => finalized.push(sessionId),
    } as any;
    const base = {
      controlFrames: new Map() as any,
      provider: 'claude' as const,
      selectedSession: { id: VIEWED } as any,
      currentSessionId: VIEWED,
      setCurrentSessionId: () => {}, setIsLoading: () => {}, setCanAbortSession: () => {},
      setClaudeStatus: () => {}, setTokenBudget: () => {}, setPendingPermissionRequests: () => {},
      pendingViewSessionRef: { current: null } as any,
      streamTimerRef: { current: null } as any,
      accumulatedStreamRef: { current: new Map() } as any,
      sessionStore,
    };
    const { rerender } = renderHook(
      (input: any) => useChatRealtimeHandlers({ ...base, ...input }),
      { initialProps: { latestMessage: null, streamFrames: new Map() } as any },
    );

    rerender({
      latestMessage: { kind: 'stream_end', sessionId: VIEWED },
      streamFrames: new Map([[VIEWED, {
        seq: 3,
        text: 'الرد الكامل',
        ended: true,
        frame: { kind: 'stream_end', sessionId: VIEWED, provider: 'claude' },
      }]]),
    });

    assert.deepEqual(written, [{ sessionId: VIEWED, text: 'الرد الكامل' }]);
    assert.deepEqual(finalized, [VIEWED]);
  });

  it('دفعات متشابكة من جلستين ⇒ لا يظهر نصّ إحداهما في الأخرى', () => {
    const h = harness();

    h.delta(VIEWED, 'أهلاً ');
    h.delta(OTHER, 'نصّ المحادثة الأخرى');
    h.delta(VIEWED, 'بك');

    vi.advanceTimersByTime(150);

    const viewed = h.written.filter((w) => w.sessionId === VIEWED);
    const other = h.written.filter((w) => w.sessionId === OTHER);

    assert.ok(viewed.length > 0, 'لم يُكتب شيء للجلسة المعروضة');
    for (const w of viewed) {
      assert.equal(
        w.text.includes('نصّ المحادثة الأخرى'),
        false,
        `تسرّب نصّ الجلسة الأخرى إلى المعروضة: ${w.text}`,
      );
    }
    assert.equal(viewed.at(-1)!.text, 'أهلاً بك');
    assert.equal(other.at(-1)!.text, 'نصّ المحادثة الأخرى');
  });

  it('انتهاء بثّ إحداهما لا يبتر بثّ الأخرى', () => {
    const h = harness();

    h.delta(VIEWED, 'الجزء الأول ');
    h.delta(OTHER, 'انتهت');
    h.end(OTHER);

    // بعد stream_end للأخرى: بقيّة المعروضة يجب أن تُكمل نصّها هي.
    h.delta(VIEWED, 'والثاني');
    vi.advanceTimersByTime(150);

    const viewed = h.written.filter((w) => w.sessionId === VIEWED);
    assert.equal(viewed.at(-1)!.text, 'الجزء الأول والثاني');
    assert.deepEqual(h.finalized, [OTHER]);
  });

  it('يحمل هوية الجولة فقط ولا ينشئ توقيتاً محلياً', () => {
    const h = harness();

    h.delta(VIEWED, 'النص النهائي', 'turn-a');
    vi.advanceTimersByTime(150);

    const response = h.written.at(-1)!;
    assert.equal(response.responseToMessageId, 'turn-a');
    assert.equal('responseStartedAt' in response, false);
  });
});

describe('قياس complete الدائم', () => {
  const saved = {
    kind: 'complete',
    responseToMessageId: 'turn-a',
    transcriptMessageId: 'msg-durable-a',
    responseTurnMetric: {
      durationMs: 0,
      startedAt: '2026-08-25T10:00:00.000Z',
      completedAt: '2026-08-25T10:00:00.000Z',
    },
    responseTurnDurationTotalMs: 0,
  };

  it('يقبل الصفر المحفوظ مع إجمالي الخادم', () => {
    assert.deepEqual(persistedTurnFromControlEvent(saved as any), {
      responseToMessageId: 'turn-a',
      responseTurnMetric: saved.responseTurnMetric,
      responseTurnDurationTotalMs: 0,
      transcriptMessageId: 'msg-durable-a',
    });
  });

  it('يرفض توقيتاً حياً غير محفوظ أو دوراً ملغى', () => {
    assert.equal(persistedTurnFromControlEvent({
      kind: 'complete',
      responseToMessageId: 'turn-a',
      turnStartedAt: saved.responseTurnMetric.startedAt,
      turnCompletedAt: saved.responseTurnMetric.completedAt,
    } as any), null);
    assert.equal(persistedTurnFromControlEvent({ ...saved, aborted: true } as any), null);
  });
});
