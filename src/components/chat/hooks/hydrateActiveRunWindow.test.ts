/**
 * B-208 (بند 7 + حرج 1) — توسيع نافذة الجلب عبر **مسار الإنتاج** في
 * `useChatSessionState`، لا عبر شرائح يدوية.
 *
 * ما يحرسه هذا الملف تحديداً:
 *
 *  1. **قياس الطفرة**: الحدّ `ACTIVE_RUN_HYDRATION_LIMIT` ليس رقماً حرّاً —
 *     الاختبار يمرّر النافذة التي طلبها الكود فعلاً عبر مُحوِّل الإنتاج
 *     (`normalizedToChatMessages` + `useRunProgress`) ويطالب بظهور وكلاء
 *     الجلسة الحقيقية. خفض الحدّ إلى 20 يُسقط هذا الاختبار (النافذة تعود
 *     `agents: []`) بدل أن يمرّ صامتاً.
 *
 *  2. **حرج 1 (سباق الـWS)**: التوسيع كان مشروطاً بنجاح لقطة REST، بينما إطار
 *     `session-status` الأسرع يرفع الـepoch فيُصيّر اللقطة `'stale'` ⇒ لا توسيع
 *     ⇒ العَرَض الأصلي بعينه. هنا **تفشل اللقطة عمداً** (`unknown`) ويأتي
 *     النشاط من مصدر آخر (مزامنة `processingSessions`)، والتوسيع يجب أن يقع.
 *
 *  3. حارس «مرّة واحدة»: لا طلبات توسيع متكرّرة (لا polling).
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, vi } from 'vitest';

// اللقطة والنقطة الخادمية: كلتاهما تمرّان عبر authenticatedFetch. نُفشلهما
// عمداً (النقطة غير منشورة بعد) لإثبات أن التوسيع لا يعتمد عليهما.
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
}));

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import fixture from './__fixtures__/run-window.42034af0.json';
import { normalizedToChatMessages } from './useChatMessages';
import { useChatSessionState } from './useChatSessionState';
import { useRunProgress } from './useRunProgress';

const FULL_TRANSCRIPT = fixture as unknown as NormalizedMessage[];
const SESSION_ID = '42034af0-5a53-4b10-8ebf-82b028fc8933';
const PROJECT = {
  projectId: 'proj-1',
  fullPath: '/home/dev/workspace/nassaj',
  path: '/home/dev/workspace/nassaj',
} as any;
const SESSION = { id: SESSION_ID, __provider: 'claude' } as any;

/** عدد صفوف الوكلاء المشتقّ من الجلسة الحقيقية (انظر runWindowAgents.integration). */
const REAL_AGENT_COUNT = 9;

type FetchCall = { limit: number | null | undefined; offset: number | undefined };

/**
 * مخزن مزيّف يحاكي عقد `useSessionStore` **وعقد الخادم**: `offset=0&limit=N`
 * يعيد آخر N صفاً (تقطيع الذيل، كما في claude-sessions.provider).
 */
function makeStore(calls: FetchCall[]) {
  let served: NormalizedMessage[] = [];
  const slot: any = {
    serverMessages: [],
    realtimeMessages: [],
    total: FULL_TRANSCRIPT.length,
    hasMore: true,
    status: 'idle',
    fetchedAt: Date.now(),
    offset: 0,
  };
  const stableEmpty: NormalizedMessage[] = [];

  return {
    servedWindow: () => served,
    store: {
      setActiveSession: () => {},
      getMessages: () => stableEmpty,
      appendRealtime: () => {},
      clearRealtime: () => {},
      recordSeq: () => {},
      getLastSeq: () => 0,
      has: () => true,
      isStale: () => false,
      getSlot: () => slot,
      replaceSessionId: () => {},
      refreshFromServer: async () => {},
      mergeTailFromServer: async () => true,
      fetchMore: async () => slot,
      fetchFromServer: async (_id: string, opts: any) => {
        calls.push({ limit: opts?.limit, offset: opts?.offset });
        const limit = opts?.limit;
        served = typeof limit === 'number' ? FULL_TRANSCRIPT.slice(-limit) : FULL_TRANSCRIPT;
        slot.serverMessages = served;
        slot.hasMore = typeof limit === 'number' && limit < FULL_TRANSCRIPT.length;
        slot.total = FULL_TRANSCRIPT.length;
        slot.status = 'idle';
        return slot;
      },
    } as any,
  };
}

