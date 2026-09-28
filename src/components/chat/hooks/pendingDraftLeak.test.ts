/**
 * تسرّب المسوّدة إلى محادثة أخرى — الرسالة المكتوبة في محادثة **جديدة** (قبل
 * أن يُعلن المزوّد معرّف الجلسة) كانت تُحفظ في `pendingUserMessage`، وهي حالة
 * عامة لا تحمل هوية جلسة. وتأثير الإفراغ في `useChatSessionState` كان يُطلَق
 * على كل تغيّر في `activeSessionId` — ومنه فتحُ المستخدم محادثةً أخرى — فيحقن
 * الرسالة في مخزن الجلسة المعروضة آنذاك. فتظهر معلّقةً أسفل محادثةٍ لم
 * تستقبلها قطّ، ولا يُصلح العرض إلا تحديث الصفحة (الصفّ عميلي محض).
 *
 * الحارس هنا يمرّ عبر مسار الإنتاج نفسه: نُركّب الخطّاف بلا جلسة، نستدعي
 * `addMessage` كما يفعل المُؤلِّف عند الإرسال، ثم نُبدّل `selectedSession` إلى
 * محادثة أخرى بينما الإرسال ما زال طائراً (`pendingViewSessionRef` غير فارغ)،
 * ونطالب بألّا يمسّ المخزنَ شيء لتلك المحادثة.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, it } from 'vitest';

import { useChatSessionState } from './useChatSessionState';

const PROJECT = { projectId: 'proj-1', fullPath: '/tmp/p', path: '/tmp/p' } as any;
const OTHER_SESSION = { id: 'session-B', __provider: 'claude' } as any;

type Appended = { sessionId: string; content: unknown };

function makeStore(appends: Appended[]) {
  const slot: any = {
    serverMessages: [],
    realtimeMessages: [],
    total: 0,
    hasMore: false,
    status: 'idle',
    fetchedAt: Date.now(),
    offset: 0,
  };
  const stableEmpty: any[] = [];
  return {
    setActiveSession: () => {},
    getMessages: () => stableEmpty,
    getSessionSlot: () => slot,
    appendRealtime: (sessionId: string, msg: any) => {
      appends.push({ sessionId, content: msg?.content });
    },
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
    fetchFromServer: async () => ({ ok: true, slot }),
  } as any;
}

function mount(sessionStore: any, pendingViewSessionRef: { current: any }) {
  return renderHook(
    ({ selectedSession }: { selectedSession: any }) =>
      useChatSessionState({
        selectedProject: PROJECT,
        selectedSession,
        ws: null,
        sendMessage: () => {},
        resetStreamingState: () => {},
        pendingViewSessionRef: pendingViewSessionRef as any,
        sessionStore,
      }),
    { initialProps: { selectedSession: null as any } },
  );
}

/** Like `mount`, but `selectedProject` also varies per render (B-1386 project-switch test). */
function mountWithProject(sessionStore: any, pendingViewSessionRef: { current: any }) {
  return renderHook(
    ({ selectedSession, selectedProject }: { selectedSession: any; selectedProject: any }) =>
      useChatSessionState({
        selectedProject,
        selectedSession,
        ws: null,
        sendMessage: () => {},
        resetStreamingState: () => {},
        pendingViewSessionRef: pendingViewSessionRef as any,
        sessionStore,
      }),
    { initialProps: { selectedSession: null as any, selectedProject: PROJECT } },
  );
}

beforeEach(() => {
  localStorage.setItem('selected-provider', 'claude');
});

