import type { Database } from 'better-sqlite3';

import { type ReviewContainer, type ReviewIncident, validateReviewContainer } from './agent-review-ingestion-types.js';
import { assertReviewSession } from './agent-review-validation.js';

/** Explicit-connection session binding and bounded quarantine reads for the internal ingestor. */
export class AgentReviewIngestionContextRepository {
  constructor(private readonly db: Database) {}

  /** Resolve only an existing Claude transcript registered by the server session synchronizer. */
  readSessionPath(sessionId: string): string | null {
    assertReviewSession(sessionId);
    const row = this.db.prepare("SELECT jsonl_path AS file FROM sessions WHERE session_id=? AND provider='claude'")
      .get(sessionId) as { file: unknown } | undefined;
    return typeof row?.file === 'string' && row.file.length <= 4096 ? row.file : null;
  }

  /** One active incident suffices to deny ingestion; no unbounded list or read-time repair. */
  firstActive(container: ReviewContainer): ReviewIncident | null {
    validateReviewContainer(container);
    return this.db.prepare(`SELECT incident_id AS incidentId,session_id AS sessionId,source,source_container_id AS sourceContainerId,
      scope,scope_agent_id AS scopeAgentId,incident_generation AS incidentGeneration,reason,evidence_sha256 AS evidenceSha256,revision,state
      FROM agent_review_quarantine_incidents WHERE session_id=? AND source=? AND source_container_id=? AND state='active'
      ORDER BY incident_id LIMIT 1`).get(container.sessionId, container.source, container.sourceContainerId) as ReviewIncident | undefined ?? null;
  }
}
