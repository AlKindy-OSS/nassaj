/**
 * T-1933 (B-1401 client half, review round 2) — `complete` بـ`pendingWorkflowIds`
 * غير فارغة يُبقي الانتظار («Workflow يعمل في الخلفية…») بلا أيّ حدثٍ لاحق
 * يُنزله. إطار `workflow_settled` (يحمل `toolUseId` الورشة المنتهية) هو
 * الإعلان الوحيد اليوم أن ورشةً بعينها انتهت — يُسوَّى بمطابقة المعرّف، لا
 * بعدٍّ عام، ويصل عبر سجلّ أحداث التحكّم (`CONTROL_EVENT_KINDS`) لا فتحة
 * `latestMessage` ذات القيمة الواحدة.
 *
 * مراجعة qa-critic (حرج، finding 2): `task_notification`/`task_reconcile`
 * بطاقتا **Agent** لا Workflow — وصولهما لا يُسوّي ورشةً معلّقة بعد اليوم.
 *
 * الحارس الثاني (finding 3): نصّ حالةٍ حيّ جديد (غير نصّ الانتظار) على نفس
 * الجلسة — إشارة أن جولة تالية بدأت فعلياً — يمحو مُدخَل الورشة القديم، فبطاقة
 * `workflow_settled` متأخّرة للورشة القديمة لا تُطفئ مؤشّر الجولة الجديدة.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, it } from 'vitest';

import { resetSessionActivityEpochs } from './sessionActivity';
import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

const SESSION = 'sess-wf';

type Spy<T extends (...args: any[]) => any> = T & { calls: Parameters<T>[] };
function spy<T extends (...args: any[]) => any>(): Spy<T> {
  const fn = ((...args: any[]) => {
    (fn as any).calls.push(args);
  }) as Spy<T>;
  fn.calls = [];
  return fn;
}

function setup() {
  const sessionStore = {
    recordSeq: () => {},
    appendRealtime: () => {},
    updateStreaming: () => {},
    finalizeStreaming: () => {},
    replaceSessionId: () => {},
    applyResponseTurnCompletion: () => {},
  } as any;

  const setIsLoading = spy<(v: boolean) => void>();
  const setCanAbortSession = spy<(v: boolean) => void>();
  const setClaudeStatus = spy<(v: unknown) => void>();
  const onSessionNotProcessing = spy<(sid?: string | null) => void>();

  const props = {
    latestMessage: null as any,
    controlFrames: new Map(),
    controlEvents: { events: [], droppedBeforeSeq: 0 },
    provider: 'claude' as const,
    selectedSession: { id: SESSION } as any,
    currentSessionId: SESSION,
    setCurrentSessionId: () => {},
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget: () => {},
    setPendingPermissionRequests: () => {},
    pendingViewSessionRef: { current: null } as any,
    streamTimerRef: { current: null } as any,
    accumulatedStreamRef: { current: new Map() } as any,
    sessionStore,
    onSessionNotProcessing,
  };

  const { rerender, result } = renderHook(
    (delivered: any) => useChatRealtimeHandlers({ ...props, ...delivered } as any),
    { initialProps: {} as any },
  );

  let seq = 0;
  // A control-event frame (`complete`, `workflow_settled`, …): routed through
  // `controlEvents` exactly as WebSocketContext delivers it (CONTROL_EVENT_KINDS).
  const sendControl = (frame: Record<string, unknown>) => {
    seq += 1;
    rerender({
      latestMessage: frame,
      controlEvents: { events: [{ seq, frame }], droppedBeforeSeq: 0 },
    });
  };
  // A `latestMessage`-only frame (`status`, `task_notification`, `task_reconcile`, …).
  const sendStream = (frame: Record<string, unknown>) => {
    rerender({ latestMessage: { ...frame } });
  };
  // مسار الإرسال المحلي الحقيقي (composer): `forgetPendingWorkflows` نفسها،
  // لا محاكاة إطار — راجع `useChatComposerState`'s send sites.
  const startNewLocalTurn = (sid: string) => {
    result.current.forgetPendingWorkflows(sid);
  };

  return {
    setIsLoading, setCanAbortSession, setClaudeStatus, onSessionNotProcessing,
    sendControl, sendStream, startNewLocalTurn,
  };
}

describe('T-1933: انتظار ورشة الخلفية بعد complete ينزل بـworkflow_settled', () => {
  beforeEach(() => {
    resetSessionActivityEpochs();
  });

  it('complete بورشتين معلّقتين: workflow_settled الأولى لا تُنزل، الثانية تُنزل', () => {
    const h = setup();

    h.sendControl({ kind: 'complete', sessionId: SESSION, pendingWorkflows: 2, pendingWorkflowIds: ['wf_a', 'wf_b'] });

    // ما زال ينتظر: لا نداء onSessionNotProcessing بعد.
    assert.equal(h.onSessionNotProcessing.calls.length, 0);
    assert.deepEqual(
      h.setClaudeStatus.calls.at(-1)?.[0],
      { text: 'Workflow يعمل في الخلفية…', tokens: 0, can_interrupt: true },
    );

    h.sendControl({ kind: 'workflow_settled', sessionId: SESSION, toolUseId: 'wf_a', reason: 'notified' });

    assert.equal(h.onSessionNotProcessing.calls.length, 0, 'ورشة ثانية ما تزال معلّقة');
    assert.equal(h.setIsLoading.calls.length, 0, 'لا تغيير على المؤشّر بعد — ورشة باقية');

    h.sendControl({ kind: 'workflow_settled', sessionId: SESSION, toolUseId: 'wf_b', reason: 'process_exited' });

    assert.equal(h.onSessionNotProcessing.calls.length, 1, 'يجب إعلان الجلسة غير عاملة بعد آخر ورشة');
    assert.equal(h.setIsLoading.calls.at(-1)?.[0], false, 'المؤشّر يجب أن يُطفَأ');
    assert.equal(h.setCanAbortSession.calls.at(-1)?.[0], false);
    assert.equal(h.setClaudeStatus.calls.at(-1)?.[0], null);
  });

  it('ورشة واحدة معلّقة: workflow_settled بمعرّفها الصحيح تُنزل فوراً', () => {
    const h = setup();

    h.sendControl({ kind: 'complete', sessionId: SESSION, pendingWorkflows: 1, pendingWorkflowIds: ['wf_x'] });
    h.sendControl({ kind: 'workflow_settled', sessionId: SESSION, toolUseId: 'wf_x', reason: 'failed' });

    assert.equal(h.onSessionNotProcessing.calls.length, 1);
    assert.equal(h.setIsLoading.calls.at(-1)?.[0], false);
  });

  it('task_notification/task_reconcile لا يُسوّيان ورشةً معلّقة (finding 2)', () => {
    const h = setup();

    h.sendControl({ kind: 'complete', sessionId: SESSION, pendingWorkflows: 1, pendingWorkflowIds: ['wf_x'] });

    h.sendStream({ kind: 'task_notification', sessionId: SESSION, status: 'completed' });
    assert.equal(h.onSessionNotProcessing.calls.length, 0, 'بطاقة Agent لا تُسوّي Workflow');

    h.sendStream({ kind: 'task_reconcile', sessionId: SESSION, taskStatus: 'settled' });
    assert.equal(h.onSessionNotProcessing.calls.length, 0, 'بطاقة Agent لا تُسوّي Workflow');

    // الورشة تبقى معلّقة، وتُسوَّى فقط بمعرّفها الصحيح.
    h.sendControl({ kind: 'workflow_settled', sessionId: SESSION, toolUseId: 'wf_x', reason: 'notified' });
    assert.equal(h.onSessionNotProcessing.calls.length, 1);
  });

  it('معرّف مجهول أو مكرَّر يُتجاهَل بلا أثر', () => {
    const h = setup();

    h.sendControl({ kind: 'complete', sessionId: SESSION, pendingWorkflows: 1, pendingWorkflowIds: ['wf_x'] });

    h.sendControl({ kind: 'workflow_settled', sessionId: SESSION, toolUseId: 'wf_unknown', reason: 'notified' });
    assert.equal(h.onSessionNotProcessing.calls.length, 0, 'معرّف مجهول لا يُسوّي شيئاً');

    h.sendControl({ kind: 'workflow_settled', sessionId: SESSION, toolUseId: 'wf_x', reason: 'notified' });
    assert.equal(h.onSessionNotProcessing.calls.length, 1);

    // نفس المعرّف يصل ثانيةً (إعادة تسليم): لا نداء ثانٍ.
    h.sendControl({ kind: 'workflow_settled', sessionId: SESSION, toolUseId: 'wf_x', reason: 'notified' });
    assert.equal(h.onSessionNotProcessing.calls.length, 1, 'معرّف مكرَّر لا يُعيد التسوية');
  });

  it('نصّ حالة جولة جديدة يمحو مُدخَل ورشة قديمة فلا تُطفئه بطاقة متأخّرة', () => {
    const h = setup();

    h.sendControl({ kind: 'complete', sessionId: SESSION, pendingWorkflows: 1, pendingWorkflowIds: ['wf_old'] });
    // جولة تالية بدأت فعلياً على نفس الجلسة (أوّل إطار status سُلطوي من الخادم).
    h.sendStream({ kind: 'status', sessionId: SESSION, text: 'Processing', tokens: 0 });
    assert.equal(h.setIsLoading.calls.at(-1)?.[0], true);

    // workflow_settled المتأخّرة للورشة القديمة تصل الآن: يجب ألا تُطفئ الجولة الجديدة.
    h.sendControl({ kind: 'workflow_settled', sessionId: SESSION, toolUseId: 'wf_old', reason: 'process_exited' });

    assert.equal(
      h.setIsLoading.calls.at(-1)?.[0],
      true,
      'البطاقة المتأخّرة أطفأت مؤشّر جولة جديدة حيّة',
    );
    assert.equal(h.onSessionNotProcessing.calls.length, 0, 'لا مُدخَل للجلسة بعد مسحه فلا تسوية');
  });

  it('استئناف بلا session_created: forgetPendingWorkflows يمحو المُدخَل قبل token_budget وحدها', () => {
    // T-1933 (B-1401، إصلاح السباق الأخير). السيناريو: complete[wf_old]، ثم
    // المستخدم يرسل رسالة جديدة على نفس الجلسة (resume — لا session_created،
    // وأوّل إطارات الجولة الجديدة token_budget وحدها لا نصّ حالةٍ حيّ)، ثم
    // workflow_settled متأخرة للورشة القديمة تصل. المسار المحلي (composer)
    // يستدعي forgetPendingWorkflows فوراً عند بدء الإرسال — قبل أيّ حدثٍ من
    // الخادم — فيُغلق النافذة كاملةً.
    const h = setup();

    h.sendControl({ kind: 'complete', sessionId: SESSION, pendingWorkflows: 1, pendingWorkflowIds: ['wf_old'] });
    assert.deepEqual(
      h.setClaudeStatus.calls.at(-1)?.[0],
      { text: 'Workflow يعمل في الخلفية…', tokens: 0, can_interrupt: true },
    );

    // بدء جولة جديدة محلياً (composer، قبل أيّ ردّ من الخادم): composer نفسه
    // يضبط isLoading(true)/canAbort(true) خارج هذا الخطّاف؛ ما يعنينا هنا هو
    // أن forgetPendingWorkflows يمحو المُدخَل فلا تُسوّيه بطاقةٌ متأخّرة.
    h.startNewLocalTurn(SESSION);

    // أول إطارات الجولة الجديدة: token_budget فقط (لا نصّ حالةٍ حيّ بعد).
    h.sendStream({ kind: 'status', sessionId: SESSION, text: 'token_budget', tokenBudget: { used: 10 } });

    // workflow_settled المتأخّرة للورشة القديمة تصل الآن.
    h.sendControl({ kind: 'workflow_settled', sessionId: SESSION, toolUseId: 'wf_old', reason: 'process_exited' });

    assert.equal(h.onSessionNotProcessing.calls.length, 0, 'لا مُدخَل للجلسة بعد forgetPendingWorkflows فلا تسوية');
    assert.equal(
      h.setIsLoading.calls.some((call) => call[0] === false),
      false,
      'المُدخَل مُحيَ محلياً؛ workflow_settled المتأخّرة يجب ألا تُطفئ isLoading',
    );
    assert.equal(
      h.setCanAbortSession.calls.some((call) => call[0] === false),
      false,
      'المُدخَل مُحيَ محلياً؛ workflow_settled المتأخّرة يجب ألا تُطفئ canAbort',
    );
  });
});
