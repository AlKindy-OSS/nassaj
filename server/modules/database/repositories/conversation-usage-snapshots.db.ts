import { getConnection } from '@/modules/database/connection.js';
import type {
  UsageAttributionKind,
  UsageAttributionScope,
} from '@/modules/database/repositories/usage-ingestion.db.js';

export type ConversationUsageSnapshotStatus = 'initializing' | 'ready' | 'stale' | 'error';

export type ConversationUsageSnapshotKey = {
  sessionId: string;
  attributionKind: UsageAttributionKind;
  attributionId?: string | null;
  attributionScope: UsageAttributionScope;
};

export type ConversationUsageSnapshotInput = ConversationUsageSnapshotKey & {
  provider: string;
  harness?: string;
  projectId?: string | null;
  projectPath?: string | null;
  generation: number;
  snapshotStatus: ConversationUsageSnapshotStatus;
  asOf?: string | null;
  measured: boolean;
  ingestComplete: boolean;
  pricingComplete: boolean;
  requestCount: number;
  outputMaxCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  costUsd?: number | null;
  reportedWorkDurationMs?: number | null;
  breakdown?: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type ConversationUsageSnapshot = ConversationUsageSnapshotInput & {
  attributionId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type SnapshotDbRow = {
  session_id: string;
  attribution_kind: UsageAttributionKind;
  attribution_id: string;
  attribution_scope: UsageAttributionScope;
  provider: string;
  harness: string;
  project_id: string | null;
  project_path: string | null;
  revision: number;
  generation: number;
  snapshot_status: ConversationUsageSnapshotStatus;
  as_of: string | null;
  measured: number;
  ingest_complete: number;
  pricing_complete: number;
  request_count: number;
  output_max_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  cache_read_tokens: number;
  cost_usd: number | null;
  reported_work_duration_ms: number | null;
  breakdown_json: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

const SNAPSHOT_COLUMNS = `session_id, attribution_kind, attribution_id, attribution_scope, provider,
  harness, project_id, project_path, revision, generation, snapshot_status, as_of,
  measured, ingest_complete, pricing_complete, request_count, output_max_count,
  input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
  cache_read_tokens, cost_usd, reported_work_duration_ms, breakdown_json,
  error_code, error_message, created_at, updated_at`;

function decodeBreakdown(serialized: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return {};
  }
}

function toSnapshot(row: SnapshotDbRow): ConversationUsageSnapshot {
  return {
    sessionId: row.session_id,
    attributionKind: row.attribution_kind,
    attributionId: row.attribution_id,
    attributionScope: row.attribution_scope,
    provider: row.provider,
    harness: row.harness,
    projectId: row.project_id,
    projectPath: row.project_path,
    revision: row.revision,
    generation: row.generation,
    snapshotStatus: row.snapshot_status,
    asOf: row.as_of,
    measured: Boolean(row.measured),
    ingestComplete: Boolean(row.ingest_complete),
    pricingComplete: Boolean(row.pricing_complete),
    requestCount: row.request_count,
    outputMaxCount: row.output_max_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheWrite5mTokens: row.cache_write_5m_tokens,
    cacheWrite1hTokens: row.cache_write_1h_tokens,
    cacheReadTokens: row.cache_read_tokens,
    costUsd: row.cost_usd,
    reportedWorkDurationMs: row.reported_work_duration_ms,
    breakdown: decodeBreakdown(row.breakdown_json),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshotParams(input: ConversationUsageSnapshotInput): unknown[] {
  return [
    input.provider,
    input.harness ?? '',
    input.projectId ?? null,
    input.projectPath ?? null,
    input.generation,
    input.snapshotStatus,
    input.asOf ?? null,
    input.measured ? 1 : 0,
    input.ingestComplete ? 1 : 0,
    input.pricingComplete ? 1 : 0,
    input.requestCount,
    input.outputMaxCount,
    input.inputTokens,
    input.outputTokens,
    input.cacheWrite5mTokens,
    input.cacheWrite1hTokens,
    input.cacheReadTokens,
    input.costUsd ?? null,
    input.reportedWorkDurationMs ?? null,
    JSON.stringify(input.breakdown ?? {}),
    input.errorCode ?? null,
    input.errorMessage ?? null,
  ];
}

export const conversationUsageSnapshotsDb = {
  markSessionError(sessionId: string, code: string, message: string): number {
    const result = getConnection().prepare(`
      UPDATE conversation_usage_snapshots
      SET snapshot_status = 'error', ingest_complete = 0,
          error_code = ?, error_message = ?, revision = revision + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(code, message, sessionId);
    return result.changes;
  },

  get(key: ConversationUsageSnapshotKey): ConversationUsageSnapshot | null {
    const row = getConnection().prepare(`
      SELECT ${SNAPSHOT_COLUMNS}
      FROM conversation_usage_snapshots
      WHERE session_id = ? AND attribution_kind = ? AND attribution_id = ? AND attribution_scope = ?
    `).get(
      key.sessionId,
      key.attributionKind,
      key.attributionId ?? '',
      key.attributionScope,
    ) as SnapshotDbRow | undefined;
    return row ? toSnapshot(row) : null;
  },

  /** Insert at revision 0, or update only when the caller's revision still wins. */
  upsertCas(input: ConversationUsageSnapshotInput, expectedRevision: number | null): boolean {
    const db = getConnection();
    const attributionId = input.attributionId ?? '';
    if (expectedRevision === null) {
      const result = db.prepare(`
        INSERT INTO conversation_usage_snapshots (
          session_id, attribution_kind, attribution_id, attribution_scope, provider, harness,
          project_id, project_path, revision, generation, snapshot_status, as_of,
          measured, ingest_complete, pricing_complete, request_count, output_max_count,
          input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
          cache_read_tokens, cost_usd, reported_work_duration_ms, breakdown_json,
          error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, attribution_kind, attribution_id, attribution_scope) DO NOTHING
      `).run(
        input.sessionId,
        input.attributionKind,
        attributionId,
        input.attributionScope,
        ...snapshotParams(input),
      );
      return result.changes === 1;
    }

    const result = db.prepare(`
      UPDATE conversation_usage_snapshots
      SET provider = ?, harness = ?, project_id = ?, project_path = ?, generation = ?,
          snapshot_status = ?, as_of = ?, measured = ?, ingest_complete = ?,
          pricing_complete = ?, request_count = ?, output_max_count = ?, input_tokens = ?,
          output_tokens = ?, cache_write_5m_tokens = ?, cache_write_1h_tokens = ?,
          cache_read_tokens = ?, cost_usd = ?, reported_work_duration_ms = ?,
          breakdown_json = ?, error_code = ?, error_message = ?, revision = revision + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ? AND attribution_kind = ? AND attribution_id = ?
        AND attribution_scope = ? AND revision = ?
    `).run(
      ...snapshotParams(input),
      input.sessionId,
      input.attributionKind,
      attributionId,
      input.attributionScope,
      expectedRevision,
    );
    return result.changes === 1;
  },
};
