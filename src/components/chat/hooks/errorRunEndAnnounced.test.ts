/**
 * T-1294 — الجولة الفاشلة تُعلن نهايتها كما تُعلنها الناجحة.
 *
 * ما كان: `case 'error'` لا يُعلن شيئاً إطلاقاً — لا مؤشّر في العنوان ولا صوت.
 * فمستخدمٌ في تبويب آخر ينتظر ردّاً ماتت جولته قبل دقائق، ولا شيء يبلغه؛ بينما
 * الاكتمال يبلغه بقناتين. أسوأ من الصمت: الشاشة نفسها تُنظَّف (المؤشّر ينزل
 * وطلبات الإذن تُمسح) فتبدو كأنها لم تعمل أصلاً.
 *
 * والعقد المحروس هو عقد B-513: الإعلان قبل أي تفريع، وخارج بوابة الشاشة
 * المعروضة، والصوت بـ`void … .catch(() => {})`.
 *
 * تحديث B-544 (نموذج المالك الخماسي): علامةُ العنوان لم تعد تُوضع من هنا —
 * صارت تُشتقّ من حالة الجلسة في `AppContent` فتبقى حتى تُفتح المحادثة بدل
 * ثانيتين، ويحرسها `sessionCompletionStore.test.ts` (الحمولة ← الوسم) و
 * `pageTitleNotification.test.ts` (البقاء). فما يحرسه هذا الملف اليوم: أن
 * **الصوت** يُعلن كل نهاية فاشلة، وأن العلامة لا تعود إلى طبقة البثّ سهواً
 * فتصير قناتان تتنازعان عنواناً واحداً.
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

const doneIndicatorCalls: number[] = [];
const errorIndicatorCalls: number[] = [];
const errorSoundCalls: number[] = [];
const completionSoundCalls: number[] = [];
let soundRejects = false;
let order = 0;

vi.mock('../../../utils/pageTitleNotification', () => ({
  showCompletionTitleIndicator: () => {
    order += 1;
    doneIndicatorCalls.push(order);
  },
  showErrorTitleIndicator: () => {
    order += 1;
    errorIndicatorCalls.push(order);
  },
  setPageBaseTitle: () => {},
}));

vi.mock('../../../utils/notificationSound', () => ({
  playChatCompletionSound: async () => {
    order += 1;
    completionSoundCalls.push(order);
  },
  // `async` عمداً: الحقيقية كذلك، فرفضُها لا يرمي تزامنياً — وهو ما يجعل عطل
  // الصوت عاجزاً بنيوياً عن إسقاط ما قبله.
  playChatErrorSound: async () => {
    order += 1;
    errorSoundCalls.push(order);
    if (soundRejects) {
      throw new Error('AudioContext blocked');
    }
  },
}));

import type { ControlEventLog } from '../../../contexts/WebSocketContext';

import { resetSessionActivityEpochs } from './sessionActivity';
import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

const VIEWED = 'sess-viewed';
const EMPTY_LOG: ControlEventLog = { events: [], droppedBeforeSeq: 0 };

function runError(frame: Record<string, unknown>) {
  const serverErrors: string[] = [];
  const sessionStore = {
    recordSeq: () => {},
    appendRealtime: () => {},
    updateStreaming: () => {},
    finalizeStreaming: () => {},
    replaceSessionId: () => {},
    withdrawOptimisticUserRow: () => null,
  } as any;

  const props = {
    latestMessage: null as any,
    controlFrames: new Map(),
    controlEvents: EMPTY_LOG,
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
    accumulatedStreamRef: { current: new Map() } as any,
    onServerError: (m: string) => serverErrors.push(m),
    sessionStore,
  };

  const { rerender } = renderHook(
    (delivered: any) => useChatRealtimeHandlers({ ...props, ...delivered } as any),
    { initialProps: {} as any },
  );

  const payload = { kind: 'error', ...frame };
  rerender({
    latestMessage: payload,
    controlEvents: { events: [{ seq: 1, frame: payload }], droppedBeforeSeq: 0 },
  });

  return { serverErrors };
}

describe('نهاية الجولة الفاشلة تُعلَن', () => {
  beforeEach(() => {
    resetSessionActivityEpochs();
    doneIndicatorCalls.length = 0;
    errorIndicatorCalls.length = 0;
    errorSoundCalls.length = 0;
    completionSoundCalls.length = 0;
    soundRejects = false;
    order = 0;
  });

  it('خطأٌ يُعلن القناتين مرّة واحدة لكلٍّ', () => {
    runError({ sessionId: VIEWED, error: 'boom' });

    assert.equal(errorSoundCalls.length, 1, 'الجولة فشلت ولا صوت يبلغ المستخدم');
    // B-544: العلامة تُشتقّ من الحالة؛ وضعُها من هنا يعيد المؤقّت من الباب الخلفي.
    assert.equal(errorIndicatorCalls.length, 0, 'علامة العنوان عادت إلى طبقة البثّ');
  });

  it('الإعلان يسبق أي تفريع لاحق — الانحدار المحروس', () => {
    const { serverErrors } = runError({ sessionId: VIEWED, error: 'boom' });

    // العدّاد يُزاد داخل بديل الصوت قبل أي عمل آخر في المعالج: وقوعُه يعني أن
    // الإعلان لم يسقط خلف بوابةٍ (شاشة معروضة، ورشة باقية، إجهاض).
    assert.equal(errorSoundCalls.length, 1);
    assert.deepEqual(serverErrors.length, 1, 'الشريط الأحمر لم يُعلَن للشاشة المعروضة');
  });

  it('عطل الصوت لا يُسقط بقية المعالج', () => {
    soundRejects = true;
    const { serverErrors } = runError({ sessionId: VIEWED, error: 'boom' });

    assert.equal(errorSoundCalls.length, 1);
    assert.equal(serverErrors.length, 1, 'رفضُ وعدِ الصوت أسقط ما بعده');
  });

  it('لا يقول «تمّ» على جولة فشلت', () => {
    runError({ sessionId: VIEWED, error: 'boom' });

    assert.equal(doneIndicatorCalls.length, 0, 'عُلِّم العنوان [Done] على فشل — كذبة');
    assert.equal(completionSoundCalls.length, 0);
  });

  it('خطأ جلسة **خلفية**: القناتان تعملان والشريط لا (شأن الشاشة المعروضة)', () => {
    const { serverErrors } = runError({ sessionId: 'sess-background', error: 'boom' });

    assert.equal(errorSoundCalls.length, 1, 'خطأ الجلسة الخلفية لا يبلغ الغائب عن التبويب');
    assert.deepEqual(serverErrors, [], 'شريطُ خطأٍ لمحادثة أخرى ظهر على الشاشة المعروضة');
  });

  it('رفضُ إرسالٍ (session_busy) لا يُعلَن نهايةً — الجلسة ما تزال تعمل', () => {
    const { serverErrors } = runError({ sessionId: VIEWED, code: 'session_busy' });

    assert.equal(
      errorIndicatorCalls.length,
      0,
      'عُلِّم العنوان [Error] على جلسة حيّة: «انتهت بفشل» كذبةٌ معكوسة',
    );
    assert.equal(errorSoundCalls.length, 0, 'رنّةُ فشلٍ عن جولة لم تنتهِ');
    assert.equal(serverErrors.length, 1, 'الشريط الأحمر هو سطح هذا الرفض — لا يُحذف معهما');
  });

  it('الرمز المنظَّم داخل error.code يُقرأ كما يُقرأ المسطَّح', () => {
    runError({ sessionId: VIEWED, error: { code: 'session_busy' } });

    assert.equal(errorIndicatorCalls.length, 0, 'الشكل المنظَّم أفلت من الاستثناء');
    assert.equal(errorSoundCalls.length, 0);
  });
});
