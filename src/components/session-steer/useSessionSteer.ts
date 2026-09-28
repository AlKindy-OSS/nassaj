import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  SessionSteerRequest,
  SessionSteerResult,
  SteerDeliveryStatus,
  SteerEvent,
  SteerRejectCode,
  SteerTurnState,
} from '../../../shared/session-steer.contract';

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

export interface UseSessionSteerArgs {
  sessionId: string | null;
  currentUserId: number | null;
  latestMessage: { type?: string; [key: string]: unknown } | null;
  controlEvents: ControlEventLogLike;
  sendMessage: (message: unknown) => { ok: boolean; reason?: string } | void;
}

const STEER_CONTROL_EVENT_TYPES = new Set([
  'steer-turn-state',
  'steer-queued',
  'steer-delivered',
  'steer-rejected',
]);

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
  sendMessage,
}: UseSessionSteerArgs) {
  const [turnState, setTurnState] = useState<SteerTurnState | null>(null);
  // T-1904 e2e (bug 3): turnId الذي أُطفئ التوجيه له محلياً بعد رفضٍ يدلّ على
  // تعطيل الميزة — تلقائياً بلا أثر لأي دورٍ لاحق (turnId مختلف).
  const [locallyDisabledForTurnId, setLocallyDisabledForTurnId] = useState<string | null>(null);
  const [events, setEvents] = useState<SteerEvent[]>([]);
  const lastProcessedRef = useRef<unknown>(null);
  const lastEventSeqRef = useRef<number | null>(null);
  const pendingRef = useRef<Map<string, { resolve: (outcome: SteerSendOutcome) => void; timer: ReturnType<typeof setTimeout> }>>(new Map());

  // جلسة جديدة/مغادَرة تصفّر حالة الدور — لا معنى لحمل turnId جلسة سابقة، ولا
  // ينبغي إعادة تشغيل أحداث جلسةٍ أخرى من السجلّ المُلحَق (المشترك بين كل
  // الجلسات) عند الوصول لهذه.
  useEffect(() => {
    setTurnState(null);
    setEvents([]);
    lastEventSeqRef.current = null;
  }, [sessionId]);

  // استهلاك steer-turn-state/steer-queued/steer-delivered/steer-rejected من
  // `controlEvents` — سجلّ مُلحَق لا يبتلع شيئاً (انظر التعليق أعلى الملف).
  useEffect(() => {
    if (!sessionId) return;
    const allEvents = controlEvents.events;
    if (allEvents.length === 0) return;

    // أول مرور لهذه الجلسة: ابدأ من نهاية السجلّ الحالي — لا نُعيد تشغيل
    // أحداث جلساتٍ سابقة (السجلّ عابر لكل الجلسات المفتوحة، بسقف 256).
    if (lastEventSeqRef.current === null) {
      lastEventSeqRef.current = allEvents[0].seq - 1;
    }

    let cursor = lastEventSeqRef.current;
    for (const entry of allEvents) {
      if (entry.seq <= cursor) continue;
      cursor = entry.seq;
      const frame = entry.frame as { type?: string; sessionId?: string; forViewerUserId?: number | null };
      if (!frame || typeof frame.type !== 'string' || !STEER_CONTROL_EVENT_TYPES.has(frame.type)) {
        continue;
      }
      if (frame.sessionId !== sessionId) continue;

      if (frame.type === 'steer-turn-state') {
        // T-1903 (backend fix 44e8ccc4e): إطارٌ عام (forViewerUserId=null، عند
        // بداية الدور) يخصّ الجلسة كلها؛ إطارٌ أحادي المقصد (عند
        // check-session-status) يخصّ مُستقبِله وحده — تجاهل ما يخصّ غيري وإن
        // وصل (دفاعياً؛ unicast لا يُفترض أن يصل أصلاً).
        if (
          typeof frame.forViewerUserId === 'number' &&
          currentUserId != null &&
          frame.forViewerUserId !== currentUserId
        ) {
          continue;
        }
        setTurnState(frame as unknown as SteerTurnState);
      } else {
        const event = frame as unknown as SteerEvent;
        setEvents((previous) => [...previous.slice(-63), event]);
      }
    }
    lastEventSeqRef.current = cursor;
  }, [controlEvents, sessionId, currentUserId]);

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
  /** T-1903: مصدر الأهلية الوحيد — غياب steer-turn-state يعني «غير قابل للتوجيه». */
  const canSteer = Boolean(
    turnState?.steerable &&
    turnState.capability?.midTurnInjection &&
    currentUserId != null &&
    !isStarter &&
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
