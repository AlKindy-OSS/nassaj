/**
 * حالة نهاية جولة المحادثة — الكاتب الخادميّ (B-577).
 *
 * يجلس عند مختنقٍ واحد (`WebSocketWriter.send`) تمرّ به حمولاتُ **كل** مزوّد،
 * فيصير الحكم مكتوباً لمرّةٍ واحدة في القاعدة بدل أن يُشتقّ في كل متصفّح على
 * حِدة. وهذا هو الفرق كلّه: من كان متصفّحه مغلقاً لحظة الانتهاء — أو فتح من
 * جهازٍ آخر، أو كانت الجولة لعضوٍ آخر — كان لا يرى شيئاً أبداً.
 *
 * **قيد أداء ملزم:** `send` تُستدعى مع كل قطعة بثّ (توكن بتوكن). فالحارس
 * `OUTCOME_SIGNAL_KINDS.has(kind)` يسبق كل شيء، وما عداه يخرج فوراً بلا لمس
 * قاعدة ولا اشتقاق.
 */

import * as databaseModule from '@/modules/database/index.js';

import {
  OUTCOME_SIGNAL_KINDS,
  deriveOutcomeSignal,
  type OutcomeSignalPayload,
} from '../../../../shared/session-outcome.js';

/**
 * الجلسات التي وصلها حكمُ نهايةٍ صريح لجولتها الحالية.
 *
 * يميّز خمودَ التأكيد من خمود الانقطاع: `process_state: 'idle'` بعد حكمٍ صريح
 * تأكيدٌ له، وبلا حكمٍ سابق هو «توقّفت دون ردّ». في الذاكرة عمداً: عمرُه عمرُ
 * الجولة، وإعادةُ التشغيل تُنهي كل الجولات على أي حال.
 */
const verdictSeen = new Set<string>();

/**
 * طلبات الأسئلة الحية لكل جلسة؛ كل عنصرٍ مجموعةُ أسماء للسؤال نفسه، لأن
 * المزوّد قد يطلبه بـ`requestId` ثم يحسمه بـ`toolUseId` أو `callId`.
 */
type PendingQuestionState = { identified: Set<Set<string>>; unidentified: number };
const pendingQuestions = new Map<string, PendingQuestionState>();

/** حدٌّ يمنع نموّ المجموعة بلا سقف على خادمٍ يعمل أسابيع. */
const MAX_TRACKED_RUNS = 2000;

/** يُطلق عند كل تغيّر لحالة جلسة، ليبثّه من يملك قناة البثّ (دلتا WS). */
type OutcomeChangeListener = (sessionId: string) => void;
const listeners = new Set<OutcomeChangeListener>();

// A number of focused websocket tests replace the database barrel with the
// smallest repository surface relevant to that test. Namespace linking keeps
// those doubles valid when this cross-cutting observer is imported indirectly;
// production always exposes the repository, while an absent test double simply
// exercises the already-supported non-persistent path.
const sessionOutcomesDb = databaseModule.sessionOutcomesDb;

