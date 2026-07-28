import { useCallback, useSyncExternalStore } from 'react';

import { onApplyServerPreference } from '../preferences/preferencesSync';
import {
  DEFAULT_CODE_HIGHLIGHT_SCOPE,
  parseCodeHighlightScope,
  type CodeHighlightScope,
} from '../syntax/codeHighlightScope';

export type TabsDisplayMode = 'full' | 'compact' | 'minimal' | 'hidden';

const TABS_DISPLAY_MODES: readonly TabsDisplayMode[] = ['full', 'compact', 'minimal', 'hidden'];

/**
 * مفتاح التخزين الافتراضي واسم حدث المزامنة — مُصدَّران كي يقرأهما مشتركون
 * **قراءة فقط** (مثل مخزن نطاق التلوين) دون إنشاء نسخة كاتبة من هذا الخطّاف
 * لكل كتلة شيفرة على الشاشة.
 */
export const UI_PREFERENCES_STORAGE_KEY = 'uiPreferences';
export const UI_PREFERENCES_SYNC_EVENT = 'ui-preferences:sync';

type UiPreferences = {
  autoExpandTools: boolean;
  showRawParameters: boolean;
  showThinking: boolean;
  hideToolCalls: boolean;
  autoScrollToBottom: boolean;
  sendByCtrlEnter: boolean;
  sidebarVisible: boolean;
  // Source of truth for the header tab switcher: full (icons + text),
  // compact (icons only), minimal (tabs hidden, usage indicator visible),
  // or hidden (tab group and usage indicator both not rendered).
  tabsDisplayMode: TabsDisplayMode;
  // Derived mirror of `tabsDisplayMode === 'compact'`. Kept as a real, synced
  // preference so legacy consumers (the appearance "Compact tabs (icons only)"
  // checkbox, HeaderUsageIndicator, MainContentTabSwitcher) keep working with no
  // changes. The reducer reconciles it on every write so the two never drift.
  tabsIconOnly: boolean;
  // Whether to show the search field and archive toggle row in the sidebar.
  // Default: true (visible). Can be hidden via Appearance settings.
  showSidebarSearch: boolean;
  // How many languages the code highlighter knows: 'core' (10, statically
  // bundled), 'extended' (+10, fetched on demand) or 'full' (~300, fetched on
  // demand). Only 'core' ships in the startup bundle — see src/syntax/.
  codeHighlightScope: CodeHighlightScope;
};

type UiPreferenceKey = keyof UiPreferences;

const parseTabsDisplayMode = (value: unknown, fallback: TabsDisplayMode): TabsDisplayMode => {
  if (typeof value === 'string' && (TABS_DISPLAY_MODES as readonly string[]).includes(value)) {
    return value as TabsDisplayMode;
  }
  return fallback;
};

type SetPreferenceAction = {
  type: 'set';
  key: UiPreferenceKey;
  value: unknown;
};

type SetManyPreferencesAction = {
  type: 'set_many';
  value?: Partial<Record<UiPreferenceKey, unknown>>;
};

type ResetPreferencesAction = {
  type: 'reset';
  value?: Partial<UiPreferences>;
};

type UiPreferencesAction =
  | SetPreferenceAction
  | SetManyPreferencesAction
  | ResetPreferencesAction;

const DEFAULTS: UiPreferences = {
  autoExpandTools: false,
  showRawParameters: false,
  showThinking: true,
  hideToolCalls: true,
  autoScrollToBottom: true,
  sendByCtrlEnter: false,
  sidebarVisible: true,
  tabsDisplayMode: 'full',
  tabsIconOnly: false,
  showSidebarSearch: true,
  codeHighlightScope: DEFAULT_CODE_HIGHLIGHT_SCOPE,
};

/**
 * Keys whose value is a string enum rather than a boolean. Kept as one list so
 * the legacy-migration path below cannot silently coerce a new enum key to
 * `false` — which is exactly what would happen under the old boolean-only reduce.
 */
const ENUM_KEYS = new Set<UiPreferenceKey>(['tabsDisplayMode', 'codeHighlightScope']);

