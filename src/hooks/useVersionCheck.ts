import { useState, useEffect, useCallback } from 'react';

import { ReleaseInfo } from '../types/sharedTypes';
import { authenticatedFetch } from '../utils/api';
import { subscribeRestartSignal } from '../utils/restartSignal';
import {
  publishServerCapabilities,
  resolveServerCapabilitiesUnavailable,
} from '../stores/serverCapabilitiesStore';

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

const SOURCE_VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;
const UNKNOWN_VERSION = '—';
const SERVER_BUILD_ID_PATTERN = /^[a-f0-9]{64}$/;

type ServerPreviewHealth = {
  restartRequired?: unknown;
  serverCandidateBuildId?: unknown;
  serverPromotedBuildId?: unknown;
  serverLoadedBuildId?: unknown;
  serverBuildIdOnDisk?: unknown;
  hasPendingActions?: unknown;
  degraded?: unknown;
  degradedReason?: unknown;
  /** Advertised only by servers that expose the authorised bulk lifecycle API. */
  bulkLifecycleActions?: unknown;
};

/** Reason codes published by /health (ADR-156 WI-6); anything else is unknown. */
const DEGRADED_REASONS = [
  'manual_recovery_required',
  'source_update_maintenance',
  'maintenance_state_unavailable',
  // ADR-156 ب.5 (H3): reopened on the previous generation while the source
  // still sits at the target; serving, but the next update is blocked.
  'source_state_unreconciled',
] as const;
export type DegradedReason = typeof DEGRADED_REASONS[number] | 'unknown';

/**
 * ADR-156 WI-6 (T-1718). A node whose maintenance gate is not healthy must say
 * so permanently in the UI, not only to an external monitor. Absent or
 * malformed values read as NOT degraded: an older server that never publishes
 * the field must not light a banner the owner cannot act on.
 */
export function resolveDegraded(data: ServerPreviewHealth): DegradedReason | null {
  if (data.degraded !== true) return null;
  const reason = data.degradedReason;
  return typeof reason === 'string' && (DEGRADED_REASONS as readonly string[]).includes(reason)
    ? reason as DegradedReason
    : 'unknown';
}

/**
 * ADR-156 M1 (plan §F.2.2). The version this node RUNS is the loaded build's
 * `runtimeVersion`, not package.json: `git checkout` moves the source to the
 * target before activation, and a degraded reopen leaves it there while the
 * previous generation keeps serving. Comparing the source would hide the
 * outstanding update and print the wrong number. The source version is only a
 * fallback for servers that do not publish a runtime identity.
 */
export function resolveRunningVersion(runtimeVersion: string | null, sourceVersion: string | null): string | null {
  return runtimeVersion ?? sourceVersion;
}

/** True when the tree holds a newer version than the process serves (staged or unreconciled). */
export function isSourceAheadOfRuntime(runtimeVersion: string | null, sourceVersion: string | null): boolean {
  return Boolean(runtimeVersion && sourceVersion && compareVersions(sourceVersion, runtimeVersion) > 0);
}

const buildId = (value: unknown): string | null =>
  typeof value === 'string' && SERVER_BUILD_ID_PATTERN.test(value) ? value : null;

/**
 * The identity test behind "a restart would load different bytes": the build
 * PROMOTED to disk is valid, differs from the one this process loaded, and — if
 * the server names a promoted build at all — names that same on-disk build.
 *
 * Factored out (review م-6) so `resolveRestartRequired` and the prepared-state
 * derivation below cannot drift apart. They answer different questions (does
 * the LEDGER say a restart is due, versus is an update PREPARED) but they must
 * agree on what counts as a promoted build, or the UI contradicts itself.
 */
function promotedBuildDiffersFromLoaded(data: ServerPreviewHealth): boolean {
  const loaded = buildId(data.serverLoadedBuildId);
  const onDisk = buildId(data.serverBuildIdOnDisk);
  if (!loaded || !onDisk || onDisk === loaded) return false;
  // The candidate is durable audit history, including after a rollback. The
  // decision is valid only when the promoted on-disk build differs from the
  // build this process actually loaded.
  const promoted = data.serverPromotedBuildId;
  return promoted === null || buildId(promoted) === onDisk;
}

