/**
 * حالة نهاية جولة المحادثة — مرآةٌ عميليّة لحقيقةٍ خادميّة (B-577).
 *
 * كانت هذه الحالة تُشتقّ في المتصفّح وتُخزَّن في `localStorage`، فمن كان
 * متصفّحه مغلقاً لحظة الانتهاء — أو فتح من جهازٍ آخر، أو كانت الجولة لعضوٍ آخر
 * — **لا يرى شارة أبداً**. لقطة المالك 2026-08-08: تسع محادثات أنهت عملها، صفر
 * شارات. ومطلبُه: «هذه الشارات مرتبطة بالمحادثات ومن غير المهم هي تعمل تحت أي
 * مستخدم، أي مستخدم يجب أن يتمكن من معرفة عدد المحادثات النشطة وحالتها».
 *
 * فصارت الحقيقة خادميّة (`session_run_outcomes`)، وصار هذا الملف مرآةً لها:
 *   • **لقطة** عند الإقلاع وبعد كل إعادة اتصال (`/outcomes/unseen`) — وتحمل
 *     الأسئلة القائمة دائماً، والانتهاء/الخطأ ما لم يُقرأا عالمياً.
 *   • **دلتا** لحظية عبر WebSocket عند كل تغيّر.
 *   • **إقرارٌ عالميّ** عند فتح نتيجة مكتملة/مخطئة (`POST …/outcome-seen`).
 *     أمّا `question` فلا يمسّه الفتح؛ يبقى حتى الإجابة أو الإلغاء.
 *
 * والواجهة العامّة لم تتغيّر (`useSessionOutcome`, `useProjectOutcome`,
 * `useTopOutcome`, `markSessionOutcome`, `clearSessionOutcome`) — تبدّل سنَدُها
 * وحده، فلا مستهلكَ واحد يحتاج تعديلاً.
 *
 * ‏`running`/`frozen` ليستا هنا: مصدرهما `sessionProcessStateStore` (بثّ حيّ من
 * مراقب العمليات + presence)، وهما مشتركتان أصلاً.
 */

import { useSyncExternalStore } from 'react';

import { authenticatedFetch } from '../utils/api';
import {
  strongerOutcome,
  type SessionOutcome,
} from '../../shared/session-outcome';

export type { SessionOutcome };
export { strongerOutcome };

/**
 * لا يكون فعل «غير مقروء» ذا معنى إلا لنتيجة نهائية قُرئت عالمياً.
 * السؤال لا يُقرأ بالفتح أصلاً، والنتيجة الظاهرة لا تحتاج إعادة.
 */
export function canMarkOutcomeUnread(
  outcome: SessionOutcome | null | undefined,
  outcomeSeen: boolean | undefined,
): boolean {
  return (outcome === 'done' || outcome === 'error') && outcomeSeen === true;
}

// ---------------------------------------------------------------------------
// الحالة الحيّة (ذاكرةٌ فقط — القاعدة هي مصدر الحقيقة)
// ---------------------------------------------------------------------------

type StoredOutcome = {
  outcome: SessionOutcome;
  outcomeAt: string | null;
};
export type OutcomeState = 'visible' | 'seen' | 'absent';

let outcomeById: ReadonlyMap<string, StoredOutcome> = new Map();

// Each WS delta advances this clock, including a `null` delta. Keeping the
// tombstone generation is what lets both a deferred REST snapshot and stale
// sidebar props distinguish "no live knowledge" from "the server just cleared it".
let deltaGeneration = 0;
const lastDeltaGenerationById = new Map<string, number>();
const terminalOutcomeStateById = new Map<string, Exclude<OutcomeState, 'visible'>>();
let latestRefreshRequestId = 0;

// React effects may observe the same selected outcome more than once. CAS makes
// duplicate POSTs safe, but not free; one request per (session, outcomeAt) is enough.
const acknowledgementInFlight = new Map<string, string>();

/**
 * جلساتٌ علّمها المستخدم يدوياً «غير مقروءة» وهو ما يزال داخلها.
 * تمنع أحداث focus من إبطال الفعل فوراً، وتسقط عند المغادرة أو دلتا جديدة.
 */
// The timestamp pins the manual unread intent to one terminal outcome. A newer
// outcome must clear the guard so opening it can acknowledge that newer result.
const manuallyUnread = new Map<string, string | null>();