const PREFERENCE_KEYS = Object.keys(DEFAULTS) as UiPreferenceKey[];
const VALID_KEYS = new Set<UiPreferenceKey>(PREFERENCE_KEYS); // prevents unknown keys from being written
const SYNC_EVENT = UI_PREFERENCES_SYNC_EVENT;

type SyncEventDetail = {
  storageKey: string;
  sourceId: string;
  value: Partial<Record<UiPreferenceKey, unknown>>;
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return fallback;
};

// Parses an arbitrary stored/incoming value for a single key, respecting its
// type (tabsDisplayMode is a string enum; everything else is boolean).
const parsePreferenceValue = <K extends UiPreferenceKey>(
  key: K,
  value: unknown,
  fallback: UiPreferences[K],
): UiPreferences[K] => {
  if (key === 'tabsDisplayMode') {
    return parseTabsDisplayMode(value, fallback as TabsDisplayMode) as UiPreferences[K];
  }
  if (key === 'codeHighlightScope') {
    return parseCodeHighlightScope(value, fallback as CodeHighlightScope) as UiPreferences[K];
  }
  return parseBoolean(value, fallback as boolean) as UiPreferences[K];
};

// Enforces the invariant tabsIconOnly === (tabsDisplayMode === 'compact').
// `lead` indicates which of the two keys the caller just wrote so the other is
// brought in line: writing tabsDisplayMode updates tabsIconOnly; toggling the
// legacy tabsIconOnly checkbox maps true->compact and false->full (never minimal
// or hidden, to preserve the existing two-state checkbox behaviour).
const reconcileTabsMode = (state: UiPreferences, lead: 'mode' | 'iconOnly'): UiPreferences => {
  if (lead === 'iconOnly') {
    // Checkbox: true→compact, false→full. minimal/hidden are unreachable from
    // the checkbox so the mapping stays a clean two-state toggle.
    const nextMode: TabsDisplayMode = state.tabsIconOnly ? 'compact' : 'full';
    return state.tabsDisplayMode === nextMode ? state : { ...state, tabsDisplayMode: nextMode };
  }
  // Mode is authoritative: tabsIconOnly mirrors compact only; full/minimal/hidden
  // all map to iconOnly=false.
  const nextIconOnly = state.tabsDisplayMode === 'compact';
  return state.tabsIconOnly === nextIconOnly ? state : { ...state, tabsIconOnly: nextIconOnly };
};

const readLegacyPreference = (key: UiPreferenceKey, fallback: boolean): boolean => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;

    // Supports values written by both JSON.stringify and plain strings.
    const parsed = JSON.parse(raw);
    return parseBoolean(parsed, fallback);
  } catch {
    return fallback;
  }
};

const readInitialPreferences = (storageKey: string): UiPreferences => {
  if (typeof window === 'undefined') {
    return DEFAULTS;
  }

  try {
    const raw = localStorage.getItem(storageKey);

    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const parsedRecord = parsed as Record<string, unknown>;

        const next = PREFERENCE_KEYS.reduce((acc, key) => {
          (acc[key] as UiPreferences[typeof key]) = parsePreferenceValue(
            key,
            parsedRecord[key],
            DEFAULTS[key],
          );
          return acc;
        }, { ...DEFAULTS });

        // Stored value predating tabsDisplayMode carries only tabsIconOnly; let it
        // lead so the mode is derived. Otherwise the explicit mode is authoritative.
        const lead = 'tabsDisplayMode' in parsedRecord ? 'mode' : 'iconOnly';
        return reconcileTabsMode(next, lead);
      }
    }
  } catch {
    // Fall back to legacy keys when unified key is missing or invalid.
  }

  const legacy = PREFERENCE_KEYS.reduce((acc, key) => {
    // Enum keys have no legacy standalone localStorage entry; they keep their
    // default instead of being read through the boolean parser.
    if (ENUM_KEYS.has(key)) {
      return acc;
    }
    (acc[key] as boolean) = readLegacyPreference(key, DEFAULTS[key] as boolean);
    return acc;
  }, { ...DEFAULTS });

  // No legacy key for the new mode; derive it from the legacy tabsIconOnly flag.
  return reconcileTabsMode(legacy, 'iconOnly');
};

