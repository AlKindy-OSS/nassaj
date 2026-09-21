/**
 * T-1293 — استهلاك سجلّ أحداث التحكّم في `useChatRealtimeHandlers`.
 *
 * السجلّ بلا مستهلك صحيح لا يُصلح شيئاً. ما يحرسه هذا الملف:
 *
 *  ١. حدثان في دفعة render واحدة يُعالَجان كلاهما (فتحة `latestMessage` كانت
 *     تُبقي الأخير وحده، فتضيع نهاية التشغيل الأولى: بطاقة عالقة وزرّ STOP
 *     لا يزول).
 *  ٢. حدثٌ بلا معرّف جلسة لا يُسقَط.
 *  ٣. الشريحتان (حالات + أحداث) تُطبَّقان **بترتيب `seq`** لا بترتيب التصريح:
 *     تأثيران منفصلان كانا يجعلان «تعمل» تسبق «انتهت» أو العكس بحسب ترتيب
 *     كتابتهما في الملف — لا بحسب ما وصل من السلك.
 *  ٤. إعادة تركيب المستهلك لا تُعيد بعث أحداث سابقة له.
 *  ٥. المعالجة **مرّة واحدة**: الحمولة تمرّ إلى `latestMessage` أيضاً، فوجود
 *     فرعٍ لها هناك كان يعني تطبيق كل أثر مرّتين.
 *  ٦. الفقد بالتقليم لا يمرّ صامتاً: قفزٌ إلى الأحدث + لقطة حتمية.
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

/** اللقطة الحتمية: نرصد طلبها بلا شبكة. */
const probeCalls: string[] = [];
vi.mock('./sessionActivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionActivity')>();
  return {
    ...actual,
    runSessionActivityProbe: async ({ sessionId }: { sessionId: string }) => {
      probeCalls.push(sessionId);
      return 'idle' as const;
    },
  };
});

import type { ControlEventLog } from '../../../contexts/WebSocketContext';

import { resetSessionActivityEpochs } from './sessionActivity';
import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';
import {
  clearOutbox,
  getOutboxSnapshot,
  markOutboxFailed,
  recordOutboxEntry,
  setOutboxUser,
} from '../utils/messageOutbox';

const SESSION = 'sess-live';
const EMPTY_LOG: ControlEventLog = { events: [], droppedBeforeSeq: 0 };

type Calls = {
  isLoading: boolean[];
  permissions: unknown[];
  appended: { sessionId: string; kind?: string }[];
  serverErrors: string[];
  navigated: string[];
  restored: string[];
  withdrawn: { sessionId: string; clientMsgId?: string }[];
};

type Delivered = {
  latestMessage?: any;
  controlFrames?: Map<string, { seq: number; frame: any }>;
  controlEvents?: ControlEventLog;
};

function harness(
  initial?: Delivered,
  options: { withdrawnText?: string | null; enableRestore?: boolean } = {},
) {
  const calls: Calls = {
    isLoading: [],
    permissions: [],
    appended: [],
    serverErrors: [],
    navigated: [],
    restored: [],
    withdrawn: [],
  };

  const sessionStore = {
    recordSeq: () => {},
    appendRealtime: (sessionId: string, msg: any) =>
      calls.appended.push({ sessionId, kind: msg?.kind }),
    updateStreaming: () => {},
    finalizeStreaming: () => {},
    replaceSessionId: () => {},
    withdrawOptimisticUserRow: (sessionId: string, clientMsgId?: string) => {
      calls.withdrawn.push({ sessionId, clientMsgId });
      return options.withdrawnText ?? null;
    },
  } as any;

  const props = {
    latestMessage: null as any,
    controlFrames: new Map(),
    controlEvents: EMPTY_LOG,
    provider: 'claude' as const,
    selectedSession: { id: SESSION } as any,
    currentSessionId: SESSION,
    setCurrentSessionId: () => {},
    setIsLoading: (v: boolean) => calls.isLoading.push(v),
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setTokenBudget: () => {},
    setPendingPermissionRequests: (v: unknown) => calls.permissions.push(v),
    pendingViewSessionRef: { current: null } as any,
    streamTimerRef: { current: null } as any,
    accumulatedStreamRef: { current: new Map() } as any,
    onNavigateToSession: (id: string) => calls.navigated.push(id),
    onServerError: (m: string) => calls.serverErrors.push(m),
    onRejectedSendRestore: options.enableRestore
      ? (text: string) => calls.restored.push(text)
      : undefined,
    sessionStore,
  };

  const { rerender, unmount } = renderHook(
    (delivered: Delivered) => useChatRealtimeHandlers({ ...props, ...delivered } as any),
    { initialProps: (initial ?? {}) as Delivered },
  );

  return { calls, rerender, unmount };
}