export function onSessionOutcomeChange(listener: OutcomeChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitChange(sessionId: string): void {
  for (const listener of listeners) {
    try {
      listener(sessionId);
    } catch (error) {
      console.error('[session-outcome] listener failed:', error);
    }
  }
}

function questionAliases(payload: OutcomeSignalPayload): Set<string> {
  const aliases = new Set<string>();
  for (const candidate of [payload.requestId, payload.toolUseId, payload.callId]) {
    if (typeof candidate === 'string' && candidate.trim()) aliases.add(candidate.trim());
  }
  return aliases;
}

function addPendingQuestion(sessionId: string, payload: OutcomeSignalPayload): void {
  const aliases = questionAliases(payload);
  const pending = pendingQuestions.get(sessionId) ?? {
    identified: new Set<Set<string>>(),
    unidentified: 0,
  };
  if (aliases.size > 0) {
    const existing = [...pending.identified].find((question) =>
      [...aliases].some((alias) => question.has(alias))
    );
    if (existing) {
      for (const alias of aliases) existing.add(alias);
    } else {
      pending.identified.add(aliases);
    }
  } else {
    pending.unidentified += 1;
  }
  pendingQuestions.set(sessionId, pending);
}

function pendingQuestionCount(pending: PendingQuestionState): number {
  return pending.identified.size + pending.unidentified;
}

function finishQuestionRemoval(sessionId: string, pending: PendingQuestionState): void {
  if (pendingQuestionCount(pending) > 0) {
    // الحالة ما زالت question، لكن إعادة بث الحقيقة مطلوبة بعد كل resolver ناجح.
    emitChange(sessionId);
    return;
  }
  pendingQuestions.delete(sessionId);
  sessionOutcomesDb.clearOutcome(sessionId);
  emitChange(sessionId);
}

/** يحسم طلب سؤال بعينه، ويزيل الشارة فقط إذا كان آخر طلب حي في الجلسة. */
export function resolveQuestionRequest(sessionId: string, requestId: string): boolean {
  if (!sessionId || !requestId) return false;
  const pending = pendingQuestions.get(sessionId);
  const normalizedId = requestId.trim();
  if (!pending || !normalizedId) return false;
  const question = [...pending.identified].find((aliases) => aliases.has(normalizedId));
  if (!question) return false;
  pending.identified.delete(question);
  finishQuestionRemoval(sessionId, pending);
  return true;
}

function resolveUnidentifiedQuestion(sessionId: string): boolean {
  const pending = pendingQuestions.get(sessionId);
  if (!pending || pending.unidentified <= 0) return false;
  pending.unidentified -= 1;
  finishQuestionRemoval(sessionId, pending);
  return true;
}

function cancelAllQuestionRequests(sessionId: string): void {
  pendingQuestions.delete(sessionId);
}

/**
 * يطبّق حمولةً واحدة على حالة الجلسة. يُستدعى من `WebSocketWriter.send` بعد
 * حارس النوع، ومن مراقب العمليات عند بدء الجولة وخمودها.
 *
 * لا يرمي أبداً: عطبٌ في تسجيل شارةٍ لا يجوز أن يُسقط بثّ المحادثة نفسها.
 */
export function applyOutcomePayload(sessionId: string, payload: OutcomeSignalPayload): void {
  if (!sessionId) return;
  try {
    const kind = payload.kind;
    if (kind === 'permission_request' || kind === 'interactive_prompt') {
      addPendingQuestion(sessionId, payload);
      sessionOutcomesDb.recordOutcome(
        sessionId,
        'question',
        typeof payload.provider === 'string' ? payload.provider : null,
      );
      emitChange(sessionId);
      return;
    }

    if (kind === 'permission_cancelled') {
      const aliases = questionAliases(payload);
      if (aliases.size > 0) {
        for (const alias of aliases) {
          if (resolveQuestionRequest(sessionId, alias)) break;
        }
      } else {
        resolveUnidentifiedQuestion(sessionId);
      }
      return;
    }

    const signal = deriveOutcomeSignal(payload, { hasVerdict: verdictSeen.has(sessionId) });
    if (!signal) return;

    if (signal.action === 'clear') {
      // `process_state:running` قد يكون استئنافاً بعد حسم سؤال واحد بينما سؤال
      // آخر ما زال معلقاً؛ التسجيل الصريح لجولة جديدة هو الذي يلغي الكل.
      if (kind === 'status' && pendingQuestions.has(sessionId)) return;
      // الإلغاء الطرفي حكمٌ صريح بأنه لا شارة. احتفظ بشاهده حتى لا يعيد
      // `markRunEnded` تصنيفه خطأً على أنه «توقّف دون ردّ» بعد لحظات.
      if (payload.kind === 'complete' && payload.aborted === true && payload.success !== false) {
        if (verdictSeen.size >= MAX_TRACKED_RUNS) verdictSeen.clear();
        verdictSeen.add(sessionId);
      } else {
        verdictSeen.delete(sessionId);
      }
      sessionOutcomesDb.clearOutcome(sessionId);
      if (kind === 'complete') cancelAllQuestionRequests(sessionId);
      emitChange(sessionId);
      return;
    }

    // `question` حالةٌ منتظِرة لا حكمَ نهاية: لا تُسجَّل شاهداً على الجولة، وإلا
    // عُدّ خمودُها بعد سؤالٍ بلا جواب «نهايةً محكوماً عليها».
    if (signal.outcome !== 'question') {
      if (verdictSeen.size >= MAX_TRACKED_RUNS) verdictSeen.clear();
      verdictSeen.add(sessionId);
    }
    const provider = typeof payload.provider === 'string' ? payload.provider : null;
    cancelAllQuestionRequests(sessionId);
    sessionOutcomesDb.recordOutcome(sessionId, signal.outcome, provider);
    emitChange(sessionId);
  } catch (error) {
    console.error('[session-outcome] failed to apply payload:', error);
  }
}

/** بدءُ جولةٍ جديدة يُسقط حكم سابقتها ويُصفّر شاهدها. */
export function markRunStarted(sessionId: string): void {
  if (!sessionId) return;
  try {
    verdictSeen.delete(sessionId);
    // لا يُستدعى إلا لتسجيل جولة جديدة فعلياً؛ إعادة التسجيل لنفس العملية
    // تُصفّى في session-process-monitor قبل الوصول إلى هنا.
    cancelAllQuestionRequests(sessionId);
    sessionOutcomesDb.clearOutcome(sessionId);
    emitChange(sessionId);
  } catch (error) {
    console.error('[session-outcome] failed to clear on run start:', error);
  }
}

/**
 * يُثبّت وصولَ حكمٍ طرفي موثوق قبل وصول حمولته المعيارية إلى الكاتب.
 *
 * بعض المزوّدين (Codex تحديداً) يعلنون نجاح الجولة ثم يغلقون العملية، بينما
 * تُستكمل أعمالٌ خادمية قصيرة قبل إرسال `complete`. قد يلاحظ مراقب العملية
 * الخمود خلال هذه الفجوة؛ هذا الشاهد يمنعه من اختراع `error`، من دون أن يكتب
 * `done` مبكراً أو يرسل حمولة نهاية مكررة. الحمولة المعيارية اللاحقة تبقى هي
 * التي تكتب الحكم الفعلي.
 */
export function markRunVerdictSeen(sessionId: string): void {
  if (!sessionId) return;
  if (verdictSeen.size >= MAX_TRACKED_RUNS) verdictSeen.clear();
  verdictSeen.add(sessionId);
}

/**
 * خمودُ الجولة. بلا حكمٍ صريح سابق فهي «توقّفت دون ردّ» — وهذا الموضع هو
 * **الوحيد** الذي يعرفها: الجولة التي مات مقبسها لا تصل عنها حمولةٌ إلى أي
 * متصفّح، فلا يمكن للعميل أن يعرفها أبداً.
 */
export function markRunEnded(sessionId: string): void {
  if (!sessionId) return;
  try {
    if (verdictSeen.has(sessionId)) {
      verdictSeen.delete(sessionId);
      return;
    }
    cancelAllQuestionRequests(sessionId);
    sessionOutcomesDb.recordOutcome(sessionId, 'error');
    emitChange(sessionId);
  } catch (error) {
    console.error('[session-outcome] failed to record silent stop:', error);
  }
}

/** الحارس الذي يسبق كل شيء عند نقطة الكتابة الساخنة. */
export function isOutcomeSignalKind(kind: unknown): boolean {
  return typeof kind === 'string' && OUTCOME_SIGNAL_KINDS.has(kind);
}

/** يعلن تغييراً إدارياً (قراءة/غير مقروء) عبر قناة الدلتا نفسها. */
export function notifyOutcomeChanged(sessionId: string): void {
  if (sessionId) emitChange(sessionId);
}
