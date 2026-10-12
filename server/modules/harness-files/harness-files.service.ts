/**
 * harness-files.service — shared vs private skills (ADR-203, T-2003).
 *
 * Every function takes an ACTOR built from `req.user` by the route; the subject
 * is always the actor themself (there is no target-user parameter, so a member
 * cannot change another user's mode). Every mutation:
 *   1. checks permission from the actor (403 before any lock);
 *   2. takes the per-user lock and re-reads the resolver; a changed snapshot
 *      aborts with 409 HARNESS_FILES_MODE_CHANGED and writes nothing;
 *   3. commits the row/switch and its STRICT audit in one transaction (a failed
 *      audit rolls the write back).
 */

import * as database from '@/modules/database/index.js';
import {
  harnessFilesStateChanged,
  resolveHarnessFilesState,
  type HarnessFilesMode,
  type HarnessFilesResolution,
} from '@/services/isolation/harness-files-mode.js';
import { withHarnessFilesLock } from '@/services/isolation/harness-files-lock.js';
import {
  describeClaudeSkillsLink,
  reconcileClaudeSkillsLinkLocked,
  type ClaudeSkillsLinkStatus,
} from '@/services/isolation/claude-skills-link.js';
import {
  PrivateStoreError,
  seedPrivateSkillsStore,
} from '@/services/isolation/private-skills-store.js';
import { invalidateProvisioned } from '@/services/isolation/provision-user-dirs.js';
import { AppError } from '@/shared/utils.js';

const { auditLogDb, harnessFilesModeDb } = database;

/** Lock key for the workspace-wide switch (never a valid numeric user id). */
const WORKSPACE_LOCK_KEY = '*workspace';

