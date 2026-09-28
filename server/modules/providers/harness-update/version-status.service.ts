/**
 * harness version-status service (T-1749 / ADR-159 item 3 & item 7).
 *
 * Reads each harness's INSTALLED version through its single resolver's binary
 * (`<binary> --version`, hard timeout + kill), and — for npm-backed harnesses —
 * probes the LATEST published version from the npm registry with a bounded
 * timeout, a ~6h TTL cache, per-package rate limiting, and stale-on-failure
 * behaviour (a network failure with no fresh cache yields `state:"unknown"`,
 * never a throw or a crash). Assembles the exact `HarnessVersionStatus` wire
 * shape the client renders.
 *
 * Every external effect (spawn, fetch, clock) is injectable so the unit tests
 * exercise failure injection and fail-closed paths without touching the host.
 */

import { spawn } from 'node:child_process';

import {
  isVendorBinaryPinEnabled,
  PINNED_VENDOR_DIGESTS,
} from '@/services/isolation/vendor-binary-integrity.js';
import { appConfigDb } from '@/modules/database/index.js';
import { HarnessBinaryUnresolvedError } from '@/shared/harness-binaries.js';

import type {
  HarnessCompatibility,
  HarnessUpdateJob,
  HarnessVersionDrift,
  HarnessVersionStatus,
} from '../../../../shared/harness-update.contract.js';


import { clearStaleNativeStageBeforeLaunch } from './native-staging.js';
import { computeHarnessCompatibility } from './compatibility.js';
import {
  getHarnessDescriptor,
  HARNESS_IDS,
  HARNESS_UPDATE_DESCRIPTORS,
  parseVersionOutput,
  type HarnessDescriptor,
} from './descriptors.js';
import { activeHarnessJobId, isHarnessLeased } from './lease.js';
import { isHarnessRecoveryBlocked } from './spawn-admission.js';
import { observeInstalledVersion, type DriftAudit, type VersionLedger } from './version-drift.js';

/** Hard cap on a `--version` read; the child is killed past it. */
export const VERSION_READ_TIMEOUT_MS = 10_000;
/** Latest-version cache TTL. */
export const LATEST_TTL_MS = 6 * 60 * 60 * 1000;
/** Minimum spacing between live npm probes for the same package. */
export const LATEST_RATE_LIMIT_MS = 5 * 60 * 1000;
/** Hard cap on a latest-version network probe. */
export const LATEST_PROBE_TIMEOUT_MS = 8_000;
/**
 * In-memory TTL for the INSTALLED-version probe (item 9). Every status read used
 * to spawn `<binary> --version` per harness — with ten harnesses and a 3s client
 * poll that was ~200 spawns/minute per open settings tab. The version on disk
 * only changes through an update job, which invalidates this cache explicitly,
 * so a short TTL is both cheap and correct.
 */
export const INSTALLED_TTL_MS = 60_000;

export interface VersionStatusDeps {
  /** Reads `<cmd> <args>` and resolves its trimmed stdout (or null on failure). */
  runVersion?: (cmd: string, args: string[]) => Promise<string | null>;
  /** Fetches the npm `latest` dist-tag version for `pkg` (or null on failure). */
  fetchNpmLatest?: (pkg: string) => Promise<string | null>;
  /** Fetches a GitHub `releases/latest` tag from a FIXED descriptor URL (or null). */
  fetchGithubLatest?: (url: string) => Promise<string | null>;
  /** Drift ledger (app_config by default). */
  versionLedger?: VersionLedger;
  /** Drift audit sink (`harness_version_drift` row by default). */
  driftAudit?: DriftAudit;
  now?: () => number;
  isLeased?: (provider: string) => boolean;
  activeJobId?: (provider: string) => string | null;
  /** Reads the in-memory job paired with the lease, when this process owns it. */
  getJob?: (jobId: string) => HarnessUpdateJob | null;
  /** Reads the durable pre-mutation/recovery fence. */
  recoveryBlocked?: (provider: string) => boolean;
  pinEnabled?: () => boolean;
  /** Durable "restore-compatible ran successfully here" flag (T-1871). */
  compatVerified?: (provider: string) => boolean;
}