/** سجلّ من أحداث مرقّمة تسلسلياً من 1. */
function log(...frames: any[]): ControlEventLog {
  return {
    events: frames.map((frame, index) => ({ seq: index + 1, frame })),
    droppedBeforeSeq: 0,
  };
}

beforeEach(() => {
  resetSessionActivityEpochs();
  probeCalls.length = 0;
  clearOutbox();
  setOutboxUser('control-consumer-test');
});

describe('session_busy — الحذف بعد استعادة النص فقط', () => {
  it('يحذف نسخة الصندوق بعد أن ينفذ onRejectedSendRestore فعلياً', () => {
    recordOutboxEntry({
      id: 'cmid-busy-active', projectId: 'p1', sessionId: SESSION, text: 'أعدني',
    });
    markOutboxFailed('cmid-busy-active', { code: 'session_busy' });
    const h = harness(undefined, { withdrawnText: 'أعدني', enableRestore: true });

    h.rerender({
      controlEvents: log({
        kind: 'error', sessionId: SESSION, clientMsgId: 'cmid-busy-active', code: 'session_busy',
      }),
    });

    assert.deepEqual(h.calls.restored, ['أعدني']);
    // B-1078: the rejected send's own id selects the bubble, not "the last one".
    assert.deepEqual(h.calls.withdrawn, [{ sessionId: SESSION, clientMsgId: 'cmid-busy-active' }]);
    assert.equal(getOutboxSnapshot().length, 0, 'بقيت بطاقة بعد رجوع النص للمؤلف');
  });

  it('يبقي النسخة إذا تعذر رد النص إلى المؤلف', () => {
    recordOutboxEntry({
      id: 'cmid-busy-offscreen', projectId: 'p1', sessionId: SESSION, text: 'احفظني',
    });
    markOutboxFailed('cmid-busy-offscreen', { code: 'session_busy' });
    const h = harness(undefined, { withdrawnText: 'احفظني', enableRestore: false });

    h.rerender({
      controlEvents: log({
        kind: 'error', sessionId: SESSION, clientMsgId: 'cmid-busy-offscreen', code: 'session_busy',
      }),
    });

    assert.equal(getOutboxSnapshot()[0]?.status, 'failed', 'حُذفت النسخة بلا شهادة استعادة');
  });

  it('B-1078: a busy frame without clientMsgId withdraws nothing (mirror tab keeps its live send)', () => {
    recordOutboxEntry({ id: 'cmid-live-m1', projectId: 'p1', sessionId: SESSION, text: 'M1 حيّة' });
    const h = harness(undefined, { withdrawnText: 'M1 حيّة', enableRestore: true });

    h.rerender({ controlEvents: log({ kind: 'error', sessionId: SESSION, code: 'session_busy' }) });

    assert.deepEqual(h.calls.withdrawn, [], 'سُحبت فقاعة بلا معرّف يسمّيها');
    assert.deepEqual(h.calls.restored, [], 'رُدّ نصّ إرسالٍ حيّ إلى المُؤلِّف');
    assert.equal(getOutboxSnapshot()[0]?.status, 'pending', 'مُسّت نسخة الصندوق');
  });

  it('B-1078: attachment-only withdrawal returns empty text: no restore, card keeps its copy', () => {
    recordOutboxEntry({ id: 'cmid-busy-images', projectId: 'p1', sessionId: SESSION, text: '' });
    markOutboxFailed('cmid-busy-images', { code: 'session_busy' });
    const h = harness(undefined, { withdrawnText: '', enableRestore: true });

    h.rerender({
      controlEvents: log({ kind: 'error', sessionId: SESSION, clientMsgId: 'cmid-busy-images', code: 'session_busy' }),
    });

    assert.deepEqual(h.calls.withdrawn, [{ sessionId: SESSION, clientMsgId: 'cmid-busy-images' }]);
    assert.deepEqual(h.calls.restored, []);
    assert.equal(getOutboxSnapshot()[0]?.status, 'failed', 'حُذفت بطاقة المرفقات');
  });
});

