/**
 * B-507 — تشغيلٌ ينتهي بخطأ يمسح طلبات الإذن المعلّقة.
 *
 * لماذا هذا حارسٌ لا زينة: `ChatComposer` يُخفي **بطاقة الحالة كاملةً** ما دام
 * هناك طلب إذن معلّق (`!hasPendingPermissions`) — البطاقة وزرّ الإيقاف والنقطة
 * النابضة معاً. وطلبٌ يتيتّم (تشغيل مات وسط الموافقة) كان يبقى في الحالة إلى
 * الأبد لأن مسار `error` وحده لم يكن يمسحه، بينما `complete` يمسحه. النتيجة:
 * كل تشغيلٍ لاحق في تلك الجلسة يعمل بلا أي مؤشّر يراه المستخدم.
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
import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

const SESSION = 'sess-error';

/**
 * ‏`error` يصل عبر **سجلّ أحداث التحكّم** (‏T-1293) ويمرّ إلى `latestMessage`
 * أيضاً كما في الإنتاج — فحفظُه في المحادثة (`appendRealtime`) يبقى على مساره
 * القديم بينما تُطبَّق آثاره على الواجهة من السجلّ.
 */
function harness(errorFrame: Record<string, unknown>) {
  const permissionWrites: unknown[] = [];
  const loadingWrites: boolean[] = [];

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
    setIsLoading: (v: boolean) => loadingWrites.push(v),
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setTokenBudget: () => {},
    setPendingPermissionRequests: (v: unknown) => permissionWrites.push(v),
    pendingViewSessionRef: { current: null } as any,
    streamTimerRef: { current: null } as any,
    accumulatedStreamRef: { current: new Map() } as any,
    sessionStore,
  };

  const { rerender } = renderHook(
    (delivered: any) => useChatRealtimeHandlers({ ...props, ...delivered } as any),
    { initialProps: {} as any },
  );
  rerender({
    latestMessage: errorFrame,
    controlEvents: { events: [{ seq: 1, frame: errorFrame }], droppedBeforeSeq: 0 },
  });
  return { permissionWrites, loadingWrites };
}

describe('useChatRealtimeHandlers — مسار error', () => {
  beforeEach(() => {
    resetSessionActivityEpochs();
  });

  it('يمسح طلبات الإذن المعلّقة للجلسة المعروضة', () => {
    const { permissionWrites } = harness({
      kind: 'error',
      sessionId: SESSION,
      error: 'boom',
    });

    const cleared = permissionWrites.some(
      (value) => Array.isArray(value) && value.length === 0,
    );
    assert.equal(cleared, true, 'error لم يمسح طلبات الإذن — البطاقة تبقى مخفية للأبد');
  });

  it('يُسقط حالة التحميل في المسار نفسه', () => {
    const { loadingWrites } = harness({
      kind: 'error',
      sessionId: SESSION,
      error: 'boom',
    });

    assert.equal(loadingWrites.includes(false), true);
  });

  it('لا يمسّ طلبات جلسةٍ أخرى غير معروضة', () => {
    const { permissionWrites, loadingWrites } = harness({
      kind: 'error',
      sessionId: 'sess-other',
      error: 'boom',
    });

    assert.equal(permissionWrites.length, 0);
    assert.equal(loadingWrites.length, 0);
  });
});
