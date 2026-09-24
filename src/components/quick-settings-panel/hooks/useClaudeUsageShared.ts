/**
 * T-1822: مخزن مشترك على مستوى الوحدة لبيانات استخدام Claude.
 *
 * المشكلة: useClaudeUsage كان يُستدعى مستقلاً من ثلاثة أماكن
 * (HeaderUsageIndicator، ClaudeUsageCollapsed، ClaudeUsageSection)
 * فكل نسخة تُشغّل مؤقّتها الخاص (180s) وتُطلق طلبها وحدها.
 *
 * الحل: مخزن وحيد module-level يمتلك المؤقّت، يُطلب بطلب واحد، ويُخبر
 * كل المشتركين عبر useSyncExternalStore. لا يُشغَّل المؤقّت إلا حين يوجد
 * مشترك واحد على الأقل (enabled).
 *
 * إضافات على useClaudeUsage القديم:
 *  - notifyTurnEnd(): يُستدعى من ChatInterface عند انتهاء دور (isLoading→false)
 *    لإعادة الجلب فوراً.
 *  - إعادة جلب تلقائية عند visibilitychange→visible وfocus (مرة واحدة للتطبيق
 *    كله لا نسخة لكل مكوّن).
 *  - عزل تبديل المستخدم (B/fix-2): userId يحدّد هوية مالك البيانات؛ تغييره
 *    يُعيد ضبط المخزن ويُلغي الطلبات الجارية لمنع مستخدم ب من رؤية بيانات أ.
 *  - إعادة ضبط المخزن حين enabledCount يصل صفر لمنع رؤية البيانات القديمة
 *    عند إعادة تفعيل المكوّنات بمستخدم مختلف.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../../../utils/api';
import type { ClaudeUsage, ClaudeUsageState } from '../claudeUsageTypes';

// مطابق لـ CACHE_TTL_MS على الخادم — نُحدَّث بنفس معدّل الخادم.
const REFRESH_INTERVAL_MS = 180_000;

/* ------------------------------------------------------------------ */
/*  هيكل المخزن الداخلي                                                */
/* ------------------------------------------------------------------ */

/**
 * ownedByUserId: معرّف المستخدم الذي جُلبت بياناته (للكشف الفوري بالتزامن
 * عن snapshot قديم قبل تنفيذ useEffect عند تبديل الحساب — fix-5).
 */
type StoreState = ClaudeUsageState & { ownedByUserId: string | null };

let state: StoreState = { status: 'idle', ownedByUserId: null };
let requestId = 0;
let intervalId: number | null = null;
let enabledCount = 0;
/** معرّف المستخدم الحالي — يُعاد الضبط عند تبديل الحساب. */
let activeUserId: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function getSnapshot(): StoreState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/* ------------------------------------------------------------------ */
/*  إعادة الضبط                                                         */
/* ------------------------------------------------------------------ */

function resetStore(): void {
  requestId += 1; // يُلغي كل الطلبات الجارية
  state = { status: 'idle', ownedByUserId: null };
  notify();
}

/* ------------------------------------------------------------------ */
/*  الجلب                                                               */
/* ------------------------------------------------------------------ */

async function fetchUsage(): Promise<void> {
  const id = ++requestId;
  // نُثبِّت المالك لحظة الجلب — أي ردّ يعود بعد تبديل الحساب سيُتجاهَل بحارس requestId.
  const ownerAtStart = activeUserId;
  // لا نمسح القيمة الناجحة السابقة أثناء إعادة الجلب — تبقى ظاهرة.
  if (state.status !== 'success') {
    state = { status: 'loading', ownedByUserId: ownerAtStart };
    notify();
  }

  try {
    const response = await api.providers.claudeUsage();
    if (id !== requestId) return;

    if (!response.ok) {
      let code: string | null = null;
      try { code = ((await response.json()) as { code?: string })?.code ?? null; } catch { /* ignore */ }
      state = { status: 'error', code, ownedByUserId: ownerAtStart };
      notify();
      return;
    }

    const data = (await response.json()) as ClaudeUsage;
    if (id !== requestId) return;
    state = { status: 'success', data, ownedByUserId: ownerAtStart };
    notify();
  } catch {
    if (id !== requestId) return;
    state = { status: 'error', code: null, ownedByUserId: ownerAtStart };
    notify();
  }
}