/**
 * B-1055 (ADR-156 WI-5). The signals behind the THIRD state: an update is
 * already PREPARED on this node and only its activation is still owed.
 *
 *  - `promoted` — a promoted build on disk that this process did not load.
 *    Only promoted bytes can be loaded by a replacement process, so this alone
 *    is prepared work, and it is derived independently of the server's own
 *    `restartRequired` ledger, which a partially-updated server can report
 *    stale. It uses the same identity test as `resolveRestartRequired` (م-6).
 *  - `candidateBuildId` — a sealed candidate that has NOT reached disk: the
 *    window between staging and activation. On its own this proves nothing,
 *    because a candidate id is durable audit history that survives a rollback
 *    (B-1334). It becomes prepared work only when the action queue holds a
 *    safe-restart row bound to THAT EXACT build — see `isUpdatePrepared`.
 */
export type PreparedSignals = {
  promoted: boolean;
  candidateBuildId: string | null;
};

export function resolvePreparedSignals(data: ServerPreviewHealth): PreparedSignals {
  const loaded = buildId(data.serverLoadedBuildId);
  if (!loaded) return { promoted: false, candidateBuildId: null };
  if (promotedBuildDiffersFromLoaded(data)) return { promoted: true, candidateBuildId: null };
  const onDisk = buildId(data.serverBuildIdOnDisk);
  const candidate = buildId(data.serverCandidateBuildId);
  return {
    promoted: false,
    candidateBuildId: candidate && candidate !== loaded && candidate !== onDisk ? candidate : null,
  };
}

/**
 * Combines the health signals with the ACTUAL queue (review م-6). The generic
 * `hasPendingActions` flag is not enough: it is true for any queued action of
 * any kind, so a retained candidate plus an unrelated queued command used to
 * read as "an update is waiting for you". The queue must hold a safe-restart
 * row bound to this candidate's own build fingerprint — that row IS the
 * pending activation, and nothing else stands in for it.
 *
 * @param queuedRestartBuildIds `expectedServerBuildId` of every queued
 *   safe-restart row, from GET /api/system/pending.
 */
export function isUpdatePrepared(
  signals: PreparedSignals,
  queuedRestartBuildIds: readonly (string | null)[] = [],
): boolean {
  if (signals.promoted) return true;
  return signals.candidateBuildId !== null
    && queuedRestartBuildIds.includes(signals.candidateBuildId);
}

/** Client-side fail-safe for older processes that may expose a stale ledger. */
export function resolveRestartRequired(data: ServerPreviewHealth): boolean | null {
  if (typeof data.restartRequired !== 'boolean') return null;
  if (!data.restartRequired) return false;
  return promotedBuildDiffersFromLoaded(data);
}

