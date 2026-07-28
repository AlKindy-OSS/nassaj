import { useState, useEffect, useCallback } from 'react';
import { compareVersions } from './useVersionCheck';

/**
 * Watches the upstream repository (siteboon/claudecodeui) for new releases so
 * the fork owner can decide what to port. This is intentionally separate from
 * useVersionCheck, which tracks the fork's own update channel
 * (the repo named by VITE_SOURCE_URL).
 *
 * - Polls the public GitHub releases API at most once per CHECK_INTERVAL,
 *   caching the last result in localStorage (shared across tabs/reloads).
 * - Compares against the last release the owner acknowledged; the baseline is
 *   v1.34.0 (fully analyzed and ported on 2026-06-11).
 * - Fails silently on network errors / rate limits.
 */

const CACHE_KEY = 'CLOUDCLI_UPSTREAM_RELEASE_CACHE';
const ACK_KEY = 'CLOUDCLI_UPSTREAM_RELEASE_ACK';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const BASELINE_VERSION = '1.34.0';

type CachedRelease = {
  version: string;
  htmlUrl: string;
  timestamp: number;
};

export type UpstreamRelease = {
  version: string;
  htmlUrl: string;
};

const readCache = (): CachedRelease | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: CachedRelease = JSON.parse(raw);
    if (typeof parsed?.version !== 'string' || typeof parsed?.timestamp !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
};

export const useUpstreamReleaseWatch = (owner: string, repo: string, enabled = true) => {
  const [latestRelease, setLatestRelease] = useState<CachedRelease | null>(null);
  const [acknowledgedVersion, setAcknowledgedVersion] = useState<string>(() => {
    try {
      return localStorage.getItem(ACK_KEY) || BASELINE_VERSION;
    } catch {
      return BASELINE_VERSION;
    }
  });

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const check = async () => {
      // Serve from cache while it is still fresh (also covers boot-time reads
      // and other tabs having refreshed it recently).
      const cached = readCache();
      if (cached && Date.now() - cached.timestamp < CHECK_INTERVAL) {
        if (!cancelled) setLatestRelease(cached);
        return;
      }

      try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
        if (!response.ok) return; // rate limit / no releases: stay silent
        const data = await response.json();
        if (!data?.tag_name) return;

        const release: CachedRelease = {
          version: String(data.tag_name).replace(/^v/, ''),
          htmlUrl: data.html_url || `https://github.com/${owner}/${repo}/releases/latest`,
          timestamp: Date.now(),
        };
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(release));
        } catch {
          // ignore quota errors
        }
        if (!cancelled) setLatestRelease(release);
      } catch {
        // network failure: stay silent, retry on next tick
      }
    };

    void check();
    const interval = setInterval(() => void check(), CHECK_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [owner, repo, enabled]);

  const acknowledge = useCallback(() => {
    if (!latestRelease) return;
    setAcknowledgedVersion(latestRelease.version);
    try {
      localStorage.setItem(ACK_KEY, latestRelease.version);
    } catch {
      // ignore quota errors
    }
  }, [latestRelease]);

  const newRelease: UpstreamRelease | null =
    latestRelease && compareVersions(latestRelease.version, acknowledgedVersion) > 0
      ? { version: latestRelease.version, htmlUrl: latestRelease.htmlUrl }
      : null;

  return { newRelease, acknowledge };
};
