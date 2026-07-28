import { useState, useEffect } from 'react';

import { version } from '../../package.json';
import { ReleaseInfo } from '../types/sharedTypes';

/**
 * Compare two semantic version strings
 * Works only with numeric versions separated by dots (e.g. "1.2.3")
 * @param {string} v1
 * @param {string} v2
 * @returns positive if v1 > v2, negative if v1 < v2, 0 if equal
 */
export const compareVersions = (v1: string, v2: string) => {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 !== p2) return p1 - p2;
  }
  return 0;
};

export type InstallMode = 'git' | 'npm';

export const useVersionCheck = (owner: string, repo: string, fetchEnabled = true) => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null);
  const [installMode, setInstallMode] = useState<InstallMode>('git');
  // T-928: true when the SERVER build (dist-server) changed after this process
  // booted — the only skew a restart actually resolves. It used to track the
  // CLIENT bundle, so every `build:client` raised a "restart required" banner
  // whose Execute button drained and restarted the server to deploy something
  // that was already live off disk (dist is served from the filesystem). That
  // loop produced seven restarts in an hour on 2026-07-27.
  // Polled on the same /health interval as installMode — no extra request.
  const [restartRequired, setRestartRequired] = useState(false);
  // T-944 F1: true when /health reports at least one pending server action.
  // The full list is fetched by useServerActions via GET /api/system/pending.
  const [hasPendingActions, setHasPendingActions] = useState(false);

  useEffect(() => {
    const fetchInstallMode = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        if (data.installMode === 'npm' || data.installMode === 'git') {
          setInstallMode(data.installMode);
        }
        // T-928: server signals when a client rebuild has landed on disk
        // while the server process is still running the old backend.
        if (typeof data.restartRequired === 'boolean') {
          setRestartRequired(data.restartRequired);
        }
        // T-944: /health exposes hasPendingActions (boolean signal only).
        // Details come from GET /api/system/pending in useServerActions.
        setHasPendingActions(Boolean(data.hasPendingActions));
      } catch {
        // Default to git on error
      }
    };
    fetchInstallMode();
    // Re-poll every 60 s so the banner appears within a minute of a build
    // finishing, without hammering /health on short intervals.
    const interval = setInterval(fetchInstallMode, 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    // Skip GitHub releases fetch when disabled (e.g. private fork with no public releases).
    // Browser console logs a network-level 404 for any failed fetch regardless of JS error
    // handling, so the only way to silence it is to not send the request at all.
    if (!fetchEnabled) return;

    const checkVersion = async () => {
      try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
        // 404 = private repo / no public releases. Treat silently like "no update".
        if (!response.ok) return;
        const data = await response.json();

        // Handle the case where there might not be any releases
        if (data.tag_name) {
          const latest = data.tag_name.replace(/^v/, '');
          setLatestVersion(latest);
          // Only show update if latest version is actually newer
          setUpdateAvailable(compareVersions(latest, version) > 0);

          // Store release information
          setReleaseInfo({
            title: data.name || data.tag_name,
            body: data.body || '',
            htmlUrl: data.html_url || `https://github.com/${owner}/${repo}/releases/latest`,
            publishedAt: data.published_at
          });
        } else {
          // No releases found, don't show update notification
          setUpdateAvailable(false);
          setLatestVersion(null);
          setReleaseInfo(null);
        }
      } catch {
        // Version check failed (e.g. private repo, network error, rate limit).
        // Stay silent — no update notification shown, no console noise.
        setUpdateAvailable(false);
        setLatestVersion(null);
        setReleaseInfo(null);
      }
    };

    checkVersion();
    const interval = setInterval(checkVersion, 5 * 60 * 1000); // Check every 5 minutes
    return () => clearInterval(interval);
  }, [owner, repo, fetchEnabled]);

  return { updateAvailable, latestVersion, currentVersion: version, releaseInfo, installMode, restartRequired, hasPendingActions };
};