describe('حدثان في دفعة واحدة', () => {
  it('نهاية تشغيلٍ يليها خطأ ⇒ كلاهما يُعالَج', () => {
    const h = harness();

    h.rerender({
      controlEvents: log(
        { kind: 'complete', sessionId: SESSION },
        { kind: 'error', sessionId: SESSION, error: 'boom' },
      ),
    });

    // كلاهما يُنزل المؤشّر، فالدليل القاطع أن الخطأ عولج هو ظهور رسالته.
    assert.deepEqual(h.calls.isLoading, [false, false], 'حدثٌ ابتُلع في نفس الدفعة');
    assert.equal(h.calls.serverErrors.length, 1);
  });

  it("حدث بـsessionId='' يُطبَّق على الجلسة المعروضة ولا يُسقَط", () => {
    const h = harness();

    h.rerender({ controlEvents: log({ kind: 'error', sessionId: '', error: 'spawn failed' }) });

    assert.deepEqual(h.calls.isLoading, [false], 'أُسقط الإطار كلياً فبقيت الشاشة تنتظر أبداً');
    assert.equal(h.calls.serverErrors.length, 1);
  });

  it('إعادة الرسم بنفس السجلّ لا تُعيد المعالجة', () => {
    const h = harness();
    const delivered = log({ kind: 'complete', sessionId: SESSION });

    h.rerender({ controlEvents: delivered });
    h.rerender({ controlEvents: { ...delivered } });

    assert.deepEqual(h.calls.isLoading, [false], 'أُعيدت معالجة حدثٍ سبق تطبيقه');
  });
});

describe('الترتيب بين الشريحتين يتبع seq لا ترتيب التصريح', () => {
  it('حالة «تعمل» (seq 1) ثم حدث «انتهت» (seq 2) ⇒ ينتهي المؤشّر منخفضاً', () => {
    const h = harness();

    h.rerender({
      controlFrames: new Map([
        [SESSION, {
          seq: 1,
          frame: { type: 'session-status', sessionId: SESSION, isProcessing: true },
        }],
      ]),
      controlEvents: {
        events: [{ seq: 2, frame: { kind: 'complete', sessionId: SESSION } }],
        droppedBeforeSeq: 0,
      },
    });

    assert.deepEqual(
      h.calls.isLoading,
      [true, false],
      'طُبِّق «انتهت» قبل «تعمل» ⇒ مؤشّر عالق بعد نهاية التشغيل',
    );
  });

  it('حدث «انتهت» (seq 1) ثم حالة «تعمل» (seq 2) ⇒ ينتهي المؤشّر مرتفعاً', () => {
    const h = harness();

    h.rerender({
      controlFrames: new Map([
        [SESSION, {
          seq: 2,
          frame: { type: 'session-status', sessionId: SESSION, isProcessing: true },
        }],
      ]),
      controlEvents: {
        events: [{ seq: 1, frame: { kind: 'complete', sessionId: SESSION } }],
        droppedBeforeSeq: 0,
      },
    });

    assert.deepEqual(
      h.calls.isLoading,
      [false, true],
      'طُبِّقت «تعمل» قبل «انتهت» ⇒ الجولة التالية تبدأ بلا مؤشّر',
    );
  });
});

