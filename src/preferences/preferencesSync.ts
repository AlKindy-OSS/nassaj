/**
 * preferencesSync — account-scoped UI preference synchronization.
 *
 * The server (commit 17ff01a) exposes a user-scoped store at
 * `/api/settings/ui-preferences`:
 *   - GET → { preferences: { ... } }   ({} when the user has none yet)
 *   - PUT body=<JSON object> → shallow-merges top-level over the stored value,
 *     returns { preferences: <merged> }. (>64KB or non-object → 400.)
 *
 * This module makes the *account* authoritative for the synced subset of UI
 * preferences while keeping every preference owner unchanged in how it reads
 * and writes localStorage (so the app keeps working offline and before the
 * server route goes live).
 *
 * Design — two halves that share one registry (REGISTRY below):
 *
 *  1. Write mirror. `localStorage.setItem` is patched once at boot
 *     (`installPreferenceWriteMirror`). Writes to a *registered* key are
 *     coalesced (debounce ~500ms) and pushed to the server as a partial PUT
 *     `{ [serverKey]: value }`. Owners keep calling `localStorage.setItem` as
 *     they do today — no per-setter wiring, minimal churn. Mirroring stays
 *     dormant until a token exists and the route has proven reachable, so the
 *     app behaves exactly as before sign-in / before the server restart.
 *
 *  2. Hydration. After authentication (`hydratePreferencesFromServer`):
 *       - GET the account preferences.
 *       - Non-empty → write each into localStorage AND dispatch a live-apply
 *         event so the running SPA reflects it immediately (no reload). Each
 *         preference owner subscribes via `onApplyServerPreference`.
 *       - Empty {} → one-time seed: PUT the current local values up so an
 *         existing owner's device settings become this account's baseline
 *         (decision 3). A brand-new browser has only defaults, which yields the
 *         "new account = defaults" behaviour automatically.
 *
 * Graceful degradation (requirement 4): a 404 / network error on GET or PUT is
 * swallowed — `markRouteUnavailable()` disables mirroring for the session so
 * the UI shows no errors and runs purely on localStorage, exactly as today.
 * Sync starts working automatically once the route responds after restart.
 */

import { api, authenticatedFetch, hasAuthenticatedSession } from '../utils/api';
import { identityRequestSignal } from '../components/auth/accountIdentityBarrier';

/* ─────────────────────────── Registry ─────────────────────────── */

/**
 * A synced preference. `serverKey` is the top-level field name in the account
 * preferences object; `read`/`write` move the value to/from localStorage in the
 * owner's native format. `applyLive` reflects a server-sourced value into the
 * running app without a reload (when the owner can only react via its own React
 * state). When `applyLive` is omitted, hydration writes localStorage and emits
 * the generic apply event; owners that listen to `storage`/custom events pick
 * it up on their own.
 */
export interface SyncedPreference {
  /** Top-level field name in the account preferences payload. */
  serverKey: string;
  /** localStorage key (defaults to serverKey when identical). */
  storageKey?: string;
  /** Read the current local value (raw localStorage string or null). */
  read?: () => unknown;
  /** Persist a server-sourced value locally. Defaults to a raw string write. */
  write?: (value: unknown) => void;
}

/**
 * All keys that mirror to the account. The map is keyed by serverKey. localStorage
 * keys default to the serverKey. The owners listed are informational.
 *
 * Local-only device state (activeTab, permissionMode-*,
 * cursorSessionId/pendingSessionId, sidebar finished-unopened set, project
 * membership filter, file-tree view mode, quick-settings handle position,
 * GitHub-stars / upstream-version caches, auth-token) is intentionally absent.
 */
