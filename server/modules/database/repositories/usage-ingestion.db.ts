import { getConnection } from '@/modules/database/connection.js';

export const MAX_USAGE_PARTIAL_TAIL_BYTES = 256 * 1024;

export type UsageCheckpointStatus = 'ready' | 'processing' | 'error' | 'retired';
export type UsageAttributionKind = 'coordinator' | 'agent' | 'user' | 'unattributed' | 'ambiguous';
export type UsageAttributionScope = 'conversation' | 'agent' | 'user';
export type UsageBackfillStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
export type UsageBackfillGeneration = {
  generation: number;
  parserVersion: number;
  status: UsageBackfillStatus;
  cursorSourceKey: string | null;
  sourcesTotal: number;
  sourcesProcessed: number;
  eventsWritten: number;
};

export type UsageSourceCheckpoint = {
  sourceKey: string;
  provider: string;
  sourcePath: string;
  deviceId: string | null;
  inode: string | null;
  offsetBytes: number;
  partialTail: string;
  parserVersion: number;
  generation: number;
  status: UsageCheckpointStatus;
  lastError: string | null;
  observedSizeBytes: number | null;
  observedMtimeMs: number | null;
  boundaryHash: string | null;
  createdAt: string;
  updatedAt: string;
};

type CheckpointDbRow = {
  source_key: string;
  provider: string;
  source_path: string;
  device_id: string | null;
  inode: string | null;
  offset_bytes: number;
  partial_tail: string;
  parser_version: number;
  generation: number;
  status: UsageCheckpointStatus;
  last_error: string | null;
  observed_size_bytes: number | null;
  observed_mtime_ms: number | null;
  boundary_hash: string | null;
  created_at: string;
  updated_at: string;
};

const CHECKPOINT_COLUMNS = `source_key, provider, source_path, device_id, inode,
  offset_bytes, partial_tail, parser_version, generation, status, last_error,
  observed_size_bytes, observed_mtime_ms, boundary_hash, created_at, updated_at`;

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPartialTail(partialTail: string): void {
  if (Buffer.byteLength(partialTail, 'utf8') > MAX_USAGE_PARTIAL_TAIL_BYTES) {
    throw new RangeError(`partialTail exceeds ${MAX_USAGE_PARTIAL_TAIL_BYTES} bytes`);
  }
}