function reducer(state: UiPreferences, action: UiPreferencesAction): UiPreferences {
  switch (action.type) {
    case 'set': {
      const { key, value } = action;
      if (!VALID_KEYS.has(key)) {
        return state;
      }

      const nextValue = parsePreferenceValue(key, value, state[key]);
      if (state[key] === nextValue) {
        return state;
      }

      const nextState = { ...state, [key]: nextValue };
      if (key === 'tabsDisplayMode') {
        return reconcileTabsMode(nextState, 'mode');
      }
      if (key === 'tabsIconOnly') {
        return reconcileTabsMode(nextState, 'iconOnly');
      }
      return nextState;
    }
    case 'set_many': {
      const updates = action.value || {};
      let changed = false;
      const nextState = { ...state };

      for (const key of PREFERENCE_KEYS) {
        if (!(key in updates)) continue;

        const value = updates[key];
        const nextValue = parsePreferenceValue(key, value, state[key]);
        if (nextState[key] !== nextValue) {
          (nextState[key] as UiPreferences[typeof key]) = nextValue;
          changed = true;
        }
      }

      if (!changed) {
        return state;
      }

      // An external payload may carry an explicit mode (authoritative) or only the
      // legacy flag; let the mode lead when present, otherwise the flag.
      const lead = 'tabsDisplayMode' in updates ? 'mode' : 'iconOnly';
      return reconcileTabsMode(nextState, lead);
    }
    case 'reset':
      return reconcileTabsMode({ ...DEFAULTS, ...(action.value || {}) }, 'mode');
    default:
      return state;
  }
}

/* ─────────────────────── المخزن المشترك (B-273) ───────────────────────
 *
 * كان لكل مستهلك نسخة `useReducer` خاصة تكتب `localStorage` وتبثّ حالتها عند
 * كل تغيير، فتلتقطها بقية النسخ فتغيّر حالتها فتبثّ بدورها. ضغطة واحدة على
 * زرّ عرض التبويبات كانت تولّد كتابةً لكل مستهلك (ستّ في الشاشة الواحدة)،
 * وصدى `storage` من تبويب ثانٍ — وهو المسار الوحيد بلا حارس — كان يضاعفها
 * عشرات المرّات فيرتجف شريط الرأس تركيباً وتفكيكاً حتى تتصادف النسخ على قيمة
 * واحدة (قياس ميداني: 1510 كتابة و1849 تحوّل DOM في 5.5 ثانية).
 *
 * البديل هنا طبقتان:
 *   1) مخزن وحيد لكل مفتاح تخزين، والمستهلكون يشتركون فيه عبر
 *      `useSyncExternalStore` (نفس نمط `useCodeHighlighter`) → التغيير كتابة
 *      واحدة وتصييرة واحدة مهما كثر المستهلكون.
 *   2) ختم إصدار متزايد (`__v`) ومعرّف كاتب (`__src`) داخل القيمة المخزَّنة:
 *      أي وارد إصداره ليس أحدث من إصدارنا يُهمَل، وأي تبنٍّ لقيمة خارجية لا
 *      يُعيد الكتابة (القيمة أصلاً في `localStorage`) → الصدى يموت عند أول
 *      ارتداد بدل أن يتردّد.
 */

/** حقلا الوسم داخل القيمة المخزَّنة؛ يتجاهلهما قارئ التفضيلات لأنهما ليسا مفتاحين صالحين. */
const VERSION_FIELD = '__v';
const WRITER_FIELD = '__src';

/** معرّف هذا التبويب — يميّز كتاباتنا عن كتابات تبويب آخر على نفس المتصفح. */
const WRITER_ID = `ui-preferences-${Math.random().toString(36).slice(2)}`;