const SYNCED_STORAGE_KEYS: string[] = [
  'theme', // ThemeContext.jsx (light/dark)
  'nassaj-theme-preset', // lib/theme-presets.ts (preset + custom colors, JSON)
  'nassaj-ui-font', // lib/ui-font.ts (interface font id, plain string)
  'userLanguage', // i18n/config.js
  'uiPreferences', // hooks/useUiPreferences.ts (6 booleans, JSON)
  'notificationSoundEnabled', // utils/notificationSound.ts ("true"/"false")
  // code-editor (components/code-editor/constants/settings.ts)
  'codeEditorTheme',
  'codeEditorWordWrap',
  'codeEditorShowMinimap',
  'codeEditorLineNumbers',
  'codeEditorFontSize',
  // settings controller permissions + projectSortOrder (JSON objects)
  'claude-settings',
  'cursor-tools-settings',
  'codex-settings',
  'gemini-settings',
  // provider selection + per-provider models (useChatProviderState.ts)
  'selected-provider',
  'claude-model',
  'cursor-model',
  'codex-model',
  'gemini-model',
  'opencode-model',
  'antigravity-model',
];

/** serverKey === storageKey for every synced key (kept 1:1 for transparency). */
const REGISTRY = new Map<string, SyncedPreference>(
  SYNCED_STORAGE_KEYS.map((key) => [key, { serverKey: key, storageKey: key }]),
);

const SYNCED_STORAGE_KEY_SET = new Set(SYNCED_STORAGE_KEYS);

/** Event dispatched on the window so preference owners can apply a server value live. */
export const PREFERENCE_APPLY_EVENT = 'preferences:apply';

export interface PreferenceApplyDetail {
  /** localStorage key that changed. */
  storageKey: string;
  /** The raw value as it now sits in localStorage (string) or null if removed. */
  rawValue: string | null;
}

/* ─────────────────────────── Runtime guards ─────────────────────────── */

const hasWindow = typeof window !== 'undefined';
const hasStorage = (() => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
})();

// Once GET/PUT proves the server route is missing (404) or the network is down,
// stop mirroring for the rest of the session. Reset is unnecessary: a fresh
// page load after the server restart re-enables it.
let routeUnavailable = false;
// Suppress the write mirror while hydration is applying server values, so the
// resulting localStorage writes are not echoed straight back to the server.
let applyingFromServer = false;
let authenticatedIdentity = false;
let identityEpoch = 0;
let preferenceWritesReady = true;

/** Mark whether AuthContext has verified an account identity in this tab. */
export function setPreferenceIdentityAuthenticated(authenticated: boolean): void {
  if (!authenticated) {
    preferenceWritesReady = false;
    neutralizePreferenceWork();
    neutralizeSyncedPreferences();
  }
  if (authenticatedIdentity === authenticated) return;
  authenticatedIdentity = authenticated;
  identityEpoch += 1;
}

const hasPreferenceIdentity = (): boolean => authenticatedIdentity || hasAuthenticatedSession();

export function markRouteUnavailable(): void {
  routeUnavailable = true;
}

/**
 * Runs `fn` with the write mirror suppressed, then restores the previous state.
 *
 * WHY (B-567). Not every `localStorage` write is a user decision. A preference
 * owner may write purely to *normalise its own stored shape* — migrating a
 * legacy value, stamping a version field — and such a write carries no intent
 * the account should learn. Mirroring it is worse than wasteful: it lands in
 * `pendingWrites`, so a hydration GET that resolves inside the ~500ms debounce
 * window sees `hasUnsyncedWrite(key)` and skips applying the account value for
 * that key entirely; the queue then flushes local defaults over the account.
 * The net effect is the very symptom users report as "my setting reverted".
 *
 * Hydration already suppresses the mirror inline for exactly this reason (see
 * `applyServerValue` below). This export generalises that guard so owners can
 * reuse it without reaching into module state.
 *
 * Nested calls restore the previous flag rather than clearing it, so wrapping a
 * normalisation that itself runs during hydration cannot re-arm the mirror
 * mid-flight.
 */
export function withMirrorSuppressed<T>(fn: () => T): T {
  const previous = applyingFromServer;
  applyingFromServer = true;
  try {
    return fn();
  } finally {
    applyingFromServer = previous;
  }
}

/** Best-effort detection of a "route not live yet" failure vs. a real value. */
const isRouteUnavailable = (status: number): boolean => status === 404 || status === 405;

/* ─────────────────────────── Write mirror ─────────────────────────── */

const pendingWrites = new Map<string, unknown>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