describe('خطّ الأساس عند التركيب', () => {
  it('طلب إذنٍ سابق لتركيب المستهلك لا يُبعث ثانيةً — ولو تلاه رسمٌ آخر', () => {
    // المحاكاة: طلب إذن وقع وأُجيب، ثم فُكِّك ChatInterface (تبويب Terminal)
    // وأُعيد تركيبه والسجلّ ما يزال يحمل الحدث. والرسم التالي (حدثٌ جديد، أو أي
    // تغيّر خصائص) هو موضع الخطر الحقيقي: التأثير يمشي على السجلّ كلّه من جديد.
    const staleRequest = {
      kind: 'permission_request',
      sessionId: SESSION,
      requestId: 'req-old',
      toolName: 'Bash',
    };
    const h = harness({ controlEvents: log(staleRequest) });

    assert.deepEqual(h.calls.permissions, [], 'أُعيد بعث طلب إذن ميت ⇒ نافذة موافقة لا أصل لها');
    assert.deepEqual(h.calls.isLoading, []);

    h.rerender({
      controlEvents: {
        events: [
          { seq: 1, frame: staleRequest },
          { seq: 2, frame: { kind: 'complete', sessionId: SESSION } },
        ],
        droppedBeforeSeq: 0,
      },
    });

    assert.deepEqual(
      h.calls.permissions,
      [[]],
      'الطلب الميت طُبِّق عند أول رسمٍ تالٍ (المسح الوحيد المشروع هو مسح `complete`)',
    );
    assert.deepEqual(h.calls.isLoading, [false], 'الحدث الجديد وحده هو ما يُطبَّق');
  });

  it('خطّ الأساس يشمل الشريحتين معاً', () => {
    const h = harness({
      controlFrames: new Map([
        [SESSION, {
          seq: 9,
          frame: { type: 'session-status', sessionId: SESSION, isProcessing: false },
        }],
      ]),
      controlEvents: {
        events: [{ seq: 4, frame: { kind: 'complete', sessionId: SESSION } }],
        droppedBeforeSeq: 0,
      },
    });

    // حدثٌ لاحق للحالة (seq 9) يُطبَّق، وحدثٌ بينهما (seq 7) لا — وإلا كان خطّ
    // الأساس محسوباً على شريحة واحدة.
    h.rerender({
      controlEvents: {
        events: [
          { seq: 7, frame: { kind: 'error', sessionId: SESSION, error: 'قديم' } },
          { seq: 10, frame: { kind: 'error', sessionId: SESSION, error: 'جديد' } },
        ],
        droppedBeforeSeq: 0,
      },
    });

    assert.equal(h.calls.serverErrors.length, 1, 'طُبِّق حدثٌ سابق لخطّ الأساس');
  });

  it('حدث جديد بعد التركيب يُطبَّق رغم وجود خطّ أساس', () => {
    const h = harness({ controlEvents: log({ kind: 'complete', sessionId: SESSION }) });

    h.rerender({
      controlEvents: {
        events: [{ seq: 2, frame: { kind: 'complete', sessionId: SESSION } }],
        droppedBeforeSeq: 0,
      },
    });

    assert.deepEqual(h.calls.isLoading, [false]);
  });
});

describe('معالجة واحدة لا مزدوجة', () => {
  it('error يمرّ بالمسارين (كالإنتاج) فيُحفَظ مرة ويُطبَّق مرة', () => {
    const h = harness();
    const frame = { kind: 'error', sessionId: SESSION, error: 'boom' };

    // كما يفعل المزوّد بالضبط: إلحاقٌ بالسجلّ **و**كتابةٌ في فتحة latestMessage.
    h.rerender({ latestMessage: frame, controlEvents: log(frame) });

    assert.deepEqual(
      h.calls.appended,
      [{ sessionId: SESSION, kind: 'error' }],
      'الحفظ في المحادثة سقط أو تضاعف بنقل الحالة',
    );
    assert.equal(h.calls.serverErrors.length, 1, 'عولج الخطأ مرّتين');
    assert.equal(h.calls.permissions.length, 1, 'مُسحت طلبات الإذن مرّتين');
  });

  it('session_busy يبقى غير محفوظ (بوابة shouldPersist لم تُمَسّ)', () => {
    const h = harness();
    const frame = { kind: 'error', sessionId: SESSION, code: 'session_busy' };

    h.rerender({ latestMessage: frame, controlEvents: log(frame) });

    assert.deepEqual(h.calls.appended, []);
    assert.equal(h.calls.serverErrors.length, 1);
  });
});

