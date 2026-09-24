/**
 * فجوة بثّ تصل بينما توسيع النافذة النشِط (`light400`،
 * `ACTIVE_RUN_HYDRATION_LIMIT` في `useChatSessionState`) قيد التنفيذ.
 *
 * المطلوب (مراجعة qa-critic، بند 2): `requestStreamGapRecovery` يستدعي
 * `queueHistoryWork('light400')` نفسه — طابور مُجمِّع واحد بحدّ ثابت واحد
 * (400)، لا نافذتين متنافستين. فجوة تصل أثناء الطلب الأوسع الجاري:
 *  - لا تُلغي الطلب الجاري (single-flight: يُعاد استخدامه، لا يُستبدَل).
 *  - لا يظهر أي طلب بنافذة 20 (لا تراجع عن التوسيع).
 *  - النافذة النهائية المطبَّقة تبقى الأوسع (400)، لا الافتتاحية (20).
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, vi } from 'vitest';

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
}));

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { publishServerCapabilities } from '../../../stores/serverCapabilitiesStore';

import { SYNTHETIC_RUN_WINDOW } from './__fixtures__/run-window.synthetic';
import { useChatSessionState } from './useChatSessionState';

const FULL_TRANSCRIPT = SYNTHETIC_RUN_WINDOW;
const SESSION_ID = 'ses_synthetic_run_window';
const PROJECT = {
  projectId: 'proj-1',
  fullPath: '/workspace/sample-project',
  path: '/workspace/sample-project',
} as any;
const SESSION = { id: SESSION_ID, __provider: 'claude' } as any;

type FetchCall = { limit: number | null | undefined; offset: number | undefined; payload?: string };

/** كـ`makeStore` في `hydrateActiveRunWindow.test.ts`، مع تحكّم بتوقيت الاستجابة. */
function makeStore(calls: FetchCall[]) {
  let served: NormalizedMessage[] = [];
  const pendingResolvers: Array<() => void> = [];
  const slot: any = {
    serverMessages: [],
    realtimeMessages: [],
    total: FULL_TRANSCRIPT.length,
    hasMore: true,
    status: 'idle',
    fetchedAt: Date.now(),
    offset: 0,
    historyRevision: 'rev-a',
  };
  const stableEmpty: NormalizedMessage[] = [];

  return {
    releaseNextRequest: () => pendingResolvers.shift()?.(),
    pendingCount: () => pendingResolvers.length,
    store: {
      setActiveSession: () => {},
      getMessages: () => stableEmpty,
      getSessionSlot: () => slot,
      appendRealtime: () => {},
      clearRealtime: () => {},
      recordSeq: () => {},
      getLastSeq: () => 0,
      has: () => true,
      isStale: () => false,
      getSlot: () => slot,
      beginHistoryRequest: () => { slot.historyGeneration = (slot.historyGeneration ?? 0) + 1; return slot.historyGeneration; },
      isHistoryRequestCurrent: (_id: string, generation: number) => slot.historyGeneration === generation,
      replaceSessionId: () => {},
      refreshFromServer: async () => {},
      mergeTailFromServer: async () => true,
      fetchMore: async () => ({ ok: true, slot }),
      setStatus: () => {},
      // Only the widened `light400` request is held pending on purpose — this
      // is what lets a "gap arrives mid-flight" scenario be reproduced
      // deterministically. The initial (limit 20) load resolves immediately,
      // exactly like the real server would for the opening page.
      requestHistorySnapshot: (_id: string, opts: any) => {
        calls.push({ limit: opts?.limit, offset: opts?.offset, payload: opts?.payload });
        const buildResult = () => {
          const limit = opts?.limit;
          served = typeof limit === 'number' ? FULL_TRANSCRIPT.slice(-limit) : FULL_TRANSCRIPT;
          return {
            ok: true,
            snapshot: {
              messages: served,
              total: FULL_TRANSCRIPT.length,
              hasMore: typeof limit === 'number' && limit < FULL_TRANSCRIPT.length,
              nextCursor: null,
              tokenUsage: null,
              responseTurnDurationTotalMs: null,
              historySchema: opts?.payload === 'light' ? 1 : null,
              payloadMode: opts?.payload === 'light' ? 'light' : 'full',
              revision: opts?.payload === 'light' ? 'rev-a' : null,
            },
          };
        };
        const isWidenRequest = opts?.payload === 'light' && typeof opts?.limit === 'number' && opts.limit > 20;
        if (!isWidenRequest) return Promise.resolve(buildResult());
        return new Promise((resolve) => { pendingResolvers.push(() => resolve(buildResult())); });
      },
      applyHistorySnapshot: (_id: string, snapshot: any) => {
        slot.serverMessages = snapshot.messages;
        slot.hasMore = snapshot.hasMore;
        slot.total = snapshot.total;
        slot.historyRevision = snapshot.revision;
        return slot;
      },
      applyLightHistoryExpansion: (_id: string, snapshot: any) => {
        slot.serverMessages = snapshot.messages;
        slot.hasMore = snapshot.hasMore;
        slot.total = snapshot.total;
        return slot;
      },
      applyHistoryEnrichment: () => slot,
      fetchFromServer: async (_id: string, opts: any) => {
        calls.push({ limit: opts?.limit, offset: opts?.offset });
        const limit = opts?.limit;
        served = typeof limit === 'number' ? FULL_TRANSCRIPT.slice(-limit) : FULL_TRANSCRIPT;
        slot.serverMessages = served;
        slot.hasMore = typeof limit === 'number' && limit < FULL_TRANSCRIPT.length;
        slot.total = FULL_TRANSCRIPT.length;
        slot.status = 'idle';
        return { ok: true, slot };
      },
    } as any,
    slot,
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

beforeEach(() => {
  localStorage.setItem('selected-provider', 'claude');
  publishServerCapabilities({
    capabilities: { lightHistory: { supported: true, enabled: true, schema: 1 } },
  });
});

describe('فجوة بثّ أثناء طلب النافذة الموسَّعة الجاري', () => {
  it('لا تُلغي الطلب الأوسع ولا تُنتج طلباً بنافذة 20', async () => {
    const calls: FetchCall[] = [];
    const { store, releaseNextRequest, pendingCount } = makeStore(calls);
    const { result } = mount(store, new Set([SESSION_ID]));

    // ينتظر بدء الطلب الموسَّع الأول (light400) قبل أن يبقى معلَّقاً عمداً.
    await waitFor(() => assert.ok(calls.some((c) => typeof c.limit === 'number' && c.limit > 20)));
    assert.equal(pendingCount(), 1, 'الطلب الموسَّع يجب أن يبقى معلَّقاً حتى نُحرِّره');

    // فجوة بثّ تصل الآن للجلسة المعروضة نفسها، أثناء الطلب الجاري.
    const callsBeforeGap = calls.length;
    result.current.requestStreamGapRecovery(SESSION_ID);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // لا طلب جديد بنافذة 20 نتيجة الفجوة (لا يُحسَب طلب التحميل الافتتاحي
    // الأصلي)، ولا إلغاء للطلب الأوسع الجاري (لا يزال معلَّقاً — لم يُستبدَل).
    const callsSinceGap = calls.slice(callsBeforeGap);
    assert.equal(callsSinceGap.filter((c) => typeof c.limit === 'number' && c.limit <= 20).length, 0);

    releaseNextRequest();
    await waitFor(() => assert.ok(store.getSlot(SESSION_ID).serverMessages.length > 20));

    // كل طلبات light400 (بما فيها أي طلب تال أعاده الطابور بعد التحرير) تبقى
    // بالحدّ الثابت نفسه، لا نافذة متراجِعة إلى 20 — بعد الطلب الافتتاحي فقط
    // (الافتتاحي بحدّ 20 مشروع، وليس تراجعاً بسببه الفجوة).
    const firstWideIndex = calls.findIndex((c) => typeof c.limit === 'number' && c.limit > 20);
    assert.ok(firstWideIndex >= 0);
    for (const call of calls.slice(firstWideIndex)) {
      if (call.payload === 'light') assert.ok((call.limit ?? 0) > 20, `طلب light بنافذة ${call.limit}`);
    }
  });
});