type PreferencesStore = {
  state: UiPreferences;
  /** أعلى إصدار رآه هذا التبويب (كتابةً أو تبنّياً). */
  version: number;
  listeners: Set<() => void>;
  detach: (() => void) | null;
  /** كتابة تطبيع واحدة عند أول اشتراك حين تكون القيمة المخزَّنة قديمة الشكل. */
  normalized: boolean;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => UiPreferences;
};

const stores = new Map<string, PreferencesStore>();

/** يقرأ إصدار القيمة المخزَّنة الآن (0 حين لا وسم أو تعذّرت القراءة). */
const readStoredVersion = (storageKey: string): number => {
  if (typeof window === 'undefined') {
    return 0;
  }
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    const version = parsed?.[VERSION_FIELD];
    return typeof version === 'number' && Number.isFinite(version) ? version : 0;
  } catch {
    return 0;
  }
};

/** يكتب الحالة موسومةً بإصدار أعلى من كل ما رآه هذا التبويب أو ما في التخزين. */
const persist = (storageKey: string, store: PreferencesStore): void => {
  if (typeof window === 'undefined') {
    return;
  }

  store.version = Math.max(readStoredVersion(storageKey), store.version) + 1;

  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...store.state,
        [VERSION_FIELD]: store.version,
        [WRITER_FIELD]: WRITER_ID,
      }),
    );
  } catch {
    // تخزين ممتلئ أو محجوب: تبقى الحالة في الذاكرة ويعمل التبويب طبيعياً.
  }

  // مشتركون خارجيون (مثل مخزن نطاق التلوين) يقرأون من التخزين عند هذا الحدث.
  window.dispatchEvent(
    new CustomEvent<SyncEventDetail>(SYNC_EVENT, {
      detail: { storageKey, sourceId: WRITER_ID, value: store.state },
    }),
  );
};

const notify = (store: PreferencesStore): void => {
  for (const listener of store.listeners) listener();
};

/**
 * يتبنّى قيمةً وردت من خارج هذا التبويب (تبويب آخر أو الحساب) **بلا إعادة
 * كتابة** — القيمة أصلاً في `localStorage`. الإصدار الأدنى أو المساوي يُهمَل
 * إلا حين `force` (مسار الحساب: الخادم مرجعٌ ووسمه قد يكون قديماً).
 */
const adoptExternal = (
  storageKey: string,
  store: PreferencesStore,
  raw: unknown,
  options: { force?: boolean } = {},
): void => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return;
  }

  const record = raw as Record<string, unknown>;
  const rawVersion = record[VERSION_FIELD];
  const incomingVersion =
    typeof rawVersion === 'number' && Number.isFinite(rawVersion) ? rawVersion : null;

  if (!options.force && incomingVersion !== null && incomingVersion <= store.version) {
    return; // صدى قديم — هنا كانت تبدأ العاصفة.
  }

  if (incomingVersion !== null) {
    store.version = Math.max(store.version, incomingVersion);
  }

  const next = reducer(store.state, {
    type: 'set_many',
    value: record as Partial<Record<UiPreferenceKey, unknown>>,
  });

  if (next === store.state) {
    return;
  }

  store.state = next;

  // قيمة الحساب تصل بوسم قديم أو بلا وسم؛ نكتبها مرّة واحدة موسومةً كي تتبنّاها
  // بقية التبويبات دون أن يُهملها حارس الإصدار. التبنّي لا يكتب، فالسلسلة تنتهي.
  if (options.force) {
    persist(storageKey, store);
  }

  notify(store);
};