/**
 * الدفعة المرسَلة الآن (B-444). كانت الدفعة تُمسح **قبل** انتظار الردّ، فأي فشل
 * — انقطاع شبكة، إعادة تشغيل الخادم، 500 عابر — يبتلع اختيار المستخدم صامتاً:
 * القيمة تبقى في `localStorage` وحدها، ثم يعيد الترطيب التالي قيمةَ الحساب
 * البائتة فوقها، فتبدو التفضيلات وكأنها «ترجع كل شوية». الآن تُحجَز الدفعة هنا
 * ولا تُشطب إلا بردّ ناجح؛ وأي فشل يعيدها إلى الطابور مع إعادة محاولة متصاعدة.
 */
let inFlight: Array<[string, unknown]> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 0;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;

function neutralizePreferenceWork(): void {
  pendingWrites.clear();
  if (flushTimer !== null) clearTimeout(flushTimer);
  if (retryTimer !== null) clearTimeout(retryTimer);
  flushTimer = null;
  retryTimer = null;
  retryDelay = 0;
}

/** Remove the previous account's values and tell mounted owners to use defaults. */
function neutralizeSyncedPreferences(): void {
  if (!hasStorage) return;
  applyingFromServer = true;
  try {
    for (const storageKey of SYNCED_STORAGE_KEYS) localStorage.removeItem(storageKey);
  } finally {
    applyingFromServer = false;
  }
  if (!hasWindow) return;
  for (const storageKey of SYNCED_STORAGE_KEYS) {
    window.dispatchEvent(new CustomEvent<PreferenceApplyDetail>(PREFERENCE_APPLY_EVENT, {
      detail: { storageKey, rawValue: null },
    }));
    if (storageKey.startsWith('codeEditor')) window.dispatchEvent(new Event('codeEditorSettingsChanged'));
  }
}

/** يعيد دفعةً فاشلة إلى الطابور دون أن تطمس كتابةً محلية أحدث منها. */
const requeue = (batch: Array<[string, unknown]>): void => {
  for (const [key, value] of batch) {
    if (!pendingWrites.has(key)) {
      pendingWrites.set(key, value);
    }
  }
};

const scheduleRetry = (): void => {
  if (retryTimer !== null || routeUnavailable) {
    return;
  }
  retryDelay = retryDelay === 0 ? RETRY_BASE_MS : Math.min(retryDelay * 2, RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushPendingWrites();
  }, retryDelay);
};

/** مفتاح له كتابة محلية لم تصل الحساب بعد (منتظرة أو قيد الإرسال). */
const hasUnsyncedWrite = (serverKey: string): boolean =>
  pendingWrites.has(serverKey) || (inFlight?.some(([key]) => key === serverKey) ?? false);

/** Parse a raw localStorage string into the value we send to the server. */
const decodeForServer = (raw: string | null): unknown => {
  if (raw === null) {
    return null;
  }
  // JSON-shaped values (objects/booleans/numbers) round-trip; plain strings
  // (e.g. "dark", a language code, a model id) stay strings.
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/** Encode a server value back into the raw localStorage representation. */
const encodeForStorage = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
};

const scheduleFlush = (): void => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingWrites();
  }, DEBOUNCE_MS);
};

async function flushPendingWrites(): Promise<void> {
  if (routeUnavailable) {
    pendingWrites.clear();
    return;
  }
  if (inFlight || pendingWrites.size === 0) {
    return; // طلب جارٍ: الذيل أدناه يعيد الإفراغ عند انتهائه.
  }
  if (!hasPreferenceIdentity()) {
    // Not signed in (or signed out mid-debounce): drop the batch. Local values
    // remain in localStorage; they will seed/sync on the next authenticated load.
    pendingWrites.clear();
    return;
  }

  const batch = [...pendingWrites];
  const batchEpoch = identityEpoch;
  pendingWrites.clear();
  inFlight = batch;

  try {
    const response = await api.put('/settings/ui-preferences', Object.fromEntries(batch));
    if (batchEpoch !== identityEpoch) return;
    if (response.ok) {
      retryDelay = 0;
    } else if (isRouteUnavailable(response.status)) {
      // المسار غير موجود أصلاً (خادم قديم): إيقاف المرآة لبقية الجلسة.
      markRouteUnavailable();
    } else {
      // 5xx أو 401 بعد فشل التجديد: عطل عابر لا يُهدَر عنده اختيار المستخدم.
      requeue(batch);
      scheduleRetry();
    }
  } catch (error) {
    if (batchEpoch !== identityEpoch) return;
    if (error instanceof DOMException && error.name === 'AbortError') return;
    // انقطاع شبكة أو إعادة تشغيل الخادم: يُعاد لا يُبتلع.
    requeue(batch);
    scheduleRetry();
  } finally {
    inFlight = null;
  }

  if (pendingWrites.size > 0 && retryTimer === null && flushTimer === null) {
    scheduleFlush();
  }
}