// DELETE broadcasts before its HTTP response is observed. Keep the guard alive
// across that window or the selected-session effect can immediately POST seen.
const markUnreadRequestBySession = new Map<string, number>();
let nextMarkUnreadRequestId = 0;

function reconcileManualUnreadWithSnapshot(snapshot: ReadonlyMap<string, StoredOutcome>): void {
  for (const [sessionId, guardedOutcomeAt] of manuallyUnread) {
    const snapshotOutcomeAt = snapshot.get(sessionId)?.outcomeAt;
    const requestInFlight = markUnreadRequestBySession.has(sessionId);
    if (requestInFlight && guardedOutcomeAt == null) continue;
    if (snapshotOutcomeAt !== guardedOutcomeAt) {
      manuallyUnread.delete(sessionId);
      markUnreadRequestBySession.delete(sessionId);
    }
  }
}

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: Map<string, StoredOutcome>): void {
  outcomeById = next;
  emitChange();
}

/**
 * ‏مفتاحا التخزين المهجوران. الحالة صارت خادميّة، فبقاؤهما يعني مصدرَين
 * لمعنى الشارة — وأحدهما تخمينُ عميلٍ يُعرض كحقيقة، وهو صنفُ العطب الذي جاء
 * هذا التغيير يستأصله. يُحذفان مرّةً عند أول تحميل.
 */
function purgeLegacyKeys(): void {
  try {
    localStorage.removeItem('nassajSessionOutcomes');
    localStorage.removeItem('sidebarSessionsFinishedUnopened');
  } catch {
    // تخزينٌ غير متاح (وضع خاص/حصة) — لا شيء يُفعل.
  }
}

if (typeof window !== 'undefined') {
  purgeLegacyKeys();
}

// ---------------------------------------------------------------------------
// المزامنة مع الخادم
// ---------------------------------------------------------------------------

/**
 * يستبدل اللقطة كاملةً بما يقوله الخادم: هذه هي الحقيقة، وما ليس فيها إمّا
 * أُقرّ به أو لم يقع.
 */
export function applyOutcomeSnapshot(
  rows: ReadonlyArray<{
    sessionId: string;
    outcome: SessionOutcome;
    outcomeAt?: string | null;
  }>,
): void {
  const next = new Map<string, StoredOutcome>();
  for (const row of rows) {
    if (row?.sessionId && row.outcome) {
      next.set(row.sessionId, {
        outcome: row.outcome,
        outcomeAt: row.outcomeAt ?? null,
      });
    }
  }
  reconcileManualUnreadWithSnapshot(next);
  lastDeltaGenerationById.clear();
  terminalOutcomeStateById.clear();
  acknowledgementInFlight.clear();
  commit(next);
}

/** دلتا لحظية: حكمٌ جديد لجلسة، أو `null` لسقوطه (بدأت جولة/أُجيب السؤال). */
export function applyOutcomeDelta(
  sessionId: string,
  outcome: SessionOutcome | null,
  outcomeAt: string | null = null,
  outcomeState: OutcomeState = outcome ? 'visible' : 'absent',
): void {
  if (!sessionId) return;
  if (outcomeState === 'visible' && !outcome) return;
  const current = outcomeById.get(sessionId);
  if (
    (outcomeState !== 'visible'
      && !current
      && terminalOutcomeStateById.get(sessionId) === outcomeState)
    || (outcomeState === 'visible'
      && current?.outcome === outcome
      && current.outcomeAt === outcomeAt)
  ) return;
  deltaGeneration += 1;
  lastDeltaGenerationById.set(sessionId, deltaGeneration);
  acknowledgementInFlight.delete(sessionId);
  let preserveManualUnread = false;
  if (outcomeState === 'visible' && markUnreadRequestBySession.has(sessionId)) {
    const guardedOutcomeAt = manuallyUnread.get(sessionId);
    if (guardedOutcomeAt == null) {
      // The first visible delta after DELETE is the restored terminal outcome.
      // Pin the guard now so a later run with a different timestamp can clear it.
      manuallyUnread.set(sessionId, outcomeAt);
      preserveManualUnread = true;
    } else {
      preserveManualUnread = guardedOutcomeAt === outcomeAt;
      if (!preserveManualUnread) markUnreadRequestBySession.delete(sessionId);
    }
  } else if (outcomeState === 'visible') {
    preserveManualUnread = manuallyUnread.has(sessionId)
      && manuallyUnread.get(sessionId) === outcomeAt;
  }
  if (!preserveManualUnread) {
    manuallyUnread.delete(sessionId);
    if (outcomeState !== 'visible') markUnreadRequestBySession.delete(sessionId);
  }
  const next = new Map(outcomeById);
  if (outcomeState === 'visible') {
    if (!outcome) return; // guarded above; keeps the discriminant explicit to TypeScript
    terminalOutcomeStateById.delete(sessionId);
    next.set(sessionId, { outcome, outcomeAt });
  } else {
    terminalOutcomeStateById.set(sessionId, outcomeState);
    next.delete(sessionId);
  }
  commit(next);
}

