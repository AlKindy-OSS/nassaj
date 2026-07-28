/**
 * B-208 — استهلاك إطارات التحكّم في `useChatRealtimeHandlers`.
 *
 * الشريحة التراكمية بلا مستهلك صحيح لا تُصلح شيئاً؛ هذا الملف يغلق السلسلة:
 * إطار في الخريطة ⇒ `setIsLoading(true)` (ومنه ظهور بطاقة العمليات الجارية).
 *
 * يغطّي أيضاً بند 2 على مسار WS: **غياب `isProcessing` = غير نشطة** — لا
 * «امسح فقط عند false صريح».
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

import type { ControlFrameMap } from '../../../contexts/WebSocketContext';

import { resetSessionActivityEpochs, readSessionActivityEpoch } from './sessionActivity';
import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

const SESSION = 'sess-live';

type Calls = {
  isLoading: boolean[];
  canAbort: boolean[];
  active: (string | null | undefined)[];
  inactive: (string | null | undefined)[];
};

function harness(controlFrames: ControlFrameMap) {
  const calls: Calls = { isLoading: [], canAbort: [], active: [], inactive: [] };
  const sessionStore = {
    recordSeq: () => {},
    appendRealtime: () => {},
    updateStreaming: () => {},
    finalizeStreaming: () => {},
    replaceSessionId: () => {},
  } as any;

  const props = {
    latestMessage: null,
    controlFrames,
    provider: 'claude' as const,
    selectedSession: { id: SESSION } as any,
    currentSessionId: SESSION,
    setCurrentSessionId: () => {},
    setIsLoading: (v: boolean) => calls.isLoading.push(v),
    setCanAbortSession: (v: boolean) => calls.canAbort.push(v),
    setClaudeStatus: () => {},
    setTokenBudget: () => {},
    setPendingPermissionRequests: () => {},
    pendingViewSessionRef: { current: null } as any,
    streamTimerRef: { current: null } as any,
    accumulatedStreamRef: { current: '' } as any,
    onSessionActive: (id?: string | null) => calls.active.push(id),
    onSessionInactive: (id?: string | null) => calls.inactive.push(id),
    sessionStore,
  };

  const { rerender } = renderHook(
    (frames: ControlFrameMap) => useChatRealtimeHandlers({ ...props, controlFrames: frames }),
    { initialProps: controlFrames },
  );
  return { calls, rerender };
}

beforeEach(() => {
  resetSessionActivityEpochs();
});

/** إطار وصل **بعد** تركيب المستهلك (الحالة الطبيعية). */
function frameAfterMount(
  harnessed: ReturnType<typeof harness>,
  seq: number,
  isProcessing?: boolean,
) {
  const frame: Record<string, unknown> = { type: 'session-status', sessionId: SESSION };
  if (isProcessing !== undefined) frame.isProcessing = isProcessing;
  harnessed.rerender(new Map([[SESSION, { seq, frame }]]));
}

