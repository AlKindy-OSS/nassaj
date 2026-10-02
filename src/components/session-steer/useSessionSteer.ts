import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  SessionSteerRequest,
  SessionSteerResult,
  SteerDeliveryStatus,
  SteerEvent,
  SteerRejectCode,
  SteerTurnState,
} from '../../../shared/session-steer.contract';
import { readServerErrorCode } from '../chat/utils/serverErrorMessage';

/**
 * T-1903/1904 (client) — «`steer-turn-state`/`steer-queued`/`steer-delivered`/
 * `steer-rejected`» تُستهلَك من `controlEvents` (سجلّ مُلحَق، `seq` +
 * `droppedBeforeSeq`)، **لا** من فتحة `latestMessage` المشتركة.
 *
 * سببٌ مُثبَت ميدانياً لا احترازي: هذه الرسائل تصل بالضبط حين يكون الازدحام
 * أعلى ما يكون (بداية الدور: أول إطار بثّ + session-status غالباً في نفس
 * المللي‑ثانية)، وفتحة `latestMessage` ذات القيمة الواحدة تبتلع رسالةً حين
 * تليها أخرى في نفس دفعة render — بالضبط علّة B-208 الموثَّقة في
 * WebSocketContext.tsx. اختبار مستخدمَين حقيقي (T-1903/1904 e2e) أثبت هذا
 * حرفياً: الخادم أرسل `steerable:true` ولم يظهر زرّ التوجيه للمشاهد إطلاقاً.
 *
 * `session-steer-result` يبقى على `latestMessage`: ردٌّ فرديٌّ لمُرسله فور
 * فعلٍ يُطلقه هو بنفسه (لا يتزاحم مع بثّ الدور نفسه بنفس الطريقة).
 */

export type SteerSendOutcome =
  | { ok: true; deliveryStatus: SteerDeliveryStatus }
  | { ok: false; code: SteerRejectCode | 'disconnected' | 'timeout'; status?: number };

export interface ControlEventLogLike {
  events: readonly { seq: number; frame: unknown }[];
  droppedBeforeSeq: number;
}

/**
 * خريطة إطارات التحكّم الحيّة (أحدث حالة لكل جلسة — `WebSocketContext`'s
 * `ControlFrameMap`)، مُعاد تعريفها هنا محلياً كي لا يستورد هذا الخطّاف من
 * `contexts/WebSocketContext` (يبقيه قابلاً للاختبار بمعزل عن React context).
 */
export interface ControlFrameMapLike {
  get(sessionId: string): { seq: number; frame: unknown } | undefined;
}

export interface UseSessionSteerArgs {
  sessionId: string | null;
  currentUserId: number | null;
  latestMessage: { type?: string; [key: string]: unknown } | null;
  controlEvents: ControlEventLogLike;
  /**
   * B-1449 — إطار `session-status` الأحدث لكل جلسة (حالة، لا حدثاً؛ نفس ما
   * تستهلكه `sessionActivity.ts`). مصدر انتهاء الدور الموثوق الوحيد المتاح
   * للعميل اليوم: الخادم لا يبثّ `steer-turn-state` ثانيةً عند انتهاء الدور
   * (يُعلَن مرّة واحدة فقط عند بدايته — `attachSteerRun` في claude-sdk.js)،
   * فبقاء `turnState` معلَّقاً إلى الأبد بعد `isLoading→false` كان هو العلّة:
   * شريط «CLAUDE ● يفكّر» + زرّ التوجيه يظلّان ظاهرَين حتى تبديل الجلسة أو
   * إعادة التحميل. اختيارٌ متعمَّد ألّا نتّكئ على `isLoading` المحلّي: ذاك
   * يخصّ البادئ فقط (ChatInterface.tsx `isRunActiveForViewer`)، بينما
   * `session-status` إطارٌ عامّ يصل كل مشاهدي الجلسة (مُصادَق في
   * chat-websocket.service.ts) فيُبقي شريط المشاهد ظاهراً طالما الدور حيّ
   * فعلاً، ويمسحه فوراً حين يُصرَّح الخادم بانتهائه — بلا فرضٍ خاطئ على مشاهدٍ
   * دورُه غيره لم ينتهِ. اختياري: غيابه (اختبارات قديمة، أو مستهلكٌ لم يُحدَّث
   * بعد) يُبقي السلوك القديم دون كسر شيء.
   */
  controlFrames?: ControlFrameMapLike;
  sendMessage: (message: unknown) => { ok: boolean; reason?: string } | void;
}

const STEER_CONTROL_EVENT_TYPES = new Set([
  'steer-turn-state',
  'steer-queued',
  'steer-delivered',
  'steer-rejected',
]);