interface LatestCacheEntry {
  version: string | null;
  fetchedAt: number;
  lastAttemptAt: number;
}

const latestCache = new Map<string, LatestCacheEntry>();

interface InstalledCacheEntry {
  raw: string | null;
  readAt: number;
}

/** harness id → last `--version` read. */
const installedCache = new Map<string, InstalledCacheEntry>();

/**
 * Drops the cached installed version for one harness (or all of them). Called by
 * the update service the moment an update job changes the bytes on disk, so the
 * next status read reports the NEW version instead of a stale cached one.
 */
export function invalidateInstalledVersion(provider?: string): void {
  if (provider) installedCache.delete(provider);
  else installedCache.clear();
}

let testDeps: VersionStatusDeps | null = null;

/**
 * Test hook: default dependencies for every status read (null restores the
 * real probes). Route tests use it so no test ever spawns a real harness
 * `--version` or reaches the npm / GitHub registries.
 */
export function _setVersionStatusTestDeps(next: VersionStatusDeps | null): void {
  testDeps = next;
}

/** Test hook: clear the latest-version AND installed-version caches. */
export function _resetLatestCache(): void {
  latestCache.clear();
  installedCache.clear();
}

/** Reads the installed version through the TTL cache. Never throws. */
async function readInstalledVersion(
  descriptor: HarnessDescriptor,
  runVersion: (cmd: string, args: string[]) => Promise<string | null>,
  now: () => number,
): Promise<string | null> {
  const t = now();
  const cached = installedCache.get(descriptor.id);
  if (cached && t - cached.readAt < INSTALLED_TTL_MS) return cached.raw;
  // An unresolved CLI (HarnessBinaryUnresolvedError) reads as "no version";
  // anything else is a real fault and propagates.
  let binary = '';
  try {
    binary = descriptor.resolveBinary();
  } catch (error) {
    if (!(error instanceof HarnessBinaryUnresolvedError)) throw error;
  }
  // A staging harness's `--version` would swap in a stale stage: never outside
  // an update window (native-staging.ts).
  if (descriptor.stagesNativeUpdate && binary) clearStaleNativeStageBeforeLaunch(descriptor.id, binary);
  const raw = await runVersion(binary, descriptor.versionArgs);
  installedCache.set(descriptor.id, { raw, readAt: t });
  return raw;
}

/** Default installed-version reader: spawn with a hard timeout + kill. */
function defaultRunVersion(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    if (!cmd) {
      resolve(null);
      return;
    }
    let settled = false;
    let out = '';
    let child: ReturnType<typeof spawn> | null = null;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      done(null);
    }, VERSION_READ_TIMEOUT_MS);
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      done(null);
      return;
    }
    child.stdout?.on('data', (b) => {
      out += b.toString();
    });
    // Some CLIs print the banner to stderr; capture both.
    child.stderr?.on('data', (b) => {
      out += b.toString();
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 || out.trim() !== '' ? out : null));
  });
}

