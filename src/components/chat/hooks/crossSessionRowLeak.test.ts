/**
 * B-426 — صفٌّ حيّ لا يُكتب إلا في محادثته هو.
 *
 * مسربان مستقلّان، كلاهما يُظهر رسالة المستخدم داخل محادثة لم تُرسَل فيها،
 * ولا يزول أثرهما إلا بتحديث الصفحة (الصفوف عميلية، وسجلّ الخادم سليم):
 *
 *  (١) **صفّ بلا معرّف جلسة**: الخادم يبعث `sessionId: capturedSessionId ||
 *      sessionId`، وهو فارغ في نافذة إقلاع محادثة جديدة قبل التقاط معرّفها.
 *      وكان العميل يرتدّ إلى «الجلسة المعروضة»، فيُلصق صدى رسالة المستخدم بأي
 *      محادثة تكون مفتوحة أمامه.
 *
 *  (٢) **`session_created` لجلسة أخرى**: عدم تطابق المعرّف كان يُقرأ «استئنافاً
 *      بائتاً للمعروضة»، فيُنسخ محتوى المعروضة إلى الجلسة الجديدة ويُسمّى باسمها
 *      (alias). يحسمه `parentSessionId`: نسبٌ صريح أو null لمحادثة وُلدت الآن.
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

import { CONTROL_EVENT_KINDS, type ControlEventLog } from '../../../contexts/WebSocketContext';

import { resetSessionActivityEpochs } from './sessionActivity';
import { useChatRealtimeHandlers, type StreamBuffer } from './useChatRealtimeHandlers';

/** المحادثة المفتوحة أمام المستخدم الآن. */
const VIEWED = 'sess-viewed';

const EMPTY_LOG: ControlEventLog = { events: [], droppedBeforeSeq: 0 };

function harness() {
  const appended: { sessionId: string; content?: string }[] = [];
  const replaced: { from: string; to: string }[] = [];
  const branched: { from: string; to: string }[] = [];
  const navigated: string[] = [];

  const sessionStore = {
    recordSeq: () => {},
    appendRealtime: (sessionId: string, msg: any) =>
      appended.push({ sessionId, content: msg?.content }),
    appendRealtimeBatch: () => {},
    updateStreaming: () => {},
    finalizeStreaming: () => {},
    replaceSessionId: (from: string, to: string) => replaced.push({ from, to }),
    branchSessionId: (from: string, to: string) => branched.push({ from, to }),
  } as any;

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
    streamTimerRef: { current: null } as any,
    accumulatedStreamRef: { current: new Map<string, StreamBuffer>() } as any,
    onNavigateToSession: (id: string) => navigated.push(id),
    sessionStore,
  };

  const { rerender } = renderHook(
    (delivered: any) => useChatRealtimeHandlers({ ...props, ...delivered }),
    { initialProps: { latestMessage: null, controlEvents: EMPTY_LOG } as any },
  );

  // مرآة الإنتاج (‏T-1293): أحداث التحكّم تُلحَق بالسجلّ **وتمرّ** إلى
  // `latestMessage` معاً — تفرّع لا تحويل. وما عداها يمرّ بالفتحة وحدها.
  let seq = 0;
  let events: { seq: number; frame: any }[] = [];
  const send = (m: any) => {
    if (m && CONTROL_EVENT_KINDS.has(m.kind)) {
      seq += 1;
      events = [...events, { seq, frame: m }];
    }
    rerender({ latestMessage: m, controlEvents: { events, droppedBeforeSeq: 0 } });
  };

  return { appended, replaced, branched, navigated, send };
}

beforeEach(() => {
  resetSessionActivityEpochs();
});

describe('B-426: لا صفّ يُكتب في محادثة ليست له', () => {
  it('صدى رسالة المستخدم بلا معرّف جلسة لا يُلصق بالمحادثة المعروضة', () => {
    const h = harness();

    h.send({ kind: 'text', role: 'user', sessionId: '', content: 'رسالة المستخدم' });

    assert.deepEqual(
      h.appended.filter((a) => a.sessionId === VIEWED),
      [],
      `صفّ بلا نسب كُتب في المحادثة المعروضة: ${JSON.stringify(h.appended)}`,
    );
  });

  it('صفّ يحمل معرّف جلسته يُكتب فيها هي لا في المعروضة', () => {
    const h = harness();

    h.send({ kind: 'text', role: 'user', sessionId: 'sess-other', content: 'رسالة' });

    assert.deepEqual(h.appended, [{ sessionId: 'sess-other', content: 'رسالة' }]);
  });

  it('session_created لمحادثة وُلدت الآن (parent=null) لا يمسّ المحادثة المعروضة', () => {
    const h = harness();

    h.send({
      kind: 'session_created',
      newSessionId: 'sess-born-now',
      sessionId: 'sess-born-now',
      parentSessionId: null,
    });

    assert.deepEqual(
      h.replaced,
      [],
      `نُسخت المحادثة المعروضة إلى جلسة لا تخصّها: ${JSON.stringify(h.replaced)}`,
    );
    assert.deepEqual(h.navigated, []);
  });

  it('استئناف بائت للمعروضة نفسها (parent = المعروضة) ⇒ الترحيل يقع كما كان', () => {
    const h = harness();

    h.send({
      kind: 'session_created',
      newSessionId: 'sess-fresh',
      sessionId: 'sess-fresh',
      parentSessionId: VIEWED,
    });

    assert.deepEqual(h.replaced, [{ from: VIEWED, to: 'sess-fresh' }]);
    assert.deepEqual(h.navigated, ['sess-fresh']);
  });

  it('مزوّد لم يُرسل النسب بعد ⇒ السلوك القديم كما هو (لا كسر)', () => {
    const h = harness();

    h.send({ kind: 'session_created', newSessionId: 'sess-legacy', sessionId: 'sess-legacy' });

    assert.deepEqual(h.replaced, [{ from: VIEWED, to: 'sess-legacy' }]);
  });

  it('فرع متابعة آمن ينقل الطلب المعلّق ولا يحوّل الجلسة الأصلية إلى alias', () => {
    const h = harness();

    h.send({
      kind: 'session_created',
      newSessionId: 'sess-branch',
      sessionId: 'sess-branch',
      parentSessionId: VIEWED,
      forked: true,
    });

    assert.deepEqual(h.branched, [{ from: VIEWED, to: 'sess-branch' }]);
    assert.deepEqual(h.replaced, []);
    assert.deepEqual(h.navigated, ['sess-branch']);
  });
});