/**
 * Flush whatever is pending immediately, with a request that survives page
 * teardown (`keepalive: true`). Used on `pagehide` / `visibilitychange→hidden`
 * so a preference changed within the debounce window right before a reload is
 * not lost — the loss was silent AND self-reversing, because the next load
 * hydrates the account value that never learned about the change (theme
 * flipping back to dark after a quick refresh).
 *
 * Raw `fetch` rather than `api.put`: only `keepalive` survives teardown, and
 * `navigator.sendBeacon` cannot carry the Bearer header. Same technique as
 * `useFavoriteModels.flushImmediately`, which writes to this very endpoint.
 */
export function flushPendingWritesNow(): void {
  if (routeUnavailable || pendingWrites.size === 0) {
    return;
  }
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!hasPreferenceIdentity()) {
    pendingWrites.clear();
    return;
  }

  const batch = [...pendingWrites];
  const batchEpoch = identityEpoch;
  pendingWrites.clear();

  try {
    void authenticatedFetch('/api/settings/ui-preferences', {
      method: 'PUT',
      body: JSON.stringify(Object.fromEntries(batch)),
      keepalive: true,
      signal: identityRequestSignal(),
    })
      .then((response) => {
        if (batchEpoch !== identityEpoch) return;
        // الصفحة قد تبقى حيّة (تبديل تطبيق على الجوال لا إغلاق): فشلٌ هنا يعود
        // إلى الطابور ليُرسَل عند العودة، لا يضيع.
        if (!response.ok) {
          requeue(batch);
          scheduleRetry();
        }
      })
      .catch((error: unknown) => {
        if (batchEpoch !== identityEpoch) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        requeue(batch);
        scheduleRetry();
      });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    /* fetch unavailable (tests / SSR): keep the batch for the next attempt */
    requeue(batch);
  }
}

/**
 * Queue a synced key for a debounced PUT. Called from the patched setItem and
 * from removeItem. Safe to call when not signed in (flush drops the batch).
 */
function queueMirror(storageKey: string, rawValue: string | null): void {
  if (applyingFromServer || routeUnavailable || !preferenceWritesReady) {
    return;
  }
  const entry = REGISTRY.get(storageKey);
  if (!entry) {
    return;
  }
  pendingWrites.set(entry.serverKey, decodeForServer(rawValue));
  scheduleFlush();
}

let writeMirrorInstalled = false;

/**
 * Patch localStorage.setItem / removeItem once so every synced write also
 * mirrors to the account. Idempotent. No-op outside the browser.
 */
export function installPreferenceWriteMirror(): void {
  if (writeMirrorInstalled || !hasWindow || !hasStorage) {
    return;
  }
  writeMirrorInstalled = true;

  const nativeSetItem = localStorage.setItem.bind(localStorage);
  const nativeRemoveItem = localStorage.removeItem.bind(localStorage);
  const nativeGetItem = localStorage.getItem.bind(localStorage);

  /** Current raw value, or null when storage is unreadable. */
  const readRaw = (key: string): string | null => {
    try {
      return nativeGetItem(key);
    } catch {
      return null;
    }
  };

  localStorage.setItem = (key: string, value: string): void => {
    const synced = SYNCED_STORAGE_KEY_SET.has(key);
    // Read BEFORE the write so a no-op rewrite can be told apart from a change.
    const previous = synced ? readRaw(key) : null;
    nativeSetItem(key, value);
    if (!synced) {
      return;
    }
    // A write that changes nothing is not a user decision — it is an owner
    // re-asserting what it just read (ThemeContext persists its boot value on
    // mount, and again after adopting a server value). Mirroring those turned
    // the account into "last client to boot wins": a tab still holding a stale
    // 'dark' republished it over the light theme the user had just chosen, and
    // the next hydration pushed dark back to every client. Same rule the
    // shared uiPreferences store already follows (B-273: adoption never
    // rewrites). Local storage is already correct either way.
    if (previous === String(value)) {
      return;
    }
    queueMirror(key, value);
  };

  localStorage.removeItem = (key: string): void => {
    const synced = SYNCED_STORAGE_KEY_SET.has(key);
    const previous = synced ? readRaw(key) : null;
    nativeRemoveItem(key);
    if (synced && previous !== null) {
      queueMirror(key, null);
    }
  };

  // Persist a change made inside the debounce window before the page goes away,
  // and re-try a batch that failed while the device was offline / the server was
  // restarting as soon as the tab is usable again (B-444).
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', flushPendingWritesNow);
    window.addEventListener('online', () => {
      retryDelay = 0;
      void flushPendingWrites();
    });
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          flushPendingWritesNow();
        } else {
          retryDelay = 0;
          void flushPendingWrites();
        }
      });
    }
  }
}

