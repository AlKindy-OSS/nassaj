import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  hashMessageAuthorContent,
  messageAuthorsDb,
  participantsDb,
  projectsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import type { MessageAuthorRow } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

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
export type SessionAccessMode = 'read' | 'write';

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

  if (participantsDb.isParticipant(sessionId, requesterUserId)) {
    return true;
  }

  return mode === 'read'
    ? projectsDb.isProjectPathVisibleToUser(projectPath ?? null, requesterUserId)
    : isProjectPathWritableByUser(projectPath, requesterUserId);
}

/**
 * Resolves a session row and authorizes the caller in one step, or throws.
 *
 * A refusal is surfaced with the SAME 404 contract as a missing session — never
 * a distinguishable 403 — so another user's session existence is never disclosed
 * through sessionId enumeration (the B-105/B-PRIV non-disclosure guarantee).
 *
 * Exported so route modules that must authorize a session WITHOUT loading its
 * content (participants, agents, active-model pinning) share this one gate
 * instead of re-deriving it.
 */
export function assertSessionAccessible(
  sessionId: string,
  requesterUserId: number | null,
  mode: SessionAccessMode,
): NonNullable<ReturnType<typeof sessionsDb.getSessionById>> {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session || !isSessionAccessibleByUser(sessionId, session.project_path, requesterUserId, mode)) {
    throw new AppError(`Session "${sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }

  return session;
}

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Stamps sender identity onto messages loaded from provider history
 * (B-MU-UX-FIX-MSG-AUTHOR + B-MU-UX-FIX-ASSISTANT-AUTHOR).
 *
 * The run path records one message_authors row per sent prompt (sidecar
 * attribution — the transcript itself is written by the provider CLI/SDK and
 * carries no identity). This pass walks the transcript in order and:
 *
 * 1. user messages — each kind:'text' role:'user' message is matched back to a
 *    recorded row by content hash; when the same text was recorded more than
 *    once (e.g. two users sent identical prompts) the row closest in time wins
 *    and is consumed so the next identical message maps to the next row. The
 *    matched author is stamped as `userId`.
 * 2. assistant messages — every assistant-authored message inherits the
 *    coordinator of the most recent preceding attributed user prompt as
 *    `coordinatorId`. A run's assistant output always follows the prompt that
 *    spawned it in transcript order, so the running "current coordinator"
 *    correctly attributes the reply without a second sidecar table.
 *
 * Messages with no resolvable author (recorded before attribution existed,
 * provider-rewritten prompts, or assistant output before the first attributed
 * prompt) keep no userId/coordinatorId — clients fall back to the session owner.
 *
 * Mutates `messages` in place; never throws (attribution is best-effort and
 * must not break history loading).
 */
function stampMessageAuthors(sessionId: string, messages: NormalizedMessage[]): void {
  let authorRows: MessageAuthorRow[];
  try {
    authorRows = messageAuthorsDb.listBySession(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to load message authors for history stamping', { sessionId, error: message });
    return;
  }
  if (authorRows.length === 0) {
    return;
  }
  applyMessageAuthorAttribution(messages, authorRows);
}

/**
 * Pure transcript-walk that applies user/coordinator attribution given the
 * session's recorded author rows. Separated from the DB read so it can be unit
 * tested in isolation. Mutates `messages` in place. See stampMessageAuthors for
 * the full attribution contract.
 */
export function applyMessageAuthorAttribution(
  messages: NormalizedMessage[],
  authorRows: MessageAuthorRow[],
): void {
  const candidatesByHash = new Map<string, MessageAuthorRow[]>();
  for (const row of authorRows) {
    const list = candidatesByHash.get(row.contentHash);
    if (list) {
      list.push(row);
    } else {
      candidatesByHash.set(row.contentHash, [row]);
    }
  }

  // Coordinator carried forward in transcript order: assistant output is
  // attributed to whoever spawned the most recent attributed user prompt.
  let currentCoordinator: number | null = null;

  for (const message of messages) {
    if (message.kind === 'text' && message.role === 'user') {
      if (message.originKind) {
        // Machine-routed prompt (coordinator → subagent, peer, channel…):
        // never attribute it to a human — even if its text coincidentally
        // hash-matches a recorded human prompt — and never adopt it as the
        // running coordinator for subsequent assistant output.
        continue;
      }
      if (message.userId != null) {
        // Already attributed (live-stamped echo) — adopt it as the coordinator
        // for any assistant output that follows.
        currentCoordinator = message.userId;
        continue;
      }
      const content = typeof message.content === 'string' ? message.content : '';
      if (!content.trim()) {
        continue;
      }

      const candidates = candidatesByHash.get(hashMessageAuthorContent(content));
      if (!candidates || candidates.length === 0) {
        continue;
      }

      // Closest recorded timestamp wins when several rows share the hash.
      let bestIndex = 0;
      const messageTime = Date.parse(message.timestamp);
      if (candidates.length > 1 && Number.isFinite(messageTime)) {
        let bestDelta = Number.POSITIVE_INFINITY;
        for (let index = 0; index < candidates.length; index++) {
          const rowTime = Date.parse(candidates[index].createdAt);
          const delta = Number.isFinite(rowTime)
            ? Math.abs(rowTime - messageTime)
            : Number.POSITIVE_INFINITY;
          if (delta < bestDelta) {
            bestDelta = delta;
            bestIndex = index;
          }
        }
      }

      message.userId = candidates[bestIndex].userId;
      currentCoordinator = candidates[bestIndex].userId;
      // Consume the matched row (but always keep the last one) so repeated
      // identical texts map one-to-one while a lone row still covers transcript
      // echoes of the same prompt.
      if (candidates.length > 1) {
        candidates.splice(bestIndex, 1);
      }
      continue;
    }

    // Assistant-authored output: inherit the active coordinator. Only stamp when
    // known and not already present, so a future live-stamped coordinatorId
    // (should one ever reach this path) is never overwritten.
    if (message.role !== 'user' && currentCoordinator != null && message.coordinatorId == null) {
      message.coordinatorId = currentCoordinator;
    }
  }
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Fetches persisted history by session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database.
   *
   * Ownership is enforced fail-closed (B-105): `requesterUserId` is the
   * authenticated caller resolved by the route from req.user. Unless that user
   * is an owner/participant of — or a recorded message author in — the session,
   * the read is refused. To avoid disclosing the existence of another user's
   * session (sessionId enumeration), an authorization failure is surfaced with
   * the SAME 404 contract as a missing session rather than a distinguishable
   * 403 — matching the existing B-PRIV pattern on the token-usage route.
   *
   * `requesterUserId` is required by the type, but `null` is accepted as the
   * explicit "no authenticated identity" value (anonymous / unresolved) and is
   * treated as having access to nothing — it never widens access.
   *
   * Access is granted when the caller is a participant / message author of the
   * session OR can see the project the session lives in (B-111): the storage is
   * physically shared, so a session listable in the sidebar because its project
   * is public or shared with the caller must also be readable. Project
   * visibility is resolved through the SAME predicate the list layer uses
   * (projectsDb.getVisibleProjectPaths → isProjectPathVisibleToUser), so the
   * content gate and the list gate cannot diverge. The earlier B-105 IDOR fix is
   * preserved: a session in a PRIVATE project the caller is not a member of
   * satisfies neither branch and still returns 404.
   */
  async fetchHistory(
    sessionId: string,
    requesterUserId: number | null,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    // Fail-closed authorization gate. A null requester is the explicit
    // "no identity" value and is refused outright; for an authenticated caller,
    // access requires either session participation/authorship OR visibility of
    // the owning project (both predicates are themselves fail-closed for a
    // non-integer id). A refusal is surfaced with the SAME 404 contract as a
    // missing session so another user's session existence is not disclosed.
    // Routed through the shared predicate so this READ gate and the mutation
    // gates below stay one implementation.
    if (!isSessionAccessibleByUser(sessionId, session.project_path, requesterUserId, 'read')) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const provider = session.provider as LLMProvider;
    const result = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: options.limit ?? null,
      offset: options.offset ?? 0,
      projectPath: session.project_path ?? '',
    });

    // Sender attribution for multi-user sessions: providers normalize history
    // without identity (the transcript has none), so the sidecar stamping runs
    // here — the single choke point every history read flows through.
    stampMessageAuthors(sessionId, result.messages);

    return result;
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   *
   * Scoped to the caller (B-IDOR-ARCHIVED). The underlying repository query has
   * no user predicate, so this listing used to return EVERY archived session on
   * the server — sessionId, project_path and custom_name included, private
   * projects included. Beyond the direct metadata leak that also handed out the
   * sessionIds that the rest of the session API treats as unguessable, turning
   * every "secret id" route into an enumerable one. The rows are therefore
   * filtered through the same read predicate the sidebar and search layers use,
   * with the visibility answer memoized per project_path so a project with many
   * archived sessions costs one query, not one per row.
   *
   * `requesterUserId` is required by the type; `null` is the explicit "no
   * identity" value and yields an EMPTY list — it never widens access.
   */
  listArchivedSessions(requesterUserId: number | null): ArchivedSessionListItem[] {
    if (requesterUserId === null) {
      return [];
    }

    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();
    const visibilityByProjectPath = new Map<string, boolean>();
    const isVisibleToRequester = (session: { session_id: string; project_path: string | null }): boolean => {
      // Participation is session-specific and must be asked per row; project
      // visibility is path-keyed and memoized.
      if (participantsDb.isParticipant(session.session_id, requesterUserId)) {
        return true;
      }
      const key = typeof session.project_path === 'string' ? session.project_path : '';
      if (!visibilityByProjectPath.has(key)) {
        visibilityByProjectPath.set(
          key,
          projectsDb.isProjectPathVisibleToUser(session.project_path, requesterUserId),
        );
      }
      return visibilityByProjectPath.get(key) as boolean;
    };

    return archivedSessions.filter(isVisibleToRequester).map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   *
   * Authorization (B-IDOR-SESSION): this is the most destructive session
   * operation — it unlinks `jsonl_path` from disk and drops the row — and it ran
   * with NO ownership check at all, so any authenticated caller could destroy any
   * conversation by id. It now requires the 'write' mandate (session participant
   * or writable project); a refusal is a 404, identical to a missing session.
   * `requesterUserId` sits in the second position to match fetchHistory so the
   * gate cannot be lost to an argument-order slip.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    requesterUserId: number | null,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = assertSessionAccessible(sessionId, requesterUserId, 'write');

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk && session.jsonl_path) {
      removedFromDisk = await removeFileIfExists(session.jsonl_path);
    }

    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   *
   * Authorization (B-IDOR-SESSION): un-archiving is a state mutation on someone
   * else's conversation, so it takes the 'write' mandate — not visibility.
   */
  restoreSessionById(
    sessionId: string,
    requesterUserId: number | null,
  ): { sessionId: string; isArchived: false } {
    assertSessionAccessible(sessionId, requesterUserId, 'write');

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   *
   * Authorization (B-IDOR-SESSION): the title is shown to every viewer of the
   * session, so renaming is a mutation of shared state and takes the 'write'
   * mandate. `requesterUserId` precedes `summary` so the gate occupies the same
   * argument slot as in every other session method.
   */
  renameSessionById(
    sessionId: string,
    requesterUserId: number | null,
    summary: string,
  ): { sessionId: string; summary: string } {
    assertSessionAccessible(sessionId, requesterUserId, 'write');

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
};