/* ------------------------------------------------------------------ */
/*  إدارة المؤقّت ومستمعي نافذة التطبيق                               */
/* ------------------------------------------------------------------ */

function startPolling(): void {
  if (intervalId !== null) return;
  void fetchUsage();
  intervalId = window.setInterval(() => { void fetchUsage(); }, REFRESH_INTERVAL_MS);
}

function stopPolling(): void {
  if (intervalId === null) return;
  window.clearInterval(intervalId);
  intervalId = null;
  // إعادة ضبط المخزن حين يُوقف آخر مشترك — يمنع رؤية بيانات مستخدم سابق
  // عند تفعيل المكوّن من جديد بحساب مختلف (السيناريو: logout→login بلا إعادة تحميل).
  resetStore();
  activeUserId = null;
}

// مستمعات مستوى التطبيق — تُضاف مرة واحدة فقط.
let appListenersAttached = false;

function attachAppListeners(): void {
  if (appListenersAttached) return;
  appListenersAttached = true;

  const onVisible = (): void => {
    if (document.visibilityState === 'visible' && enabledCount > 0) void fetchUsage();
  };
  const onFocus = (): void => { if (enabledCount > 0) void fetchUsage(); };

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onFocus);
}

/* ------------------------------------------------------------------ */
/*  API عامة                                                            */
/* ------------------------------------------------------------------ */

/**
 * يُستدعى من ChatInterface عند انتهاء دور (isLoading true→false).
 * يُعيد الجلب فوراً لتحديث مؤشّر الاستخدام بعد كل رد.
 */
export function notifyClaudeUsageTurnEnd(): void {
  if (enabledCount > 0) void fetchUsage();
}

/* ------------------------------------------------------------------ */
/*  الخطّاف                                                             */
/* ------------------------------------------------------------------ */

export type UseClaudeUsageSharedResult = ClaudeUsageState & { refetch: () => void };

/**
 * بديل useClaudeUsage يشارك المخزن الواحد مع كل المكوّنات.
 * الواجهة متطابقة: `{ status, data?, code?, refetch }`.
 *
 * @param enabled  - يوقف الجلب حين false (نفس دلالة useClaudeUsage).
 * @param userId   - معرّف المستخدم الحالي (من useAuth().user?.id).
 *                   عند تغيّره يُعاد ضبط المخزن ويُلغى كل طلب جارٍ لمستخدم سابق.
 */
export function useClaudeUsageShared(
  enabled: boolean,
  userId?: string | number | null,
): UseClaudeUsageSharedResult {
  // عزل تبديل المستخدم: حين يتغيّر userId أعد الضبط مباشرةً.
  const userKey = userId != null ? String(userId) : null;
  useEffect(() => {
    if (userKey === null) return;
    if (activeUserId !== null && activeUserId !== userKey) {
      // تبديل حساب — أسقط البيانات القديمة فوراً.
      activeUserId = userKey;
      resetStore();
    } else if (activeUserId === null) {
      activeUserId = userKey;
    }
  }, [userKey]);

  // اشتراك + إدارة عدّاد المُشغَّلين.
  useEffect(() => {
    if (!enabled) return;
    enabledCount += 1;
    attachAppListeners();
    startPolling();
    return () => {
      enabledCount = Math.max(0, enabledCount - 1);
      if (enabledCount === 0) stopPolling();
    };
  }, [enabled]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // fix-5: كشف متزامن عن snapshot قديم.
  // useEffect يعمل بعد الإطار الأول، لذا قد يُعرض snapshot يخصّ مستخدماً سابقاً
  // للمستخدم الجديد. الحلّ: نُقارن خلال الرّند — بلا آثار جانبية.
  // الشرط: userKey وownedByUserId كلاهما معروفان ومتعارضان.
  const isStaleSnapshot =
    userKey !== null &&
    snapshot.ownedByUserId !== null &&
    snapshot.ownedByUserId !== userKey;

  if (isStaleSnapshot) {
    return { status: 'idle', refetch: fetchUsage };
  }

  return { ...snapshot, refetch: fetchUsage };
}