/** يجلب لقطة الحالات المشتركة الظاهرة — عند الإقلاع وبعد كل إعادة اتصال. */
export async function refreshOutcomes(): Promise<boolean> {
  const requestId = ++latestRefreshRequestId;
  const generationAtStart = deltaGeneration;
  try {
    const response = await authenticatedFetch('/api/providers/sessions/outcomes/unseen');
    if (!response.ok) return false;
    const data = await response.json();
    if (!Array.isArray(data?.outcomes) || requestId !== latestRefreshRequestId) return false;

    const snapshot = new Map<string, StoredOutcome>();
    for (const row of data.outcomes as Array<{
      sessionId?: unknown;
      outcome?: unknown;
      outcomeAt?: unknown;
    }>) {
      if (
        typeof row?.sessionId !== 'string'
        || (row.outcome !== 'question' && row.outcome !== 'error' && row.outcome !== 'done')
      ) continue;
      snapshot.set(row.sessionId, {
        outcome: row.outcome,
        outcomeAt: typeof row.outcomeAt === 'string' ? row.outcomeAt : null,
      });
    }

    const next = new Map<string, StoredOutcome>();
    const ids = new Set([...outcomeById.keys(), ...snapshot.keys()]);
    for (const sessionId of ids) {
      const changedDuringRequest = (lastDeltaGenerationById.get(sessionId) ?? 0) > generationAtStart;
      const current = outcomeById.get(sessionId);
      if (changedDuringRequest) {
        if (current) next.set(sessionId, current);
        continue;
      }

      const fromSnapshot = snapshot.get(sessionId);
      if (!fromSnapshot) {
        terminalOutcomeStateById.set(sessionId, 'absent');
        continue;
      }
      terminalOutcomeStateById.delete(sessionId);

      // A newer live timestamp must not regress even if it preceded this fetch.
      if (
        current?.outcomeAt
        && fromSnapshot.outcomeAt
        && current.outcomeAt > fromSnapshot.outcomeAt
      ) {
        next.set(sessionId, current);
      } else {
        next.set(sessionId, fromSnapshot);
      }
    }
    reconcileManualUnreadWithSnapshot(next);
    acknowledgementInFlight.clear();
    commit(next);
    return true;
  } catch {
    // شبكةٌ متعذّرة: تبقى اللقطة السابقة. لا شارة تُخترع ولا تُمحى بالظنّ.
    return false;
  }
}

/**
 * إقرارٌ عالميّ برؤية نتيجة محادثة مكتملة أو مخطئة.
 *
 * ‏`question` ليس «نتيجة مقروءة»: لا يُمسح محلياً ولا يُرسل نداء، فيبقى
 * لدى الجميع حتى تأتي دلتا الإجابة أو الإلغاء من الخادم.
 * والنتيجة النهائية لا تُمسح تفاؤلياً؛ دلتا الخادم وحدها تؤكد نجاح CAS، فلا يخفي
 * العميل حكماً أحدث إذا رفض الخادم ختماً قديماً.
 */
export function acknowledgeOutcome(sessionId: string): void {
  if (!sessionId) return;
  const stored = outcomeById.get(sessionId);
  if (!stored || stored.outcome === 'question' || !stored.outcomeAt) return;
  if (manuallyUnread.has(sessionId)) return;
  if (acknowledgementInFlight.get(sessionId) === stored.outcomeAt) return;
  acknowledgementInFlight.set(sessionId, stored.outcomeAt);
  void authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/outcome-seen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedOutcomeAt: stored.outcomeAt }),
  }).then((response) => {
    if (!response.ok && acknowledgementInFlight.get(sessionId) === stored.outcomeAt) {
      acknowledgementInFlight.delete(sessionId);
    }
  }).catch(() => {
    if (acknowledgementInFlight.get(sessionId) === stored.outcomeAt) {
      acknowledgementInFlight.delete(sessionId);
    }
  });
}

