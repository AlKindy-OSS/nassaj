/**
 * B-513 — إعلان نهاية التشغيل أساسٌ لا يُحجب، والصوت قناة تابعة لإعدادها.
 *
 * تحديث B-538 (قرار المالك 2026-08-07): «العلامة تبقى حتى أفتح المحادثة».
 * فعلامةُ العنوان لم تعد تُوضع من هذه الطبقة — صارت تُشتقّ من «انتهت ولم
 * تُفتح» في `AppContent`، فتبقى قائمة بدل ثانيتين. وما يحرسه هذا الملف اليوم:
 * أن الصوت ما زال يُعلن في **كل** نهاية تشغيل مهما اختلفت صورتها، وأن علامة
 * العنوان لا تعود إلى هنا سهواً فتصير قناتان تتنازعان عنواناً واحداً.
 * الحارسان المقابلان: `sessionCompletionStore.test.ts` (متى يقع الوسم)
 * و`pageTitleNotification.test.ts` (أن العلامة المشتقّة بلا مؤقّت).
 *
 * قرار المالك (2026-08-06): «إعداد الصوت يعمل مستقلاً عن مؤشّر حالة المحادثة،
 * فقط يعمل إن كان مفعّلاً؛ أما المؤشّر فهو الأساس».
 *
 * ما يحرسه هذا الملف: كان الاستدعاءان معاً **أسفل** بوابتَي `msg.aborted`
 * و`hasPendingWorkflows`، فأي نهاية تشغيل غير أبسط صورها كانت تُسقط المؤشّر
 * والصوت معاً — والمستخدم لا يعلم أن ردّه جاهز. الآن يُعلَنان قبل أي تفريع،
 * والصوت وحده يفحص إعداده داخل `playChatCompletionSound`.
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

const indicatorCalls: number[] = [];
const soundCalls: number[] = [];
let soundRejects = false;
let order = 0;

vi.mock('../../../utils/pageTitleNotification', () => ({
  showCompletionTitleIndicator: () => {
    order += 1;
    indicatorCalls.push(order);
  },
  showErrorTitleIndicator: () => {},
  setPageBaseTitle: () => {},
}));

vi.mock('../../../utils/notificationSound', () => ({
  // `async` عمداً: الدالة الحقيقية كذلك، فرفضُها لا يرمي تزامنياً — وهذا هو
  // ما يجعل عطل الصوت عاجزاً بنيوياً عن إسقاط ما بعده.
  playChatCompletionSound: async () => {
    order += 1;
    soundCalls.push(order);
    if (soundRejects) {
      throw new Error('AudioContext blocked');
    }
  },
  playChatErrorSound: async () => {},
}));

import { resetSessionActivityEpochs } from './sessionActivity';
import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

const SESSION = 'sess-end';

/**
 * ‏`complete` صار يصل عبر **سجلّ أحداث التحكّم** لا عبر فتحة `latestMessage`
 * (‏T-1293)، والحمولة تمرّ إلى الفتحة أيضاً كما في الإنتاج (تفرّع لا تحويل).
 *
 * والتركيب على سجلّ **فارغ** ثم تسليم الحدث بعده مقصود: كل ما كان في السجلّ
 * لحظة التركيب دون خطّ الأساس فلا يُطبَّق (وهو حارس «لا تُعاد أحداث سابقة عند
 * إعادة التركيب»).
 */
function runComplete(extra: Record<string, unknown>) {
  const sessionStore = {
    recordSeq: () => {},
    appendRealtime: () => {},
    updateStreaming: () => {},
    finalizeStreaming: () => {},
    replaceSessionId: () => {},
  } as any;

  const props = {
    latestMessage: null as any,
    controlFrames: new Map(),
    controlEvents: { events: [], droppedBeforeSeq: 0 },
    provider: 'claude' as const,
    selectedSession: { id: SESSION } as any,
    currentSessionId: SESSION,
    setCurrentSessionId: () => {},
    setIsLoading: () => {},
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setTokenBudget: () => {},
    setPendingPermissionRequests: () => {},
    pendingViewSessionRef: { current: null } as any,
    streamTimerRef: { current: null } as any,
    accumulatedStreamRef: { current: new Map() } as any,
    sessionStore,
  };

  const { rerender } = renderHook(
    (delivered: any) => useChatRealtimeHandlers({ ...props, ...delivered } as any),
    { initialProps: {} as any },
  );

  const frame = { kind: 'complete', sessionId: SESSION, ...extra };
  rerender({
    latestMessage: frame,
    controlEvents: { events: [{ seq: 1, frame }], droppedBeforeSeq: 0 },
  });
}

describe('نهاية التشغيل: المؤشّر أساس والصوت تابع', () => {
  beforeEach(() => {
    resetSessionActivityEpochs();
    indicatorCalls.length = 0;
    soundCalls.length = 0;
    soundRejects = false;
    order = 0;
  });

  it('اكتمالٌ عادي يُعلن الصوت', () => {
    runComplete({});

    assert.equal(soundCalls.length, 1);
  });

  it('تشغيل أُجهض يُعلن نهايته أيضاً — الانحدار المحروس', () => {
    runComplete({ aborted: true });

    assert.equal(
      soundCalls.length,
      1,
      'الإجهاض أسقط الإعلان: المحادثة انتهت والمستخدم لا يعلم',
    );
  });

  it('ورشة خلفية باقية لا تُسقط إعلان اكتمال الردّ', () => {
    runComplete({ pendingWorkflows: 2 });

    assert.equal(
      soundCalls.length,
      1,
      'وجود ورشة أسقط الإعلان: الدور اكتمل فعلاً والردّ جاهز',
    );
  });

  // B-538: العلامة تُشتقّ من الحالة في `AppContent`. وضعُها من هنا أيضاً يعيد
  // المؤقّت ذا الثانيتين من الباب الخلفي: `showTitleIndicator` تجدول إزالتها
  // فور أن تصير الصفحة أمام المستخدم، فتمحو علامةً مشتقّةً يُفترض بقاؤها.
  it('علامة العنوان لا تُوضع من طبقة البثّ', () => {
    runComplete({});
    runComplete({ aborted: true });

    assert.equal(indicatorCalls.length, 0);
  });
});
