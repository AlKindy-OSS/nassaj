/**
 * ADR-214 / T-2066: مخزن مشترك لإنفاق Anthropic API منذ بداية الشهر للمستخدم الحالي.
 *
 * نفس نمط `useClaudeUsageShared`: مخزن واحد على مستوى الوحدة يمتلك المؤقّت،
 * فطلب واحد مهما تعدّدت المكوّنات المركّبة، وإعادة ضبط عند تبديل المستخدم أو
 * حين يُفكّ آخر مشترك — لئلا يرى مستخدمٌ إنفاق غيره.
 *
 * الفرق المقصود عن مخزن الحصّة: الإنفاق يُقرأ بمفتاح Admin من واجهة تقارير
 * Anthropic، وهي أبطأ تحديثاً وأغلى نداءً، فالدورة ~15 دقيقة، ولا يُجلب والصفحة
 * مخفيّة، والعودة للصفحة لا تُعيد الجلب إلا إن مضت الدورة.
 *
 * الحالات: `none` = الخادم أجاب 404 NO_SPEND_SOURCE (لا مفتاح ⇒ الشارة مخفيّة)،
 * و`error` يحمل رمز الخادم (`API_SPEND_AUTH` / `API_SPEND_UNAVAILABLE`). وحمولة
 * ناقصة تُعامَل خطأً لا صفراً — لا مبلغ مختلق.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { api } from '../../../utils/api';

export const API_SPEND_REFRESH_MS = 15 * 60_000;

export type AnthropicApiSpend = {
  spendCents: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  observedAt: string;
  hasData: boolean;
  excludesPriorityTier: boolean;
};

export type ApiSpendErrorCode = 'API_SPEND_AUTH' | 'API_SPEND_UNAVAILABLE';

export type AnthropicApiSpendState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'success'; data: AnthropicApiSpend }
  | { status: 'error'; code: ApiSpendErrorCode };

type StoreState = AnthropicApiSpendState & { ownedByUserId: string | null };

let state: StoreState = { status: 'idle', ownedByUserId: null };
let requestId = 0;
let intervalId: number | null = null;
let enabledCount = 0;
let lastFetchAt = 0;
let activeUserId: string | null = null;
const listeners = new Set<() => void>();

function setState(next: StoreState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): StoreState {
  return state;
}

function resetStore(): void {
  requestId += 1;
  lastFetchAt = 0;
  setState({ status: 'idle', ownedByUserId: null });
}

/** يقبل الحمولة فقط إن كانت أرقامها صالحة؛ غير ذلك ⇒ null (لا صفر مختلق). */
function parseSpend(raw: unknown): AnthropicApiSpend | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<AnthropicApiSpend>;
  // السالب مقبول: أرصدة/استردادات المؤسسة قد تجعل المجموع سالباً، ويُعرض كما هو.
  const validCents = typeof value.spendCents === 'number' && Number.isFinite(value.spendCents);
  const validCurrency = typeof value.currency === 'string' && value.currency.trim() !== '';
  if (!validCents || !validCurrency || typeof value.hasData !== 'boolean') return null;
  if (typeof value.periodStart !== 'string' || typeof value.observedAt !== 'string') return null;
  return {
    spendCents: value.spendCents as number,
    currency: value.currency as string,
    periodStart: value.periodStart,
    periodEnd: typeof value.periodEnd === 'string' ? value.periodEnd : value.observedAt,
    observedAt: value.observedAt,
    hasData: value.hasData,
    excludesPriorityTier: value.excludesPriorityTier !== false,
  };
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    return ((await response.json()) as { code?: string })?.code ?? null;
  } catch {
    return null;
  }
}

async function fetchSpend(): Promise<void> {
  const id = ++requestId;
  const owner = activeUserId;
  lastFetchAt = Date.now();
  // القيمة الناجحة السابقة تبقى ظاهرة أثناء إعادة الجلب.
  if (state.status !== 'success') setState({ status: 'loading', ownedByUserId: owner });

  try {
    const response = await api.providers.anthropicApiSpend();
    if (id !== requestId) return;
    if (response.status === 404) {
      setState({ status: 'none', ownedByUserId: owner });
      return;
    }
    if (!response.ok) {
      const code = await readErrorCode(response);
      if (id !== requestId) return;
      const mapped: ApiSpendErrorCode = code === 'API_SPEND_AUTH' ? 'API_SPEND_AUTH' : 'API_SPEND_UNAVAILABLE';
      setState({ status: 'error', code: mapped, ownedByUserId: owner });
      return;
    }
    const data = parseSpend(await response.json());
    if (id !== requestId) return;
    setState(
      data
        ? { status: 'success', data, ownedByUserId: owner }
        : { status: 'error', code: 'API_SPEND_UNAVAILABLE', ownedByUserId: owner },
    );
  } catch {
    if (id !== requestId) return;
    setState({ status: 'error', code: 'API_SPEND_UNAVAILABLE', ownedByUserId: owner });
  }
}

function isPageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function onVisibilityChange(): void {
  if (enabledCount === 0 || !isPageVisible()) return;
  if (Date.now() - lastFetchAt >= API_SPEND_REFRESH_MS) void fetchSpend();
}

function startPolling(): void {
  if (intervalId !== null) return;
  void fetchSpend();
  intervalId = window.setInterval(() => {
    if (isPageVisible()) void fetchSpend();
  }, API_SPEND_REFRESH_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function stopPolling(): void {
  if (intervalId === null) return;
  window.clearInterval(intervalId);
  intervalId = null;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  resetStore();
  activeUserId = null;
}

/**
 * يُستدعى بعد حفظ مفتاح Admin أو حذفه من الإعدادات كي يتبعه الهيدر فوراً
 * بدل انتظار الدورة التالية. لا أثر له بلا مشترك مُفعَّل.
 */
export function refreshAnthropicApiSpend(): void {
  if (enabledCount > 0) void fetchSpend();
}

/**
 * إنفاق API للمستخدم الحالي من المخزن المشترك.
 *
 * @param enabled - يوقف الجلب حين false (مزوّد غير Anthropic أو الهيدر مخفي).
 * @param userId  - معرّف المستخدم الحالي؛ تغيّره يُسقط بيانات السابق فوراً.
 */
export function useAnthropicApiSpend(
  enabled: boolean,
  userId?: string | number | null,
): AnthropicApiSpendState {
  const userKey = userId != null ? String(userId) : null;
  useEffect(() => {
    if (userKey === null) return;
    if (activeUserId !== null && activeUserId !== userKey) {
      activeUserId = userKey;
      resetStore();
      if (enabledCount > 0) void fetchSpend();
    } else if (activeUserId === null) {
      activeUserId = userKey;
    }
  }, [userKey]);

  useEffect(() => {
    if (!enabled) return;
    enabledCount += 1;
    startPolling();
    return () => {
      enabledCount = Math.max(0, enabledCount - 1);
      if (enabledCount === 0) stopPolling();
    };
  }, [enabled]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!enabled) return { status: 'idle' };
  if (userKey !== null && snapshot.ownedByUserId !== null && snapshot.ownedByUserId !== userKey) {
    return { status: 'idle' };
  }
  return toPublicState(snapshot);
}

function toPublicState(snapshot: StoreState): AnthropicApiSpendState {
  switch (snapshot.status) {
    case 'success':
      return { status: 'success', data: snapshot.data };
    case 'error':
      return { status: 'error', code: snapshot.code };
    default:
      return { status: snapshot.status };
  }
}