/* ─────────────────────────── Hydration ─────────────────────────── */

/** Write a server-sourced value into localStorage and notify the running app. */
function applyServerValue(storageKey: string, value: unknown): void {
  if (!hasStorage) {
    return;
  }
  const entry = REGISTRY.get(storageKey);
  const raw = encodeForStorage(value);

  // Suppress the write mirror for this localStorage write — the value already
  // came from the server; echoing it back is wasteful and risks a loop.
  applyingFromServer = true;
  try {
    if (entry?.write) {
      entry.write(value);
    } else {
      localStorage.setItem(storageKey, raw);
    }
  } finally {
    applyingFromServer = false;
  }

  if (hasWindow) {
    // Generic live-apply event for owners that keep their value in React state
    // (ThemeContext, RtlContext, useUiPreferences, …). Each owner subscribes via
    // onApplyServerPreference and decides how to reflect it.
    window.dispatchEvent(
      new CustomEvent<PreferenceApplyDetail>(PREFERENCE_APPLY_EVENT, {
        detail: { storageKey, rawValue: localStorage.getItem(storageKey) },
      }),
    );

    // The code-editor subsystem already refreshes its React state from
    // localStorage on this event, so reuse it rather than re-implementing the
    // five-key read path here.
    if (storageKey.startsWith('codeEditor')) {
      window.dispatchEvent(new Event('codeEditorSettingsChanged'));
    }
  }
}

/**
 * Apply a full server preferences object to the running app. Exposed for tests.
 */
export function applyServerPreferences(preferences: Record<string, unknown>): void {
  for (const [serverKey, value] of Object.entries(preferences)) {
    const entry = REGISTRY.get(serverKey);
    if (!entry) {
      continue; // Unknown/forward-compat key — ignore.
    }
    // A queued local write is newer than this payload (the user changed the
    // setting while the GET was in flight). Applying the server value here
    // would undo the change in front of the user and then re-publish the old
    // value, so the account can never learn the new one.
    // (وتشمل الدفعة قيد الإرسال أو التي فشلت وتنتظر إعادة المحاولة — B-444.)
    if (hasUnsyncedWrite(serverKey)) {
      continue;
    }
    applyServerValue(entry.storageKey ?? serverKey, value);
  }
}

/** Collect the current local values for every synced key (skips unset keys). */
export function collectLocalPreferences(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!hasStorage) {
    return out;
  }
  for (const [serverKey, entry] of REGISTRY.entries()) {
    const storageKey = entry.storageKey ?? serverKey;
    const raw = entry.read ? entry.read() : localStorage.getItem(storageKey);
    if (raw === null || raw === undefined) {
      continue; // Unset → leave it to the account default.
    }
    out[serverKey] = typeof raw === 'string' ? decodeForServer(raw) : raw;
  }
  return out;
}

/**
 * Hydrate account preferences after authentication.
 *
 *  - Non-empty server payload → apply live (server is authoritative, decision 2).
 *  - Empty payload → seed the account from this device's current values once
 *    (decision 3), then the server is authoritative on subsequent loads.
 *  - 404 / network error → silently fall back to localStorage (requirement 4).
 *
 * Returns a small status object (handy for tests / diagnostics).
 */
