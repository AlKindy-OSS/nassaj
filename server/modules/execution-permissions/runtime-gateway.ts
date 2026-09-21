import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  BOOT_ID_UNAVAILABLE,
  type PermissionChildIdentity,
  getConnection,
  reconcileExpiredPermissionExecutions,
} from '@/modules/database/index.js';
// constants/ is outside the module graph but is the canonical platform-mode source.
// eslint-disable-next-line boundaries/no-unknown
import { IS_PLATFORM } from '@/constants/config.js';

import { createAuthenticatedLaunchActor } from './actor.js';
import {
  resolveInstalledAgyBuildFingerprint,
  PERMISSION_CAPABILITY_ARTIFACT_DIGEST,
  resolveInstalledClaudeBuildFingerprint,
  resolveInstalledCodexBuildFingerprint,
  resolveMeasuredPermissionCandidate,
} from './capability-registry.js';
import { createExecutionPermissionGateway, type PermissionGatewayResult } from './execution-gateway.service.js';
import { CLAUDE_REFERENCE_VECTOR_V1 } from './fixtures/claude-reference-v1.js';
import { resolveRuntimePermissionIdentity } from './runtime-release-identity.js';
import type { CanonicalLaunchContext } from './types.js';

const readSmallIdentity = (file: string, fallback: string, maxLength = 256): string => {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return value && value.length <= maxLength ? value : fallback;
  } catch {
    return fallback;
  }
};

const runtimeIdentity = resolveRuntimePermissionIdentity(process.env);
const processStat = readSmallIdentity(`/proc/${process.pid}/stat`, '', 4096);
const processStartTicks = processStat.includes(')')
  ? (processStat.slice(processStat.lastIndexOf(')') + 2).split(' ')[19] ?? `pid:${process.pid}`)
  : `pid:${process.pid}`;
const processIdentity = Object.freeze({
  ownerId: `server:${process.pid}`,
  ownerPid: process.pid,
  ownerBootId: readSmallIdentity('/proc/sys/kernel/random/boot_id', BOOT_ID_UNAVAILABLE),
  ownerStartTicks: processStartTicks,
});

let gateway: ReturnType<typeof createExecutionPermissionGateway> | null = null;
type RuntimeInstalledIdentity = Readonly<{
  buildFingerprint: string; sdkFingerprint?: string; cliFingerprint?: string;
}>;

/** Build a drift-sensitive resolver. Installed identities are re-read for every admission. */
export const createRuntimeCandidateResolver = (dependencies: Readonly<{
  resolveClaude(): RuntimeInstalledIdentity;
  resolveCodex(): RuntimeInstalledIdentity;
  resolveAntigravity(): RuntimeInstalledIdentity;
  now(): string;
}> = {
  resolveClaude: resolveInstalledClaudeBuildFingerprint,
  resolveCodex: resolveInstalledCodexBuildFingerprint,
  resolveAntigravity: resolveInstalledAgyBuildFingerprint,
  now: () => new Date().toISOString(),
}) => (context: CanonicalLaunchContext) => {
  try {
    const installedIdentity = context.body === 'claude'
      ? dependencies.resolveClaude()
      : context.body === 'codex'
        ? dependencies.resolveCodex()
        : context.body === 'antigravity'
          ? dependencies.resolveAntigravity()
          : null;
    if (!installedIdentity) return null;
    return resolveMeasuredPermissionCandidate(
      context,
      dependencies.now(),
      installedIdentity,
    );
  } catch {
    return null;
  }
};

const candidateForRuntime = createRuntimeCandidateResolver();

const getGateway = (): ReturnType<typeof createExecutionPermissionGateway> => {
  gateway ??= createExecutionPermissionGateway({
    database: getConnection(),
    authority: runtimeIdentity.authority,
    reference: CLAUDE_REFERENCE_VECTOR_V1,
    candidateFor: candidateForRuntime,
    capabilityArtifactDigest: PERMISSION_CAPABILITY_ARTIFACT_DIGEST,
    releaseBuild: runtimeIdentity.releaseBuild,
    manifestDigest: runtimeIdentity.manifestSha256,
    processIdentity,
    randomId: () => crypto.randomUUID(),
    nowMs: () => Date.now(),
  });
  return gateway;
};

/** Production composition entry: actor comes from auth middleware, context from server state. */
export const authorizeRuntimeProviderExecution = (
  authenticatedPrincipal: unknown,
  context: CanonicalLaunchContext,
): PermissionGatewayResult => {
  if (IS_PLATFORM) throw new Error('PLATFORM_ACTOR_UNVERIFIED');
  const actor = createAuthenticatedLaunchActor(authenticatedPrincipal as never);
  if (actor.principalId !== context.principalId) {
    throw new Error('LAUNCH_ACTOR_CONTEXT_MISMATCH');
  }
  return getGateway().authorize(actor, context, 'full_delegation');
};

/** Reconciles expired permission effects before readiness using exact Linux process identity. */
/** True only for the exact process (pid + boot + start ticks); PID reuse never matches. */
export const processAlive = (
  currentBootId: string,
  owner: PermissionChildIdentity,
  dependencies = { kill: process.kill, readFile: (file: string) => fs.readFileSync(file, 'utf8') },
): boolean => {
  // Unreadable identities cannot establish death (including a permissions failure).
  if (!currentBootId || currentBootId === BOOT_ID_UNAVAILABLE
    || !owner.bootId || owner.bootId === BOOT_ID_UNAVAILABLE) return true;
  if (owner.bootId !== currentBootId) return false;
  if (!/^\d+$/.test(owner.startTicks)) return true;
  try {
    dependencies.kill(owner.pid, 0);
    const stat = dependencies.readFile(`/proc/${owner.pid}/stat`).trim();
    if (!stat.includes(')')) return true;
    const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) return true;
    return startTicks === owner.startTicks;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH' && code !== 'ENOENT';
  }
};

/**
 * Boot gate (server/index.js): a local effect whose child is proven dead is recorded, never
 * fatal. An external unknown or a still-active exact owner is fatal for this boot only; the
 * rows are terminal and their scopes fenced, so the immediate retry boots clean (T-1593).
 */
export const isPermissionReconciliationFatal = (
  summary: Readonly<{ unknownExternal: number; stillActive: number }>,
): boolean => summary.unknownExternal > 0 || summary.stillActive > 0;

export const reconcileRuntimePermissionExecutions = () => {
  const currentBootId = readSmallIdentity('/proc/sys/kernel/random/boot_id', BOOT_ID_UNAVAILABLE);
  // A reboot ends local owners, but cannot establish the outcome of their effects.
  const alive = (identity: PermissionChildIdentity) => processAlive(currentBootId, identity);
  const summary = reconcileExpiredPermissionExecutions(getConnection(), Date.now(), alive, alive);
  if (summary.orphans.length > 0) {
    console.error('[permission-execution] local effect child processes outlived their dead owner; '
      + 'their scopes stay fenced until an operator lift (kill or wait for them to exit)',
      { orphans: summary.orphans });
  }
  return summary;
};
