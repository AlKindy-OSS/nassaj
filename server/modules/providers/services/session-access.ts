import {
  canAccessProject,
  findOwningProject,
  isProjectMembershipEnforced,
  messageAuthorsDb,
  participantsDb,
  projectMembersDb,
  projectsDb,
  userDb,
} from '@/modules/database/index.js';

/**
 * Session authorization predicate (B-IDOR-SESSION), split out of
 * sessions.service so the transcript reader (ADR-201) can authorise without
 * importing the history service. Behaviour is unchanged; sessions.service
 * re-exports both names.
 */

/**
 * Session authorization mode (B-IDOR-SESSION).
 *
 *   'read'  — may LOOK at the session (history, participants, archive listing).
 *   'write' — may MUTATE or DESTROY it (delete, archive, restore, rename, pin a
 *             model onto it).
 *
 * The two are deliberately NOT the same predicate: every project defaults to
 * `visibility = 'public'`, and a public project is READABLE by any authenticated
 * user by design (B-PRIV). Gating a mutation on the read predicate therefore let
 * ANY authenticated user delete another user's conversation (and its transcript
 * file on disk) by sessionId alone. This mirrors the project-level split already
 * made in B-138: isProjectVisibleToUser (read) vs isProjectWritableByUser (write).
 */
export type SessionAccessMode = 'read' | 'write' | 'restamp';

/**
 * `'restamp'` is a THIRD, strictly narrower mandate — participants only, with no
 * project-level arm at all (ADR-099, qa-critic حرج 3).
 *
 * Re-stamping a session's engine is not a bigger write; it is a different kind of
 * act. `'write'` grants project writers the right to change how a conversation
 * runs. Re-stamping changes WHERE ITS TEXT GOES: flipping a vendor-pinned session
 * to official Anthropic replays the entire history — every word the other member
 * wrote — to a different company, on a different account. Three concrete abuses a
 * project-writer arm would have permitted:
 *
 *   • export another member's conversation without their consent (the export
 *     acknowledgement would be shown to the switcher, not to the data's owner);
 *   • disable a colleague's session remotely by pinning an engine they hold no
 *     key for (every later turn throws ENGINE_PROVIDER_UNAVAILABLE);
 *   • spend the ORG key on their turns (apply-claude-engine-provider-env falls
 *     back to the operator-wide slot when the member has no key of their own).
 *
 * Consent for that belongs to whoever is in the conversation, so this mode stops
 * at `participantsDb.isParticipant`.
 */

/**
 * WRITE authorization for the project that owns a session, resolved from the
 * session's `project_path`.
 *
 * Sessions carry a path, not a project_id, while the write predicate is keyed by
 * project_id — so the path is resolved to its project row first. Fail-closed: an
 * empty path or a path with no project row returns false (the caller then falls
 * back to session participation only). Deliberately reuses
 * projectsDb.isProjectWritableByUser so the session write gate and the file
 * write gate cannot diverge; note that its public bypass is ABSENT by design —
 * 'public' confers read, never write.
 */
function isProjectPathWritableByUser(projectPath: string | null | undefined, userId: number): boolean {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    return false;
  }

  const project = projectsDb.getProjectPath(projectPath);
  if (!project) {
    return false;
  }

  return projectsDb.isProjectWritableByUser(project.project_id, userId);
}

/**
 * The single session authorization predicate every session route flows through.
 *
 * Access is granted when the caller is a participant of THAT session (the run
 * path records the spawner as its 'owner' participant, so this is the
 * conversation-ownership route) OR, depending on `mode`, when they can see /
 * write the project the session lives in. Both branches resolve through the SAME
 * repository predicates the sidebar list layer and the file-write layer use, so
 * the content gate, the list gate and the mutation gate cannot silently diverge.
 *
 * Fail-closed by construction: a null / non-integer requester (anonymous or
 * unresolved identity) is refused before any branch and never widens access.
 */
