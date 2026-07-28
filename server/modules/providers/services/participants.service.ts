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

import { participantsDb, projectsDb, sessionAgentsDb, sessionsDb } from '@/modules/database/index.js';
import type { SessionAgentRow, SessionParticipantRow } from '@/modules/database/index.js';
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

export const participantsService = {
  /** Human participants of a single session. */
  listSessionParticipants(sessionId: string): ParticipantView[] {
    return participantsDb.listBySession(sessionId);
  },

  /**
   * Non-human actors (model + subagents) of a single session, parsed on demand
   * from the transcript. Resolves the transcript path and provider from the DB
   * session row so the parser can branch (antigravity vs claude-style).
   */
  async listSessionAgents(sessionId: string): Promise<AgentView[]> {
    const session = sessionsDb.getSessionById(sessionId);
    const transcriptPath = session?.jsonl_path ?? null;
    const provider = session?.provider;

    const agents = await getSessionAgents(sessionId, transcriptPath, { provider });
    return agents as AgentView[];
  },

  /**
   * Aggregated participants + agents across every active session of a project.
   * Resolves the project_id to its path, fetches the project's sessions, then
   * unions humans (DB) and agents (parse-on-demand per session, then summed).
   */
  async getProjectParticipants(
    projectId: string
  ): Promise<{ users: ParticipantView[]; agents: AgentView[] }> {
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

    // Ensure each session's agent cache is fresh before aggregating. Parsing is
    // mtime-gated, so unchanged transcripts are cheap no-ops.
    await Promise.all(
      sessions.map((s) =>
        getSessionAgents(s.session_id, s.jsonl_path ?? null, { provider: s.provider })
      )
    );

    const agents = sessionAgentsDb.aggregateBySessionIds(sessionIds) as AgentView[];

    return { users, agents };
  },
};
