import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  hashMessageAuthorContent,
  messageAuthorsDb,
  messageCoordinationDb,
  participantsDb,
  projectsDb,
  responseTurnMetricsDb,
  sessionsDb,
  type MessageAuthorRow,
  type MessageCoordinationRow,
} from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import {
  isLightHistoryEnabled,
  LIGHT_HISTORY_SCHEMA,
  loadStableHistorySnapshot,
  projectLightHistory,
  type HistoryPayloadMode,
  type HistoryResponse,
} from '@/modules/providers/services/session-history-light.service.js';
import type {
  FetchHistoryOptions,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { projectVendorHistoryReceipts } from '../shared/vendor/vendor-receipt-identity.js';
import { projectClaudeHistoryReceipts } from '../list/claude/claude-receipt-identity.js';
import { projectCodexHistoryIdentities, copyCodexHistoryIdentities } from '../list/codex/codex-receipt-identity.js';
import { withCoordinationDirective } from '../../../../shared/coordinationDirectives.js';
import { DOCUMENT_SHARING_INSTRUCTIONS, stripRuntimeInstructionsPrefix } from '../../../../shared/documentSharingInstructions.js';

import { HISTORY_LIMITS, HistoryReadLease, HistoryBudgetError, historyAdmission } from './history-budget.service.js';
import { HistoryHttpSink } from './history-response.service.js';

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

  if (participantsDb.isParticipant(sessionId, requesterUserId)) {
    return true;
  }

  // Participation is the ONLY route to a restamp — no project arm (see the
  // SessionAccessMode doc). Placed before the other two so a future mode added
  // to the union cannot fall through into the write branch by omission.
  if (mode === 'restamp') {
    return false;
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

/** Bounded source lookup with the existing read/restamp predicate and non-disclosing denial. */
export function assertHistorySourceAccessible(sessionId: string, requesterUserId: number | null, mode: SessionAccessMode) {
  const session = sessionsDb.getHistorySource(sessionId);
  if (!session || !isSessionAccessibleByUser(sessionId, session.project_path, requesterUserId, mode)) {
    throw new HistoryBudgetError('SESSION_NOT_FOUND');
  }
  if (session.sourceOversized) throw new HistoryBudgetError('HISTORY_BUDGET_EXCEEDED');
  return session;
}

/** Resolves delivery evidence without inferring completion or matching prompt text. */
export function readMessageDelivery(
  sessionId: string, userId: number | null, clientMsgId: string, provider: string,
) {
  if (userId === null) throw new AppError('Authentication required.', { code: 'UNAUTHORIZED', statusCode: 401 });
  assertSessionAccessible(sessionId, userId, 'read');
  const identity = { clientMsgId, sessionId, provider };
  const row = messageCoordinationDb.readDelivery({ ...identity, userId });
  let accepted = Boolean(row?.acceptedAt) || row?.lifecycleStatus === 'started';
  if (!accepted && row?.lifecycleStatus === 'terminal' && row.verdictJson) {
    try {
      const verdict = JSON.parse(row.verdictJson) as Record<string, unknown> | null;
      accepted = !!verdict && !Array.isArray(verdict) && verdict.kind === 'complete'
        && verdict.clientMsgId === clientMsgId && verdict.provider === provider
        && verdict.sessionId === sessionId
        && (verdict.actualSessionId === undefined || verdict.actualSessionId === sessionId)
        && (verdict.success === undefined || verdict.success === true)
        && (verdict.exitCode === undefined || verdict.exitCode === 0)
        && (verdict.notStarted === undefined || verdict.notStarted === false)
        && !verdict.code && !verdict.error && verdict.sameClientMsgIdRetryable !== true;
    } catch { /* Missing or corrupt evidence remains unknown. */ }
  }
  if (!accepted || !row) return { ...identity, status: 'unknown' as const };
  return { ...identity, status: 'accepted' as const, receipt: {
    ...identity, content: row.content, createdAt: row.createdAt, source: 'ingress_receipt' as const,
  } };
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
function stampMessageAuthors(sessionId: string, messages: NormalizedMessage[], lease?: HistoryReadLease): void {
  let authorRows: MessageAuthorRow[];
  try {
    authorRows = messageAuthorsDb.listBySession(sessionId, lease);
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

/** Re-attaches immutable turn policy without modifying provider transcripts. */
export function applyMessageCoordination(
  messages: NormalizedMessage[],
  rows: MessageCoordinationRow[],
  lease?: HistoryReadLease,
): void {
  const prepared = new Map<MessageCoordinationRow, string[]>();
  if (lease) for (const row of rows) {
    const bytes = 4 * row.canonicalContent.length + 2 * DOCUMENT_SHARING_INSTRUCTIONS.length;
    lease.charge('retainedBytes', 4096 + bytes);
    lease.charge('copyBytes', 2048 + bytes, lease.limits.jobBytes);
    prepared.set(row, coordinationTranscriptVariants(row));
  }
  const remaining = [...rows];
  for (const message of messages) {
    if (message.kind !== 'text' || message.role !== 'user' || message.originKind) continue;
    const actual = message.content ?? '';
    const matchingIndices: number[] = [];
    remaining.forEach((candidate, index) => {
      if (candidate.provider !== message.provider) return false;
      if (message.userId != null && message.userId !== candidate.userId) return false;
      // T-1804: تُقصّ بادئةُ التعليمات بنيويّاً (بوسميها المُرسَيين في الصدر)
      // ثمّ يُطابَق المتبقّي **مطابقةً تامّة**. المطابقةُ على النصّ الكامل لم تعد
      // تصلح: كتلةُ النشر تحمل مسارَ ناشرٍ يختلف بين الأجهزة وبين تثبيتين على
      // الجهاز الواحد، فرسالةٌ مخزّنةٌ قد تحمل مساراً لم يعد قائماً. ولا نصَّ
      // مستخدمٍ يُحذف: المقصوصُ وسمان حرفيّان، والباقي يُقارن حرفاً بحرف.
      const body = stripRuntimeInstructionsPrefix(actual);
      if (
        actual === candidate.canonicalContent
        || (prepared.get(candidate) ?? coordinationTranscriptVariants(candidate)).includes(body)
      ) matchingIndices.push(index);
    });
    if (matchingIndices.length === 0) continue;
    const messageTime = Date.parse(message.timestamp);
    const bestIndex = matchingIndices.reduce((best, index) => {
      if (!Number.isFinite(messageTime)) return best;
      const bestTime = Date.parse(remaining[best].createdAt);
      const candidateTime = Date.parse(remaining[index].createdAt);
      const bestDelta = Number.isFinite(bestTime) ? Math.abs(bestTime - messageTime) : Number.POSITIVE_INFINITY;
      const candidateDelta = Number.isFinite(candidateTime)
        ? Math.abs(candidateTime - messageTime)
        : Number.POSITIVE_INFINITY;
      return candidateDelta < bestDelta ? index : best;
    }, matchingIndices[0]);
    const candidate = remaining.splice(bestIndex, 1)[0];
    message.userId ??= candidate.userId;
    message.coordinationLevel = candidate.coordinationLevel;
    // Exact equality against the stored canonical message, never pattern stripping.
    if (message.content !== candidate.canonicalContent) {
      message.content = candidate.canonicalContent;
    }
  }
}

/**
 * الأشكالُ المتوقَّعة **بعد** قصّ بادئة التعليمات: نصُّ المستخدم بتوجيه التنسيق
 * أو بدونه. ما قبل T-1804 وما بعده يؤولان إلى الشكل نفسه هنا، فالسجلّ القديم
 * يعمل بلا قائمةِ أشكالٍ تاريخيّةٍ تُصان يدويّاً.
 */
function coordinationTranscriptVariants(row: MessageCoordinationRow): string[] {
  return [withCoordinationDirective(row.canonicalContent, row.coordinationLevel)];
}

function stampMessageCoordination(sessionId: string, messages: NormalizedMessage[], lease?: HistoryReadLease): void {
  try {
    applyMessageCoordination(messages, messageCoordinationDb.listBySession(sessionId, lease), lease);
  } catch (error) {
    console.error('Failed to load message coordination for history stamping', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Adds only durable, attested timing to assistant messages already selected by
 * the provider pagination.  This runs after the session read gate, and never
 * exposes the internal turn id or any metric for a message outside this page.
 */
export function applyResponseTurnMetrics(
  messages: NormalizedMessage[],
  rows: Array<{ assistantMessageId: string; startedAt: string; completedAt: string; durationMs: number }>,
): void {
  const byMessageId = new Map(rows.map((row) => [row.assistantMessageId, row]));
  const stamp = (message: NormalizedMessage, metric: {
    assistantMessageId: string; startedAt: string; completedAt: string; durationMs: number;
  }) => {
    message.responseTurnMetric = {
      durationMs: metric.durationMs,
      startedAt: metric.startedAt,
      completedAt: metric.completedAt,
    };
  };

  for (const message of messages) {
    const metric = byMessageId.get(message.id);
    if (metric) stamp(message, metric);
  }
}

function stampResponseTurnMetrics(sessionId: string, messages: NormalizedMessage[], lease?: HistoryReadLease): void {
  const assistantIds = messages
    .filter((message) => message.kind === 'text' && message.role === 'assistant')
    .map((message) => message.id);
  let rows;
  try {
    rows = responseTurnMetricsDb.listForMessages(sessionId, assistantIds, lease);
  } catch (error) {
    console.error('Failed to load response timing for history', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  applyResponseTurnMetrics(messages, rows);
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
  usesBoundedHistory(sessionId: string): boolean {
    // T-1632 / B-1025: the bounded reader (HISTORY_LIMITS tokens=20000,
    // sourceBytes=4MiB) rejects most real Claude sessions with 413, so it stays
    // opt-in until its limits are accepted; default routing is the full reader.
    if (process.env.NASSAJ_BOUNDED_HISTORY !== '1') return false;
    const source = sessionsDb.getHistorySource(sessionId);
    return Boolean(source?.sourceOversized) || source?.provider === 'claude' || source?.provider === 'codex';
  },

  /** Keep history owned through a trusted consumer; only a reserved detached value may escape. */
  async withHistoryLeaseCallback(sessionId: string, requesterUserId: number | null,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset' | 'cursor'> & {
      payloadMode?: HistoryPayloadMode; revision?: string; access?: 'read' | 'restamp';
    }, signal: AbortSignal, consume: (payload: HistoryResponse, lease: HistoryReadLease) => Promise<void> | void): Promise<void> {
    let release: (() => void) | undefined, lease: HistoryReadLease | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let payload: HistoryResponse | undefined;
    let primaryFailed = false;
    try {
      const session = assertHistorySourceAccessible(sessionId, requesterUserId, options.access ?? 'read');
      const authorize = () => {
        const fresh = assertHistorySourceAccessible(sessionId, requesterUserId, options.access ?? 'read');
        if (fresh.provider !== session.provider || fresh.jsonl_path !== session.jsonl_path) throw new HistoryBudgetError('HISTORY_REVISION_CHANGED');
      };
      if (!session.jsonl_path || !['claude', 'codex'].includes(session.provider)) throw new HistoryBudgetError('HISTORY_SOURCE_UNAVAILABLE');
      release = await historyAdmission.acquire({ session: sessionId, user: String(requesterUserId), provider: session.provider }, signal);
      authorize();
      const deadline = new AbortController();
      timer = setTimeout(() => deadline.abort(new HistoryBudgetError('HISTORY_TIMEOUT')), HISTORY_LIMITS.executionMs);
      lease = new HistoryReadLease(AbortSignal.any([signal, deadline.signal]));
      await lease.initialize(session.jsonl_path);
      payload = await this.fetchHistory(sessionId, requesterUserId, { ...options, historyLease: lease });
      await lease.verify(); authorize(); lease.reserveDto(payload); lease.check();
      await consume(payload, lease);
    } catch (error) {
      primaryFailed = true; throw error;
    } finally {
      payload = undefined;
      if (timer) clearTimeout(timer);
      try {
        if (lease && release) await historyAdmission.closeAndRelease(lease, release);
        else { await lease?.close(); release?.(); }
      } catch (cleanupError) {
        if (!primaryFailed) throw cleanupError;
        // Preserve even a thrown undefined/null; never inspect or log either untrusted error.
        try {
          console.error('History cleanup failed after primary failure', {
            event: 'history_cleanup_failed', quarantined: historyAdmission.quarantined,
          });
        } catch { /* Logging must not replace the original rejection. */ }
      }
    }
  },

  /** Own native history through response completion; the body never outlives its read lease. */
  async withHistoryLease(sessionId: string, requesterUserId: number | null,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset' | 'cursor'> & {
      payloadMode?: HistoryPayloadMode; revision?: string;
    }, sink: HistoryHttpSink): Promise<void> {
    if (!HistoryHttpSink.isConcrete(sink)) throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
    try {
      await this.withHistoryLeaseCallback(sessionId, requesterUserId, options, sink.signal, async (payload, lease) => {
        let body: Buffer | undefined = Buffer.from(JSON.stringify(payload));
        try {
          lease.charge('responseBytes', body.length); lease.check();
          await sink.write(body, lease.signal); await sink.complete();
        } catch (error) {
          await sink.sendFailure(error);
        } finally { body = undefined; }
      });
    } catch (error) { await sink.sendFailure(error); }
  },

  async fetchHistory(
    sessionId: string,
    requesterUserId: number | null,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset' | 'cursor'> & {
      payloadMode?: HistoryPayloadMode;
      revision?: string;
      historyLease?: HistoryReadLease;
    } = {},
  ): Promise<HistoryResponse> {
    const session = options.historyLease ? sessionsDb.getHistorySource(sessionId) : sessionsDb.getSessionById(sessionId);
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

    const payloadMode = options.payloadMode ?? 'full';
    if (payloadMode === 'light' && !isLightHistoryEnabled()) {
      throw new AppError('Lightweight session history is not enabled.', {
        code: 'LIGHT_HISTORY_DISABLED', statusCode: 409,
      });
    }

    const provider = session.provider as LLMProvider;
    const limit = options.limit ?? null;
    const offset = options.offset ?? 0;
    const { result, revision } = await loadStableHistorySnapshot({
      sessionId,
      requesterUserId,
      source: {
        provider,
        projectPath: session.project_path,
        jsonlPath: session.jsonl_path,
        updatedAt: session.updated_at,
      },
      pageKey: JSON.stringify([limit, offset, options.cursor ?? null]),
      historyLease: options.historyLease,
      load: async () => {
        const loaded = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
          limit,
          offset,
          cursor: options.cursor,
          historyLease: options.historyLease,
          projectPath: session.project_path ?? '',
        });

        // Cache only the final normalized/stamped snapshot. Permission was
        // checked above before either cache or inflight state was touched.
        options.historyLease?.charge('normalizedRows', loaded.messages.length, HISTORY_LIMITS.records);
        options.historyLease?.reserveDto(loaded);
        stampMessageAuthors(sessionId, loaded.messages, options.historyLease);
        stampMessageCoordination(sessionId, loaded.messages, options.historyLease);
        stampResponseTurnMetrics(sessionId, loaded.messages, options.historyLease);
        loaded.responseTurnDurationTotalMs = responseTurnMetricsDb.sumSessionDuration(sessionId, options.historyLease);
        return loaded;
      },
    });

    if (options.revision !== undefined && options.revision !== revision) {
      throw new AppError('Session history revision changed.', {
        code: 'HISTORY_REVISION_CHANGED', statusCode: 409,
      });
    }

    options.historyLease?.check();
    options.historyLease?.reserveDto(result);
    const ownedResult = provider === 'claude'
      ? projectClaudeHistoryReceipts(result, sessionId, requesterUserId, undefined, options.historyLease)
      : provider === 'codex' ? result
        : projectVendorHistoryReceipts(result, provider, sessionId, requesterUserId);
    let payload = payloadMode === 'light' ? projectLightHistory(ownedResult) : ownedResult;
    if (provider === 'codex') payload = projectCodexHistoryIdentities(
      copyCodexHistoryIdentities(result, payload), sessionId, requesterUserId, options.historyLease, messageCoordinationDb.readCodexVerdicts);
    return {
      ...payload,
      historySchema: LIGHT_HISTORY_SCHEMA,
      payloadMode,
      revision,
    };
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