function mount(sessionStore: any, processingSessions?: Set<string>) {
  return renderHook(() =>
    useChatSessionState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      ws: null,
      sendMessage: () => {},
      processingSessions,
      resetStreamingState: () => {},
      pendingViewSessionRef: { current: null } as any,
      sessionStore,
    }),
  );
}

/** يُمرّر نافذةً عبر مسار العرض الحقيقي ويُعيد عدد الوكلاء الظاهرين. */
function agentsFor(window: NormalizedMessage[]): number {
  const chatMessages = normalizedToChatMessages(window);
  const { result } = renderHook(() => useRunProgress(chatMessages, true));
  return result.current.agents.length;
}

beforeEach(() => {
  localStorage.setItem('selected-provider', 'claude');
});

describe('توسيع النافذة عند ثبوت النشاط', () => {
  it('حرج 1: النشاط من مصدر غير اللقطة (اللقطة فشلت) ⇒ التوسيع يقع رغم ذلك', async () => {
    const calls: FetchCall[] = [];
    const { store, servedWindow } = makeStore(calls);

    // `processingSessions` = مصدر نشاط مستقلّ عن REST (كما يفعل إطار
    // `session-status` الفائز بالسباق). اللقطة نفسها ستعود 'unknown' (404).
    mount(store, new Set([SESSION_ID]));

    await waitFor(() => {
      assert.ok(
        calls.some((c) => typeof c.limit === 'number' && c.limit > 20),
        `لم يقع أي توسيع للنافذة. الطلبات: ${JSON.stringify(calls)}`,
      );
    });

    // الجوهر: النافذة التي طُلبت فعلاً تُظهر وكلاء الجلسة الحقيقية.
    assert.equal(
      agentsFor(servedWindow()),
      REAL_AGENT_COUNT,
      'النافذة المطلوبة لا تُظهر وكلاء الجلسة — الحدّ أصغر مما تتطلبه بيانات الإنتاج',
    );
  });

  it('قياس الطفرة: النافذة الافتتاحية (20) لا تُظهر شيئاً — الفرق ليس مصادفة', () => {
    assert.equal(agentsFor(FULL_TRANSCRIPT.slice(-20)), 0);
    assert.equal(agentsFor(FULL_TRANSCRIPT), REAL_AGENT_COUNT);
  });

  it('الحدّ المطلوب يتجاوز مسافة آخر مطالبة بشرية عن الذيل (شرط (ب))', async () => {
    const calls: FetchCall[] = [];
    const { store } = makeStore(calls);
    mount(store, new Set([SESSION_ID]));

    await waitFor(() => {
      assert.ok(calls.some((c) => typeof c.limit === 'number' && c.limit > 20));
    });

    const widenedLimit = Math.max(
      ...calls.map((c) => (typeof c.limit === 'number' ? c.limit : 0)),
    );

    // المسافة مشتقّة من بيانات الإنتاج وقت التشغيل، لا رقم مكتوب يدوياً.
    const boundaryIndex = FULL_TRANSCRIPT.reduce(
      (last, m: any, i) => (m.kind === 'text' && m.role === 'user' && !m.originKind ? i : last),
      -1,
    );
    assert.ok(boundaryIndex >= 0, 'الـfixture بلا مطالبة بشرية — لا يختبر الشرط (ب)');
    const requiredRows = FULL_TRANSCRIPT.length - boundaryIndex;

    assert.ok(
      widenedLimit >= requiredRows,
      `الحدّ ${widenedLimit} لا يبلغ حدّ الجولة (يلزم ${requiredRows} صفاً على الأقل)`,
    );
  });

  it('حارس «مرّة واحدة»: لا توسيع متكرّر (لا polling)', async () => {
    const calls: FetchCall[] = [];
    const { store } = makeStore(calls);
    const { rerender } = mount(store, new Set([SESSION_ID]));

    await waitFor(() => {
      assert.ok(calls.some((c) => typeof c.limit === 'number' && c.limit > 20));
    });

    rerender();
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const widenCalls = calls.filter((c) => typeof c.limit === 'number' && c.limit > 20);
    assert.equal(widenCalls.length, 1, `توسيع متكرّر: ${widenCalls.length} طلبات`);
  });

  it('جلسة خاملة: لا توسيع إطلاقاً (لا تحميل زائد على كل فتح)', async () => {
    const calls: FetchCall[] = [];
    const { store } = makeStore(calls);
    mount(store); // بلا processingSessions واللقطة تفشل ⇒ لا نشاط مثبت

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      calls.filter((c) => typeof c.limit === 'number' && c.limit > 20).length,
      0,
    );
  });
});