export const useVersionCheck = () => {
  const [sourceVersion, setSourceVersion] = useState<string | null>(null);
  // M1: the RUNNING build's version from /health; null when the server does
  // not publish one (older build or no provenance), and then source is used.
  const [runtimeVersion, setRuntimeVersion] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null);
  const [installMode, setInstallMode] = useState<InstallMode>('git');
  const [updateMode, setUpdateMode] = useState<'release' | 'local-main' | null>(null);
  const [localUpdateAvailable, setLocalUpdateAvailable] = useState(false);
  // T-928: true when the SERVER build (dist-server) changed after this process
  // booted — the only skew a restart actually resolves. It used to track the
  // CLIENT bundle, so every `build:client` raised a "restart required" banner
  // whose Execute button drained and restarted the server to deploy something
  // that was already live off disk (dist is served from the filesystem). That
  // loop produced seven restarts in an hour on 2026-07-27.
  // Polled on the same /health interval as installMode — no extra request.
  //
  // T-1296 (السابقة الثانية، 2026-08-04): عولج حينها مصدر الإشارة الخاطئة ولم
  // تُعالَج نافذة الستين ثانية، فبقيت اللافتة تكذب من الطرف الآخر: إعادة التشغيل
  // تكتمل في 2–5 ثوانٍ، والاستطلاع كل 60 ثانية — فتظلّ اللافتة معروضة حتى دقيقة
  // بعد أن صارت باطلة. المالك يقرأ بقاءها «لم يُنفَّذ طلبي» فيضغط ثانيةً. المقيس:
  // 27 انفجاراً بفارق أقل من 120 ثانية من 103 حدث system_restart_triggered
  // (~26% مهدور)، وثلاث إعادات في أربع ثوانٍ عند 22:18:10/12/14 — الثانية
  // والثالثة بسبب `restart-required-banner`.
  // العلاج هنا شقّان: (أ) إسقاط تفاؤلي للافتة فور إشارة `completed`، و(ب) استطلاع
  // مُسرَّع (3 ثوانٍ) طوال دورة إعادة التشغيل بدل انتظار الدورة التالية — والشقّ (ب)
  // ضروريّ لأن مراقب الاستطلاع في اللوحة يتوقّف بإغلاقها، فلا أحد يُسقط اللافتة.
  // ما يبقى خارج قدرة العميل: تبويب على جهاز آخر أو مرآة جلسة لمشاهد ثانٍ — تحتاج
  // طابعاً زمنياً معمَّراً من الخادم في /health (T-1302). لا تعتبر هذا كافياً.
  const [restartRequired, setRestartRequired] = useState(false);
  // T-944 F1: true when /health reports at least one pending server action.
  // The full list is fetched by useServerActions via GET /api/system/pending.
  const [hasPendingActions, setHasPendingActions] = useState(false);
  // Fail closed: an older or partially-updated server must never make a
  // destructive bulk control look available merely because the client has
  // already been published.
  const [bulkLifecycleActions, setBulkLifecycleActions] = useState(false);
  // B-1055: a build is staged or promoted but not the one this process runs.
  const [preparedSignals, setPreparedSignals] = useState<PreparedSignals>(
    { promoted: false, candidateBuildId: null },
  );
  // ADR-156 WI-6: the maintenance gate is not healthy; the banner stays up.
  const [degradedReason, setDegradedReason] = useState<DegradedReason | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const response = await fetch('/health', { cache: 'no-store' });
      if (!response.ok) {
        resolveServerCapabilitiesUnavailable();
        setBulkLifecycleActions(false);
        return null;
      }
      const data = await response.json();
      // One shared health read feeds feature consumers. Chat must never create
      // a second `/health` request merely to decide which history payload to use.
      publishServerCapabilities(data);
      setUpdateMode(data.updateMode === 'local-main' ? 'local-main' : 'release');
      // Keep the last version that the source itself confirmed. A transient
      // health/read failure must not make an already-known version disappear.
      if (typeof data.sourceVersion === 'string' && SOURCE_VERSION_PATTERN.test(data.sourceVersion)) {
        setSourceVersion(data.sourceVersion);
      }
      // Unlike the source version, a successful read that no longer names a
      // runtime version CLEARS it: a restart onto a build without provenance
      // must not keep printing the previous process's number.
      setRuntimeVersion(
        typeof data.runtimeVersion === 'string' && SOURCE_VERSION_PATTERN.test(data.runtimeVersion)
          ? data.runtimeVersion
          : null,
      );
      if (data.installMode === 'npm' || data.installMode === 'git') {
        setInstallMode(data.installMode);
      }
      // T-928: server signals when a client rebuild has landed on disk
      // while the server process is still running the old backend.
      const resolvedRestartRequired = resolveRestartRequired(data);
      if (resolvedRestartRequired !== null) {
        setRestartRequired(resolvedRestartRequired);
      }
      // T-944: /health exposes hasPendingActions (boolean signal only).
      // Details come from GET /api/system/pending in useServerActions.
      setHasPendingActions(Boolean(data.hasPendingActions));
      setBulkLifecycleActions(data.bulkLifecycleActions === true);
      setPreparedSignals(resolvePreparedSignals(data));
      setDegradedReason(resolveDegraded(data));
      return resolvedRestartRequired;
    } catch {
      // Default to git on error
      resolveServerCapabilitiesUnavailable();
      setBulkLifecycleActions(false);
      return null;
    }
  }, []);

  useEffect(() => {
    void fetchHealth();
    // Re-poll every 60 s so the banner appears within a minute of a build
    // finishing, without hammering /health on short intervals. The 60 s cadence
    // is right for the RISING edge (a build landing); the FALLING edge is driven
    // by the restart signal below, because there it is a whole minute of lying.
    const interval = setInterval(() => void fetchHealth(), 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  // T-1296: accelerate the falling edge of restartRequired.
  //  - 'triggered'  → poll /health every 3 s (capped) until the server comes back
  //                   and reports restartRequired=false. Survives the panel being
  //                   closed, which stops useRestartWatch dead.
  //  - 'completed'  → drop the banner optimistically NOW, then re-fetch /health
  //                   immediately to confirm rather than wait for the next tick.
  useEffect(() => {
    let fastTimer: ReturnType<typeof setInterval> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

    const stopFast = () => {
      if (fastTimer) { clearInterval(fastTimer); fastTimer = null; }
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
    };

    const unsubscribe = subscribeRestartSignal(signal => {
      if (signal === 'completed') {
        stopFast();
        setRestartRequired(false);
        setPreparedSignals({ promoted: false, candidateBuildId: null });
        void fetchHealth();
        return;
      }
      // 'triggered'
      stopFast();
      fastTimer = setInterval(() => {
        void fetchHealth().then(required => {
          if (required === false) stopFast();
        });
      }, 3_000);
      // Hard cap: a restart that has not landed in 90 s is not coming back on
      // its own, and a hidden 3 s poll must never become permanent.
      deadlineTimer = setTimeout(stopFast, 90_000);
    });

    return () => {
      unsubscribe();
      stopFast();
    };
  }, [fetchHealth]);

  useEffect(() => {
    if (!updateMode) return;
    const checkVersion = async () => {
      const clearRelease = () => {
        setLatestVersion(null);
        setReleaseInfo(null);
      };

      try {
        if (updateMode === 'local-main') {
          clearRelease();
          const response = await authenticatedFetch('/api/system/update/local');
          if (response.ok) {
            const data = await response.json();
            setLocalUpdateAvailable(data.mode === 'local-main' && data.available === true);
          }
          return;
        }
        setLocalUpdateAvailable(false);
        // Release discovery is server-side so private repository credentials are
        // never exposed to the browser. The endpoint is authenticated just like
        // the governed updater that consumes the advertised version.
        const response = await authenticatedFetch('/api/system/release/latest');
        // Express may honor a conditional request even with a private no-store
        // response. A 304 means the current release state remains authoritative.
        if (response.status === 304) return;
        if (!response.ok) {
          clearRelease();
          return;
        }
        const data = await response.json();

        if (data.success === true && typeof data.version === 'string') {
          const latest = data.version;
          setLatestVersion(latest);
          setReleaseInfo({
            title: data.title || data.tagName || latest,
            body: data.notes || '',
            // The private repository coordinate never crosses into the browser.
            htmlUrl: '',
            publishedAt: data.publishedAt || ''
          });
        } else {
          clearRelease();
        }
      } catch {
        clearRelease();
      }
    };

    checkVersion();
    const interval = setInterval(checkVersion, 5 * 60 * 1000); // Check every 5 minutes
    return () => clearInterval(interval);
  }, [updateMode]);

  const runningVersion = resolveRunningVersion(runtimeVersion, sourceVersion);
  const newerReleaseOffered = Boolean(
    latestVersion && runningVersion && compareVersions(latestVersion, runningVersion) > 0,
  );
  // B-1055 (ADR-156 WI-5). The version comparison alone made the update entry
  // point VANISH exactly when it was most needed: `git checkout` moves
  // package.json to the target version the moment the source is staged, so the
  // comparison goes to zero while the new build is still waiting to be
  // activated — and the owner lost every way to finish the update from the UI.
  // A prepared-but-inactive build is update work that is still outstanding.
  //
  // م-6: the candidate branch needs the ACTION QUEUE, which lives in
  // useServerActions and cannot be read from here without a second poll of the
  // same endpoint. So this hook answers the part it can prove on its own — the
  // promoted build — and exposes `preparedSignals` so the one caller that also
  // holds the queue (the sidebar) can complete the judgement with
  // `isUpdatePrepared`. Callers without the queue are never MORE optimistic
  // than the evidence they hold.
  const preparedAwaitingActivation = restartRequired || preparedSignals.promoted;
  const updateAvailable = updateMode === 'local-main' ? localUpdateAvailable : newerReleaseOffered || preparedAwaitingActivation;

  return {
    updateAvailable,
    /** A newer release is offered but nothing is staged yet. */
    newerReleaseOffered,
    /** The third state, as far as /health alone can prove it (see م-6). */
    updatePrepared: preparedAwaitingActivation,
    /** Raw signals for a caller that can also read the action queue. */
    preparedSignals,
    latestVersion,
    /** The version this node SERVES (runtime, falling back to source). */
    currentVersion: runningVersion ?? UNKNOWN_VERSION,
    /** The working tree's version; differs from `currentVersion` while staged or unreconciled. */
    sourceVersion,
    sourceAheadOfRuntime: isSourceAheadOfRuntime(runtimeVersion, sourceVersion),
    releaseInfo,
    installMode,
    restartRequired,
    hasPendingActions,
    bulkLifecycleActions,
    /** ADR-156 WI-6: null when healthy, otherwise the published reason code. */
    degradedReason,
  };
};
