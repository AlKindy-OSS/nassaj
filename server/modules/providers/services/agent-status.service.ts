/**
 * T-873(2) — app-level `Agent` orphan visibility (READ-ONLY).
 *
 * WHAT IT ANSWERS
 * ---------------
 * "Which of MY background agents stopped without handing back a result, and what
 * had they produced before they stopped?" — across every session the
 * authenticated caller owns. Until now the answer existed only on disk and was
 * retrieved by the coordinator running `tail` by hand.
 *
 * RELATION TO THE OTHER TWO SURFACES (three disjoint scopes, no overlap)
 * ----------------------------------------------------------------------
 *   workflow-status.service.ts   → `subagents/workflows/wf_*`  (Workflow tool)
 *   agent-reconcile.service.ts   → parent-transcript queue rows (delivery gap,
 *                                  in-memory, inside getSessionMessages)
 *   THIS SERVICE                 → `subagents/agent-*.jsonl`   (Agent tool)
 *
 * The delivery-gap detector and this scanner are complementary on purpose: the
 * former catches an agent whose notification WAS written but never handed over;
 * the latter catches an agent that died before any notification was written at
 * all. Neither can see the other's population.
 *
 * NO LIVENESS CLAIM, NO RESUME
 * ----------------------------
 * This service reads FILES. It never probes a pid, never claims a process is
 * alive or dead, and — per the standing veto reaffirmed by two committees — it
 * NEVER starts, resumes or re-dispatches anything. `resumeHint` is descriptive
 * text for a human; no code path consumes it.
 *
 * NO FALSE SETTLEMENT
 * -------------------
 * An agent that cannot be judged from its transcript is reported as `'unknown'`
 * WITH a reason, never as completed and never as settled. Completed agents are
 * dropped from the payload entirely — this endpoint reports only the population
 * that needs a human's attention.
 *
 * FAIL-CLOSED OWNERSHIP
 * ---------------------
 * `userId = null` (anonymous/unresolved) ⇒ empty envelope, no scan. Only sessions
 * returned by `participantsDb.getSessionIdsForUser(userId)` are ever inspected,
 * so another user's agent id, description, path or report can never enter a
 * response — it never enters the scan. The `getAgentReport` lookup applies the
 * SAME gate before opening any file, and additionally validates the agent id
 * against a strict character class so a caller-supplied id can never traverse
 * out of the session's `subagents` directory.
 *
 * DECLARED CAPS
 * -------------
 * Sessions per call and agent transcripts per call are both capped, and the
 * envelope reports `scanned`/`eligible`/`capped` so "no orphan found" is never
 * confused with "we stopped looking".
 */

import path from 'node:path';

import { participantsDb, sessionsDb } from '@/modules/database/index.js';
import { DEFAULT_QUIET_MS } from '@/modules/providers/list/claude/workflow-reconcile.service.js';
import {
  agentMetaPath,
  agentTranscriptPath,
  listSessionAgentIds,
  readAgentMeta,
  readAgentOutcome,
  type AgentOutcome,
  type AgentUnknownReason,
} from '@/modules/providers/list/claude/agent-transcript.reader.js';

/** Upper bound on sessions inspected per call (newest-first by the DB ordering). */
const MAX_SESSIONS_SCANNED = 200;

/**
 * Upper bound on agent transcripts read per call. Each read is a bounded tail
 * read, but the corpus can hold hundreds of agents per project, so the total is
 * capped too and the cap is declared in the envelope.
 */
const MAX_AGENTS_SCANNED = 400;

/** Characters recovered into the list payload; the full report has its own route. */
const REPORT_PREVIEW_CHARS = 600;

/**
 * Agent ids are harness-generated tokens (e.g. `ab0bf67f9ea3d0c25`). Anything
 * outside this class is rejected before it is ever joined onto a path, so a
 * caller cannot walk out of the `subagents` directory.
 */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Validates a caller-supplied agent id. Exported for the route's 400 contract. */
export function isValidAgentId(agentId: unknown): agentId is string {
  return typeof agentId === 'string' && AGENT_ID_RE.test(agentId);
}