describe('رسالة المسوّدة لا تنتقل إلى محادثة أخرى', () => {
  it('فتحُ محادثة أخرى أثناء إرسالٍ طائر لا يحقن المسوّدة في مخزنها', async () => {
    const appends: Appended[] = [];
    // كما يضبطه المُؤلِّف عند الإرسال بلا جلسة (useChatComposerState).
    const pendingViewSessionRef: { current: { sessionId: string | null; startedAt: number } | null } =
      { current: { sessionId: null, startedAt: Date.now() } };
    const { result, rerender } = mount(makeStore(appends), pendingViewSessionRef);

    act(() => {
      result.current.addMessage({
        type: 'user',
        content: 'رسالة المسوّدة',
        timestamp: new Date(),
      } as any);
    });

    // بلا جلسة: تظهر في العرض الحالي (المسوّدة) ولا شيء في المخزن.
    assert.equal(appends.length, 0);
    assert.equal(result.current.chatMessages.length, 1);

    // المستخدم يفتح محادثة أخرى قبل وصول session_created.
    rerender({ selectedSession: OTHER_SESSION });

    await waitFor(() => {
      assert.equal(
        appends.filter((a) => a.sessionId === OTHER_SESSION.id).length,
        0,
        `تسرّبت المسوّدة إلى محادثة أخرى: ${JSON.stringify(appends)}`,
      );
    });
    // ولا تُعرض داخلها أيضاً.
    assert.equal(result.current.chatMessages.length, 0);
  });

  it(
    'B-1386: session_created لجلسة جديدة يُبقي المرجع حياً حتى يلحق الموجّه — ' +
    'لا يُصفَّر currentSessionId ولا تُفقد المسوّدة',
    async () => {
      const appends: Appended[] = [];
      const pendingViewSessionRef:
        { current: { sessionId: string | null; startedAt: number; projectId?: string | null } | null } =
        { current: { sessionId: null, startedAt: Date.now(), projectId: PROJECT.projectId } };
      const { result, rerender } = mount(makeStore(appends), pendingViewSessionRef);

      act(() => {
        result.current.addMessage({
          type: 'user',
          content: 'أول رسالة',
          timestamp: new Date(),
        } as any);
      });
      assert.equal(result.current.chatMessages.length, 1);

      // مطابقٌ لما يفعله useChatRealtimeHandlers بعد B-1386: يضبط sessionId على
      // المرجع (لا يُصفِّره) ثم يضبط currentSessionId، والموجّه لم يلحق بعد.
      act(() => {
        pendingViewSessionRef.current!.sessionId = 'session-new';
        result.current.setCurrentSessionId('session-new');
      });

      // جولة تصيير أخرى بلا selectedSession (سباق الموجّه): لا يُصفَّر
      // currentSessionId، ولا تضيع المسوّدة.
      rerender({ selectedSession: null });
      assert.equal(result.current.currentSessionId, 'session-new');

      await waitFor(() => {
        assert.deepEqual(
          appends.map((a) => a.sessionId),
          ['session-new'],
          `الإفراغ لم يقع في مخزن الجلسة الجديدة: ${JSON.stringify(appends)}`,
        );
      });

      // الموجّه يلحق أخيراً: المرجع يُصفَّر ذاتياً، والجلسة تبقى صحيحة.
      rerender({ selectedSession: { id: 'session-new', __provider: 'claude' } as any });
      assert.equal(pendingViewSessionRef.current, null);
      assert.equal(result.current.currentSessionId, 'session-new');
    },
  );

  it('وصول الجلسة التي أنشأها الإرسال نفسه ⇒ الإفراغ يقع في مخزنها', async () => {
    const appends: Appended[] = [];
    const pendingViewSessionRef: { current: { sessionId: string | null; startedAt: number } | null } =
      { current: { sessionId: null, startedAt: Date.now() } };
    const { result, rerender } = mount(makeStore(appends), pendingViewSessionRef);

    act(() => {
      result.current.addMessage({
        type: 'user',
        content: 'رسالة المسوّدة',
        timestamp: new Date(),
      } as any);
    });

    // معالج session_created يصفّر المرجع تزامنياً ثم يضبط معرّف الجلسة.
    act(() => {
      pendingViewSessionRef.current = null;
      result.current.setCurrentSessionId('session-A');
    });

    await waitFor(() => {
      assert.deepEqual(
        appends.map((a) => a.sessionId),
        ['session-A'],
        `الإفراغ المشروع لم يقع كما يجب: ${JSON.stringify(appends)}`,
      );
    });
  });

  it(
    'B-1386: switching PROJECT mid-send (no newSessionTrigger bump) resets ' +
    'currentSessionId instead of pinning it to the abandoned project',
    async () => {
      const appends: Appended[] = [];
      const OTHER_PROJECT = { projectId: 'proj-2', fullPath: '/tmp/p2', path: '/tmp/p2' } as any;
      // Stamped by useChatComposerState with the ORIGINATING project (proj-1).
      const pendingViewSessionRef:
        { current: { sessionId: string | null; startedAt: number; projectId?: string | null } | null } =
        { current: { sessionId: 'session-new', startedAt: Date.now(), projectId: PROJECT.projectId } };
      const { result, rerender } = mountWithProject(makeStore(appends), pendingViewSessionRef);

      act(() => {
        result.current.setCurrentSessionId('session-new');
      });

      // handleProjectSelect: setSelectedProject(OTHER_PROJECT) + setSelectedSession(null),
      // no newSessionTrigger bump.
      rerender({ selectedSession: null, selectedProject: OTHER_PROJECT });

      assert.equal(
        result.current.currentSessionId,
        null,
        'a real project switch must reset currentSessionId, not get pinned by the router-lag guard',
      );
      assert.equal(pendingViewSessionRef.current, null);
    },
  );
});
