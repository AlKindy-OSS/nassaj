/**
 * useWhatsNew — show a version's curated highlights once per user.
 *
 * Keyed on the running version reported by `useVersionCheck`, so it fires for
 * every signed-in user after the node updates, not only for whoever pressed
 * the update button, and also right after an update job activates and the
 * version poll catches up.
 *
 * "Seen" lives in the user's account-synced UI preferences
 * (`uiPreferences.whatsNewLastSeenVersion`, see `useUiPreferences` and
 * `preferencesSync`), so a new device or browser does not show it again.
 * Rules:
 *  - Nothing shows until this tab has settled the account preferences
 *    (`getPreferencesHydratedSnapshot`), so a fresh device never flashes the
 *    popup before sync confirms it was already seen.
 *  - Dismissing records the version in the account preferences (mirrored to
 *    the server) and in a per-browser localStorage key.
 *  - The localStorage key is a fallback: if the server sync is offline or
 *    fails, the popup still shows at most once in that browser. It also
 *    migrates the old per-browser record — a version found there counts as seen
 *    and is pushed to the account when the account lacks it.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import {
  getPreferencesHydratedSnapshot,
  subscribePreferencesHydrated,
} from '../../../preferences/preferencesSync';
import { getWhatsNew } from './highlights';

/** Per-browser record (legacy store and offline fallback). */
export const WHATS_NEW_SEEN_KEY = 'nassaj:whatsNew:lastSeenVersion';

function readLastSeen(): string | null {
  try {
    return window.localStorage.getItem(WHATS_NEW_SEEN_KEY);
  } catch {
    return null;
  }
}

function writeLastSeen(version: string): void {
  try {
    window.localStorage.setItem(WHATS_NEW_SEEN_KEY, version);
  } catch {
    // Storage unavailable (private mode, quota): the account record still holds it.
  }
}

/**
 * Pure decision: which version's highlights to show now, or null for none.
 * `seenVersions` holds every record that may mark it seen (account, browser).
 */
export function resolveWhatsNewVersion(
  currentVersion: string | null | undefined,
  seenVersions: readonly (string | null | undefined)[],
  language: string,
): string | null {
  if (!currentVersion || seenVersions.includes(currentVersion)) return null;
  return getWhatsNew(currentVersion, language) ? currentVersion : null;
}

/**
 * Whether the browser record should be pushed to the account: the account has
 * no record yet (legacy migration), or the browser saw the running version
 * while the account did not (a dismissal whose sync was lost offline). An
 * account record newer than the browser's is never overwritten.
 */
export function shouldPushBrowserSeen(
  browserSeen: string | null,
  accountSeen: string | null,
  currentVersion: string | null | undefined,
): browserSeen is string {
  if (!browserSeen || browserSeen === accountSeen) return false;
  return !accountSeen || browserSeen === currentVersion;
}

export function useWhatsNew(currentVersion: string | null | undefined, language: string): {
  version: string | null;
  items: readonly string[] | null;
  dismiss: () => void;
} {
  const hydrated = useSyncExternalStore(
    subscribePreferencesHydrated,
    getPreferencesHydratedSnapshot,
    getPreferencesHydratedSnapshot,
  );
  const { preferences, setPreference } = useUiPreferences();
  const accountSeen = preferences.whatsNewLastSeenVersion || null;
  const [browserSeen, setBrowserSeen] = useState<string | null>(readLastSeen);

  useEffect(() => {
    if (hydrated && shouldPushBrowserSeen(browserSeen, accountSeen, currentVersion)) {
      setPreference('whatsNewLastSeenVersion', browserSeen);
    }
  }, [hydrated, browserSeen, accountSeen, currentVersion, setPreference]);

  const version = useMemo(
    () => (hydrated ? resolveWhatsNewVersion(currentVersion, [accountSeen, browserSeen], language) : null),
    [hydrated, currentVersion, accountSeen, browserSeen, language],
  );

  const dismiss = useCallback(() => {
    if (!version) return;
    writeLastSeen(version);
    setBrowserSeen(version);
    setPreference('whatsNewLastSeenVersion', version);
  }, [version, setPreference]);

  return { version, items: version ? getWhatsNew(version, language) : null, dismiss };
}