/** One agent that stopped without delivering a result. */
export type OrphanedAgent = {
  sessionId: string;
  agentId: string;
  /** `'interrupted'` = explicit cut marker; `'unknown'` = not decidable. */
  outcome: 'interrupted' | 'unknown';
  /** Non-null exactly when `outcome === 'unknown'`. */
  unknownReason: AgentUnknownReason | null;
  agentType: string | null;
  description: string | null;
  /** Launch-time join key to the parent transcript (`meta.json.toolUseId`). */
  toolUseId: string | null;
  model: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  updatedAt: string | null;
  /** True when the agent HAD produced a report before it stopped. */
  hasReport: boolean;
  /** First {@link REPORT_PREVIEW_CHARS} of that report; full text via its route. */
  reportPreview: string | null;
  /** Descriptive only — nothing in this codebase acts on it. */
  resumeHint: string;
};

/** Envelope with the declared caps made observable. */
export type OrphanedAgentsResult = {
  agents: OrphanedAgent[];
  /** Distinct sessions the caller owns (before the session cap). */
  eligible: number;
  /** Sessions actually inspected this call. */
  scanned: number;
  /** Agent transcripts actually read this call. */
  agentsScanned: number;
  /** True when either cap stopped the scan short. */
  capped: boolean;
};

/** The recovered report of one agent, resolved through the ownership gate. */
export type AgentReport = {
  sessionId: string;
  agentId: string;
  outcome: AgentOutcome['outcome'];
  unknownReason: AgentUnknownReason | null;
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  /** The final assistant text, verbatim — what `tail` used to be run for. */
  report: string | null;
  reportTruncated: boolean;
  interruptionText: string | null;
};

/**
 * Resolves a session's `subagents` directory from its transcript path, using the
 * exact derivation getSessionMessages uses.
 */
function resolveSubagentsDir(jsonlPath: string | null): string | null {
  if (!jsonlPath) {
    return null;
  }
  const projectDir = path.dirname(jsonlPath);
  const transcriptSessionId = path.basename(jsonlPath, '.jsonl');
  return path.join(projectDir, transcriptSessionId, 'subagents');
}

/**
 * Maps the caller's owned session ids to their `subagents` directories, honoring
 * the session cap. Returns the ordered pairs plus the eligibility counters.
 */
function resolveOwnedSubagentDirs(userId: number): {
  pairs: Array<{ sessionId: string; subagentsDir: string }>;
  eligible: number;
  sessionCapped: boolean;
} {
  const ownedSessionIds = participantsDb.getSessionIdsForUser(userId);
  const eligible = ownedSessionIds.length;
  if (eligible === 0) {
    return { pairs: [], eligible: 0, sessionCapped: false };
  }

  const toScan = ownedSessionIds.slice(0, MAX_SESSIONS_SCANNED);
  const sessionCapped = eligible > toScan.length;

  // Batched transcript-path lookup (no N+1) for exactly the capped id set.
  const pathRows = sessionsDb.getSessionFilePathsByIds(toScan);
  const jsonlBySession = new Map<string, string>();
  for (const row of pathRows) {
    jsonlBySession.set(row.session_id, row.jsonl_path);
  }

  const pairs: Array<{ sessionId: string; subagentsDir: string }> = [];
  for (const sessionId of toScan) {
    const subagentsDir = resolveSubagentsDir(jsonlBySession.get(sessionId) ?? null);
    if (subagentsDir) {
      pairs.push({ sessionId, subagentsDir });
    }
  }

  return { pairs, eligible, sessionCapped };
}

