/**
 * useFavoriteModels — per-user, device-synced model favourites.
 *
 * Storage: the `favoriteModels` key inside `user_ui_preferences` (server-side
 * SQLite, GET/PUT /api/settings/ui-preferences). No localStorage — the
 * requirement is that favourites follow the user across devices, which the
 * localStorage-based path cannot guarantee (it is device-local).
 *
 * The server's `updateUiPreferences` merges at the top level (verified in
 * ui-preferences.integration.test.ts:70-75), so PUT `{ favoriteModels: [...] }`
 * never touches other preference keys stored in the same row.
 *
 * Optimistic updates: toggling updates local React state immediately, then
 * schedules a debounced PUT (300 ms) so rapid consecutive taps coalesce into
 * one network round-trip. If the PUT fails, local state is already correct —
 * the server will just be behind until the next successful write. This is
 * acceptable for a UI preference (low stakes, non-transactional).
 *
 * Stale keys (model retired / provider gone) are preserved in storage.
 * `resolveFavoriteRows` in modelFavorites.ts handles the display filtering;
 * this hook never silently prunes the list to avoid destroying a preference
 * the user might recover when the provider comes back.
 *
 * Race safety (Condition 1): the initial GET never overwrites a toggle that
 * arrived while the request was in flight. `hasUserToggledRef` is set to true
 * on the first `handleToggleFavorite` call; any GET response arriving after
 * that point is discarded — the user's optimistic state is authoritative.
 *
 * Page-unload safety (Condition 2): `pagehide` and `visibilitychange→hidden`
 * cancel the pending debounce and immediately fire a keepalive `fetch` so a
 * toggle made just before a hard reload or tab close is not silently lost.
 * `navigator.sendBeacon` is intentionally avoided — auth is a Bearer token in
 * the `Authorization` header (not a cookie), and Beacon cannot carry custom
 * headers, so the request would be rejected 401 before the server persists it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../utils/api';
import { toggleFavorite } from '../components/chat/view/subcomponents/modelFavorites';
import type { FavoriteModels } from '../components/chat/view/subcomponents/modelFavorites';

const DEBOUNCE_MS = 300;

/**
 * Soft cap on the stored list length. The 64 KB server budget for
 * `user_ui_preferences` is shared across all preference keys; 200 model keys
 * fit comfortably within that and far exceed any realistic user need.
 * Attempts to add a key beyond this limit are silently rejected (removal
 * always works regardless of size).
 */
const MAX_FAVORITES = 200;

/**
 * localStorage key for the JWT — must stay in sync with
 * `AUTH_TOKEN_STORAGE_KEY` in src/utils/api.js and
 * src/components/auth/constants.ts. Duplicated here (not imported) because
 * api.js does not export it; a local constant avoids a cross-module coupling
 * for a single string used only in the keepalive flush path.
 */
const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

export interface UseFavoriteModelsReturn {
  /** Current favorites list (array of PickerRow.key strings). */
  favorites: FavoriteModels;
  /**
   * Toggles a row key in/out of the favourites list.
   * Optimistically updates local state; debounces the server write.
   */
  handleToggleFavorite: (key: string) => void;
  /** True while the initial GET is in flight. Favourites group is hidden. */
  isLoading: boolean;
}