const attach = (storageKey: string, store: PreferencesStore): void => {
  if (typeof window === 'undefined' || store.detach) {
    return;
  }

  const handleStorageChange = (event: StorageEvent) => {
    if (event.key !== storageKey || event.newValue === null) {
      return;
    }
    try {
      adoptExternal(storageKey, store, JSON.parse(event.newValue));
    } catch {
      // قيمة تخزين تالفة — تُهمَل.
    }
  };

  // لم يعد لهذا التبويب كاتب غير هذا المخزن، فحدثنا نحن يُهمَل؛ ويبقى المسار
  // مفتوحاً لأي كاتب خارجي مستقبلاً، محكوماً بحارس الإصدار نفسه.
  const handleSyncEvent = (event: Event) => {
    const detail = (event as CustomEvent<SyncEventDetail>).detail;
    if (!detail || detail.storageKey !== storageKey || detail.sourceId === WRITER_ID) {
      return;
    }
    adoptExternal(storageKey, store, detail.value);
  };

  window.addEventListener('storage', handleStorageChange);
  window.addEventListener(SYNC_EVENT, handleSyncEvent as EventListener);

  // قيمة الحساب بعد تسجيل الدخول (الخادم مرجع) — تُطبَّق حيّاً بلا إعادة تحميل.
  const offApply = onApplyServerPreference(storageKey, (rawValue) => {
    if (rawValue === null) {
      return;
    }
    try {
      adoptExternal(storageKey, store, JSON.parse(rawValue), { force: true });
    } catch {
      // قيمة خادم تالفة — تُهمَل.
    }
  });

  store.detach = () => {
    window.removeEventListener('storage', handleStorageChange);
    window.removeEventListener(SYNC_EVENT, handleSyncEvent as EventListener);
    offApply();
    store.detach = null;
  };
};

const getStore = (storageKey: string): PreferencesStore => {
  const existing = stores.get(storageKey);
  if (existing) {
    return existing;
  }

  const store: PreferencesStore = {
    state: readInitialPreferences(storageKey),
    version: readStoredVersion(storageKey),
    listeners: new Set(),
    detach: null,
    normalized: false,
    subscribe: (listener) => {
      store.listeners.add(listener);
      attach(storageKey, store);

      // ترحيل الشكل القديم (قيمة بلا وسم، أو مفاتيح مفردة قديمة) يُثبَّت مرّة
      // واحدة لكل تبويب حتى يقرأه المشتركون الآخرون والمزامنة مع الحساب.
      if (!store.normalized) {
        store.normalized = true;
        if (typeof window !== 'undefined' && readStoredVersion(storageKey) === 0) {
          persist(storageKey, store);
        }
      }

      return () => {
        store.listeners.delete(listener);
        if (store.listeners.size === 0) {
          store.detach?.();
        }
      };
    },
    getSnapshot: () => store.state,
  };

  stores.set(storageKey, store);
  return store;
};

/** يطبّق فعلاً على المخزن المشترك: كتابة واحدة وإخطار واحد للمستهلكين جميعاً. */
const dispatchToStore = (storageKey: string, action: UiPreferencesAction): void => {
  const store = getStore(storageKey);
  const next = reducer(store.state, action);
  if (next === store.state) {
    return;
  }

  store.state = next;
  persist(storageKey, store);
  notify(store);
};

/** اختبارات فقط: يُسقط المخزن المشترك ليبدأ الاختبار التالي من حالة نظيفة. */
export function __resetUiPreferencesStoreForTests(): void {
  for (const store of stores.values()) {
    store.detach?.();
  }
  stores.clear();
}

export function useUiPreferences(storageKey = UI_PREFERENCES_STORAGE_KEY) {
  const store = getStore(storageKey);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const dispatch = useCallback(
    (action: UiPreferencesAction) => dispatchToStore(storageKey, action),
    [storageKey],
  );

  const setPreference = useCallback(
    (key: UiPreferenceKey, value: unknown) => dispatchToStore(storageKey, { type: 'set', key, value }),
    [storageKey],
  );

  const setPreferences = useCallback(
    (value: Partial<Record<UiPreferenceKey, unknown>>) =>
      dispatchToStore(storageKey, { type: 'set_many', value }),
    [storageKey],
  );

  const resetPreferences = useCallback(
    (value?: Partial<UiPreferences>) => dispatchToStore(storageKey, { type: 'reset', value }),
    [storageKey],
  );

  return {
    preferences: state,
    setPreference,
    setPreferences,
    resetPreferences,
    dispatch,
  };
}