/**
 * B-1470 review — `kind:'error'` codes that reject a SEND attempt rather than
 * end the run, so a live turn must survive them:
 *  - `session_busy` / `steer_requires_session_steer`: a second message (or a
 *    typed "/steer") while the turn runs (claude-sdk.js; B-518 treats
 *    `session_busy` as non-terminal in useChatRealtimeHandlers too);
 *  - `message_dispatch_unconfirmed` / `message_dispatch_not_started`: the
 *    socket handler's catch for a failed command (chat-websocket.service.ts),
 *    which carries the resumed `sessionId` but says nothing about a run that
 *    was already going.
 */
const NON_TERMINAL_ERROR_CODES = new Set([
  'session_busy',
  'steer_requires_session_steer',
  'message_dispatch_unconfirmed',
  'message_dispatch_not_started',
]);

type SteerLogFrame = {
  type?: string;
  kind?: string;
  sessionId?: string;
  forViewerUserId?: number | null;
  notStarted?: unknown;
  code?: unknown;
  error?: unknown;
};

/**
 * B-1470 — does this control event end the current run? `complete` always
 * does; `error` only when it is not a rejected send attempt (`notStarted`, or
 * a code in NON_TERMINAL_ERROR_CODES). The live client receives `complete` at
 * turn end but no session-status{isProcessing:false}.
 */
export function isTurnEndingEvent(frame: SteerLogFrame): boolean {
  if (frame.kind === 'complete') return true;
  if (frame.kind !== 'error' || frame.notStarted === true) return false;
  const code = readServerErrorCode(frame);
  return code == null || !NON_TERMINAL_ERROR_CODES.has(code);
}

type SteerLogAction =
  | { kind: 'turn-ended' }
  | { kind: 'turn-state'; state: SteerTurnState }
  | { kind: 'steer-event'; event: SteerEvent };

/**
 * What one control-log entry means for this session's steer state, or null
 * when it is irrelevant (other session, other kind, unicast for another
 * viewer). The log is ordered by the shared `seq`, so a previous turn's end is
 * applied before the next turn's steer-turn-state and cannot clear it.
 */
export function classifySteerLogEntry(
  raw: unknown,
  sessionId: string,
  currentUserId: number | null,
): SteerLogAction | null {
  const frame = raw as SteerLogFrame | null;
  if (!frame || frame.sessionId !== sessionId) return null;
  if (isTurnEndingEvent(frame)) return { kind: 'turn-ended' };
  if (typeof frame.type !== 'string' || !STEER_CONTROL_EVENT_TYPES.has(frame.type)) return null;
  if (frame.type !== 'steer-turn-state') {
    return { kind: 'steer-event', event: frame as unknown as SteerEvent };
  }
  // T-1903 (backend fix 44e8ccc4e): a broadcast frame (forViewerUserId=null,
  // at turn start) is for the whole session; a unicast one (on
  // check-session-status) is for its recipient only — ignore another viewer's.
  const forOther = typeof frame.forViewerUserId === 'number'
    && currentUserId != null
    && frame.forViewerUserId !== currentUserId;
  return forOther ? null : { kind: 'turn-state', state: frame as unknown as SteerTurnState };
}

const SEND_TIMEOUT_MS = 15_000;

/**
 * T-1904 e2e (bug 3) — رموز رفضٍ تعني «الميزة أُطفئت أثناء الدور نفسه»، لا
 * فشلاً عابراً (سرعة مثلاً). عند وصول أيٍّ منها من `session-steer-result`
 * نُخفي زرّ التوجيه فوراً لبقية هذا الدور بصرف النظر عن steer-turn-state
 * السابق، بدل تركه ظاهراً حتى إطارٍ تالٍ قد لا يصل قبل انتهاء الدور.
 */
const POLICY_DISABLED_REJECT_CODES = new Set<SteerRejectCode>([
  'steer_disabled',
  'steer_not_consented',
  'steer_unsupported',
  'steer_unavailable',
]);

