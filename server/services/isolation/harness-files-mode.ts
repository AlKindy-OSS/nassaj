/**
 * harness-files-mode — the ONE answer to "which skills does this user's harness
 * run with: the shared set or their private copy?" (ADR-203, T-2003).
 *
 * It sits in the isolation layer because its callers span layers that cannot
 * import each other: the provisioning pass (provision-user-dirs.js), the Codex
 * and Claude launch paths, the skills providers and the /api/harness-files
 * routes. Same reasoning as governance-exemption.ts.
 *
 * Resolution order (ADR-203 "Effective mode"):
 *   1. platform mode (VITE_IS_PLATFORM=true) or the feature flag off → shared;
 *   2. owner/admin → their stored mode;
 *   3. member → their stored mode only while the workspace switch is on.
 * The role is read from the DATABASE, never from a request body.
 *
 * FAIL-SAFE: any database fault, unknown user or invalid id answers `shared`,
 * which is the pre-feature behaviour for everyone.
 */

import * as databaseModule from '@/modules/database/index.js';

export type HarnessFilesMode = 'shared' | 'private';
export type HarnessFilesRole = 'owner' | 'admin' | 'user' | null;

/** Emergency kill switch / development flag (ADR-203 "Feature flag and rollback"). */
export const PRIVATE_SKILLS_FLAG = 'NASSAJ_HARNESS_PRIVATE_SKILLS';

/**
 * Default when the flag is unset: enabled since C5 acceptance (ADR-203). The
 * flag is now only an emergency kill switch (`0` = off); members still stay
 * shared until owner/admin turn the workspace switch on.
 */
export const PRIVATE_SKILLS_DEFAULT_ENABLED = true;

/** Harnesses with a private store in v1; every other harness is "shared only". */
export const PRIVATE_SKILLS_HARNESSES = Object.freeze(['claude', 'codex'] as const);
export type PrivateSkillsHarness = (typeof PRIVATE_SKILLS_HARNESSES)[number];

export interface HarnessFilesResolution {
  /** The user's saved choice (row or `shared`). */
  requested: HarnessFilesMode;
  /** What the harness actually runs with now. */
  effective: HarnessFilesMode;
  /** Role read from the users table; null when unknown. */
  role: HarnessFilesRole;
  /** Workspace switch "allow members to use private files". */
  allowMemberPrivate: boolean;
  /** True when this user may pick `private` right now. */
  canChoose: boolean;
  featureEnabled: boolean;
  platformMode: boolean;
}

/** True when `VITE_IS_PLATFORM` is on; read per call so tests can toggle it. */
export function isHarnessFilesPlatformMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITE_IS_PLATFORM === 'true';
}

/**
 * Reads the feature flag: `0` forces off, `1` forces on, anything else uses
 * PRIVATE_SKILLS_DEFAULT_ENABLED.
 */
export function isPrivateSkillsFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[PRIVATE_SKILLS_FLAG] ?? '').trim();
  if (raw === '0') return false;
  if (raw === '1') return true;
  return PRIVATE_SKILLS_DEFAULT_ENABLED;
}

function readRole(userId: string | number): HarnessFilesRole {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = databaseModule.userDb?.getRawById?.(id) as
    | { role?: string; is_active?: number; status?: string }
    | undefined;
  if (!row || row.is_active === 0 || (row.status && row.status !== 'active')) return null;
  return row.role === 'owner' || row.role === 'admin' || row.role === 'user' ? row.role : null;
}

function sharedResolution(featureEnabled: boolean, platformMode: boolean): HarnessFilesResolution {
  return {
    requested: 'shared',
    effective: 'shared',
    role: null,
    allowMemberPrivate: false,
    canChoose: false,
    featureEnabled,
    platformMode,
  };
}

/**
 * Full resolution for one user (used by the API and by every write that must
 * compare a before/after snapshot). Never throws.
 *
 * @param userId authenticated user id (from the token, never from a body)
 */
export function resolveHarnessFilesState(
  userId: string | number | null | undefined,
): HarnessFilesResolution {
  const featureEnabled = isPrivateSkillsFeatureEnabled();
  const platformMode = isHarnessFilesPlatformMode();
  if (userId === null || userId === undefined || userId === '') {
    return sharedResolution(featureEnabled, platformMode);
  }
  try {
    const repo = databaseModule.harnessFilesModeDb;
    if (!repo) return sharedResolution(featureEnabled, platformMode);
    const role = readRole(userId);
    const requested = repo.getStoredMode(userId);
    const allowMemberPrivate = repo.getAllowMemberPrivate();
    const elevated = role === 'owner' || role === 'admin';
    const canChoose = featureEnabled && !platformMode && role !== null
      && (elevated || allowMemberPrivate);
    const effective: HarnessFilesMode = featureEnabled && !platformMode && requested === 'private'
      && (elevated || (role === 'user' && allowMemberPrivate)) ? 'private' : 'shared';
    return { requested, effective, role, allowMemberPrivate, canChoose, featureEnabled, platformMode };
  } catch {
    return sharedResolution(featureEnabled, platformMode);
  }
}

/**
 * The effective mode only. Short-circuits to `shared` before any database read
 * when the feature is off or in platform mode (it runs on every spawn).
 */
export function resolveHarnessFilesMode(userId: string | number | null | undefined): HarnessFilesMode {
  if (!isPrivateSkillsFeatureEnabled() || isHarnessFilesPlatformMode()) return 'shared';
  return resolveHarnessFilesState(userId).effective;
}

/** True when the two snapshots would route writes to different places. */
export function harnessFilesStateChanged(
  before: HarnessFilesResolution,
  after: HarnessFilesResolution,
): boolean {
  return before.effective !== after.effective
    || before.requested !== after.requested
    || before.canChoose !== after.canChoose;
}
