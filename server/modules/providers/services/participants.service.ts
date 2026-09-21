/**
 * Participants & agents service.
 *
 * Read-side business logic for the session/project participant tracking
 * feature. Keeps the route handlers thin: routes validate input and shape the
 * HTTP response; this service owns the repository calls, transcript-path
 * resolution, and project aggregation.
 *
 * Humans come from the session_participants table; non-human actors (model +
 * subagents) come from the on-demand transcript parser, which is cached per
 * transcript mtime.
 */

import {
  participantsDb,
  projectsDb,
  sessionAgentsDb,
  sessionsDb,
  type SessionAgentRow,
  type SessionParticipantRow,
} from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

// JS module (allowJs): mtime-cached transcript parser outside the modules tree.
// eslint-disable-next-line boundaries/no-unknown
import { getSessionAgents } from '@/services/transcript-parser.js';

export type ParticipantView = {
  userId: number;
  username: string;
  role: SessionParticipantRow['role'];
  first_seen: string;
  last_seen: string;
  message_count: number;
  // Profile picture URL (/avatars/<userId>.<ext>) or null; powers real avatars
  // in the participant stack instead of the coloured initial fallback.
  avatarUrl: string | null;
};

export type AgentView = {
  agent_name: string;
  agent_kind: SessionAgentRow['agent_kind'];
  invocation_count: number;
  agent_model?: string | null;
};

export type SessionAgentsView = {
  agents: AgentView[];
  /** `sessions.provider` — the CLI/harness that ran the turns. Null if unknown. */
  harness: string | null;
  /** `sessions.engine_provider` — the vendor that served them (ADR-088). */
  engine: string | null;
};

export const participantsService = {
  /** Human participants of a single session. */
  listSessionParticipants(sessionId: string): ParticipantView[] {
    return participantsDb.listBySession(sessionId);
  },

  /**
   * Non-human actors (model + subagents) of a single session, parsed on demand
   * from the transcript. Resolves the transcript path and provider from the DB
   * session row so the parser can branch (antigravity vs claude-style).
   *
   * Also returns the session's two provider axes, which the header renders as
   * the chip's mark (B-410). They answer different questions and must not be
   * collapsed into one: `harness` is the CLI that ran the turn (claude / codex /
   * opencode / agy …), `engine` is the vendor whose API served the tokens
   * (`sessions.engine_provider`, written from the resolved spawn verdict —
   * ADR-088). A kimi engine under a claude harness is a legitimate pairing; so
   * is an official engine under an opencode harness.
   */
  async listSessionAgents(sessionId: string): Promise<SessionAgentsView> {
    const session = sessionsDb.getSessionById(sessionId);
    const transcriptPath = session?.jsonl_path ?? null;
    const provider = session?.provider;

    const agents = await getSessionAgents(sessionId, transcriptPath, { provider });
    return {
      agents: agents as AgentView[],
      harness: provider ?? null,
      engine: session?.engine_provider ?? null,
    };
  },

  /**
   * Aggregated participants + agents across every active session of a project.
   * Resolves the project_id to its path, fetches the project's sessions, then
   * unions humans and the already parsed agent cache.
   *
   * This is deliberately a cache-only read. Project cards need the human
   * avatars immediately, while parsing every transcript here made the card wait
   * for the slowest session in the project. Session detail still refreshes an
   * agent roster on demand through {@link listSessionAgents}; this aggregate
   * reports only agent observations that have actually been parsed already.
   */
  async getProjectParticipants(
    projectId: string
  ): Promise<{ users: ParticipantView[]; agents: AgentView[]; agentsSource: 'cache' }> {
    const projectPath = projectsDb.getProjectPathById(projectId);
    if (!projectPath) {
      throw new AppError('Project not found.', {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }

    const sessions = sessionsDb.getSessionsByProjectPath(projectPath);
    const sessionIds = sessions.map((s) => s.session_id);

    const users = participantsDb.aggregateBySessionIds(sessionIds);

    // Do not start an unbounded transcript-parse fan-out from a sidebar read.
    // The cache is refreshed by the per-session agent view, where the caller is
    // explicitly looking at that roster. This preserves accurate cached data
    // without delaying human participant avatars behind unrelated I/O.
    const agents = sessionAgentsDb.aggregateBySessionIds(sessionIds) as AgentView[];

    // `agents` is intentionally not a complete live roster. Keep the field for
    // backward compatibility and mark its provenance so compact clients do not
    // present the cached subset as a project-wide total.
    return { users, agents, agentsSource: 'cache' };
  },
};
