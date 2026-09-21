/**
 * optimisticUserRowSurvivesRefresh.test.ts — B-516: الجلبُ من الخادم لا يمحو
 * رسالةً لم يستلمها الخادم.
 *
 * الخلل الذي تُثبّته
 * ------------------
 * ‏`refreshFromServer` كان ينهي كل جلب ناجح بـ`slot.realtimeMessages = []` بلا
 * شرط. والصفّ المتفائل لرسالة المستخدم يعيش هناك وحده بمعرّف `local_*`، ولا
 * يُطابَق بحمولة الخادم إلا ببصمة نصّية حرفية — وهي تفشل **مضموناً** مع الصور،
 * لأن الخادم يُذيّل النصّ بمسارات الصور قبل حفظه (`handleImages`).
 *
 * السلسلة المقيسة (‏2026-08-06T15:18:57): مات المقبس والبثّ جارٍ (‏1006) ⇒ قال
 * ‏`check-session-status` ‏`idle` ⇒ نزل `isLoading` ⇒ استُدعي `refreshFromServer`
 * ⇒ مُحيت رسالة المالك وصورتها من أمامه. لم يفشل إرسال ولم تضع بيانات — مُحي
 * العرض وحده.
 *
 * الاختبار يقود `refreshFromServer` الإنتاجية عبر الخُطّاف نفسه (لا نسخةً
 * مبسّطة منه)، ولا يُموَّه إلا `authenticatedFetch` — أي الشبكة وحدها.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

import { useSessionStore, retainUnsyncedOptimisticRows } from './useSessionStore';
import type { NormalizedMessage } from './useSessionStore';

const SID = 'b516-session-0001';

/** الصفّ المتفائل كما يبنيه `chatMessageToNormalized` في مسار الإرسال. */
function localUserRow(content: string, id = 'local_1785852158337_ab12cd'): NormalizedMessage {
  return {
    id,
    sessionId: SID,
    timestamp: '2026-08-06T15:18:40.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content,
  };
}

/** صفّ الخادم كما يعود من سجلّ المحادثة (النصّ محفوظ كما سُلِّم للنموذج). */
function serverUserRow(content: string, id = 'srv-1'): NormalizedMessage {
  return {
    id,
    sessionId: SID,
    timestamp: '2026-08-06T15:18:41.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content,
  };
}

/** التذييل الحرفي الذي يضيفه الخادم لكل رسالة فيها صورة (claude-sdk.js). */
const IMAGE_NOTE =
  '\n\n[Images provided at the following paths:]\n'
  + '1. /workspace/chat-images/'
  + '0123456789abcdef0123456789abcdef/image_0.png';

function respondWith(messages: NormalizedMessage[], responseTurnDurationTotalMs: number | null = null) {
  authenticatedFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ messages, total: messages.length, hasMore: false, responseTurnDurationTotalMs }),
  });
}