export interface HarnessFilesActor {
  userId: string | number | null;
  role: string | null;
  platformMode: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export type HarnessSupport = { provider: string; support: 'full' | 'shared-only'; reason?: string };

/**
 * Per-harness support list (ADR-203 Scope v1). Reasons are stable codes the
 * client translates: `no_shared_baseline`, `shared_not_hideable`,
 * `no_managed_skills`.
 */
export const HARNESS_SUPPORT: readonly HarnessSupport[] = Object.freeze([
  { provider: 'claude', support: 'full' },
  { provider: 'codex', support: 'full' },
  { provider: 'qwen', support: 'shared-only', reason: 'no_shared_baseline' },
  { provider: 'opencode', support: 'shared-only', reason: 'shared_not_hideable' },
  { provider: 'glm', support: 'shared-only', reason: 'shared_not_hideable' },
  { provider: 'antigravity', support: 'shared-only', reason: 'no_shared_baseline' },
  { provider: 'hermes', support: 'shared-only', reason: 'no_shared_baseline' },
  { provider: 'kimi', support: 'shared-only', reason: 'no_managed_skills' },
  { provider: 'cursor', support: 'shared-only', reason: 'no_managed_skills' },
  { provider: 'deepseek', support: 'shared-only', reason: 'no_managed_skills' },
] as HarnessSupport[]);

export interface HarnessFilesView {
  workspace: {
    allowMemberPrivate: boolean;
    /** Owner/admin only: members who return to `private` when the switch is on. */
    savedPrivateMembers?: number;
  };
  me: {
    requested: HarnessFilesMode;
    effective: HarnessFilesMode;
    canChoose: boolean;
    canManageWorkspace: boolean;
    featureEnabled: boolean;
    harnesses: HarnessSupport[];
    /**
     * Claude link state: `pending` = the choice waits for the user's live
     * sessions to close; `legacy-real-dir` = a real directory stays shared.
     */
    claude: { link: ReturnType<typeof describeClaudeSkillsLink> | 'unknown' };
  };
}

/** PUT /me response: the view plus what the Claude reconcile did right now. */
export type HarnessFilesModeResult = HarnessFilesView & { claudeLink: ClaudeSkillsLinkStatus | 'unchanged' };

function isElevated(actor: HarnessFilesActor): boolean {
  return actor.role === 'owner' || actor.role === 'admin';
}

function requirePrincipal(actor: HarnessFilesActor): string | number {
  if (actor.userId === null || actor.userId === '' || actor.userId === undefined) {
    throw new AppError('An authenticated account is required.', {
      code: 'HARNESS_FILES_UNIDENTIFIED', statusCode: 403,
    });
  }
  return actor.userId;
}

function refusePlatform(actor: HarnessFilesActor): void {
  if (actor.platformMode) {
    throw new AppError('Private files are unavailable in platform mode.', {
      code: 'HARNESS_FILES_PLATFORM', statusCode: 403,
    });
  }
}

function modeChangedError(): AppError {
  return new AppError('The files mode changed while this request was running. Reload and retry.', {
    code: 'HARNESS_FILES_MODE_CHANGED', statusCode: 409,
  });
}

function claudeLinkState(userId: string | number | null): HarnessFilesView['me']['claude'] {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return { link: 'unknown' };
  try {
    return { link: describeClaudeSkillsLink(id) };
  } catch {
    return { link: 'unknown' };
  }
}

/**
 * Seeds both private stores (never overwriting). Store faults map to stable
 * codes: caps → 422, unsafe path → 422, unverifiable shared source → 503.
 */
function prepareStores(userId: string | number): void {
  try {
    seedPrivateSkillsStore(userId, 'claude');
    seedPrivateSkillsStore(userId, 'codex');
  } catch (err) {
    if (!(err instanceof PrivateStoreError)) {
      // fs errors carry absolute paths in their message: log the errno only and
      // answer with a generic 500 so no path reaches the client.
      console.error('[harness-files] private store preparation failed', {
        userId, code: (err as NodeJS.ErrnoException)?.code ?? 'unknown',
      });
      throw new AppError('Your private files could not be prepared.', {
        code: 'HARNESS_FILES_STORE_FAILED', statusCode: 500,
      });
    }
    if (err.code === 'seed_source_unverified' || err.code === 'seed_source_unavailable') {
      throw new AppError('The shared skills could not be verified; try again later.', {
        code: 'HARNESS_FILES_SEED_SOURCE_UNAVAILABLE', statusCode: 503,
      });
    }
    const code = err.code === 'cap_exceeded' ? 'HARNESS_FILES_SEED_TOO_LARGE' : 'HARNESS_FILES_PATH_REJECTED';
    throw new AppError('Your private files could not be prepared.', {
      code, statusCode: 422, details: { reason: err.detail ?? err.code },
    });
  }
}

function savedPrivateMembers(): number {
  try {
    return harnessFilesModeDb.listMembersWithSavedPrivate().length;
  } catch {
    return 0;
  }
}

/** Builds the GET view for the caller. Never writes. */
export function describeHarnessFiles(actor: HarnessFilesActor): HarnessFilesView {
  const state = resolveHarnessFilesState(actor.userId);
  const manage = isElevated(actor) && !actor.platformMode;
  return {
    workspace: {
      allowMemberPrivate: state.allowMemberPrivate,
      ...(manage ? { savedPrivateMembers: savedPrivateMembers() } : {}),
    },
    me: {
      requested: state.requested,
      effective: state.effective,
      canChoose: state.canChoose && !actor.platformMode,
      canManageWorkspace: manage,
      featureEnabled: state.featureEnabled,
      harnesses: HARNESS_SUPPORT.map((entry) => ({ ...entry })),
      claude: claudeLinkState(actor.userId),
    },
  };
}

function assertMayRequest(mode: HarnessFilesMode, state: HarnessFilesResolution): void {
  if (mode !== 'private') return;
  if (!state.featureEnabled) {
    throw new AppError('Private files are turned off on this server.', {
      code: 'HARNESS_FILES_FEATURE_DISABLED', statusCode: 403,
    });
  }
  if (!state.canChoose) {
    throw new AppError('Private files are not enabled for members in this workspace.', {
      code: 'HARNESS_FILES_PRIVATE_DISABLED', statusCode: 403,
    });
  }
}

function commitMode(
  principal: string | number,
  mode: HarnessFilesMode,
  before: HarnessFilesResolution,
  actor: HarnessFilesActor,
): void {
  database.getConnection().transaction(() => {
    if (harnessFilesStateChanged(before, resolveHarnessFilesState(principal))) throw modeChangedError();
    harnessFilesModeDb.setStoredMode(principal, mode);
    const after = resolveHarnessFilesState(principal);
    auditLogDb.recordStrict('harness_files_mode_changed', {
      userId: Number(principal),
      metadata: { from: before.requested, to: mode, effective: after.effective, role: after.role },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  })();
}

/**
 * PUT /me: sets the caller's own requested mode. Order (ADR-203): under the
 * per-user lock, seed the private stores if absent, THEN commit row + strict
 * audit in one transaction; a failed commit leaves the seeded store as a
 * harmless orphan reused by the next switch. The Claude link is reconciled
 * right away (deferred while a session of this user is live).
 */
export async function setMyHarnessFilesMode(
  mode: HarnessFilesMode,
  actor: HarnessFilesActor,
): Promise<HarnessFilesModeResult> {
  refusePlatform(actor);
  const principal = requirePrincipal(actor);
  const observed = resolveHarnessFilesState(principal);
  assertMayRequest(mode, observed);
  const claudeLink = await withHarnessFilesLock(principal, () => {
    const before = resolveHarnessFilesState(principal);
    if (harnessFilesStateChanged(observed, before)) throw modeChangedError();
    if (before.requested === mode) return 'unchanged' as const;
    if (mode === 'private') prepareStores(principal);
    commitMode(principal, mode, before, actor);
    invalidateProvisioned(principal);
    return reconcileClaudeSkillsLinkLocked(Number(principal));
  });
  return { ...describeHarnessFiles(actor), claudeLink };
}

function commitWorkspace(allow: boolean, from: boolean, actor: HarnessFilesActor): number[] {
  let affected: number[] = [];
  database.getConnection().transaction(() => {
    if (harnessFilesModeDb.getAllowMemberPrivate() !== from) throw modeChangedError();
    affected = harnessFilesModeDb.listMembersWithSavedPrivate();
    harnessFilesModeDb.setAllowMemberPrivate(allow);
    auditLogDb.recordStrict('harness_files_member_policy_changed', {
      userId: Number(actor.userId),
      metadata: { from, to: allow, role: actor.role, affectedMembers: affected.length },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  })();
  return affected;
}

/**
 * PUT /workspace: owner/admin turn "allow members to use private files" on/off.
 * The stored member choices are kept; `affectedMembers` counts the members whose
 * effective mode this change moves (their saved choice is `private`).
 */
export async function setWorkspaceAllowMemberPrivate(
  allow: boolean,
  actor: HarnessFilesActor,
): Promise<HarnessFilesView & { affectedMembers: number }> {
  refusePlatform(actor);
  requirePrincipal(actor);
  if (!isElevated(actor)) {
    throw new AppError('Only an owner or admin may change this workspace setting.', {
      code: 'HARNESS_FILES_WORKSPACE_FORBIDDEN', statusCode: 403,
    });
  }
  const affected = await withHarnessFilesLock(WORKSPACE_LOCK_KEY, () => {
    const from = harnessFilesModeDb.getAllowMemberPrivate();
    if (from === allow) return [] as number[];
    return commitWorkspace(allow, from, actor);
  });
  for (const memberId of affected) invalidateProvisioned(memberId);
  return { ...describeHarnessFiles(actor), affectedMembers: affected.length };
}