export function useFavoriteModels(): UseFavoriteModelsReturn {
  const [favorites, setFavorites] = useState<FavoriteModels>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Ref keeps the latest favorites so the debounced flush always writes the
  // most-recent state (avoids stale closure over a superseded array).
  const favoritesRef = useRef<FavoriteModels>(favorites);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Condition 1 guard: once the user has toggled at least once, the GET result
  // is discarded. The user's optimistic state is authoritative from that point.
  // Without this guard a slow GET (network lag, cold cache) would silently undo
  // a star the user tapped immediately after mount — the GET .then would call
  // setFavorites(serverValue) AFTER setFavorites(optimisticValue), reverting the
  // UI, and the subsequent debounced PUT would write the server value back,
  // permanently erasing the user's intent.
  const hasUserToggledRef = useRef(false);

  // Load on mount — one GET per component lifetime.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    api
      .get('/settings/ui-preferences')
      .then(async (response: Response) => {
        if (cancelled) return;
        if (!response.ok) return; // graceful: keep empty list on error
        const data: unknown = await response.json();
        if (cancelled) return;
        // Condition 1: discard the server snapshot if the user has already
        // interacted — their optimistic state must not be replaced.
        if (hasUserToggledRef.current) return;
        const prefs = (data as Record<string, unknown>)?.preferences;
        if (prefs && typeof prefs === 'object' && !Array.isArray(prefs)) {
          const raw = (prefs as Record<string, unknown>).favoriteModels;
          if (Array.isArray(raw)) {
            // Accept only string values; malformed entries silently filtered.
            const valid = raw.filter((x): x is string => typeof x === 'string');
            setFavorites(valid);
            favoritesRef.current = valid;
          }
        }
      })
      .catch(() => {
        // Network / auth failure: start with empty list. The user can still
        // toggle during the session; writes will fail silently too, which is
        // acceptable for a non-critical preference.
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced flush: sends the latest ref value to avoid stale closures.
  const scheduleFlush = useCallback((next: FavoriteModels) => {
    favoritesRef.current = next;
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
    }
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      api
        .put('/settings/ui-preferences', { favoriteModels: favoritesRef.current })
        .catch(() => {
          // Best-effort: local state already updated. Server lags behind.
        });
    }, DEBOUNCE_MS);
  }, []);

  /**
   * Condition 2: immediate flush for page-unload scenarios.
   *
   * Cancels any pending debounce and fires a keepalive `fetch` so a toggle
   * made within the last 300 ms before a hard reload or tab close is persisted.
   * If there is no pending timer (nothing to flush) this is a no-op.
   *
   * Why raw `fetch` with `keepalive: true` instead of `api.put`:
   *   • `keepalive: true` marks the request as "survive page teardown" — the
   *     browser queues it even if the JS context is gone. `api.put` (which
   *     uses `authenticatedFetch`) does not set keepalive.
   *   • `navigator.sendBeacon` is NOT used because auth is a Bearer token in
   *     the Authorization header. Beacon sends a POST and cannot carry custom
   *     headers — the server would reject it with 401.
   *
   * Auth token is read from localStorage (same key as api.js /
   * src/components/auth/constants.ts) so the header matches what the server
   * expects. The token may be absent (not logged in, token cleared) — in that
   * case the request fires without an Authorization header and the server will
   * 401 it; this is acceptable for a best-effort flush.
   */
  const flushImmediately = useCallback(() => {
    if (flushTimerRef.current === null) return; // nothing pending — no-op
    clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;

    const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    fetch('/api/settings/ui-preferences', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ favoriteModels: favoritesRef.current }),
      keepalive: true,
    }).catch(() => {
      /* best-effort — page may already be tearing down */
    });
  }, []); // only refs used — stable, no deps needed

  // Condition 2: register page-unload listeners for the immediate flush.
  useEffect(() => {
    const handlePageHide = () => flushImmediately();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushImmediately();
    };

    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // Defensive: also flush synchronously when the component unmounts during
      // normal SPA navigation. For hard reloads the pagehide path covers this.
      // This does NOT help if the page is killed mid-debounce by the OS, but
      // pagehide handles that case.
      flushImmediately();
    };
  }, [flushImmediately]);

  const handleToggleFavorite = useCallback(
    (key: string) => {
      // Mark that the user has interacted so the GET result is no longer
      // authoritative (Condition 1 guard). Set before setFavorites so any
      // concurrent GET resolution that runs as a microtask after this line sees
      // the flag as true. (JavaScript is single-threaded, so a synchronous block
      // between these two statements is impossible — this ordering is defensive.)
      hasUserToggledRef.current = true;

      setFavorites((prev) => {
        // Soft cap: silently reject additions at the limit. Removals always pass.
        if (!prev.includes(key) && prev.length >= MAX_FAVORITES) return prev;
        const next = toggleFavorite(key, prev);
        scheduleFlush(next);
        return next;
      });
    },
    [scheduleFlush],
  );

  return { favorites, handleToggleFavorite, isLoading };
}