describe('فقدٌ بالتقليم لا يمرّ صامتاً', () => {
  it('يقفز إلى الأحدث ويطلب اللقطة الحتمية بدل المضيّ على حالة ناقصة', () => {
    const h = harness({ controlEvents: log({ kind: 'complete', sessionId: SESSION }) });

    // أُسقطت أحداث حتى seq 40 قبل أن يعالجها هذا المستهلك.
    h.rerender({
      controlEvents: {
        events: [{ seq: 41, frame: { kind: 'error', sessionId: SESSION, error: 'ناجٍ' } }],
        droppedBeforeSeq: 40,
      },
    });

    assert.deepEqual(probeCalls, [SESSION], 'مضى صامتاً على حالة ناقصة بلا تعافٍ');
    assert.equal(h.calls.serverErrors.length, 0, 'طُبِّق ما بقي رغم أن ترتيبه بالنسبة لما فُقد مجهول');
  });

  it('بعد القفز يُستأنف الاستهلاك من الأحدث', () => {
    const h = harness({ controlEvents: log({ kind: 'complete', sessionId: SESSION }) });

    h.rerender({
      controlEvents: {
        events: [{ seq: 41, frame: { kind: 'error', sessionId: SESSION, error: 'ناجٍ' } }],
        droppedBeforeSeq: 40,
      },
    });
    h.rerender({
      controlEvents: {
        events: [
          { seq: 41, frame: { kind: 'error', sessionId: SESSION, error: 'ناجٍ' } },
          { seq: 42, frame: { kind: 'error', sessionId: SESSION, error: 'بعد التعافي' } },
        ],
        droppedBeforeSeq: 40,
      },
    });

    assert.equal(h.calls.serverErrors.length, 1, 'تجمّد الاستهلاك بعد الفقد');
  });

  it('فقدٌ مُغطّى بخطّ الأساس لا يُطلق لقطة (لا إنذار كاذب)', () => {
    // مستهلكٌ رُكِّب بعد التقليم: كل ما فُقد سابقٌ لعمره أصلاً.
    const h = harness({
      controlEvents: {
        events: [{ seq: 50, frame: { kind: 'complete', sessionId: SESSION } }],
        droppedBeforeSeq: 40,
      },
    });

    h.rerender({
      controlEvents: {
        events: [{ seq: 51, frame: { kind: 'complete', sessionId: SESSION } }],
        droppedBeforeSeq: 40,
      },
    });

    assert.deepEqual(probeCalls, []);
    assert.deepEqual(h.calls.isLoading, [false], 'الحدث التالي للفقد لم يُطبَّق');
  });
});

describe('B-928 — every server banner path retains a safe classification', () => {
  it.each([
    [{ kind: 'session_created' }, 'session_create_failed'],
    [{ kind: 'session_created', error: { code: 'future_create_error', detail: 'private-token' } }, 'future_create_error'],
    [{ kind: 'complete', aborted: true, success: false, error: 'private-token' }, 'abort_failed'],
    [{ kind: 'error', error: 'private-token' }, 'SERVER_ERROR_UNCLASSIFIED'],
  ])('surfaces a safe code for %j', (event, code) => {
    const h = harness();
    h.rerender({ controlEvents: log({ ...event, sessionId: SESSION }) });
    assert.equal(h.calls.serverErrors.length, 1);
    assert.ok(h.calls.serverErrors[0].endsWith(`: ${code}`));
    assert.ok(!h.calls.serverErrors[0].includes('private-token'));
    assert.ok(h.calls.isLoading.includes(false));
    h.unmount();
  });
});