export function isSessionAccessibleByUser(
  sessionId: string,
  projectPath: string | null | undefined,
  requesterUserId: number | null,
  mode: SessionAccessMode,
): boolean {
  if (requesterUserId === null || !Number.isInteger(requesterUserId)) {
    return false;
  }

  let participant = false;
  try {
    participant = participantsDb.isParticipant(sessionId, requesterUserId);
  } catch {
    return false;
  }
  if (participant) {
    // ADR-172 (qa م3): under enforcement a participant who lost access to the
    // session's (registered) project no longer reads or restamps through it.
    if (!isProjectMembershipEnforced()) {
      return true;
    }
    const owner = findOwningProject(projectPath ?? '');
    if (owner === null) {
      return mode === 'read' || participantsDb.hasSpawnConsent(sessionId, requesterUserId);
    }
    if (mode === 'restamp' && !participantsDb.hasSpawnConsent(sessionId, requesterUserId)) {
      return false;
    }
    return canAccessProject(owner.project_id, requesterUserId);
  }

  // Participation is the ONLY route to a restamp — no project arm (see the
  // SessionAccessMode doc). Placed before the other two so a future mode added
  // to the union cannot fall through into the write branch by omission.
  if (mode === 'restamp') {
    return false;
  }

  if (isProjectMembershipEnforced() && findOwningProject(projectPath ?? '') === null) {
    try {
      return mode === 'read' && messageAuthorsDb.isAuthor(sessionId, requesterUserId);
    } catch {
      return false;
    }
  }

  return mode === 'read'
    ? projectsDb.isProjectPathVisibleToUser(projectPath ?? null, requesterUserId)
    : isProjectPathWritableByUser(projectPath, requesterUserId);
}

/** Platform roles that may permanently delete any session they can write (B-1647). */
const DESTROY_ELEVATED_APP_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

/** Exact project row first, then the nested-path owner (ADR-172 resolution). */
function resolveSessionProject(projectPath: string | null | undefined) {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) return null;
  const exact = projectsDb.getProjectPath(projectPath);
  if (exact) return exact;
  const owning = findOwningProject(projectPath);
  return owning ? projectsDb.getProjectById(owning.project_id) : null;
}

/** Project creator or explicit 'owner' member — the same rule as canManageProject. */
function isSessionProjectOwner(projectPath: string | null | undefined, userId: number): boolean {
  const project = resolveSessionProject(projectPath);
  if (!project) return false;
  if (project.created_by === userId) return true;
  return projectMembersDb.getRole(project.project_id, userId) === 'owner';
}

/** Active user whose platform role is owner/admin; read from the DB, never the request. */
function hasElevatedAppRole(userId: number): boolean {
  const user = userDb.getUserById(userId);
  return user !== undefined && DESTROY_ELEVATED_APP_ROLES.has(user.role);
}

/**
 * Permanent-delete mandate for a session (B-1647, owner decision 2026-10-16).
 *
 * Archive stays on the ordinary 'write' mandate. Destroying the row and its
 * transcript is narrower: the caller must hold 'write' AND be one of
 *   - the session's strict spawn owner (its creator; never provenance/authorship),
 *   - the owner of the session's project (creator or 'owner' member), or
 *   - a platform owner/admin.
 * Under ADR-173 shared writing any author is a participant, so 'write' alone
 * would let one message's author erase the creator's conversation from disk.
 * The 'write' conjunct keeps project privacy absolute for the elevated arms.
 */
export function canPermanentlyDeleteSession(
  sessionId: string,
  projectPath: string | null | undefined,
  requesterUserId: number | null,
): boolean {
  if (requesterUserId === null || !Number.isInteger(requesterUserId)) return false;
  if (!isSessionAccessibleByUser(sessionId, projectPath, requesterUserId, 'write')) return false;
  try {
    return participantsDb.resolveStrictSpawnOwnerUserId(sessionId) === requesterUserId
      || isSessionProjectOwner(projectPath, requesterUserId)
      || hasElevatedAppRole(requesterUserId);
  } catch {
    return false;
  }
}