function generateClientMsgId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `steer-${crypto.randomUUID()}`;
    }
  } catch {
    // falls through
  }
  return `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useSessionSteer({
  sessionId,
  currentUserId,
  latestMessage,
  controlEvents,
  controlFrames,
  sendMessage,
}: UseSessionSteerArgs) {
  const [turnState, setTurnState] = useState<SteerTurnState | null>(null);
  // T-1904 e2e (bug 3): turnId الذي أُطفئ التوجيه له محلياً بعد رفضٍ يدلّ على
  // تعطيل الميزة — تلقائياً بلا أثر لأي دورٍ لاحق (turnId مختلف).
  const [locallyDisabledForTurnId, setLocallyDisabledForTurnId] = useState<string | null>(null);
  const [events, setEvents] = useState<SteerEvent[]>([]);
  const lastProcessedRef = useRef<unknown>(null);
  const lastEventSeqRef = useRef<number | null>(null);
  // B-1470 — `seq` of the steer-turn-state entry that set `turnState`. The
  // control-events log and `controlFrames` share one monotonic counter
  // (WebSocketContext `controlSeqRef`), so a session-status whose `seq` is not
  // above this one was stored before the current turn started.
  const turnStateSeqRef = useRef<number | null>(null);
  const pendingRef = useRef<Map<string, { resolve: (outcome: SteerSendOutcome) => void; timer: ReturnType<typeof setTimeout> }>>(new Map());

  // جلسة جديدة/مغادَرة تصفّر حالة الدور — لا معنى لحمل turnId جلسة سابقة، ولا
  // ينبغي إعادة تشغيل أحداث جلسةٍ أخرى من السجلّ المُلحَق (المشترك بين كل
  // الجلسات) عند الوصول لهذه.
  useEffect(() => {
    setTurnState(null);
    setEvents([]);
    lastEventSeqRef.current = null;
    turnStateSeqRef.current = null;
  }, [sessionId]);

  // استهلاك steer-turn-state/steer-queued/steer-delivered/steer-rejected (ونهاية
  // الدور، B-1470) من `controlEvents` — سجلّ مُلحَق لا يبتلع شيئاً (انظر
  // التعليق أعلى الملف). القرار لكل إدخال في `classifySteerLogEntry` أدناه.
  useEffect(() => {
    if (!sessionId) return;
    const allEvents = controlEvents.events;
    if (allEvents.length === 0) return;

    // أول مرور لهذه الجلسة: يُعاد تشغيل السجلّ المحتفَظ به كلّه (من أول إدخال
    // فيه)، لا من نهايته — فيُستعاد steer-turn-state لدورٍ بدأ قبل فتح
    // الجلسة، ونهاية دورٍ سابق تُطبَّق قبل بداية التالي بترتيب `seq`. أحداث
    // الجلسات الأخرى في السجلّ (عابر للجلسات، بسقف 256) تُستبعَد بـ`sessionId`.
    if (lastEventSeqRef.current === null) {
      lastEventSeqRef.current = allEvents[0].seq - 1;
    }

    let cursor = lastEventSeqRef.current;
    for (const entry of allEvents) {
      if (entry.seq <= cursor) continue;
      cursor = entry.seq;
      const action = classifySteerLogEntry(entry.frame, sessionId, currentUserId);
      if (action?.kind === 'turn-ended') {
        turnStateSeqRef.current = null;
        setTurnState(null);
        setEvents([]);
      } else if (action?.kind === 'turn-state') {
        turnStateSeqRef.current = entry.seq;
        setTurnState(action.state);
      } else if (action?.kind === 'steer-event') {
        const { event } = action;
        setEvents((previous) => [...previous.slice(-63), event]);
      }
    }
    lastEventSeqRef.current = cursor;
  }, [controlEvents, sessionId, currentUserId]);

  // B-1449 — انتهاء الدور: `session-status{isProcessing:false}` هو الإعلان
  // العامّ الوحيد الذي يصل بعد إعلان `steer-turn-state` (مرّة واحدة عند
  // البداية) ولا يبتلعه شيء (خريطة «أحدث حالة» لكل جلسة، مصادَقة خادمياً على
  // كل اتصال جديد عبر `check-session-status` — انظر التعليق أعلى
  // `controlFrames` في التوقيع). `isProcessing:true` لا يمسح شيئاً — هذا
  // بالضبط ما يُبقي شريط/زرّ التوجيه ظاهرَين لمشاهدٍ ما زال يرى دوراً حيّاً
  // لغيره. لا نمسح حين لا يوجد turnState أصلاً (لا شيء لنمسحه).
  //
  // B-1470 — الخريطة «أحدث حالة تفوز»، فعند بداية دورٍ ثانٍ ما زالت تحمل
  // `isProcessing:false` من نهاية الدور السابق (لا يسبق `steer-turn-state`
  // الجديد إطارُ `isProcessing:true` بالضرورة)، فكان هذا الأثر يمسح حالة الدور
  // الجديد فور وصولها ويُطفئ التوجيه للدور كلّه. المسح الآن مشروط بأن يكون
  // إطار الانتهاء أحدث (`seq` أعلى، عدّاد مشترك رتيب) من إطار بداية الدور.
  // إطار إعادة الاتصال (`check-session-status`) يأخذ `seq` جديداً فيمسح كما قبل.
  useEffect(() => {
    if (!sessionId || !controlFrames || turnState === null) return;
    const entry = controlFrames.get(sessionId);
    const frame = entry?.frame as { type?: string; isProcessing?: unknown } | undefined;
    const startedAt = turnStateSeqRef.current;
    const arrivedAfterTurnStart = entry != null && (startedAt == null || entry.seq > startedAt);
    if (frame && frame.type === 'session-status' && frame.isProcessing === false && arrivedAfterTurnStart) {
      setTurnState(null);
      setEvents([]);
    }
  }, [controlFrames, sessionId, turnState]);

  // session-steer-result يبقى على latestMessage (انظر التعليق أعلى الملف).
  useEffect(() => {
    if (!latestMessage || latestMessage === lastProcessedRef.current) {
      return;
    }
    lastProcessedRef.current = latestMessage;
    const data = latestMessage as { type?: string; sessionId?: string };
    if (data.type !== 'session-steer-result') {
      return;
    }

    const result = data as unknown as SessionSteerResult;
    // T-1904 e2e (bug 3) — رفضٌ يُخبر أن التوجيه أُطفئ (سياسة الخادم العامة
    // تحوّلت إلى off، أو الموافقة الشخصية أُلغيت) يُخفي زرّ التوجيه لهذا
    // الدور فوراً محلياً — لا ننتظر steer-turn-state تالياً قد لا يصل قبل
    // انتهاء الدور نفسه.
    if (!result.ok && result.code && POLICY_DISABLED_REJECT_CODES.has(result.code) && turnState?.turnId) {
      setLocallyDisabledForTurnId(turnState.turnId);
    }
    const pending = pendingRef.current.get(result.clientMsgId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRef.current.delete(result.clientMsgId);
    pending.resolve(
      result.ok
        ? { ok: true, deliveryStatus: result.deliveryStatus ?? 'queued' }
        : { ok: false, code: result.code ?? 'internal_error', status: result.status },
    );
  }, [latestMessage, turnState]);

  useEffect(() => () => {
    pendingRef.current.forEach(({ timer }) => clearTimeout(timer));
    pendingRef.current.clear();
  }, []);

  const isStarter = turnState != null && currentUserId != null && turnState.starterUserId === currentUserId;
  /**
   * T-1903: مصدر الأهلية الوحيد — غياب steer-turn-state يعني «غير قابل
   * للتوجيه». ADR-190 (تحديث a19af3a88) — `steerable` في الإطار العام
   * (forViewerUserId: null) صار يعني «عضوٌ غير البادئ قد يوجّه» فقط؛ البادئ
   * يقرأ `starterSteerable` حصراً. غيابها (إطارٌ أقدم من قبل df0898ce0) يعني
   * false صراحةً حسب العقد — لا تراجُع إلى `steerable` القديم، فهذا يعني الآن
   * شيئاً مختلفاً كلياً (أهلية غيره لا أهليته هو).
   */
  const starterEligible = turnState?.starterSteerable ?? false;
  const canSteer = Boolean(
    (isStarter ? starterEligible : turnState?.steerable) &&
    turnState?.capability?.midTurnInjection &&
    currentUserId != null &&
    // T-1904 e2e (bug 3): رفضٌ سابق بسبب تعطيل الميزة يُخفي الزرّ فوراً لبقية
    // هذا الدور بعينه — turnId مختلف (دورٌ جديد) يُعيد الأهلية تلقائياً.
    !(turnState.turnId && turnState.turnId === locallyDisabledForTurnId),
  );

  const sendSteer = useCallback(
    (text: string): Promise<SteerSendOutcome> => {
      const trimmed = text.trim();
      // T-1903 (ADR-190 §backend fix 44e8ccc4e): turnId صار nullable — null
      // يعني «لا دورَ قابلاً للتوجيه إطلاقاً» (مزوّدٌ غير Claude، أو دورٌ غير
      // مسلَّح). لا نبني طلباً بمعرّف فارغ.
      if (!sessionId || !turnState || !turnState.turnId) {
        return Promise.resolve({ ok: false, code: 'turn_not_active' });
      }
      if (!trimmed) {
        return Promise.resolve({ ok: false, code: 'text_empty' });
      }
      const clientMsgId = generateClientMsgId();
      const request: SessionSteerRequest = {
        type: 'session-steer',
        sessionId,
        turnId: turnState.turnId,
        clientMsgId,
        text: trimmed,
      };

      return new Promise<SteerSendOutcome>((resolve) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(clientMsgId);
          resolve({ ok: false, code: 'timeout' });
        }, SEND_TIMEOUT_MS);
        pendingRef.current.set(clientMsgId, { resolve, timer });

        const result = sendMessage(request);
        if (result && result.ok === false) {
          clearTimeout(timer);
          pendingRef.current.delete(clientMsgId);
          resolve({ ok: false, code: 'disconnected' });
        }
      });
    },
    [sessionId, turnState, sendMessage],
  );

  return { turnState, events, canSteer, isStarter, sendSteer };
}