function toCheckpoint(row: CheckpointDbRow): UsageSourceCheckpoint {
  return {
    sourceKey: row.source_key,
    provider: row.provider,
    sourcePath: row.source_path,
    deviceId: row.device_id,
    inode: row.inode,
    offsetBytes: row.offset_bytes,
    partialTail: row.partial_tail,
    parserVersion: row.parser_version,
    generation: row.generation,
    status: row.status,
    lastError: row.last_error,
    observedSizeBytes: row.observed_size_bytes,
    observedMtimeMs: row.observed_mtime_ms,
    boundaryHash: row.boundary_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreateUsageCheckpoint = {
  sourceKey: string;
  provider: string;
  sourcePath: string;
  deviceId?: string | null;
  inode?: string | null;
  parserVersion: number;
};

export type AdvanceUsageCheckpoint = {
  sourceKey: string;
  expectedGeneration: number;
  expectedOffsetBytes: number;
  nextOffsetBytes: number;
  partialTail: string;
  deviceId?: string | null;
  inode?: string | null;
  observedSizeBytes?: number | null;
  observedMtimeMs?: number | null;
  boundaryHash?: string | null;
};

export type UsageRequestEventInput = {
  eventId: string;
  sourceKey: string;
  sourceGeneration: number;
  byteStart: number;
  byteEnd: number;
  occurredAt: string;
  provider: string;
  harness?: string;
  sessionId: string;
  projectId?: string | null;
  projectPath?: string | null;
  requestKey: string;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  cacheReadTokens?: number;
  outputMax?: boolean | null;
  isSubagent?: boolean;
  attributionScope: UsageAttributionScope;
  attributionKind: UsageAttributionKind;
  attributionId?: string | null;
  attributionConfidence?: number | null;
};

export type UsageSourceLinkInput = {
  parentSourceKey: string;
  childSourceKey: string;
  relation: 'subagent' | 'workflow' | 'fork' | 'other';
  sessionId?: string | null;
  agentId?: string | null;
  generation: number;
};

export type UsageDurationEventInput = {
  eventId: string;
  sourceKey: string;
  sourceGeneration: number;
  sessionId?: string | null;
  projectId?: string | null;
  projectPath?: string | null;
  kind: 'request' | 'tool' | 'agent' | 'work_interval';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  attributionKind?: UsageAttributionKind;
  attributionId?: string | null;
};

export type ConversationUsageFact = {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  subagentRequests: number;
  outputMaxCount: number;
};

export const usageIngestionDb = {
  getCheckpoint(sourceKey: string): UsageSourceCheckpoint | null {
    const row = getConnection()
      .prepare(`SELECT ${CHECKPOINT_COLUMNS} FROM usage_source_checkpoints WHERE source_key = ?`)
      .get(sourceKey) as CheckpointDbRow | undefined;
    return row ? toCheckpoint(row) : null;
  },

  createCheckpoint(input: CreateUsageCheckpoint): boolean {
    assertNonNegativeInteger('parserVersion', input.parserVersion);
    const result = getConnection().prepare(`
      INSERT INTO usage_source_checkpoints (
        source_key, provider, source_path, device_id, inode, parser_version
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO NOTHING
    `).run(
      input.sourceKey,
      input.provider,
      input.sourcePath,
      input.deviceId ?? null,
      input.inode ?? null,
      input.parserVersion,
    );
    return result.changes === 1;
  },

  /** CAS advance: both generation and old offset must still match. */
  advanceCheckpointCas(input: AdvanceUsageCheckpoint): boolean {
    assertNonNegativeInteger('expectedGeneration', input.expectedGeneration);
    assertNonNegativeInteger('expectedOffsetBytes', input.expectedOffsetBytes);
    assertNonNegativeInteger('nextOffsetBytes', input.nextOffsetBytes);
    if (input.nextOffsetBytes < input.expectedOffsetBytes) {
      throw new RangeError('nextOffsetBytes cannot move backwards within a generation');
    }
    assertPartialTail(input.partialTail);
    const result = getConnection().prepare(`
      UPDATE usage_source_checkpoints
      SET offset_bytes = ?, partial_tail = ?, device_id = COALESCE(?, device_id),
          inode = COALESCE(?, inode), observed_size_bytes = ?, observed_mtime_ms = ?,
          boundary_hash = ?, status = 'ready', last_error = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE source_key = ? AND generation = ? AND offset_bytes = ?
    `).run(
      input.nextOffsetBytes,
      input.partialTail,
      input.deviceId ?? null,
      input.inode ?? null,
      input.observedSizeBytes ?? null,
      input.observedMtimeMs ?? null,
      input.boundaryHash ?? null,
      input.sourceKey,
      input.expectedGeneration,
      input.expectedOffsetBytes,
    );
    return result.changes === 1;
  },

  /** CAS reset for rotation/truncation/parser rebuild; increments generation. */
  resetCheckpointCas(input: CreateUsageCheckpoint & { expectedGeneration: number }): boolean {
    assertNonNegativeInteger('expectedGeneration', input.expectedGeneration);
    assertNonNegativeInteger('parserVersion', input.parserVersion);
    const result = getConnection().prepare(`
      UPDATE usage_source_checkpoints
      SET provider = ?, source_path = ?, device_id = ?, inode = ?, offset_bytes = 0,
          partial_tail = '', parser_version = ?, generation = generation + 1,
          status = 'ready', last_error = NULL, observed_size_bytes = NULL,
          observed_mtime_ms = NULL, boundary_hash = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE source_key = ? AND generation = ?
    `).run(
      input.provider,
      input.sourcePath,
      input.deviceId ?? null,
      input.inode ?? null,
      input.parserVersion,
      input.sourceKey,
      input.expectedGeneration,
    );
    return result.changes === 1;
  },

  /** Must run in the same transaction as a generation reset, before purge. */
  invalidateSnapshotsForSource(sourceKey: string, reason: string): number {
    const result = getConnection().prepare(`
      UPDATE conversation_usage_snapshots
      SET snapshot_status = 'stale', ingest_complete = 0,
          error_code = 'source_generation_reset', error_message = ?,
          revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE session_id IN (
        SELECT DISTINCT session_id FROM usage_request_occurrences WHERE source_key = ?
        UNION
        SELECT DISTINCT session_id FROM usage_duration_events WHERE source_key = ? AND session_id IS NOT NULL
        UNION
        SELECT DISTINCT session_id FROM usage_source_links
          WHERE (parent_source_key = ? OR child_source_key = ?) AND session_id IS NOT NULL
      )
    `).run(reason, sourceKey, sourceKey, sourceKey, sourceKey);
    return result.changes;
  },

  setCheckpointStatusCas(input: {
    sourceKey: string;
    expectedGeneration: number;
    expectedStatus: UsageCheckpointStatus;
    nextStatus: UsageCheckpointStatus;
    lastError?: string | null;
  }): boolean {
    const result = getConnection().prepare(`
      UPDATE usage_source_checkpoints
      SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE source_key = ? AND generation = ? AND status = ?
    `).run(
      input.nextStatus,
      input.lastError ?? null,
      input.sourceKey,
      input.expectedGeneration,
      input.expectedStatus,
    );
    return result.changes === 1;
  },

  /** Inserts physical provenance, then merges the pricing-free logical fact. */
  insertRequestEvent(input: UsageRequestEventInput): boolean {
    const counters = [
      input.sourceGeneration,
      input.byteStart,
      input.byteEnd,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.cacheWrite5mTokens ?? 0,
      input.cacheWrite1hTokens ?? 0,
      input.cacheReadTokens ?? 0,
    ];
    counters.forEach((value, index) => assertNonNegativeInteger(`requestCounter[${index}]`, value));
    const db = getConnection();
    return db.transaction(() => {
      const attributionId = input.attributionId ?? '';
      const occurrence = db.prepare(`
        INSERT INTO usage_request_occurrences (
          event_id, source_key, source_generation, byte_start, byte_end,
          session_id, request_key, attribution_kind, attribution_id, attribution_scope
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).run(
        input.eventId, input.sourceKey, input.sourceGeneration, input.byteStart, input.byteEnd,
        input.sessionId, input.requestKey, input.attributionKind, attributionId, input.attributionScope,
      );
      if (occurrence.changes !== 1) return false;

      db.prepare(`
        INSERT INTO usage_request_events (
          session_id, request_key, attribution_kind, attribution_id, attribution_scope,
          occurred_at, provider, harness, project_id, project_path, model,
          input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
          cache_read_tokens, output_max, is_subagent, attribution_confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, request_key, attribution_kind, attribution_id, attribution_scope)
        DO UPDATE SET
          model = CASE WHEN usage_request_events.model IS NULL OR usage_request_events.model = 'unknown'
            THEN excluded.model ELSE usage_request_events.model END,
          input_tokens = MAX(usage_request_events.input_tokens, excluded.input_tokens),
          output_tokens = MAX(usage_request_events.output_tokens, excluded.output_tokens),
          cache_write_5m_tokens = MAX(usage_request_events.cache_write_5m_tokens, excluded.cache_write_5m_tokens),
          cache_write_1h_tokens = MAX(usage_request_events.cache_write_1h_tokens, excluded.cache_write_1h_tokens),
          cache_read_tokens = MAX(usage_request_events.cache_read_tokens, excluded.cache_read_tokens),
          output_max = COALESCE(excluded.output_max, usage_request_events.output_max),
          is_subagent = MAX(usage_request_events.is_subagent, excluded.is_subagent),
          attribution_confidence = MAX(usage_request_events.attribution_confidence, excluded.attribution_confidence),
          updated_at = CURRENT_TIMESTAMP
      `).run(
        input.sessionId, input.requestKey, input.attributionKind, attributionId, input.attributionScope,
        input.occurredAt, input.provider, input.harness ?? '', input.projectId ?? null,
        input.projectPath ?? null, input.model ?? null, input.inputTokens ?? 0,
        input.outputTokens ?? 0, input.cacheWrite5mTokens ?? 0,
        input.cacheWrite1hTokens ?? 0, input.cacheReadTokens ?? 0,
        input.outputMax === null || input.outputMax === undefined ? null : input.outputMax ? 1 : 0,
        input.isSubagent ? 1 : 0, input.attributionConfidence ?? null,
      );
      return true;
    })();
  },

  /** Compatibility name used by the writer; insertion already performs the merge. */
  mergeRequestEvent(input: UsageRequestEventInput): boolean {
    return this.insertRequestEvent(input);
  },

  purgeSourceGenerationsBefore(sourceKey: string, generation: number): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare(`DELETE FROM usage_request_occurrences
                  WHERE source_key = ? AND source_generation < ?`).run(sourceKey, generation);
      db.prepare(`DELETE FROM usage_request_events AS fact
                  WHERE NOT EXISTS (
                    SELECT 1 FROM usage_request_occurrences AS occurrence
                    WHERE occurrence.session_id = fact.session_id
                      AND occurrence.request_key = fact.request_key
                      AND occurrence.attribution_kind = fact.attribution_kind
                      AND occurrence.attribution_id = fact.attribution_id
                      AND occurrence.attribution_scope = fact.attribution_scope
                  )`).run();
      db.prepare('DELETE FROM usage_duration_events WHERE source_key = ? AND source_generation < ?')
        .run(sourceKey, generation);
      db.prepare('DELETE FROM usage_source_links WHERE parent_source_key = ? AND generation < ?')
        .run(sourceKey, generation);
    })();
  },

  listConversationFacts(
    sessionId: string,
    attribution?: { kind: UsageAttributionKind; id?: string | null; scope?: UsageAttributionScope },
  ): ConversationUsageFact[] {
    const filter = attribution
      ? 'AND e.attribution_kind = ? AND e.attribution_id = ? AND e.attribution_scope = ?'
      : '';
    const params = attribution
      ? [sessionId, attribution.kind, attribution.id ?? '', attribution.scope ?? 'conversation']
      : [sessionId];
    return getConnection().prepare(`
      SELECT COALESCE(e.model, 'unknown') AS model, COUNT(*) AS requests,
        SUM(e.input_tokens) AS inputTokens, SUM(e.output_tokens) AS outputTokens,
        SUM(e.cache_write_5m_tokens) AS cacheWrite5mTokens,
        SUM(e.cache_write_1h_tokens) AS cacheWrite1hTokens,
        SUM(e.cache_read_tokens) AS cacheReadTokens,
        SUM(e.is_subagent) AS subagentRequests,
        SUM(CASE WHEN e.output_max = 1 THEN 1 ELSE 0 END) AS outputMaxCount
      FROM usage_request_events e
      WHERE e.session_id = ?
      ${filter}
      GROUP BY COALESCE(e.model, 'unknown')
      ORDER BY model
    `).all(...params) as ConversationUsageFact[];
  },

  listConversationAttributions(sessionId: string): Array<{
    kind: UsageAttributionKind;
    id: string;
    scope: UsageAttributionScope;
  }> {
    return getConnection().prepare(`
      SELECT DISTINCT e.attribution_kind AS kind, e.attribution_id AS id,
        e.attribution_scope AS scope
      FROM usage_request_events e
      WHERE e.session_id = ? AND e.attribution_kind <> 'coordinator'
    `).all(sessionId) as Array<{ kind: UsageAttributionKind; id: string; scope: UsageAttributionScope }>;
  },

  sumConversationDuration(sessionId: string): number | null {
    const row = getConnection().prepare(`
      SELECT SUM(d.duration_ms) AS duration
      FROM usage_duration_events d
      JOIN usage_source_checkpoints c
        ON c.source_key = d.source_key AND c.generation = d.source_generation
      WHERE d.session_id = ?
    `).get(sessionId) as { duration: number | null };
    return row.duration;
  },

  insertSourceLink(input: UsageSourceLinkInput): boolean {
    const result = getConnection().prepare(`
      INSERT INTO usage_source_links (
        parent_source_key, child_source_key, relation, session_id, agent_id, generation
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      input.parentSourceKey,
      input.childSourceKey,
      input.relation,
      input.sessionId ?? null,
      input.agentId ?? null,
      input.generation,
    );
    return result.changes === 1;
  },

  insertDurationEvent(input: UsageDurationEventInput): boolean {
    assertNonNegativeInteger('durationMs', input.durationMs);
    const result = getConnection().prepare(`
      INSERT INTO usage_duration_events (
        event_id, source_key, source_generation, session_id, project_id,
        project_path, kind, started_at, ended_at, duration_ms, attribution_kind, attribution_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `).run(
      input.eventId,
      input.sourceKey,
      input.sourceGeneration,
      input.sessionId ?? null,
      input.projectId ?? null,
      input.projectPath ?? null,
      input.kind,
      input.startedAt,
      input.endedAt,
      input.durationMs,
      input.attributionKind ?? 'unattributed',
      input.attributionId ?? '',
    );
    return result.changes === 1;
  },

  createBackfillGeneration(parserVersion: number, sourcesTotal = 0): number {
    assertNonNegativeInteger('parserVersion', parserVersion);
    assertNonNegativeInteger('sourcesTotal', sourcesTotal);
    const result = getConnection().prepare(`
      INSERT INTO usage_backfill_generations (parser_version, sources_total)
      VALUES (?, ?)
    `).run(parserVersion, sourcesTotal);
    return Number(result.lastInsertRowid);
  },

  getResumableBackfillGeneration(parserVersion: number): UsageBackfillGeneration | null {
    const row = getConnection().prepare(`
      SELECT generation, parser_version AS parserVersion, status,
        cursor_source_key AS cursorSourceKey, sources_total AS sourcesTotal,
        sources_processed AS sourcesProcessed, events_written AS eventsWritten
      FROM usage_backfill_generations
      WHERE parser_version = ? AND status IN ('pending', 'running')
      ORDER BY generation DESC LIMIT 1
    `).get(parserVersion) as UsageBackfillGeneration | undefined;
    return row ?? null;
  },

  claimBackfillGeneration(generation: number): boolean {
    const result = getConnection().prepare(`
      UPDATE usage_backfill_generations
      SET status = 'running', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE generation = ? AND status = 'pending'
    `).run(generation);
    return result.changes === 1;
  },

  updateBackfillProgressCas(input: {
    generation: number;
    expectedSourcesProcessed: number;
    sourcesProcessed: number;
    eventsWritten: number;
    cursorSourceKey?: string | null;
  }): boolean {
    const result = getConnection().prepare(`
      UPDATE usage_backfill_generations
      SET sources_processed = ?, events_written = ?, cursor_source_key = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE generation = ? AND status = 'running' AND sources_processed = ?
    `).run(
      input.sourcesProcessed,
      input.eventsWritten,
      input.cursorSourceKey ?? null,
      input.generation,
      input.expectedSourcesProcessed,
    );
    return result.changes === 1;
  },

  finishBackfillGeneration(
    generation: number,
    status: Extract<UsageBackfillStatus, 'complete' | 'failed' | 'cancelled'>,
    lastError: string | null = null,
  ): boolean {
    const result = getConnection().prepare(`
      UPDATE usage_backfill_generations
      SET status = ?, last_error = ?, completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE generation = ? AND status = 'running'
    `).run(status, lastError, generation);
    return result.changes === 1;
  },
};