/** Captures the exact terminal result present at an explicit route opening. */
export function getOutcomeAcknowledgementToken(sessionId: string): string | null {
  const stored = outcomeById.get(sessionId);
  if (!stored || stored.outcome === 'question' || !stored.outcomeAt) return null;
  return stored.outcomeAt;
}

/**
 * Keeps page-visibility policy explicit and optionally pins a deferred opening
 * to the exact result that was visible when the opening happened.
 */
export function acknowledgeOutcomeWhenActive(
  sessionId: string,
  isActive: boolean,
  expectedOutcomeAt?: string,
): void {
  if (!isActive) return;
  if (
    expectedOutcomeAt !== undefined
    && outcomeById.get(sessionId)?.outcomeAt !== expectedOutcomeAt
  ) return;
  acknowledgeOutcome(sessionId);
}

/**
 * ‏T-1340 — «تحديد كغير مقروء»: يُبطل الإقرار العالميّ، فتعود الشارة للجميع.
 *
 * والخادمُ يُرجع الحكم القائم ويبثّه، فتُعرض الشارة فوراً بلا جلبٍ ثانٍ. وتُسجَّل
 * الجلسة «غير مقروءة يدوياً» كي لا يُبطل الإقرارُ التلقائي الفعلَ في اللحظة
 * التالية وهو ما يزال ينظر إليها.
 */
export async function markOutcomeUnread(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  const requestId = ++nextMarkUnreadRequestId;
  markUnreadRequestBySession.set(sessionId, requestId);
  manuallyUnread.set(sessionId, outcomeById.get(sessionId)?.outcomeAt ?? null);
  try {
    const response = await authenticatedFetch(
      `/api/providers/sessions/${encodeURIComponent(sessionId)}/outcome-seen`,
      { method: 'DELETE' },
    );
    if (markUnreadRequestBySession.get(sessionId) !== requestId) return response.ok;
    if (!response.ok) {
      markUnreadRequestBySession.delete(sessionId);
      manuallyUnread.delete(sessionId);
      return false;
    }
    const data = await response.json();
    if (markUnreadRequestBySession.get(sessionId) !== requestId) return true;
    const outcome = (data?.outcome ?? null) as SessionOutcome | null;
    if (!outcome) {
      markUnreadRequestBySession.delete(sessionId);
      manuallyUnread.delete(sessionId);
      return false;
    }
    // قد يسبق بثّ DELETE هذه الاستجابة؛ يعيد البثّ الحالة ويحذف الحارس بوصفه
    // دلتا. نجاح الطلب هو النقطة الحاسمة، لذا نعيد تثبيت الحارس بعدها.
    markUnreadRequestBySession.delete(sessionId);
    const outcomeAt = typeof data?.outcomeAt === 'string' ? data.outcomeAt : null;
    const current = outcomeById.get(sessionId);
    if (current?.outcomeAt && outcomeAt && current.outcomeAt !== outcomeAt) {
      // A newer terminal result arrived while DELETE was in flight. Do not let
      // the older HTTP response overwrite it or protect it from acknowledgement.
      manuallyUnread.delete(sessionId);
      return true;
    }
    manuallyUnread.set(sessionId, outcomeAt);
    // لا نستعمل applyOutcomeDelta هنا: هذه ليست دلتا جديدة تلغي الحارس، بل
    // الاستجابة للفعل الذي أنشأه. بثّ الخادم اللاحق مطابق فيكون idempotent.
    const next = new Map(outcomeById);
    terminalOutcomeStateById.delete(sessionId);
    next.set(sessionId, {
      outcome,
      outcomeAt,
    });
    commit(next);
    return true;
  } catch {
    if (markUnreadRequestBySession.get(sessionId) === requestId) {
      markUnreadRequestBySession.delete(sessionId);
      manuallyUnread.delete(sessionId);
    }
    return false;
  }
}

