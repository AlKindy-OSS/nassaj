/**
 * useCodeHighlighter — المُلوِّن + المستوى المختار، لكل كتلة شيفرة.
 *
 * ## لماذا لا `useUiPreferences()` هنا
 *
 * `useUiPreferences` **مالكٌ كاتب**: كل نسخة منه تكتب `localStorage` وتبثّ حدث
 * مزامنة في أوّل `useEffect`. كتل الشيفرة تُعَدّ بالعشرات في محادثة واحدة، فوضع
 * ذلك الخطّاف داخل الكتلة يعني عشرات عمليات الكتابة وعشرات الأحداث في كل تغيير
 * — وكل حدث يُوقظ الجميع. هنا نقرأ **فقط**، من نفس المفتاح ونفس الأحداث، عبر
 * مخزن وحيد على مستوى الوحدة مهما بلغ عدد الكتل.
 *
 * المصادر الثلاثة المُشترَك فيها تُغطّي كل طرق تغيّر التفضيل:
 *   1. `ui-preferences:sync` — كتابة من الإعدادات في نفس التبويب (سريان فوري).
 *   2. `storage` — تبويب آخر.
 *   3. `preferences:apply` — قيمة الحساب بعد تسجيل الدخول (الخادم مرجع).
 */
import { useEffect, useSyncExternalStore } from 'react';

import {
  UI_PREFERENCES_STORAGE_KEY,
  UI_PREFERENCES_SYNC_EVENT,
} from '../hooks/useUiPreferences';
import { onApplyServerPreference } from '../preferences/preferencesSync';

import {
  DEFAULT_CODE_HIGHLIGHT_SCOPE,
  parseCodeHighlightScope,
  type CodeHighlightScope,
} from './codeHighlightScope';
import {
  CodeHighlighter,
  ensureScope,
  getRegistryVersion,
  subscribeToRegistry,
} from './prismRegistry';

/* ───────────────────── مخزن المستوى (قراءة فقط) ───────────────────── */

const scopeListeners = new Set<() => void>();
let cachedScope: CodeHighlightScope | null = null;
let detachSources: (() => void) | null = null;

function readScopeFromStorage(): CodeHighlightScope {
  if (typeof window === 'undefined') return DEFAULT_CODE_HIGHLIGHT_SCOPE;
  try {
    const raw = window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_CODE_HIGHLIGHT_SCOPE;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_CODE_HIGHLIGHT_SCOPE;
    return parseCodeHighlightScope(parsed.codeHighlightScope);
  } catch {
    return DEFAULT_CODE_HIGHLIGHT_SCOPE;
  }
}

/**
 * يُعيد القراءة ويُخطر المشتركين عند التغيّر فقط.
 * `useSyncExternalStore` يوجب لقطةً مستقرّة، فالقيمة مُخزَّنة لا محسوبة كل مرّة.
 */
function refreshScope(): void {
  const next = readScopeFromStorage();
  if (next === cachedScope) return;
  cachedScope = next;
  for (const listener of scopeListeners) listener();
}

function attachSources(): void {
  if (typeof window === 'undefined' || detachSources) return;

  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== UI_PREFERENCES_STORAGE_KEY) return;
    refreshScope();
  };
  const onSync = () => refreshScope();

  window.addEventListener('storage', onStorage);
  window.addEventListener(UI_PREFERENCES_SYNC_EVENT, onSync);
  const offApply = onApplyServerPreference(UI_PREFERENCES_STORAGE_KEY, () => refreshScope());

  detachSources = () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(UI_PREFERENCES_SYNC_EVENT, onSync);
    offApply();
    detachSources = null;
  };
}

function subscribeToScope(listener: () => void): () => void {
  scopeListeners.add(listener);
  attachSources();
  return () => {
    scopeListeners.delete(listener);
    if (scopeListeners.size === 0) detachSources?.();
  };
}

function getScopeSnapshot(): CodeHighlightScope {
  if (cachedScope === null) cachedScope = readScopeFromStorage();
  return cachedScope;
}

function getScopeServerSnapshot(): CodeHighlightScope {
  return DEFAULT_CODE_HIGHLIGHT_SCOPE;
}

/** يُفرِغ اللقطة المُخزَّنة — للاختبارات وحدها (كل اختبار ببيئة تخزين نظيفة). */
export function resetCodeHighlightScopeCache(): void {
  cachedScope = null;
}

/** المستوى المختار حالياً، متزامناً مع الإعدادات بلا إعادة تحميل. */
export function useCodeHighlightScope(): CodeHighlightScope {
  return useSyncExternalStore(subscribeToScope, getScopeSnapshot, getScopeServerSnapshot);
}

/* ─────────────────────────── الخطّاف ─────────────────────────── */

export type CodeHighlighterState = {
  /** مكوِّن `PrismLight` — مرجع ثابت، فلا إعادة تركيب ولا وميض عند الترقية. */
  SyntaxHighlighter: typeof CodeHighlighter;
  /** المستوى المختار (للتشخيص والاختبارات). */
  scope: CodeHighlightScope;
};

export function useCodeHighlighter(): CodeHighlighterState {
  const scope = useCodeHighlightScope();

  // الاشتراك في السِجلّ هو ما يجعل الترقية تظهر: عند اكتمال تسجيل المستوى
  // الأعلى ترتفع النسخة فتُعاد كتل الشيفرة رسماً — نفس المكوِّن ونفس الإطار،
  // يتغيّر التلوين وحده. القيمة نفسها لا تُستعمل في العرض عمداً.
  useSyncExternalStore(subscribeToRegistry, getRegistryVersion, getRegistryVersion);

  useEffect(() => {
    void ensureScope(scope);
  }, [scope]);

  return { SyntaxHighlighter: CodeHighlighter, scope };
}
