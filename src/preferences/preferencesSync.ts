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

import { api } from '../utils/api';

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
 * Local-only device state (activeTab, showParticipantsBar, permissionMode-*,
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

export function markRouteUnavailable(): void {
  routeUnavailable = true;
}

/** Best-effort detection of a "route not live yet" failure vs. a real value. */
const isRouteUnavailable = (status: number): boolean => status === 404 || status === 405;

/* ─────────────────────────── Write mirror ─────────────────────────── */

const pendingWrites = new Map<string, unknown>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

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
  if (routeUnavailable || pendingWrites.size === 0) {
    pendingWrites.clear();
    return;
  }
  if (!getAuthToken()) {
    // Not signed in (or signed out mid-debounce): drop the batch. Local values
    // remain in localStorage; they will seed/sync on the next authenticated load.
    pendingWrites.clear();
    return;
  }

  const batch = Object.fromEntries(pendingWrites);
  pendingWrites.clear();

  try {
    const response = await api.put('/settings/ui-preferences', batch);
    if (!response.ok && isRouteUnavailable(response.status)) {
      markRouteUnavailable();
    }
  } catch {
    // Network error: keep working on localStorage, do not surface to the UI.
    markRouteUnavailable();
  }
}

const getAuthToken = (): string | null => {
  if (!hasStorage) {
    return null;
  }
  try {
    return localStorage.getItem('auth-token');
  } catch {
    return null;
  }
};

/**
 * Queue a synced key for a debounced PUT. Called from the patched setItem and
 * from removeItem. Safe to call when not signed in (flush drops the batch).
 */
function queueMirror(storageKey: string, rawValue: string | null): void {
  if (applyingFromServer || routeUnavailable) {
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

  localStorage.setItem = (key: string, value: string): void => {
    nativeSetItem(key, value);
    if (SYNCED_STORAGE_KEY_SET.has(key)) {
      queueMirror(key, value);
    }
  };

  localStorage.removeItem = (key: string): void => {
    nativeRemoveItem(key);
    if (SYNCED_STORAGE_KEY_SET.has(key)) {
      queueMirror(key, null);
    }
  };
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
  if (routeUnavailable || !getAuthToken()) {
    return { status: 'skipped' };
  }

  let payload: { preferences?: Record<string, unknown> } | null = null;
  try {
    const response = await api.get('/settings/ui-preferences');
    if (!response.ok) {
      if (isRouteUnavailable(response.status)) {
        markRouteUnavailable();
      }
      return { status: 'unavailable' };
    }
    payload = (await response.json()) as { preferences?: Record<string, unknown> };
  } catch {
    markRouteUnavailable();
    return { status: 'unavailable' };
  }

  const preferences = payload?.preferences;
  const isObject = preferences && typeof preferences === 'object' && !Array.isArray(preferences);

  if (isObject && Object.keys(preferences).length > 0) {
    applyServerPreferences(preferences);
    return { status: 'applied' };
  }

  // Empty {} → one-time seed from this device's current values.
  const local = collectLocalPreferences();
  if (Object.keys(local).length === 0) {
    return { status: 'skipped' }; // Brand-new browser: nothing to seed → defaults.
  }

  try {
    const response = await api.put('/settings/ui-preferences', local);
    if (!response.ok && isRouteUnavailable(response.status)) {
      markRouteUnavailable();
      return { status: 'unavailable' };
    }
  } catch {
    markRouteUnavailable();
    return { status: 'unavailable' };
  }
  return { status: 'seeded' };
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
  pendingWrites.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/** Read-only view of the synced key list (for tests / diagnostics). */
export function getSyncedStorageKeys(): readonly string[] {
  return SYNCED_STORAGE_KEYS;
}