export async function hydratePreferencesFromServer(): Promise<
  { status: 'applied' | 'seeded' | 'unavailable' | 'skipped' }
> {
  if (routeUnavailable || !hasPreferenceIdentity()) {
    return { status: 'skipped' };
  }

  let payload: { preferences?: Record<string, unknown> } | null = null;
  const hydrationEpoch = identityEpoch;
  const finishHydration = <T extends { status: string }>(result: T): T => {
    if (hydrationEpoch === identityEpoch && authenticatedIdentity) preferenceWritesReady = true;
    return result;
  };
  try {
    const response = await api.get('/settings/ui-preferences');
    if (!response.ok) {
      if (isRouteUnavailable(response.status)) {
        markRouteUnavailable();
      }
      return finishHydration({ status: 'unavailable' as const });
    }
    payload = (await response.json()) as { preferences?: Record<string, unknown> };
    if (hydrationEpoch !== identityEpoch) return { status: 'skipped' };
  } catch {
    // عطل شبكة عابر عند الإقلاع (إعادة تشغيل الخادم، نفق متذبذب) لا يُعطّل
    // مرآة الكتابة لبقية عمر التبويب — وإلا صار كل تغيير بعده محلياً فقط،
    // فيُمحى عند أول ترطيب لاحق. الإسقاط الدائم لـ404/405 وحدها (B-444).
    return finishHydration({ status: 'unavailable' as const });
  }

  const preferences = payload?.preferences;
  const isObject = preferences && typeof preferences === 'object' && !Array.isArray(preferences);

  if (isObject && Object.keys(preferences).length > 0) {
    applyServerPreferences(preferences);
    return finishHydration({ status: 'applied' as const });
  }

  // Empty {} → one-time seed from this device's current values.
  const local = collectLocalPreferences();
  if (Object.keys(local).length === 0) {
    return finishHydration({ status: 'skipped' as const }); // Brand-new browser: nothing to seed → defaults.
  }

  try {
    const response = await api.put('/settings/ui-preferences', local);
    if (hydrationEpoch !== identityEpoch) return { status: 'skipped' };
    if (!response.ok && isRouteUnavailable(response.status)) {
      markRouteUnavailable();
      return finishHydration({ status: 'unavailable' as const });
    }
  } catch {
    // كما في مسار الـGET: العابر لا يُسقط المرآة (B-444).
    return finishHydration({ status: 'unavailable' as const });
  }
  return finishHydration({ status: 'seeded' as const });
}

/* ─────────────────────────── Owner subscription helper ─────────────────────────── */

/**
 * Subscribe to live-apply events for a single storage key. Owners (Contexts /
 * hooks that keep the value in React state) call this so a server-hydrated value
 * is reflected without a reload. Returns an unsubscribe function.
 */
export function onApplyServerPreference(
  storageKey: string,
  handler: (rawValue: string | null) => void,
): () => void {
  if (!hasWindow) {
    return () => {};
  }
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<PreferenceApplyDetail>).detail;
    if (detail?.storageKey === storageKey) {
      handler(detail.rawValue);
    }
  };
  window.addEventListener(PREFERENCE_APPLY_EVENT, listener as EventListener);
  return () => window.removeEventListener(PREFERENCE_APPLY_EVENT, listener as EventListener);
}

/** Test-only: reset module state between cases. */
export function __resetPreferenceSyncForTests(): void {
  routeUnavailable = false;
  applyingFromServer = false;
  authenticatedIdentity = false;
  identityEpoch += 1;
  preferenceWritesReady = true;
  // Each test installs fresh window/localStorage stubs; the patch closes over
  // the previous ones, so the mirror must be re-installable.
  writeMirrorInstalled = false;
  pendingWrites.clear();
  inFlight = null;
  retryDelay = 0;
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/** Read-only view of the synced key list (for tests / diagnostics). */
export function getSyncedStorageKeys(): readonly string[] {
  return SYNCED_STORAGE_KEYS;
}

if (typeof window !== 'undefined') {
  window.addEventListener('auth:identity-changing', () => {
    setPreferenceIdentityAuthenticated(false);
  });
}
