/**
 * Runtime dependencies of the snapshot-backed harness flows (T-1871 stage 3):
 * paths, clock, ledger, ack tokens, child runners, gates, fences and audit.
 * One place builds the production defaults; tests replace any subset with
 * `/var/tmp` fixtures and stubs through `_setSnapshotRuntimeOverrides` or a
 * per-call override, so no test touches a real install or real member data.
 */

import os from 'node:os';

import { auditLogDb } from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/no-unknown -- the root command service owns the canonical secret-stripping environment.
import { cleanSpawnEnv } from '@/services/command-board-custom.js';
import { isVendorBinaryPinEnabled } from '@/services/isolation/vendor-binary-integrity.js';
import { HarnessBinaryUnresolvedError } from '@/shared/harness-binaries.js';
// eslint-disable-next-line boundaries/no-unknown -- process presence is a root service shared by all provider launchers.
import { hasActiveRunForProviders } from '@/services/session-process-monitor.js';

import { AckTokenService, loadOrCreateAckKey } from './confirmation.js';
import type { HarnessDescriptor } from './descriptors.js';
import {
  installCompatAsset,
  OPENCODE_COMPAT_ASSET,
  type AssetInstallOptions,
  type ReleaseAssetSpec,
} from './opencode-asset.js';
import {
  defaultHasUnregisteredLaunch,
  defaultRunVersion,
  runHarnessUpdateCommand,
  type RunCommandOptions,
} from './run-command.js';
import { isUpdaterGroupAlive, killUpdaterGroup, type UpdaterGroup } from './harness-lock.js';
import { snapshotError } from './snapshot/errors.js';
import type { StatfsFn } from './snapshot/retention.js';
import { assertNoStoreHolders } from './snapshot/open-handles.js';
import { snapshotRootDir } from './snapshot/paths.js';
import { sharedSpawnLedger, type SpawnLedger } from './spawn-ledger.js';
import {
  clearHarnessRecoveryBlocked,
  isHarnessRecoveryBlocked,
  markHarnessRecoveryBlocked,
} from './spawn-admission.js';
import type { HarnessAuditFn, RunResult } from './update-jobs.js';
import { recordJobVersionChange } from './version-drift.js';
import {
  isRestoreCompatibleVerified,
  markRestoreCompatibleVerified,
  probeLatestVersion,
} from './version-status.service.js';

/** Durable per-harness launch fence (the recovery intent / rollback_failed block). */
export interface RecoveryFence {
  mark(harness: string): void;
  clear(harness: string): void;
  isSet(harness: string): boolean;
}

/** Everything the snapshot flows reach outside their own logic. */
export interface SnapshotRuntime {
  /**
   * Home whose `.nassaj-users/*` + host stores are covered. Binaries are
   * resolved by the descriptor against `cleanEnv()`, the env the updater gets.
   */
  home: string;
  snapshotRoot: string;
  now: () => number;
  ledger: SpawnLedger;
  acks: () => AckTokenService;
  runVersion: (cmd: string, args: string[]) => Promise<string | null>;
  runCommand: (cmd: string, args: string[], opts: RunCommandOptions) => Promise<RunResult>;
  cleanEnv: () => NodeJS.ProcessEnv;
  hasLiveSession: (providerIds: string[]) => boolean;
  hasUnregisteredLaunch: (providerIds: string[]) => Promise<boolean>;
  assertNoHolders: (paths: string[]) => void;
  statfs?: StatfsFn;
  deviceOf?: (p: string) => number;
  fence: RecoveryFence;
  audit: HarnessAuditFn;
  pinArmed: () => boolean;
  /** Latest published version (cached probe), or null when unknown. */
  latestVersion: (d: HarnessDescriptor) => Promise<string | null>;
  recordVersionChange: (harness: string, version: string) => void;
  /** Durable "a real restore-compatible run succeeded here" flag (qa cond. 4). */
  compatVerified: { get(harness: string): boolean; set(harness: string): void };
  installCompatAsset: (opts: AssetInstallOptions) => Promise<void>;
  /** The pinned release asset restore-compatible installs (opencode 1.17.18). */
  compatAsset: ReleaseAssetSpec;
  /** Liveness + kill of a persisted updater process group (boot reconcile). */
  updaterGroup: { isAlive(g: UpdaterGroup): boolean; kill(g: UpdaterGroup): void };
  /** How long boot waits for a killed updater group to be proven dead. */
  updaterDeathWaitMs: number;
}

let ackService: AckTokenService | null = null;

/** The dedicated-key ack service; the key is loaded on first use only. */
function defaultAcks(): AckTokenService {
  ackService ??= new AckTokenService(loadOrCreateAckKey());
  return ackService;
}

function defaultRuntime(): SnapshotRuntime {
  return {
    home: os.homedir(),
    snapshotRoot: snapshotRootDir(),
    now: Date.now,
    ledger: sharedSpawnLedger(),
    acks: defaultAcks,
    runVersion: defaultRunVersion,
    runCommand: runHarnessUpdateCommand,
    cleanEnv: () => cleanSpawnEnv() as NodeJS.ProcessEnv,
    hasLiveSession: hasActiveRunForProviders,
    hasUnregisteredLaunch: defaultHasUnregisteredLaunch,
    assertNoHolders: (paths) => assertNoStoreHolders(paths),
    fence: { mark: markHarnessRecoveryBlocked, clear: clearHarnessRecoveryBlocked, isSet: (id) => isHarnessRecoveryBlocked(id) },
    audit: (action, metadata, userId) => auditLogDb.record(action, { userId, metadata }),
    pinArmed: () => isVendorBinaryPinEnabled(),
    latestVersion: (d) => probeLatestVersion(d),
    recordVersionChange: recordJobVersionChange,
    compatVerified: { get: isRestoreCompatibleVerified, set: markRestoreCompatibleVerified },
    installCompatAsset,
    compatAsset: OPENCODE_COMPAT_ASSET,
    updaterGroup: { isAlive: isUpdaterGroupAlive, kill: killUpdaterGroup },
    updaterDeathWaitMs: 5_000,
  };
}

let overrides: Partial<SnapshotRuntime> | null = null;

/** Test hook: replace any subset of the runtime (null restores production). */
export function _setSnapshotRuntimeOverrides(next: Partial<SnapshotRuntime> | null): void {
  overrides = next;
}

/** The effective runtime: production defaults ← test overrides ← per-call overrides. */
export function resolveSnapshotRuntime(perCall: Partial<SnapshotRuntime> = {}): SnapshotRuntime {
  return { ...defaultRuntime(), ...(overrides ?? {}), ...perCall };
}

/**
 * The binary a flow snapshots, verifies and restores: the descriptor's registry
 * resolver. A CLI the registry cannot resolve is a layout mismatch (refused
 * before any change).
 */
export function resolveDescriptorBinary(d: HarnessDescriptor): string {
  try {
    return d.resolveBinary();
  } catch (error) {
    if (error instanceof HarnessBinaryUnresolvedError) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
    throw error;
  }
}