/** Default latest probe: npm registry `latest` dist-tag with a bounded timeout. */
async function defaultFetchNpmLatest(pkg: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LATEST_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}/latest`,
      { signal: controller.signal, headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default GitHub probe: `releases/latest` of a fixed https URL, no auth, bounded
 * timeout. Strips a leading `v` from `tag_name`; anything not version-shaped is
 * treated as a failure (null) rather than shown.
 */
async function defaultFetchGithubLatest(url: string): Promise<string | null> {
  if (!url.startsWith('https://api.github.com/')) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LATEST_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'nassaj-harness-version-probe',
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown };
    if (typeof body.tag_name !== 'string') return null;
    const version = body.tag_name.replace(/^v/, '');
    return /^\d+\.\d+/.test(version) ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the latest version for `pkg` honouring cache TTL, rate limit and
 * stale-on-failure. `{ version, stale }` — `version` is null only when there is
 * neither a fresh nor a stale value (→ caller marks state `unknown`).
 */
async function resolveLatest(
  pkg: string,
  fetchLatest: (pkg: string) => Promise<string | null>,
  now: () => number,
): Promise<{ version: string | null; stale: boolean }> {
  const t = now();
  const cached = latestCache.get(pkg);
  if (cached && cached.version !== null && t - cached.fetchedAt < LATEST_TTL_MS) {
    return { version: cached.version, stale: false };
  }
  // Rate limit: do not hammer npm. Within the window, reuse whatever we have.
  if (cached && t - cached.lastAttemptAt < LATEST_RATE_LIMIT_MS) {
    return { version: cached.version, stale: cached.version !== null };
  }
  const fresh = await fetchLatest(pkg);
  if (fresh !== null) {
    latestCache.set(pkg, { version: fresh, fetchedAt: t, lastAttemptAt: t });
    return { version: fresh, stale: false };
  }
  // Network failure: keep any prior value as stale; record the attempt.
  latestCache.set(pkg, {
    version: cached?.version ?? null,
    fetchedAt: cached?.fetchedAt ?? 0,
    lastAttemptAt: t,
  });
  return { version: cached?.version ?? null, stale: cached?.version != null };
}

/** Runs the descriptor's latest probe through the shared cache; null = no probe. */
async function probeLatest(
  descriptor: HarnessDescriptor,
  deps: VersionStatusDeps,
  now: () => number,
): Promise<{ version: string | null; stale: boolean } | null> {
  const probe = descriptor.latestProbe;
  if (!probe) return null;
  if (probe.kind === 'npm') {
    return resolveLatest(probe.pkg, deps.fetchNpmLatest ?? defaultFetchNpmLatest, now);
  }
  return resolveLatest(probe.url, deps.fetchGithubLatest ?? defaultFetchGithubLatest, now);
}

/**
 * Latest published version of `descriptor` through the shared probe cache
 * (null when the harness has no probe or the probe has no answer). Used by the
 * update service to judge the TARGET's compatibility before a pinBreak ack.
 */
export async function probeLatestVersion(descriptor: HarnessDescriptor): Promise<string | null> {
  const latest = await probeLatest(descriptor, testDeps ?? {}, Date.now);
  return latest?.version ?? null;
}

/** Compatibility verdict for one version of this harness under the live pin posture. */
export function compatibilityOf(
  descriptor: HarnessDescriptor,
  version: string | null,
  pinArmed: boolean,
): HarnessCompatibility {
  return computeHarnessCompatibility({
    version,
    descriptor,
    pins: PINNED_VENDOR_DIGESTS,
    pinArmed,
    carrierAlwaysEnforced: Boolean(descriptor.compat?.alwaysEnforcedMode),
  });
}

/** Drift verdict; a failing ledger omits the field instead of failing the read. */
function driftOf(
  descriptor: HarnessDescriptor,
  installedVersion: string,
  deps: VersionStatusDeps,
  now: () => number,
): HarnessVersionDrift | undefined {
  try {
    return observeInstalledVersion(descriptor.id, installedVersion, {
      ledger: deps.versionLedger,
      audit: deps.driftAudit,
      nowIso: () => new Date(now()).toISOString(),
    });
  } catch {
    return undefined;
  }
}

/** Compatibility of the latest version, when a probe answered. */
function targetOf(
  descriptor: HarnessDescriptor,
  latestVersion: string | null,
  pinArmed: boolean,
): { targetCompatibility?: HarnessCompatibility } {
  return latestVersion === null
    ? {}
    : { targetCompatibility: compatibilityOf(descriptor, latestVersion, pinArmed) };
}

/**
 * True when the pin is armed AND this harness is in the frozen pin table AND
 * the harness has no snapshot rollback. A snapshot-backed harness is never
 * refused outright: leaving the pin needs a server-built `pinBreak`
 * acknowledgement instead (T-1871 §9), and the pin itself never changes.
 */
export function isHarnessPinRefused(
  descriptor: HarnessDescriptor,
  pinEnabled: () => boolean,
): boolean {
  return (
    descriptor.snapshot === null
    && descriptor.pinKey !== null
    && descriptor.pinKey in PINNED_VENDOR_DIGESTS
    && pinEnabled()
  );
}

/** T-1871 descriptor facts every status row carries (all optional on the wire). */
function updateFacts(
  descriptor: HarnessDescriptor,
  compatVerified: (provider: string) => boolean,
): Pick<HarnessVersionStatus, 'manualOnly' | 'notices' | 'restoreCompatible'> {
  const restore = descriptor.restoreCompatible;
  return {
    ...(descriptor.manualOnly ? { manualOnly: true } : {}),
    ...(descriptor.notices ? { notices: { ...descriptor.notices } } : {}),
    ...(restore ? { restoreCompatible: { version: restore.version, verified: safeFlag(compatVerified, descriptor.id) } } : {}),
  };
}

function safeFlag(read: (provider: string) => boolean, provider: string): boolean {
  try {
    return read(provider);
  } catch {
    return false;
  }
}

/** Spreads `drift` only when the ledger answered (the field stays optional). */
function withDrift(drift: HarnessVersionDrift | undefined): { drift?: HarnessVersionDrift } {
  return drift === undefined ? {} : { drift };
}

const COMPAT_VERIFIED_PREFIX = 'harness_restore_compatible_verified:';

/** Durable flag: a real restore-compatible run of `provider` succeeded on this host. */
export function isRestoreCompatibleVerified(provider: string): boolean {
  return appConfigDb.get(`${COMPAT_VERIFIED_PREFIX}${provider}`) === '1';
}

/** Sets the flag above; only a verified restore-compatible run calls it. */
export function markRestoreCompatibleVerified(provider: string): void {
  appConfigDb.set(`${COMPAT_VERIFIED_PREFIX}${provider}`, '1');
}

/** Computes the full status for one harness. Never throws. */
export async function getHarnessVersionStatus(
  idOrAlias: string,
  callDeps: VersionStatusDeps = {},
): Promise<HarnessVersionStatus | null> {
  const deps: VersionStatusDeps = { ...(testDeps ?? {}), ...callDeps };
  const descriptor = getHarnessDescriptor(idOrAlias);
  if (!descriptor) return null;

  const runVersion = deps.runVersion ?? defaultRunVersion;
  const now = deps.now ?? Date.now;
  const leased = (deps.isLeased ?? isHarnessLeased)(descriptor.id);
  const activeJobId = (deps.activeJobId ?? activeHarnessJobId)(descriptor.id);
  const activeJob = activeJobId === null ? null : deps.getJob?.(activeJobId) ?? null;
  const pinEnabled = deps.pinEnabled ?? (() => isVendorBinaryPinEnabled());
  const checkedAt = new Date(now()).toISOString();

  let recoveryBlocked = false;
  if (descriptor.updatable) {
    try {
      recoveryBlocked = (deps.recoveryBlocked ?? isHarnessRecoveryBlocked)(descriptor.id);
    } catch {
      recoveryBlocked = true;
    }
  }

  const activeIntent = leased
    && activeJobId !== null
    && (activeJob?.status === 'queued' || activeJob?.status === 'running');
  const failedRecovery = activeJob?.status === 'failed'
    && activeJob.error?.code === 'recovery_failed';

  const base = {
    provider: descriptor.id,
    checkedAt,
    updating: activeIntent,
    activeJobId: activeIntent ? activeJobId : null,
    ...updateFacts(descriptor, deps.compatVerified ?? isRestoreCompatibleVerified),
  };

  // The same durable marker is written before the first installation mutation
  // and retained after an unverified recovery. A coherent live job+lease means
  // the mutation is still legitimately running. Every other marked state is a
  // restart-safe recovery failure. Neither case may probe the changing binary.
  if (recoveryBlocked && activeIntent) {
    return {
      ...base,
      state: 'unknown',
      installedVersion: null,
      latestVersion: null,
      upToDate: null,
      updatable: false,
      reason: null,
    };
  }
  if (recoveryBlocked || failedRecovery) {
    return {
      ...base,
      updating: false,
      activeJobId: null,
      state: 'unknown',
      installedVersion: null,
      latestVersion: null,
      upToDate: null,
      updatable: false,
      reason: 'recovery_failed',
    };
  }

  // Hosted, no local CLI.
  if (descriptor.state === 'no-cli') {
    return {
      ...base,
      state: 'no-cli',
      installedVersion: null,
      latestVersion: null,
      upToDate: null,
      updatable: false,
      reason: descriptor.reason,
    };
  }

  // Read the installed version through the single resolver (TTL-cached).
  const rawVersion = await readInstalledVersion(descriptor, runVersion, now);
  const installedVersion = parseVersionOutput(rawVersion);

  // Managed-external with an unreadable version: unchanged pre-T-1871 shape.
  if (installedVersion === null && descriptor.state === 'managed-external') {
    return {
      ...base,
      state: 'managed-external',
      installedVersion: null,
      latestVersion: null,
      upToDate: null,
      updatable: false,
      reason: descriptor.reason ?? 'managed-external',
    };
  }

  // Binary not installed / unreadable → treat as no local CLI (never a crash).
  if (installedVersion === null) {
    return {
      ...base,
      state: 'no-cli',
      installedVersion: null,
      latestVersion: null,
      upToDate: null,
      updatable: false,
      reason: 'not-installed',
    };
  }

  const pinArmed = pinEnabled();
  const annotated = {
    ...base,
    compatibility: compatibilityOf(descriptor, installedVersion, pinArmed),
    ...withDrift(driftOf(descriptor, installedVersion, deps, now)),
  };

  // Managed-external: installed but nassaj cannot update in place. A latest probe
  // (when the descriptor has one) is informational only; updatable stays false.
  if (descriptor.state === 'managed-external') {
    const latest = await probeLatest(descriptor, deps, now);
    const latestVersion = latest?.version ?? null;
    return {
      ...annotated,
      state: 'managed-external',
      installedVersion,
      latestVersion,
      upToDate: latestVersion === null ? null : installedVersion === latestVersion,
      updatable: false,
      reason: descriptor.reason ?? 'managed-external',
      ...targetOf(descriptor, latestVersion, pinArmed),
    };
  }

  // Digest-pin refusal (item 5): armed pin + pinned harness → not updatable.
  if (isHarnessPinRefused(descriptor, () => pinArmed)) {
    return {
      ...annotated,
      state: 'updatable',
      installedVersion,
      latestVersion: null,
      upToDate: null,
      updatable: false,
      reason: 'pinned',
    };
  }

  const latest = await probeLatest(descriptor, deps, now);
  if (latest) {
    const { version: latestVersion, stale } = latest;
    if (latestVersion === null) {
      // Probe failed with no cache → unknown (never crash, never guess).
      return {
        ...annotated,
        state: 'unknown',
        installedVersion,
        latestVersion: null,
        upToDate: null,
        updatable: descriptor.updatable,
        reason: 'probe-failed',
      };
    }
    const upToDate = installedVersion === latestVersion;
    return {
      ...annotated,
      state: 'updatable',
      installedVersion,
      latestVersion,
      upToDate,
      updatable: descriptor.updatable,
      reason: stale ? 'latest-stale' : upToDate ? null : 'update-available',
      ...targetOf(descriptor, latestVersion, pinArmed),
    };
  }

  // No cheap latest probe (native self-updaters): show installed, no comparison.
  // The updater is idempotent, so the button is still safe to press.
  return {
    ...annotated,
    state: 'updatable',
    installedVersion,
    latestVersion: null,
    upToDate: null,
    updatable: descriptor.updatable,
    reason: 'no-latest-probe',
  };
}

/** Computes statuses for ALL harnesses (stable order). Never throws. */
export async function getAllHarnessVersionStatuses(
  deps: VersionStatusDeps = {},
): Promise<HarnessVersionStatus[]> {
  const out: HarnessVersionStatus[] = [];
  for (const id of HARNESS_IDS) {
    const status = await getHarnessVersionStatus(id, deps);
    if (status) out.push(status);
  }
  return out;
}

export { HARNESS_UPDATE_DESCRIPTORS };
