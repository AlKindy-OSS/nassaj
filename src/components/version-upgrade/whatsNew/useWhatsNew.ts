/**
 * useWhatsNew — show a version's curated highlights once per browser.
 *
 * Keyed on the running version reported by `useVersionCheck`, so it fires for
 * every signed-in user after the node updates, not only for whoever pressed
 * the update button, and also right after an update job activates and the
 * version poll catches up. A per-browser "last seen version" in localStorage
 * keeps it to once per version; dismissing records the version.
 */

import { useCallback, useEffect, useState } from 'react';
import { getWhatsNew } from './highlights';

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
    // Storage unavailable (private mode, quota): the popup may show again; harmless.
  }
}

/** Pure decision: which version's highlights to show now, or null for none. */
export function resolveWhatsNewVersion(
  currentVersion: string | null | undefined,
  lastSeen: string | null,
  language: string,
): string | null {
  if (!currentVersion || currentVersion === lastSeen) return null;
  return getWhatsNew(currentVersion, language) ? currentVersion : null;
}

export function useWhatsNew(currentVersion: string | null | undefined, language: string): {
  version: string | null;
  items: readonly string[] | null;
  dismiss: () => void;
} {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    setVersion(resolveWhatsNewVersion(currentVersion, readLastSeen(), language));
  }, [currentVersion, language]);

  const dismiss = useCallback(() => {
    if (version) writeLastSeen(version);
    setVersion(null);
  }, [version]);

  return { version, items: version ? getWhatsNew(version, language) : null, dismiss };
}