describe('استهلاك إطار session-status من الشريحة التراكمية', () => {
  it('isProcessing: true ⇒ يرفع isLoading (تظهر بطاقة العمليات الجارية)', () => {
    const h = harness(new Map());
    frameAfterMount(h, 1, true);

    assert.deepEqual(h.calls.isLoading, [true]);
    assert.deepEqual(h.calls.canAbort, [true]);
    assert.deepEqual(h.calls.active, [SESSION]);
  });

  it('غياب isProcessing ⇒ غير نشطة (لا مؤشّر عالق)', () => {
    const h = harness(new Map());
    frameAfterMount(h, 1);

    assert.deepEqual(h.calls.isLoading, [false]);
    assert.deepEqual(h.calls.canAbort, [false]);
    assert.deepEqual(h.calls.inactive, [SESSION]);
  });

  it('إطاران لجلستين في نفس الدفعة ⇒ كلاهما يُعالَج', () => {
    const h = harness(new Map());
    h.rerender(new Map([
      [SESSION, { seq: 1, frame: { type: 'session-status', sessionId: SESSION, isProcessing: true } }],
      ['other', { seq: 2, frame: { type: 'session-status', sessionId: 'other', isProcessing: true } }],
    ]));

    // الجلسة المعروضة ترفع المؤشّر؛ الأخرى تُبلَّغ للقوائم فقط بلا مساس بالعرض.
    assert.deepEqual(h.calls.isLoading, [true]);
    assert.deepEqual(h.calls.active, [SESSION, 'other']);
  });

  it('إعادة الرسم بنفس الخريطة لا تُعيد المعالجة (حارس التسلسل)', () => {
    const h = harness(new Map());
    frameAfterMount(h, 1, true);
    h.rerender(new Map([
      [SESSION, { seq: 1, frame: { type: 'session-status', sessionId: SESSION, isProcessing: true } }],
    ]));

    assert.deepEqual(h.calls.isLoading, [true], 'أُعيدت معالجة إطار سبق تطبيقه');
  });

  it('إطار جديد بتسلسل أعلى لنفس الجلسة يُعالَج', () => {
    const h = harness(new Map());
    frameAfterMount(h, 1, true);
    frameAfterMount(h, 2, false);

    assert.deepEqual(h.calls.isLoading, [true, false]);
  });

  it('كل إطار يرفع epoch الجلسة فتُبطَل اللقطات المتأخرة (بند 5)', () => {
    const before = readSessionActivityEpoch(SESSION);
    const h = harness(new Map());
    frameAfterMount(h, 1, true);
    assert.ok(readSessionActivityEpoch(SESSION) > before);
  });
});

describe('حرج 2 — إطار بائت سابق لتركيب المستهلك', () => {
  it('إطار موجود في الشريحة عند التركيب لا يُطبَّق (المزوّد في الجذر يبقى، والمستهلك يُفكَّك)', () => {
    // المحاكاة الحرفية للحادثة: جلسة فُتحت خاملة (إطار seq 1 بـ false) ثم صارت
    // حيّة بلا إطار جديد (المخزن دافئ) ⇒ المستخدم يفتح تبويب Terminal ويعود
    // ⇒ ChatInterface يُعاد تركيبه والشريحة ما تزال تحمل الإطار البائت.
    const staleMap: ControlFrameMap = new Map([
      [SESSION, { seq: 1, frame: { type: 'session-status', sessionId: SESSION, isProcessing: false } }],
    ]);
    const { calls } = harness(staleMap);

    assert.deepEqual(
      calls.isLoading,
      [],
      'أُعيد تطبيق إطار بائت ⇒ setIsLoading(false) وسط تشغيل حيّ ⇒ تختفي البطاقة وزر STOP',
    );
    assert.deepEqual(calls.inactive, []);
  });

  it('لا يرفع epoch الجلسة (فلا يُبطل لقطة التعافي التالية)', () => {
    const staleMap: ControlFrameMap = new Map([
      [SESSION, { seq: 7, frame: { type: 'session-status', sessionId: SESSION, isProcessing: false } }],
    ]);
    const before = readSessionActivityEpoch(SESSION);
    harness(staleMap);
    assert.equal(readSessionActivityEpoch(SESSION), before);
  });

  it('إطار جديد بعد التركيب يُطبَّق رغم وجود خطّ أساس', () => {
    const staleMap: ControlFrameMap = new Map([
      [SESSION, { seq: 5, frame: { type: 'session-status', sessionId: SESSION, isProcessing: false } }],
    ]);
    const h = harness(staleMap);
    frameAfterMount(h, 6, true);

    assert.deepEqual(h.calls.isLoading, [true]);
  });

  it('إطار وارد بتسلسل أدنى من خطّ الأساس يُتجاهل (وصول خارج الترتيب)', () => {
    const staleMap: ControlFrameMap = new Map([
      [SESSION, { seq: 9, frame: { type: 'session-status', sessionId: SESSION, isProcessing: false } }],
    ]);
    const h = harness(staleMap);
    frameAfterMount(h, 3, false);

    assert.deepEqual(h.calls.isLoading, []);
  });
});