export const agentStatusService = {
  /**
   * Returns the caller's agents that stopped without delivering a result.
   *
   * Completed agents are dropped. An `'unknown'` agent whose transcript was
   * written within the quiet window is ALSO dropped: its file is still being
   * appended to, so reporting it as an orphan would be a guess. (This is a
   * statement about the FILE, not a liveness claim about a process — the same
   * reasoning as workflow-reconcile's freshness gate (b).) An `'interrupted'`
   * agent carries an explicit terminal marker and is reported regardless.
   *
   * Fail-closed on identity, fail-safe on everything else: any per-session or
   * per-agent anomaly degrades that item, never the call, and never throws.
   *
   * @param userId  Authenticated numeric user id, or null when unresolved.
   * @param options Test seams: `now`, `quietMs`, `tailBytes`.
   */
  async getOrphanedAgents(
    userId: number | null,
    options: { now?: number; quietMs?: number; tailBytes?: number } = {},
  ): Promise<OrphanedAgentsResult> {
    const empty: OrphanedAgentsResult = {
      agents: [],
      eligible: 0,
      scanned: 0,
      agentsScanned: 0,
      capped: false,
    };

    // Fail-closed: no usable identity => reveal nothing, do not scan.
    if (!Number.isInteger(userId)) {
      return empty;
    }

    const now = options.now ?? Date.now();
    const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;

    try {
      const { pairs, eligible, sessionCapped } = resolveOwnedSubagentDirs(userId as number);
      if (pairs.length === 0) {
        return { ...empty, eligible };
      }

      const agents: OrphanedAgent[] = [];
      let scanned = 0;
      let agentsScanned = 0;
      let agentCapped = false;

      for (const { sessionId, subagentsDir } of pairs) {
        scanned += 1;
        const agentIds = await listSessionAgentIds(subagentsDir);

        for (const agentId of agentIds) {
          if (agentsScanned >= MAX_AGENTS_SCANNED) {
            agentCapped = true;
            break;
          }
          agentsScanned += 1;

          const outcome = await readAgentOutcome(
            agentTranscriptPath(subagentsDir, agentId),
            agentId,
            { tailBytes: options.tailBytes },
          );

          if (outcome.outcome === 'completed') {
            continue; // Delivered its report on disk — not this endpoint's concern.
          }

          // Still-being-written transcript => decline to call it an orphan.
          if (outcome.outcome === 'unknown') {
            const mtimeMs = outcome.updatedAt ? new Date(outcome.updatedAt).getTime() : NaN;
            if (Number.isFinite(mtimeMs) && now - mtimeMs < quietMs) {
              continue;
            }
          }

          const meta = await readAgentMeta(agentMetaPath(subagentsDir, agentId));
          agents.push({
            sessionId,
            agentId,
            outcome: outcome.outcome,
            unknownReason: outcome.unknownReason,
            agentType: meta.agentType,
            description: meta.description,
            toolUseId: meta.toolUseId,
            model: meta.model,
            startedAt: outcome.startedAt,
            lastActivityAt: outcome.lastActivityAt,
            updatedAt: outcome.updatedAt,
            hasReport: outcome.finalText !== null,
            reportPreview:
              outcome.finalText !== null
                ? outcome.finalText.slice(0, REPORT_PREVIEW_CHARS)
                : null,
            resumeHint: `SendMessage → ${agentId}`,
          });
        }

        if (agentCapped) {
          break;
        }
      }

      return {
        agents,
        eligible,
        scanned,
        agentsScanned,
        capped: sessionCapped || agentCapped,
      };
    } catch (error) {
      console.debug(
        '[agent-status] unexpected failure, returning empty:',
        error instanceof Error ? error.message : String(error),
      );
      return empty;
    }
  },

  /**
   * Returns one agent's recovered report — the automated replacement for the
   * coordinator's manual `tail`.
   *
   * Fail-closed twice over: an unresolved caller gets null without a scan, and
   * the agent is located ONLY by walking the caller's own sessions, so an id
   * belonging to someone else resolves to null exactly like a nonexistent one
   * (no existence oracle). The id is validated against {@link AGENT_ID_RE}
   * before it touches a path.
   *
   * @returns The report, or null when not found / not owned / not readable.
   */
  async getAgentReport(
    userId: number | null,
    agentId: string,
    options: { tailBytes?: number } = {},
  ): Promise<AgentReport | null> {
    if (!Number.isInteger(userId) || !isValidAgentId(agentId)) {
      return null;
    }

    try {
      const { pairs } = resolveOwnedSubagentDirs(userId as number);

      for (const { sessionId, subagentsDir } of pairs) {
        const agentIds = await listSessionAgentIds(subagentsDir);
        if (!agentIds.includes(agentId)) {
          continue;
        }

        const outcome = await readAgentOutcome(
          agentTranscriptPath(subagentsDir, agentId),
          agentId,
          { tailBytes: options.tailBytes },
        );
        if (outcome.unknownReason === 'unreadable') {
          return null;
        }
        const meta = await readAgentMeta(agentMetaPath(subagentsDir, agentId));

        return {
          sessionId,
          agentId,
          outcome: outcome.outcome,
          unknownReason: outcome.unknownReason,
          agentType: meta.agentType,
          description: meta.description,
          toolUseId: meta.toolUseId,
          startedAt: outcome.startedAt,
          lastActivityAt: outcome.lastActivityAt,
          report: outcome.finalText,
          reportTruncated: outcome.finalTextTruncated,
          interruptionText: outcome.interruptionText,
        };
      }

      return null;
    } catch (error) {
      console.debug(
        '[agent-status] report lookup failed, returning null:',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  },
};
