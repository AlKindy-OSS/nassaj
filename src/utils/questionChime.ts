/**
 * متى يرنّ «سؤالٌ ينتظر جوابك» (‏T-2041).
 *
 * الحالة نفسها خادميّة (‏B-577) وتصل دلتا `session_outcome`؛ هذا الملف يقرّر
 * شيئاً واحداً: هل تستحقّ هذه الدلتا صوتاً **في هذا التبويب**؟
 *
 *  • **انتقالٌ جديد فقط**: الدلتا ظاهرة بنتيجة `question`، والجلسة لم تكن على
 *    سؤالٍ قبلها، ولم يُرنَّ لنفس (الجلسة، `outcomeAt`) من قبل. اللقطة عند
 *    الإقلاع وإعادة الاتصال لا تمرّ من هنا أصلاً، فلا صوت عند التحميل.
 *  • **تبويبٌ واحد**: آخر تبويبٍ نال التركيز وحده يرنّ (ختمٌ في `localStorage`).
 *  • **لمن يملك الكتابة**: القارئ يرى النقطة ولا يُزعَج بصوت. انظر
 *    `hasLikelyWriteAccess` لحدود هذا الحكم في العميل.
 */

import type { Project } from '../types/app';
import type { SessionOutcome } from '../stores/sessionCompletionStore';

const FOCUS_STAMP_STORAGE_KEY = 'nassajTabFocusStamp';
const MAX_REMEMBERED_CHIMES = 200;

const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const chimedKeys = new Set<string>();
let focusTrackingInstalled = false;

const readFocusStamp = (): { tabId: string; at: number } | null => {
  try {
    const raw = localStorage.getItem(FOCUS_STAMP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tabId?: unknown; at?: unknown };
    return typeof parsed?.tabId === 'string' && typeof parsed.at === 'number'
      ? { tabId: parsed.tabId, at: parsed.at }
      : null;
  } catch {
    return null;
  }
};

/** يختم هذا التبويب آخرَ من نال التركيز. */
export const markTabFocused = (): void => {
  try {
    localStorage.setItem(FOCUS_STAMP_STORAGE_KEY, JSON.stringify({ tabId, at: Date.now() }));
  } catch {
    // تخزينٌ غير متاح: كل تبويب يرنّ — أهون من ألّا يرنّ أحد.
  }
};

/** لا ختم بعد (أو تخزين معطوب) ⇒ هذا التبويب يُعدّ صاحب التركيز. */
export const isMostRecentlyFocusedTab = (): boolean => {
  const stamp = readFocusStamp();
  return !stamp || stamp.tabId === tabId;
};

/** يركّب مستمعي التركيز مرّةً، ويختم التبويب فوراً إن كان مركَّزاً الآن. */
export const installTabFocusTracking = (): void => {
  if (focusTrackingInstalled || typeof window === 'undefined') return;
  focusTrackingInstalled = true;
  window.addEventListener('focus', markTabFocused);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') markTabFocused();
  });
  if (typeof document.hasFocus === 'function' && document.hasFocus()) markTabFocused();
};

/**
 * تقريب العميل لحقّ الكتابة: الخادم لا يبثّ `isProjectWritableByUser` في
 * القائمة ولا في الدلتا. المتاح للمشاهد: `canAccess` (منشئ/عضو/مدير)،
 * و`isOwner`، و`isMember` (مشاركٌ في جلسةٍ من المشروع). مشروعٌ غير معروف ⇒
 * لا صوت (فشلٌ مغلق: النقطة تبقى ظاهرة).
 */
export const hasLikelyWriteAccess = (project: Project | null | undefined): boolean =>
  Boolean(project && (project.canAccess === true || project.isOwner === true || project.isMember === true));

export type QuestionDelta = {
  sessionId: string;
  outcome: SessionOutcome | null;
  outcomeAt: string | null;
  outcomeState: 'visible' | 'seen' | 'absent';
  /** النتيجة المخزَّنة قبل تطبيق الدلتا. */
  previousOutcome: SessionOutcome | null;
  /** مشروع الجلسة من حالة العميل، إن عُرف. */
  project: Project | null | undefined;
};

/**
 * هل تُشغَّل نغمة السؤال لهذه الدلتا؟ يسجّل المفتاح عند الموافقة فلا تتكرّر
 * لنفس الانتقال حتى لو أُعيد بثّه.
 */
export const shouldChimeForQuestionDelta = (delta: QuestionDelta): boolean => {
  if (delta.outcomeState !== 'visible' || delta.outcome !== 'question') return false;
  if (delta.previousOutcome === 'question') return false;
  const key = `${delta.sessionId}\u0000${delta.outcomeAt ?? ''}`;
  if (chimedKeys.has(key)) return false;
  if (!hasLikelyWriteAccess(delta.project)) return false;
  if (!isMostRecentlyFocusedTab()) return false;
  chimedKeys.add(key);
  if (chimedKeys.size > MAX_REMEMBERED_CHIMES) {
    const oldest = chimedKeys.values().next().value;
    if (oldest !== undefined) chimedKeys.delete(oldest);
  }
  return true;
};

/** للاختبارات فقط. */
export const resetQuestionChimeForTests = (): void => {
  chimedKeys.clear();
};

export const getTabIdForTests = (): string => tabId;