/** مغادرةُ المحادثة تُسقط علامة «غير مقروء يدوياً»: فتحُها بعدها إقرارٌ جديد. */
export function releaseManualUnread(exceptSessionId?: string | null): void {
  const sessionIds = new Set([
    ...manuallyUnread.keys(),
    ...markUnreadRequestBySession.keys(),
  ]);
  for (const id of sessionIds) {
    if (id !== exceptSessionId) {
      manuallyUnread.delete(id);
      markUnreadRequestBySession.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// الواجهة التي يستهلكها العرض (لم تتغيّر)
// ---------------------------------------------------------------------------

/** Reactive: حالة هذه الجلسة، أو `null`. */
export function useSessionOutcome(sessionId?: string | null): SessionOutcome | null {
  return useSyncExternalStore(subscribe, () =>
    sessionId ? outcomeById.get(sessionId)?.outcome ?? null : null,
  );
}

/**
 * Reactive source for the sidebar action. Only an explicit WS `seen` state can
 * override stale REST props to show the action; `absent` explicitly hides it.
 */
export function useCanMarkOutcomeUnread(
  sessionId: string,
  rawOutcome: SessionOutcome | null | undefined,
  rawOutcomeSeen: boolean | undefined,
): boolean {
  return useSyncExternalStore(subscribe, () => {
    if (outcomeById.has(sessionId)) return false;
    const terminalState = terminalOutcomeStateById.get(sessionId);
    if (terminalState === 'seen') {
      return rawOutcome === 'done' || rawOutcome === 'error';
    }
    if (terminalState === 'absent') return false;
    return canMarkOutcomeUnread(rawOutcome, rawOutcomeSeen);
  });
}

/**
 * Project-level rollup: أعلى حالة أولويةً بين جلسات المشروع المعطاة.
 * الأولوية: `question` ثم `error` ثم `done`.
 */
export function useProjectOutcome(
  sessionIds: ReadonlyArray<string | null | undefined>,
): SessionOutcome | null {
  return useSyncExternalStore(subscribe, () => {
    let best: SessionOutcome | null = null;
    for (const id of sessionIds) {
      if (!id) continue;
      best = strongerOutcome(best, outcomeById.get(id)?.outcome ?? null);
    }
    return best;
  });
}

/**
 * أعلى حالة تنتظر المستخدمَ في التطبيق كلّه — تقودها علامة عنوان التبويب.
 */
export function useTopOutcome(): SessionOutcome | null {
  return useSyncExternalStore(subscribe, () => {
    let best: SessionOutcome | null = null;
    for (const stored of outcomeById.values()) {
      best = strongerOutcome(best, stored.outcome);
    }
    return best;
  });
}

/** عدد المحادثات التي تنتظر هذا المستخدم — «كم محادثة وحالتها». */
export function useOutcomeCounts(): Record<SessionOutcome, number> {
  return useSyncExternalStore(
    subscribe,
    () => countsSnapshot,
  );
}

let countsSnapshot: Record<SessionOutcome, number> = { question: 0, error: 0, done: 0 };
subscribe(() => {
  const next: Record<SessionOutcome, number> = { question: 0, error: 0, done: 0 };
  for (const stored of outcomeById.values()) next[stored.outcome] += 1;
  countsSnapshot = next;
});

// ---------------------------------------------------------------------------
// توافقٌ مع المستهلكين القائمين
// ---------------------------------------------------------------------------

/**
 * ‏الكتابة صارت خادميّة، فهاتان تُبقيان العرض لحظياً بين وصول الحمولة ووصول
 * الدلتا — ولا تكتبان شيئاً دائماً. الحقيقة يكتبها الخادم عند مختنق الإرسال.
 */
export function markSessionOutcome(sessionId: string, outcome: SessionOutcome): void {
  applyOutcomeDelta(sessionId, outcome, null, 'visible');
}

export function clearSessionOutcome(sessionId: string): void {
  applyOutcomeDelta(sessionId, null, null, 'absent');
}

/** Clears every account-derived outcome and invalidates deferred REST reads. */
export function resetSessionCompletionStore(): void {
  latestRefreshRequestId += 1;
  deltaGeneration += 1;
  outcomeById = new Map();
  lastDeltaGenerationById.clear();
  terminalOutcomeStateById.clear();
  acknowledgementInFlight.clear();
  manuallyUnread.clear();
  markUnreadRequestBySession.clear();
  countsSnapshot = { question: 0, error: 0, done: 0 };
  emitChange();
}

if (typeof window !== 'undefined') {
  window.addEventListener('auth:identity-changing', resetSessionCompletionStore);
}