beforeEach(() => {
  authenticatedFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('B-516 — refreshFromServer لا يمحو ما لم يستلمه الخادم', () => {
  it('يُبقي رسالة المستخدم حين تغيب عن حمولة الخادم (الحادثة: نصّ + صورة)', async () => {
    const { result } = renderHook(() => useSessionStore());
    const pending = localUserRow('راجع هذه اللقطة من فضلك');

    await act(async () => {
      result.current.appendRealtime(SID, pending);
    });

    // الخادم لم يُرجِع الرسالة (السجل لم يُقرأ بعد / الجولة ماتت قبل الكتابة).
    respondWith([serverUserRow('رسالة أقدم تماماً', 'srv-old')]);
    await act(async () => {
      await result.current.refreshFromServer(SID);
    });

    const shown = result.current.getMessages(SID);
    expect(shown.map((m) => m.id)).toContain(pending.id);
    expect(shown.find((m) => m.id === pending.id)?.content).toBe('راجع هذه اللقطة من فضلك');
  });

  it('يحذف الصفّ المتفائل حالما يظهر نظيره — ولو ذيّله الخادم بمسارات الصور', async () => {
    const { result } = renderHook(() => useSessionStore());
    const pending = localUserRow('راجع هذه اللقطة من فضلك');

    await act(async () => {
      result.current.appendRealtime(SID, pending);
    });

    // نفس النصّ، مذيّلاً بما يضيفه الخادم للصور: مطابقةٌ حرفية تفشل هنا حتماً.
    respondWith([{ ...serverUserRow(`راجع هذه اللقطة من فضلك${IMAGE_NOTE}`, 'srv-twin'), clientMsgId: pending.id }]);
    await act(async () => {
      await result.current.refreshFromServer(SID);
    });

    const shown = result.current.getMessages(SID);
    expect(shown.map((m) => m.id)).toEqual(['srv-twin']);
    expect(result.current.getSlot(SID).realtimeMessages).toHaveLength(0);
  });

  it('يحفظ رد المساعد حين لا يثبت سجل الخادم وصوله', async () => {
    const { result } = renderHook(() => useSessionStore());
    const assistantEcho: NormalizedMessage = {
      id: 'local_9_assistant',
      sessionId: SID,
      timestamp: '2026-08-06T15:18:45.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'تمام، سأبدأ',
    };

    await act(async () => {
      result.current.appendRealtime(SID, assistantEcho);
    });

    respondWith([serverUserRow('رسالة أقدم تماماً', 'srv-old')]);
    await act(async () => {
      await result.current.refreshFromServer(SID);
    });

    expect(result.current.getSlot(SID).realtimeMessages).toEqual([assistantEcho]);
  });
});

describe('B-741 — mergeTailFromServer يستبدل الصف المطابق بالنسخة الموثقة', () => {
  it('يحدّث توقيت الرد المحفوظ بدلاً من إسقاطه عند تطابق المعرّف', async () => {
    const { result } = renderHook(() => useSessionStore());
    const assistant: NormalizedMessage = {
      id: 'durable-assistant-1',
      sessionId: SID,
      timestamp: '2026-08-19T01:00:00.000Z',
      provider: 'codex',
      kind: 'text',
      role: 'assistant',
      content: 'رد محفوظ',
    };

    respondWith([assistant]);
    await act(async () => {
      await result.current.fetchFromServer(SID);
    });

    const stamped: NormalizedMessage = {
      ...assistant,
      responseTurnMetric: {
        durationMs: 60_000,
        startedAt: '2026-08-19T00:59:00.000Z',
        completedAt: '2026-08-19T01:00:00.000Z',
      },
    };
    respondWith([stamped], 180_000);
    await act(async () => {
      await result.current.mergeTailFromServer(SID);
    });

    expect(result.current.getMessages(SID).find((message) => message.id === assistant.id))
      .toMatchObject({ responseTurnMetric: stamped.responseTurnMetric });
    expect(result.current.getSlot(SID).responseTurnDurationTotalMs).toBe(180_000);
  });

  it('يحدّث الإجمالي الكامل حتى حين تكون صفحة reconnect فارغة', async () => {
    const { result } = renderHook(() => useSessionStore());
    result.current.setActiveSession(SID);

    respondWith([], 0);
    await act(async () => {
      await result.current.mergeTailFromServer(SID);
    });

    expect(result.current.getSlot(SID).responseTurnDurationTotalMs).toBe(0);
  });

  it('يمسح إجمالياً قديماً إلى null عند refresh ناجح بلا قياس', async () => {
    const { result } = renderHook(() => useSessionStore());
    result.current.setActiveSession(SID);

    respondWith([], 12_000);
    await act(async () => {
      await result.current.fetchFromServer(SID);
    });
    expect(result.current.getSlot(SID).responseTurnDurationTotalMs).toBe(12_000);

    respondWith([], null);
    await act(async () => {
      await result.current.refreshFromServer(SID);
    });
    expect(result.current.getSlot(SID).responseTurnDurationTotalMs).toBeNull();
  });

  it('يأخذ الإجمالي الكامل من كل صفحة ولا يجمع الصفحة محلياً', async () => {
    const { result } = renderHook(() => useSessionStore());
    result.current.setActiveSession(SID);
    const newest = serverUserRow('الأحدث', 'newest');
    const older = serverUserRow('الأقدم', 'older');

    authenticatedFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        messages: [newest], total: 2, hasMore: true, responseTurnDurationTotalMs: 90_000,
      }),
    });
    await act(async () => {
      await result.current.fetchFromServer(SID, { limit: 1 });
    });
    expect(result.current.getSlot(SID).responseTurnDurationTotalMs).toBe(90_000);

    authenticatedFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        messages: [older], total: 2, hasMore: false, responseTurnDurationTotalMs: 90_000,
      }),
    });
    await act(async () => {
      await result.current.fetchMore(SID, { limit: 1 });
    });
    expect(result.current.getSlot(SID).responseTurnDurationTotalMs).toBe(90_000);
  });
});

describe('B-516 — حدود المطابقة (المخرج من البقاء)', () => {
  const local = localUserRow('راجع هذه اللقطة');

  it('تُطابق الهوية الصريحة ولو تغير النص بتذييل الصور أو الملفات', () => {
    for (const suffix of [
      IMAGE_NOTE,
      '\n\n[Files provided at the following paths:]\n1. .nassaj-uploads/inbox/a.pdf',
      '\n\nultrathink ultrawork',
    ]) {
      expect(
        retainUnsyncedOptimisticRows([local], [{ ...serverUserRow(`راجع هذه اللقطة${suffix}`), clientMsgId: local.id }]),
      ).toEqual([]);
    }
  });

  it('لا تُطابِق رسالةً أخرى تبدأ بالنصّ نفسه ثم تُكمل في السطر ذاته', () => {
    const other = serverUserRow('راجع هذه اللقطة الثانية أيضاً');
    expect(retainUnsyncedOptimisticRows([local], [other])).toEqual([local]);
  });

  it('يحفظ صف الصورة بلا نص إلى أن تثبت هويته في السجل', () => {
    const imageOnly = localUserRow('', 'local_2_imageonly');
    expect(retainUnsyncedOptimisticRows([imageOnly], [])).toEqual([imageOnly]);
  });
});
