import { createHash } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

export type UsageStatisticsRunStatus = 'building' | 'ready' | 'superseded' | 'incomplete' | 'quarantined' | 'failed';
export type UsageStatisticsTerminalRunStatus = Extract<UsageStatisticsRunStatus, 'incomplete' | 'quarantined' | 'failed'>;
export type UsageStatisticsFailureCode =
  | 'manifest_incomplete'
  | 'lineage_incomplete'
  | 'source_changed'
  | 'source_invalid'
  | 'vector_reset_unmarked'
  | 'fact_rejected'
  | 'snapshot_rejected'
  | 'duplicate_event_payload_mismatch'
  | 'source_snapshot_mismatch'
  | 'finalize_validation_failed'
  | 'writer_failed';
export type UsageStatisticsV3WriterMode = 'off' | 'shadow' | 'on';
export type UsageStatisticsV3ReaderMode = 'off' | 'compare' | 'on' | 'rollback';

/** Resolves the fail-closed v3 writer flag; unknown values are treated as `off`. */
export const usageStatisticsV3WriterMode = (): UsageStatisticsV3WriterMode => {
  const value = process.env.USAGE_STATISTICS_V3_WRITER;
  return value === 'shadow' || value === 'on' ? value : 'off';
};

/** `rollback` is read-only: callers must select v1 and never mutate v3. */
export const usageStatisticsV3ReaderMode = (): UsageStatisticsV3ReaderMode => {
  const value = process.env.USAGE_STATISTICS_V3_READER;
  return value === 'compare' || value === 'on' || value === 'rollback' ? value : 'off';
};

export type UsageStatisticsV3Run = {
  runId: string; sessionId: string; rootSessionId: string; provider: string;
  status: UsageStatisticsRunStatus; manifestFingerprint: string; scopeFingerprint: string;
  attributionFingerprint: string; metricsFingerprint: string; pricingVersion: string;
  generation: number; parentRunId?: string | null; leaseOwner: string; leaseExpiresAtMs: number;
  evidence: Record<string, string | number | boolean | null>;
};

export type UsageStatisticsV3Fact = {
  eventKey: string; occurredAt: string; model: string; inputTokens: number;
  outputTokens: number; cachedInputTokens: number; requestCount: number; isSubagent: boolean;
  evidence: Record<string, string | number | boolean | null>;
};

export type UsageStatisticsV3Lineage = {
  rootSessionId: string; parentThreadId: string; spawnCallId: string;
  agentThreadId: string; childGeneration: number; sourceKey: string;
};

export type UsageSourceSnapshotV3 = {
  sourceKey: string; sourceGeneration: number; contentSha256: string; sizeBytes: number;
  factCount: number; terminalVectorSha256: string; manifestFingerprint: string;
};

export type UsageReadyProjectionMetaV3 = {
  sourceCount: number;
  lineageCount: number;
  subagentRolloutCount: number;
  workDurationMs: number | null;
};

/** A `/proc` proof is supplied by the service; this repository never reads the OS. */
export type UsageV3ProcessProof = {
  processIdentityId: string;
  hostBootId: string;
  pid: number;
  procStartTicks: string;
};

export type UsageV3AuthorityKey = {
  ownerUserId: number;
  provider: string;
  rootSessionId: string;
  scopeFingerprint: string;
  attributionFingerprint: string;
};

export type UsageV3BeginPreflight = UsageV3AuthorityKey & {
  authorityId: string;
  receiptId: string;
  parentReceiptId?: string | null;
  proof: UsageV3ProcessProof;
  nowMonotonicNs: bigint;
  leaseDeadlineMonotonicNs: bigint;
  wallNowMs?: number;
};

export type UsageV3AuthorityRecoveryView = {
  status: 'idle' | 'preflighting' | 'preflight_passed' | 'running' | 'ready' | 'superseded';
  activePreflightId: string | null;
  activeRunId: string | null;
  token: number;
  process: UsageV3ProcessProof | null;
  leaseDeadlineMonotonicNs: bigint | null;
};

export type UsageV3PreflightClaim = UsageV3AuthorityKey & {
  receiptId: string;
  runId: string;
  token: number;
  proof: UsageV3ProcessProof;
  nowMonotonicNs: bigint;
  expectedLeaseDeadlineMonotonicNs: bigint;
  leaseDeadlineMonotonicNs: bigint;
  retainUntilMs: number;
  metricsFingerprint?: string;
  pricingVersion?: string;
  envelopeJson?: string;
};

export type UsageV3CanonicalFact = UsageStatisticsV3Fact & {
  sourceIdentityHash: string;
  sourceGeneration: number;
  byteStart: number;
};
export type UsageV3CanonicalLineage = { parentSourceIdentityHash: string; childSourceIdentityHash: string; edgeType: 'spawn' };
export type UsageV3CanonicalProjectionMeta = { sourceCount: number; factCount: number; lineageCount: number; workDurationMs: number | null };

export type UsageV3AuthorityTuple = {
  status: 'preflighting' | 'preflight_passed' | 'running';
  activePreflightId: string;
  activeRunId: string | null;
  token: number;
  proof: UsageV3ProcessProof;
  leaseDeadlineMonotonicNs: bigint;
};

export type UsageV3SourceSnapshot = {
  receiptId: string;
  sourceIdentityHash: string;
  generation: number;
  descriptorJson: string;
  parentSourceIdentityHash?: string | null;
  edgeType?: 'spawn' | null;
};

export type UsageV3MerkleSnapshot = {
  receiptId: string;
  sourceRootHex: string;
  topologyRootHex: string;
  rootSourceIdentityHash: string;
  envelopeJson: string;
};

export type UsageV3DeathProof = {
  kind: 'process_missing' | 'process_reused' | 'host_rebooted';
  observedHostBootId: string;
  observedPid: number;
  observedProcStartTicks: string | null;
};

export type UsageV3CanonicalTerminalStatus = 'failed' | 'quarantined' | 'superseded';
export type UsageV3CanonicalFailureCode = 'canonical_source_changed' | 'canonical_finalize_mismatch'
  | 'canonical_context_lost' | 'canonical_owner_dead' | 'lease_expired';

const v3FenceWritesEnabled = (): boolean => usageStatisticsV3WriterMode() === 'on'
  && usageStatisticsV3ReaderMode() !== 'rollback';

const validFenceText = (value: string, maximum = 512): boolean => value.length > 0
  && value.length <= maximum && !value.includes('\0');
const monotonicText = (value: bigint): string => {
  if (value < 0n) throw new RangeError('Monotonic values must be non-negative');
  return value.toString();
};
const validProof = (proof: UsageV3ProcessProof): boolean => Number.isSafeInteger(proof.pid)
  && proof.pid > 0 && validFenceText(proof.processIdentityId, 128)
  && validFenceText(proof.hostBootId, 128) && validFenceText(proof.procStartTicks, 64);
const validHash = (value: string): boolean => SHA256_PATTERN.test(value);
const CANONICAL_FAILURE_CODES = new Set<UsageV3CanonicalFailureCode>([
  'canonical_source_changed', 'canonical_finalize_mismatch', 'canonical_context_lost', 'canonical_owner_dead',
  'lease_expired',
]);
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const validJsonBounded = (value: string): boolean => {
  if (Buffer.byteLength(value, 'utf8') > MAX_EVIDENCE_BYTES) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null
      && !/(?:^|\")(?:path|realpath|locator)(?:\"|:)/i.test(value);
  } catch { return false; }
};

const MAX_RUN_BYTES = 256 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024;
export const MAX_USAGE_V3_FACTS_PER_RUN = 500_000;
export const MAX_USAGE_V3_FACTS_PER_SOURCE = 100_000;
export const MAX_USAGE_V3_SOURCES = 256;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TERMINAL_STATUSES = new Set<UsageStatisticsTerminalRunStatus>(['incomplete', 'quarantined', 'failed']);
const FAILURE_CODES = new Set<UsageStatisticsFailureCode>([
  'manifest_incomplete', 'lineage_incomplete', 'source_changed', 'source_invalid',
  'vector_reset_unmarked', 'fact_rejected', 'snapshot_rejected',
  'duplicate_event_payload_mismatch', 'source_snapshot_mismatch',
  'finalize_validation_failed', 'writer_failed',
]);
const EVIDENCE_KEYS = new Set([
  'sourceKey', 'generation', 'byteStart', 'byteEnd', 'manifestFingerprint', 'workDurationRequired',
]);
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const assertInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
};

const evidenceJson = (evidence: Record<string, string | number | boolean | null>): string => {
  if (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > MAX_EVIDENCE_BYTES) {
    throw new RangeError('Evidence exceeds 4KiB');
  }
  for (const key of Object.keys(evidence)) if (!EVIDENCE_KEYS.has(key)) throw new RangeError(`Evidence key ${key} is not allowlisted`);
  const canonical = { ...evidence };
  if (typeof canonical.sourceKey === 'string') canonical.sourceKey = sha256(canonical.sourceKey);
  if (typeof canonical.manifestFingerprint === 'string') canonical.manifestFingerprint = sha256(canonical.manifestFingerprint);
  for (const key of ['generation', 'byteStart', 'byteEnd'] as const) {
    if (canonical[key] !== undefined && (typeof canonical[key] !== 'number'
      || !Number.isSafeInteger(canonical[key]) || canonical[key] < 0)) {
      throw new RangeError(`Evidence ${key} must be a non-negative safe integer`);
    }
  }
  if (canonical.workDurationRequired !== undefined && typeof canonical.workDurationRequired !== 'boolean') {
    throw new RangeError('Evidence workDurationRequired must be boolean');
  }
  const serialized = JSON.stringify(canonical);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_BYTES) throw new RangeError('Canonical evidence exceeds 4KiB');
  return serialized;
};

export const usageStatisticsV3Db = {
  /** Minimal path/PII-free authority state needed by the recovery service. */
  getAuthorityRecoveryView(key: UsageV3AuthorityKey): UsageV3AuthorityRecoveryView | null {
    const row = getConnection().prepare(`SELECT a.status, a.active_preflight_id, a.active_run_id, a.token,
      a.owner_process_identity_id, a.lease_deadline_monotonic_ns, p.host_boot_id, p.pid, p.proc_start_ticks
      FROM usage_v3_preflight_authorities a LEFT JOIN usage_v3_process_identities p
        ON p.process_identity_id = a.owner_process_identity_id
      WHERE a.owner_user_id = ? AND a.provider = ? AND a.root_session_id = ? AND a.scope_fingerprint = ?
        AND a.attribution_fingerprint = ?`).get(key.ownerUserId, key.provider, key.rootSessionId,
      key.scopeFingerprint, key.attributionFingerprint) as {
        status: UsageV3AuthorityRecoveryView['status']; active_preflight_id: string | null; active_run_id: string | null;
        token: number; owner_process_identity_id: string | null; lease_deadline_monotonic_ns: string | null;
        host_boot_id: string | null; pid: number | null; proc_start_ticks: string | null;
      } | undefined;
    if (!row) return null;
    const process = row.owner_process_identity_id && row.host_boot_id && row.pid && row.proc_start_ticks
      ? { processIdentityId: row.owner_process_identity_id, hostBootId: row.host_boot_id,
        pid: row.pid, procStartTicks: row.proc_start_ticks } : null;
    return { status: row.status, activePreflightId: row.active_preflight_id, activeRunId: row.active_run_id,
      token: row.token, process, leaseDeadlineMonotonicNs: row.lease_deadline_monotonic_ns === null
        ? null : BigInt(row.lease_deadline_monotonic_ns) };
  },

  /** Returns only the durable I/O reservation for one opaque receipt id. */
  getAttemptIoBudget(receiptId: string): { accountedIoBytes: number; reserved: boolean } | null {
    const row = getConnection().prepare(`SELECT accounted_io_bytes AS accountedIoBytes,
      io_budget_reserved AS reserved FROM usage_v3_preflight_receipts WHERE receipt_id = ?`).get(receiptId) as
      { accountedIoBytes: number; reserved: number } | undefined;
    return row ? { accountedIoBytes: row.accountedIoBytes, reserved: row.reserved === 1 } : null;
  },

  /** Reads only a ready canonical projection, scoped by its authority key. */
  getReadyCanonicalRun(input: UsageV3AuthorityKey & { metricsFingerprint: string }): { runId: string } | null {
    const row = getConnection().prepare(`SELECT c.run_id AS runId FROM usage_v3_canonical_runs c
      JOIN usage_v3_preflight_authorities a ON a.authority_id = c.authority_id
      WHERE c.status = 'ready' AND c.owner_user_id = ? AND c.root_session_id = ? AND c.metrics_fingerprint = ?
        AND a.owner_user_id = ? AND a.provider = ? AND a.root_session_id = ? AND a.scope_fingerprint = ?
        AND a.attribution_fingerprint = ?`).get(input.ownerUserId, input.rootSessionId, input.metricsFingerprint,
      input.ownerUserId, input.provider, input.rootSessionId, input.scopeFingerprint, input.attributionFingerprint) as { runId: string } | undefined;
    return row ?? null;
  },

  /** Lists immutable canonical facts; no legacy-run fallback is permitted. */
  listCanonicalFacts(runId: string): UsageV3CanonicalFact[] {
    return getConnection().prepare(`SELECT event_key AS eventKey, source_identity_hash AS sourceIdentityHash,
      source_generation AS sourceGeneration, byte_start AS byteStart, occurred_at AS occurredAt, model,
      input_tokens AS inputTokens, output_tokens AS outputTokens, cached_input_tokens AS cachedInputTokens,
      request_count AS requestCount, is_subagent AS isSubagent, evidence_json AS evidenceJson
      FROM usage_v3_canonical_facts WHERE run_id = ? ORDER BY occurred_at, event_key`).all(runId).map(value => {
      const row = value as Omit<UsageV3CanonicalFact, 'evidence' | 'isSubagent'> & { isSubagent: number; evidenceJson: string };
      return { ...row, isSubagent: row.isSubagent === 1, evidence: JSON.parse(row.evidenceJson) as UsageV3CanonicalFact['evidence'] };
    });
  },

  /** Aggregate metadata for a ready canonical projection only. */
  getCanonicalProjectionMeta(runId: string): UsageV3CanonicalProjectionMeta | null {
    return getConnection().prepare(`SELECT (SELECT COUNT(*) FROM usage_v3_preflight_sources s
      WHERE s.receipt_id = c.preflight_receipt_id) AS sourceCount, c.fact_count AS factCount,
      c.lineage_count AS lineageCount, c.work_duration_ms AS workDurationMs
      FROM usage_v3_canonical_runs c WHERE c.run_id = ? AND c.status = 'ready'`).get(runId) as UsageV3CanonicalProjectionMeta | undefined ?? null;
  },

  /**
   * Starts a new fenced preflight after proving one and only one spawn-owner in
   * the same IMMEDIATE transaction.  A false result is deliberately opaque:
   * callers must not infer which ownership predicate failed.
   */
  beginPreflight(input: UsageV3BeginPreflight): { token: number; attemptNo: number } | null {
    const wallNowMs = input.wallNowMs ?? Date.now();
    if (!v3FenceWritesEnabled() || !validProof(input.proof)
      || !Number.isInteger(input.ownerUserId) || input.ownerUserId < 1
      || ![input.authorityId, input.receiptId, input.provider, input.rootSessionId,
        input.scopeFingerprint, input.attributionFingerprint].every(value => validFenceText(value, 128))
      || input.leaseDeadlineMonotonicNs <= input.nowMonotonicNs
      || !Number.isSafeInteger(wallNowMs) || wallNowMs < 0) return null;
    const db = getConnection();
    return db.transaction(() => {
      const owner = db.prepare(`SELECT COUNT(*) AS count, MIN(user_id) AS user_id
        FROM session_participants WHERE session_id = ? AND role = 'owner' AND attribution = 'spawn'`)
        .get(input.rootSessionId) as { count: number; user_id: number | null };
      if (owner.count !== 1 || owner.user_id !== input.ownerUserId) return null;
      db.prepare(`INSERT INTO usage_v3_process_identities
        (process_identity_id, host_boot_id, pid, proc_start_ticks) VALUES (?, ?, ?, ?)
        ON CONFLICT(host_boot_id, pid, proc_start_ticks) DO NOTHING`).run(
        input.proof.processIdentityId, input.proof.hostBootId, input.proof.pid, input.proof.procStartTicks,
      );
      const process = db.prepare(`SELECT process_identity_id FROM usage_v3_process_identities
        WHERE host_boot_id = ? AND pid = ? AND proc_start_ticks = ?`).get(
        input.proof.hostBootId, input.proof.pid, input.proof.procStartTicks,
      ) as { process_identity_id: string } | undefined;
      if (!process || process.process_identity_id !== input.proof.processIdentityId) return null;
      db.prepare(`INSERT INTO usage_v3_preflight_authorities
        (authority_id, owner_user_id, provider, root_session_id, scope_fingerprint, attribution_fingerprint, status)
        VALUES (?, ?, ?, ?, ?, ?, 'idle') ON CONFLICT(owner_user_id, provider, root_session_id,
          scope_fingerprint, attribution_fingerprint) DO NOTHING`).run(
        input.authorityId, input.ownerUserId, input.provider, input.rootSessionId,
        input.scopeFingerprint, input.attributionFingerprint,
      );
      const authority = db.prepare(`SELECT authority_id, token FROM usage_v3_preflight_authorities
        WHERE owner_user_id = ? AND provider = ? AND root_session_id = ? AND scope_fingerprint = ?
          AND attribution_fingerprint = ? AND status IN ('idle', 'ready', 'superseded')
          AND active_preflight_id IS NULL AND active_run_id IS NULL AND owner_process_identity_id IS NULL
          AND lease_deadline_monotonic_ns IS NULL`).get(input.ownerUserId, input.provider, input.rootSessionId,
        input.scopeFingerprint, input.attributionFingerprint) as { authority_id: string; token: number } | undefined;
      if (!authority) return null;
      const attempts = db.prepare(`SELECT COUNT(*) FILTER (WHERE created_at_ms >= ?) AS window_count,
        COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no FROM usage_v3_preflight_receipts WHERE authority_id = ?`)
        .get(wallNowMs - ATTEMPT_WINDOW_MS, authority.authority_id) as { window_count: number; attempt_no: number };
      if (attempts.window_count >= 3) return null;
      const latest = db.prepare(`SELECT receipt_id FROM usage_v3_preflight_receipts WHERE authority_id = ?
        AND created_at_ms >= ? ORDER BY created_at_ms DESC, attempt_no DESC LIMIT 1`).get(
        authority.authority_id, wallNowMs - ATTEMPT_WINDOW_MS) as { receipt_id: string } | undefined;
      if (input.parentReceiptId !== undefined && (input.parentReceiptId ?? null) !== (latest?.receipt_id ?? null)) return null;
      const changed = db.prepare(`UPDATE usage_v3_preflight_authorities SET status = 'preflighting',
        active_preflight_id = ?, token = token + 1, owner_process_identity_id = ?,
        lease_deadline_monotonic_ns = ?, updated_at = CURRENT_TIMESTAMP
        WHERE authority_id = ? AND token = ? AND status IN ('idle', 'ready', 'superseded')
          AND active_preflight_id IS NULL AND active_run_id IS NULL AND owner_process_identity_id IS NULL
          AND lease_deadline_monotonic_ns IS NULL`).run(input.receiptId, input.proof.processIdentityId,
        monotonicText(input.leaseDeadlineMonotonicNs), authority.authority_id, authority.token);
      if (changed.changes !== 1) return null;
      db.prepare(`INSERT INTO usage_v3_preflight_receipts (receipt_id, authority_id, attempt_no,
        parent_receipt_id, owner_user_id, root_session_id, status, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'building', ?)`).run(
        input.receiptId, authority.authority_id, attempts.attempt_no, latest?.receipt_id ?? null,
        input.ownerUserId, input.rootSessionId, wallNowMs,
      );
      return { token: authority.token + 1, attemptNo: attempts.attempt_no };
    }).immediate();
  },

  /** Reserves the two-pass I/O budget once per receipt and across the rolling attempt window. */
  reserveAttemptIoBudget(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple,
    requestedBytes: number, wallNowMs: number): boolean {
    if (!v3FenceWritesEnabled() || expected.status !== 'preflighting' || expected.activeRunId !== null
      || !validProof(expected.proof) || !Number.isSafeInteger(requestedBytes) || requestedBytes < 0
      || requestedBytes > MAX_RUN_BYTES || !Number.isSafeInteger(wallNowMs) || wallNowMs < 0) return false;
    return getConnection().prepare(`UPDATE usage_v3_preflight_receipts SET accounted_io_bytes = ?, io_budget_reserved = 1
      WHERE receipt_id = ? AND status = 'building' AND io_budget_reserved = 0
        AND (SELECT COALESCE(SUM(r.accounted_io_bytes), 0) FROM usage_v3_preflight_receipts r
          WHERE r.authority_id = usage_v3_preflight_receipts.authority_id AND r.created_at_ms >= ?) + ? <= ?
        AND EXISTS (SELECT 1 FROM usage_v3_preflight_authorities a
          WHERE a.authority_id = usage_v3_preflight_receipts.authority_id AND a.owner_user_id = ? AND a.provider = ?
            AND a.root_session_id = ? AND a.scope_fingerprint = ? AND a.attribution_fingerprint = ?
            AND a.status = 'preflighting' AND a.active_preflight_id = ? AND a.active_run_id IS NULL
            AND a.token = ? AND a.owner_process_identity_id = ? AND a.lease_deadline_monotonic_ns = ?)`).run(
      requestedBytes, expected.activePreflightId, wallNowMs - ATTEMPT_WINDOW_MS, requestedBytes, MAX_RUN_BYTES,
      key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
      expected.activePreflightId, expected.token, expected.proof.processIdentityId,
      monotonicText(expected.leaseDeadlineMonotonicNs)).changes === 1;
  },

  /** Atomically seals a building receipt and advances only its matching authority tuple. */
  passPreflight(key: UsageV3AuthorityKey, receiptId: string, token: number, proof: UsageV3ProcessProof,
    expectedLeaseDeadlineMonotonicNs: bigint, nowMonotonicNs: bigint, retainUntilMs: number): boolean {
    if (!v3FenceWritesEnabled() || !validProof(proof) || !Number.isSafeInteger(token) || token < 0
      || !Number.isSafeInteger(retainUntilMs) || retainUntilMs < 0) return false;
    const db = getConnection();
    return db.transaction(() => {
      const changed = db.prepare(`UPDATE usage_v3_preflight_authorities SET status = 'preflight_passed', token = token + 1,
        updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND provider = ? AND root_session_id = ?
          AND scope_fingerprint = ? AND attribution_fingerprint = ? AND status = 'preflighting'
          AND active_preflight_id = ? AND active_run_id IS NULL AND token = ? AND owner_process_identity_id = ?
          AND lease_deadline_monotonic_ns = ?
          AND CAST(lease_deadline_monotonic_ns AS INTEGER) > CAST(? AS INTEGER)`).run(
        key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
        receiptId, token, proof.processIdentityId, monotonicText(expectedLeaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs),
      );
      if (changed.changes !== 1) return false;
      const receipt = db.prepare(`UPDATE usage_v3_preflight_receipts SET status = 'passed', retain_until_ms = ?,
        terminal_at = CURRENT_TIMESTAMP WHERE receipt_id = ? AND status = 'building'`).run(retainUntilMs, receiptId);
      if (receipt.changes !== 1) throw new Error('USAGE_V3_RECEIPT_TERMINAL_CONFLICT');
      return true;
    }).immediate();
  },

  /** Seals a failed/quarantined preflight once and fences its authority from further writes. */
  terminatePreflight(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple, nowMonotonicNs: bigint,
    status: 'quarantined' | 'failed' | 'superseded', retainUntilMs: number): boolean {
    if (!v3FenceWritesEnabled() || !validProof(expected.proof) || !Number.isSafeInteger(retainUntilMs)
      || retainUntilMs < 0 || expected.status !== 'preflighting') return false;
    const db = getConnection();
    return db.transaction(() => {
      const authority = db.prepare(`UPDATE usage_v3_preflight_authorities SET status = 'superseded', token = token + 1,
        owner_process_identity_id = NULL, lease_deadline_monotonic_ns = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE owner_user_id = ? AND provider = ? AND root_session_id = ? AND scope_fingerprint = ?
          AND attribution_fingerprint = ? AND status = 'preflighting' AND active_preflight_id = ?
          AND active_run_id IS NULL AND token = ? AND owner_process_identity_id = ? AND lease_deadline_monotonic_ns = ?
          AND CAST(lease_deadline_monotonic_ns AS INTEGER) > CAST(? AS INTEGER)`).run(
        key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
        expected.activePreflightId, expected.token, expected.proof.processIdentityId,
        monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs),
      );
      if (authority.changes !== 1) return false;
      if (db.prepare(`UPDATE usage_v3_preflight_receipts SET status = ?, retain_until_ms = ?, terminal_at = CURRENT_TIMESTAMP
        WHERE receipt_id = ? AND status = 'building'`).run(status, retainUntilMs, expected.activePreflightId).changes !== 1) {
        throw new Error('USAGE_V3_RECEIPT_TERMINAL_CONFLICT');
      }
      return true;
    }).immediate();
  },

  /** Claims only a passed immutable receipt; callers provide source/process proofs, never paths. */
  claimCanonicalRun(input: UsageV3PreflightClaim): boolean {
    if (!v3FenceWritesEnabled() || !validProof(input.proof) || !Number.isSafeInteger(input.token)
      || input.token < 0 || !Number.isSafeInteger(input.retainUntilMs) || input.retainUntilMs < 0) return false;
    const db = getConnection();
    return db.transaction(() => {
      const changed = db.prepare(`UPDATE usage_v3_preflight_authorities SET status = 'running', active_run_id = ?,
        token = token + 1, lease_deadline_monotonic_ns = ?, updated_at = CURRENT_TIMESTAMP
        WHERE owner_user_id = ? AND provider = ? AND root_session_id = ? AND scope_fingerprint = ?
          AND attribution_fingerprint = ? AND status = 'preflight_passed' AND active_preflight_id = ?
          AND active_run_id IS NULL AND token = ? AND owner_process_identity_id = ?
          AND lease_deadline_monotonic_ns = ?
          AND CAST(lease_deadline_monotonic_ns AS INTEGER) > CAST(? AS INTEGER)
          AND EXISTS (SELECT 1 FROM usage_v3_preflight_receipts r WHERE r.receipt_id = ?
            AND r.status = 'passed' AND r.owner_user_id = ? AND r.root_session_id = ?)`).run(
        input.runId, monotonicText(input.leaseDeadlineMonotonicNs), input.ownerUserId, input.provider,
        input.rootSessionId, input.scopeFingerprint, input.attributionFingerprint, input.receiptId,
        input.token, input.proof.processIdentityId, monotonicText(input.expectedLeaseDeadlineMonotonicNs),
        monotonicText(input.nowMonotonicNs), input.receiptId,
        input.ownerUserId, input.rootSessionId,
      );
      if (changed.changes !== 1) return false;
      const authority = db.prepare(`SELECT authority_id, token FROM usage_v3_preflight_authorities
        WHERE owner_user_id = ? AND provider = ? AND root_session_id = ? AND scope_fingerprint = ?
          AND attribution_fingerprint = ?`).get(input.ownerUserId, input.provider, input.rootSessionId,
        input.scopeFingerprint, input.attributionFingerprint) as { authority_id: string; token: number };
      db.prepare(`INSERT INTO usage_v3_canonical_runs (run_id, authority_id, preflight_receipt_id, owner_user_id,
        root_session_id, status, retain_until_ms, metrics_fingerprint, pricing_version, envelope_json) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`).run(
        input.runId, authority.authority_id, input.receiptId, input.ownerUserId, input.rootSessionId, input.retainUntilMs,
        input.metricsFingerprint ?? '', input.pricingVersion ?? '', input.envelopeJson ?? '{}',
      );
      db.prepare(`UPDATE usage_v3_preflight_receipts SET retain_until_ms = MAX(retain_until_ms, ?)
        WHERE receipt_id = ?`).run(input.retainUntilMs + 30 * 24 * 60 * 60 * 1000, input.receiptId);
      return true;
    }).immediate();
  },

  /** Extends a lease only for its exact current tuple; `now === deadline` is expired. */
  renewPreflightLease(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple,
    nowMonotonicNs: bigint, nextDeadlineMonotonicNs: bigint): boolean {
    if (!v3FenceWritesEnabled() || !['preflighting', 'running'].includes(expected.status)
      || !validProof(expected.proof) || nextDeadlineMonotonicNs <= nowMonotonicNs) return false;
    return getConnection().prepare(`UPDATE usage_v3_preflight_authorities SET lease_deadline_monotonic_ns = ?,
      updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND provider = ? AND root_session_id = ?
        AND scope_fingerprint = ? AND attribution_fingerprint = ? AND status = ? AND active_preflight_id = ?
        AND active_run_id IS ? AND token = ? AND owner_process_identity_id = ?
        AND lease_deadline_monotonic_ns = ? AND CAST(lease_deadline_monotonic_ns AS INTEGER) > CAST(? AS INTEGER)`).run(
      monotonicText(nextDeadlineMonotonicNs), key.ownerUserId, key.provider, key.rootSessionId,
      key.scopeFingerprint, key.attributionFingerprint, expected.status, expected.activePreflightId,
      expected.activeRunId, expected.token, expected.proof.processIdentityId,
      monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs),
    ).changes === 1;
  },

  /** Persists one path-free source descriptor while the preflight tuple is still owned. */
  recordPreflightSource(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple,
    nowMonotonicNs: bigint, source: UsageV3SourceSnapshot): boolean {
    if (!v3FenceWritesEnabled() || expected.status !== 'preflighting' || !validProof(expected.proof)
      || !validHash(source.sourceIdentityHash) || !Number.isSafeInteger(source.generation) || source.generation < 0
      || !validJsonBounded(source.descriptorJson) || (source.parentSourceIdentityHash !== undefined
        && source.parentSourceIdentityHash !== null && !validHash(source.parentSourceIdentityHash))) return false;
    const db = getConnection();
    return db.transaction(() => {
      const owns = db.prepare(`SELECT authority_id FROM usage_v3_preflight_authorities WHERE owner_user_id = ?
        AND provider = ? AND root_session_id = ? AND scope_fingerprint = ? AND attribution_fingerprint = ?
        AND status = 'preflighting' AND active_preflight_id = ? AND active_run_id IS NULL AND token = ?
        AND owner_process_identity_id = ? AND lease_deadline_monotonic_ns = ?
        AND CAST(lease_deadline_monotonic_ns AS INTEGER) > CAST(? AS INTEGER)`).get(
        key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
        expected.activePreflightId, expected.token, expected.proof.processIdentityId,
        monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs),
      ) as { authority_id: string } | undefined;
      if (!owns || source.receiptId !== expected.activePreflightId) return false;
      const count = db.prepare('SELECT COUNT(*) AS count FROM usage_v3_preflight_sources WHERE receipt_id = ?')
        .get(source.receiptId) as { count: number };
      if (count.count >= MAX_USAGE_V3_SOURCES) return false;
      return db.prepare(`INSERT INTO usage_v3_preflight_sources (receipt_id, source_identity_hash, generation,
        descriptor_json, parent_source_identity_hash, edge_type) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(receipt_id, source_identity_hash) DO NOTHING`).run(source.receiptId, source.sourceIdentityHash,
        source.generation, source.descriptorJson, source.parentSourceIdentityHash ?? null, source.edgeType ?? null).changes === 1;
    }).immediate();
  },

  /** Stores the service-computed Merkle envelope once; terminal receipts cannot be rewritten. */
  recordPreflightMerkle(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple,
    nowMonotonicNs: bigint, snapshot: UsageV3MerkleSnapshot): boolean {
    if (!v3FenceWritesEnabled() || expected.status !== 'preflighting' || !validProof(expected.proof)
      || ![snapshot.sourceRootHex, snapshot.topologyRootHex, snapshot.rootSourceIdentityHash].every(validHash)
      || !validJsonBounded(snapshot.envelopeJson)) return false;
    return getConnection().prepare(`UPDATE usage_v3_preflight_receipts SET source_root_hex = ?, topology_root_hex = ?,
      root_source_identity_hash = ?, envelope_json = ? WHERE receipt_id = ? AND status = 'building'
        AND EXISTS (SELECT 1 FROM usage_v3_preflight_authorities a WHERE a.owner_user_id = ? AND a.provider = ?
          AND a.root_session_id = ? AND a.scope_fingerprint = ? AND a.attribution_fingerprint = ?
          AND a.status = 'preflighting' AND a.active_preflight_id = usage_v3_preflight_receipts.receipt_id
          AND a.active_run_id IS NULL AND a.token = ? AND a.owner_process_identity_id = ?
          AND a.lease_deadline_monotonic_ns = ? AND CAST(a.lease_deadline_monotonic_ns AS INTEGER) > CAST(? AS INTEGER))`).run(
      snapshot.sourceRootHex, snapshot.topologyRootHex, snapshot.rootSourceIdentityHash, snapshot.envelopeJson,
      snapshot.receiptId, key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint,
      key.attributionFingerprint, expected.token, expected.proof.processIdentityId,
      monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs),
    ).changes === 1;
  },

  /** Appends an immutable canonical projection fact under the exact running authority tuple. */
  recordCanonicalFact(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple, nowMonotonicNs: bigint,
    fact: UsageV3CanonicalFact): boolean {
    if (!v3FenceWritesEnabled() || expected.status !== 'running' || !expected.activeRunId || !validProof(expected.proof)
      || !validHash(fact.sourceIdentityHash) || !Number.isSafeInteger(fact.sourceGeneration) || fact.sourceGeneration < 0
      || !Number.isSafeInteger(fact.byteStart) || fact.byteStart < 0 || !Number.isFinite(Date.parse(fact.occurredAt))) return false;
    for (const value of [fact.inputTokens, fact.outputTokens, fact.cachedInputTokens, fact.requestCount]) assertInteger('canonical fact value', value);
    const expectedKey = sha256(`${fact.sourceIdentityHash}+${fact.sourceGeneration}+${fact.byteStart}`);
    if (fact.eventKey !== expectedKey) return false;
    const evidence = evidenceJson(fact.evidence); const bytes = Buffer.byteLength(JSON.stringify(fact), 'utf8');
    const db = getConnection();
    return db.transaction(() => {
      const run = db.prepare(`UPDATE usage_v3_canonical_runs SET fact_count = fact_count + 1, fact_bytes = fact_bytes + ?
        WHERE run_id = ? AND status = 'running' AND owner_user_id = ? AND root_session_id = ? AND fact_count < 500000
          AND fact_bytes + ? <= 268435456 AND EXISTS (SELECT 1 FROM usage_v3_preflight_sources s
            WHERE s.receipt_id = usage_v3_canonical_runs.preflight_receipt_id AND s.source_identity_hash = ?
              AND s.generation = ?) AND EXISTS (SELECT 1 FROM usage_v3_preflight_authorities a
            WHERE a.authority_id = usage_v3_canonical_runs.authority_id AND a.owner_user_id = ? AND a.provider = ?
              AND a.root_session_id = ? AND a.scope_fingerprint = ? AND a.attribution_fingerprint = ? AND a.status = 'running'
              AND a.active_preflight_id = usage_v3_canonical_runs.preflight_receipt_id AND a.active_run_id = ?
              AND a.token = ? AND a.owner_process_identity_id = ? AND a.lease_deadline_monotonic_ns = ?
              AND CAST(a.lease_deadline_monotonic_ns AS INTEGER) > CAST(? AS INTEGER))`).run(bytes, expected.activeRunId,
        key.ownerUserId, key.rootSessionId, bytes, fact.sourceIdentityHash, fact.sourceGeneration,
        key.ownerUserId, key.provider, key.rootSessionId,
        key.scopeFingerprint, key.attributionFingerprint, expected.activeRunId, expected.token,
        expected.proof.processIdentityId, monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs));
      if (run.changes !== 1) return false;
      const source = db.prepare(`SELECT COUNT(*) AS count FROM usage_v3_canonical_facts WHERE run_id = ?
        AND source_identity_hash = ? AND source_generation = ?`).get(expected.activeRunId, fact.sourceIdentityHash, fact.sourceGeneration) as { count: number };
      if (source.count >= MAX_USAGE_V3_FACTS_PER_SOURCE) throw new Error('USAGE_V3_CANONICAL_SOURCE_LIMIT');
      if (db.prepare(`INSERT INTO usage_v3_canonical_facts (run_id, event_key, source_identity_hash, source_generation, byte_start,
        occurred_at, model, input_tokens, output_tokens, cached_input_tokens, request_count, is_subagent, evidence_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, event_key) DO NOTHING`).run(
        expected.activeRunId, fact.eventKey, fact.sourceIdentityHash, fact.sourceGeneration, fact.byteStart, fact.occurredAt,
        fact.model, fact.inputTokens, fact.outputTokens, fact.cachedInputTokens, fact.requestCount, fact.isSubagent ? 1 : 0, evidence,
      ).changes !== 1) throw new Error('USAGE_V3_CANONICAL_EVENT_CONFLICT');
      return true;
    }).immediate();
  },

  /** Stores a direct spawn parent edge only while the canonical attempt is fenced. */
  recordCanonicalLineage(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple, nowMonotonicNs: bigint,
    edge: UsageV3CanonicalLineage): boolean {
    if (!v3FenceWritesEnabled() || expected.status !== 'running' || !expected.activeRunId || !validProof(expected.proof)
      || edge.edgeType !== 'spawn' || !validHash(edge.parentSourceIdentityHash) || !validHash(edge.childSourceIdentityHash)
      || edge.parentSourceIdentityHash === edge.childSourceIdentityHash) return false;
    const db = getConnection();
    return db.transaction(() => {
      const updated = db.prepare(`UPDATE usage_v3_canonical_runs SET lineage_count = lineage_count + 1 WHERE run_id = ?
        AND status = 'running' AND lineage_count < 512 AND EXISTS (SELECT 1 FROM usage_v3_preflight_authorities a
          WHERE a.authority_id = usage_v3_canonical_runs.authority_id AND a.owner_user_id = ? AND a.provider = ?
            AND a.root_session_id = ? AND a.scope_fingerprint = ? AND a.attribution_fingerprint = ? AND a.status = 'running'
            AND a.active_run_id = ? AND a.token = ? AND a.owner_process_identity_id = ? AND a.lease_deadline_monotonic_ns = ?
            AND CAST(a.lease_deadline_monotonic_ns AS INTEGER) > CAST(? AS INTEGER))`).run(expected.activeRunId,
        key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
        expected.activeRunId, expected.token, expected.proof.processIdentityId,
        monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs));
      if (updated.changes !== 1) return false;
      if (db.prepare(`INSERT INTO usage_v3_canonical_lineage (run_id, parent_source_identity_hash, child_source_identity_hash, edge_type)
        VALUES (?, ?, ?, 'spawn') ON CONFLICT DO NOTHING`).run(expected.activeRunId, edge.parentSourceIdentityHash,
        edge.childSourceIdentityHash).changes !== 1) throw new Error('USAGE_V3_CANONICAL_LINEAGE_CONFLICT');
      return true;
    }).immediate();
  },

  /** Records measured work duration before publication under the running CAS tuple. */
  setCanonicalWorkDuration(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple,
    nowMonotonicNs: bigint, workDurationMs: number): boolean {
    if (!Number.isSafeInteger(workDurationMs) || workDurationMs < 0 || expected.status !== 'running' || !expected.activeRunId) return false;
    return getConnection().prepare(`UPDATE usage_v3_canonical_runs SET work_duration_ms = ? WHERE run_id = ?
      AND status = 'running' AND EXISTS (SELECT 1 FROM usage_v3_preflight_authorities a
        WHERE a.authority_id = usage_v3_canonical_runs.authority_id AND a.owner_user_id = ? AND a.provider = ?
          AND a.root_session_id = ? AND a.scope_fingerprint = ? AND a.attribution_fingerprint = ? AND a.status = 'running'
          AND a.active_run_id = ? AND a.token = ? AND a.owner_process_identity_id = ? AND a.lease_deadline_monotonic_ns = ?
          AND CAST(a.lease_deadline_monotonic_ns AS INTEGER) > CAST(? AS INTEGER))`).run(workDurationMs, expected.activeRunId,
      key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
      expected.activeRunId, expected.token, expected.proof.processIdentityId,
      monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs)).changes === 1;
  },

  /** Publishes a claimed run only if the passed receipt still has the exact stored Merkle snapshot. */
  finalizeCanonicalRun(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple, nowMonotonicNs: bigint,
    snapshot: UsageV3MerkleSnapshot): boolean {
    if (!v3FenceWritesEnabled() || expected.status !== 'running' || !expected.activeRunId || !validProof(expected.proof)
      || ![snapshot.sourceRootHex, snapshot.topologyRootHex, snapshot.rootSourceIdentityHash].every(validHash)) return false;
    const db = getConnection();
    return db.transaction(() => {
      const run = db.prepare(`SELECT c.preflight_receipt_id FROM usage_v3_canonical_runs c
        JOIN usage_v3_preflight_receipts r ON r.receipt_id = c.preflight_receipt_id
        JOIN usage_v3_preflight_authorities a ON a.authority_id = c.authority_id
        WHERE c.run_id = ? AND c.status = 'running' AND c.owner_user_id = ? AND c.root_session_id = ?
          AND r.receipt_id = ? AND r.status = 'passed' AND r.owner_user_id = ? AND r.root_session_id = ?
          AND r.source_root_hex = ? AND r.topology_root_hex = ? AND r.root_source_identity_hash = ?
          AND r.envelope_json = ? AND a.owner_user_id = ? AND a.provider = ? AND a.root_session_id = ?
          AND a.scope_fingerprint = ? AND a.attribution_fingerprint = ? AND a.status = 'running'
          AND a.active_preflight_id = ? AND a.active_run_id = ? AND a.token = ? AND a.owner_process_identity_id = ?
          AND a.lease_deadline_monotonic_ns = ? AND CAST(a.lease_deadline_monotonic_ns AS INTEGER) > CAST(? AS INTEGER)`).get(
        expected.activeRunId, key.ownerUserId, key.rootSessionId, snapshot.receiptId, key.ownerUserId, key.rootSessionId,
        snapshot.sourceRootHex, snapshot.topologyRootHex, snapshot.rootSourceIdentityHash, snapshot.envelopeJson,
        key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
        expected.activePreflightId, expected.activeRunId, expected.token, expected.proof.processIdentityId,
        monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs),
      );
      if (!run) return false;
      const projection = db.prepare(`SELECT c.fact_count AS declared_facts, c.work_duration_ms,
        (SELECT COUNT(*) FROM usage_v3_preflight_sources WHERE receipt_id = c.preflight_receipt_id) AS sources,
        (SELECT COUNT(*) FROM usage_v3_canonical_facts WHERE run_id = c.run_id) AS facts
        FROM usage_v3_canonical_runs c WHERE c.run_id = ?`).get(expected.activeRunId) as {
          declared_facts: number; work_duration_ms: number | null; sources: number; facts: number;
        } | undefined;
      if (!projection || projection.sources < 1 || projection.facts < 1 || projection.facts !== projection.declared_facts
        || projection.work_duration_ms === null) return false;
      db.prepare(`UPDATE usage_v3_canonical_runs SET status = 'superseded', completed_at = CURRENT_TIMESTAMP
        WHERE authority_id = (SELECT authority_id FROM usage_v3_canonical_runs WHERE run_id = ?)
          AND status = 'ready' AND run_id <> ?`).run(expected.activeRunId, expected.activeRunId);
      if (db.prepare(`UPDATE usage_v3_canonical_runs SET status = 'ready', completed_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND status = 'running'`).run(expected.activeRunId).changes !== 1) throw new Error('USAGE_V3_FINALIZE_RACE');
      return db.prepare(`UPDATE usage_v3_preflight_authorities SET status = 'ready', token = token + 1,
        owner_process_identity_id = NULL, lease_deadline_monotonic_ns = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE status = 'running' AND active_preflight_id = ? AND active_run_id = ? AND token = ?
          AND owner_process_identity_id = ? AND lease_deadline_monotonic_ns = ?`).run(expected.activePreflightId,
        expected.activeRunId, expected.token, expected.proof.processIdentityId,
        monotonicText(expected.leaseDeadlineMonotonicNs)).changes === 1;
    }).immediate();
  },

  /** Expires only the exact owned building preflight once its stored monotonic deadline is reached. */
  expireOwnedPreflight(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple,
    nowMonotonicNs: bigint, retainUntilMs: number): boolean {
    if (!v3FenceWritesEnabled() || expected.status !== 'preflighting' || expected.activeRunId !== null
      || !validProof(expected.proof) || !Number.isSafeInteger(retainUntilMs) || retainUntilMs < 0) return false;
    const db = getConnection();
    return db.transaction(() => {
      const changed = db.prepare(`UPDATE usage_v3_preflight_authorities SET status = 'idle', active_preflight_id = NULL,
        active_run_id = NULL, token = token + 1, owner_process_identity_id = NULL, lease_deadline_monotonic_ns = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND provider = ? AND root_session_id = ?
          AND scope_fingerprint = ? AND attribution_fingerprint = ? AND status = 'preflighting'
          AND active_preflight_id = ? AND active_run_id IS NULL AND token = ? AND owner_process_identity_id = ?
          AND lease_deadline_monotonic_ns = ? AND CAST(lease_deadline_monotonic_ns AS INTEGER) <= CAST(? AS INTEGER)`).run(
        key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
        expected.activePreflightId, expected.token, expected.proof.processIdentityId,
        monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs));
      if (changed.changes !== 1) return false;
      if (db.prepare(`UPDATE usage_v3_preflight_receipts SET status = 'failed', failure_code = 'lease_expired',
        retain_until_ms = ?, terminal_at = CURRENT_TIMESTAMP WHERE receipt_id = ? AND status = 'building'`).run(
        retainUntilMs, expected.activePreflightId).changes !== 1) throw new Error('USAGE_V3_PREFLIGHT_EXPIRY_CONFLICT');
      return true;
    }).immediate();
  },

  /** Expires the same live owner's passed context without consuming its immutable receipt. */
  expireOwnedPassedContext(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple,
    nowMonotonicNs: bigint): boolean {
    if (!v3FenceWritesEnabled() || expected.status !== 'preflight_passed' || expected.activeRunId !== null
      || !validProof(expected.proof)) return false;
    return getConnection().transaction(() => getConnection().prepare(`UPDATE usage_v3_preflight_authorities
      SET status = 'idle', active_preflight_id = NULL, active_run_id = NULL, token = token + 1,
        owner_process_identity_id = NULL, lease_deadline_monotonic_ns = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE owner_user_id = ? AND provider = ? AND root_session_id = ? AND scope_fingerprint = ?
        AND attribution_fingerprint = ? AND status = 'preflight_passed' AND active_preflight_id = ?
        AND active_run_id IS NULL AND token = ? AND owner_process_identity_id = ? AND lease_deadline_monotonic_ns = ?
        AND CAST(lease_deadline_monotonic_ns AS INTEGER) <= CAST(? AS INTEGER)
        AND EXISTS (SELECT 1 FROM usage_v3_preflight_receipts r WHERE r.receipt_id = active_preflight_id
          AND r.status = 'passed')`).run(key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint,
      key.attributionFingerprint, expected.activePreflightId, expected.token, expected.proof.processIdentityId,
      monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs)).changes === 1).immediate();
  },

  /** Expires only the exact owned running canonical attempt; prior ready rows are untouched. */
  expireOwnedCanonical(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple,
    nowMonotonicNs: bigint, retainUntilMs: number): boolean {
    if (!v3FenceWritesEnabled() || expected.status !== 'running' || !expected.activeRunId || !validProof(expected.proof)
      || !Number.isSafeInteger(retainUntilMs) || retainUntilMs < 0) return false;
    const db = getConnection();
    return db.transaction(() => {
      const changed = db.prepare(`UPDATE usage_v3_preflight_authorities SET status = 'idle', active_preflight_id = NULL,
        active_run_id = NULL, token = token + 1, owner_process_identity_id = NULL, lease_deadline_monotonic_ns = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND provider = ? AND root_session_id = ?
          AND scope_fingerprint = ? AND attribution_fingerprint = ? AND status = 'running' AND active_preflight_id = ?
          AND active_run_id = ? AND token = ? AND owner_process_identity_id = ? AND lease_deadline_monotonic_ns = ?
          AND CAST(lease_deadline_monotonic_ns AS INTEGER) <= CAST(? AS INTEGER)`).run(
        key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
        expected.activePreflightId, expected.activeRunId, expected.token, expected.proof.processIdentityId,
        monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs));
      if (changed.changes !== 1) return false;
      if (db.prepare(`UPDATE usage_v3_canonical_runs SET status = 'failed', failure_code = 'lease_expired',
        retain_until_ms = MAX(retain_until_ms, ?), completed_at = CURRENT_TIMESTAMP WHERE run_id = ? AND status = 'running'
          AND owner_user_id = ? AND root_session_id = ? AND preflight_receipt_id = ?`).run(retainUntilMs,
        expected.activeRunId, key.ownerUserId, key.rootSessionId, expected.activePreflightId).changes !== 1) {
        throw new Error('USAGE_V3_CANONICAL_EXPIRY_CONFLICT');
      }
      return true;
    }).immediate();
  },

  /** Terminates only the current running canonical attempt and leaves every prior ready run intact. */
  terminateCanonicalRun(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple, nowMonotonicNs: bigint,
    status: UsageV3CanonicalTerminalStatus, failureCode: UsageV3CanonicalFailureCode, retainUntilMs: number): boolean {
    if (!v3FenceWritesEnabled() || expected.status !== 'running' || !expected.activeRunId || !validProof(expected.proof)
      || !CANONICAL_FAILURE_CODES.has(failureCode) || !Number.isSafeInteger(retainUntilMs) || retainUntilMs < 0) return false;
    const db = getConnection();
    return db.transaction(() => {
      const authority = db.prepare(`UPDATE usage_v3_preflight_authorities SET status = 'idle', active_preflight_id = NULL,
        active_run_id = NULL, token = token + 1, owner_process_identity_id = NULL, lease_deadline_monotonic_ns = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND provider = ? AND root_session_id = ?
          AND scope_fingerprint = ? AND attribution_fingerprint = ? AND status = 'running' AND active_preflight_id = ?
          AND active_run_id = ? AND token = ? AND owner_process_identity_id = ? AND lease_deadline_monotonic_ns = ?
          AND CAST(lease_deadline_monotonic_ns AS INTEGER) > CAST(? AS INTEGER)`).run(
        key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
        expected.activePreflightId, expected.activeRunId, expected.token, expected.proof.processIdentityId,
        monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs),
      );
      if (authority.changes !== 1) return false;
      if (db.prepare(`UPDATE usage_v3_canonical_runs SET status = ?, failure_code = ?, retain_until_ms = MAX(retain_until_ms, ?),
        completed_at = CURRENT_TIMESTAMP WHERE run_id = ? AND status = 'running' AND owner_user_id = ? AND root_session_id = ?
          AND preflight_receipt_id = ?`).run(status, failureCode, retainUntilMs, expected.activeRunId,
        key.ownerUserId, key.rootSessionId, expected.activePreflightId).changes !== 1) throw new Error('USAGE_V3_CANONICAL_TERMINAL_CONFLICT');
      return true;
    }).immediate();
  },

  /** Recovery path for a dead running writer; death evidence is supplied and verified by the service. */
  recoverDeadCanonicalRun(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple,
    death: UsageV3DeathProof, retainUntilMs: number): boolean {
    if (!v3FenceWritesEnabled() || !Number.isSafeInteger(retainUntilMs) || retainUntilMs < 0 || expected.status !== 'running'
      || !expected.activeRunId || !validProof(expected.proof)) return false;
    const validDeath = death.kind === 'host_rebooted'
      ? death.observedHostBootId !== expected.proof.hostBootId
      : death.observedHostBootId === expected.proof.hostBootId && death.observedPid === expected.proof.pid
        && (death.kind === 'process_missing' || death.observedProcStartTicks !== expected.proof.procStartTicks);
    if (!validDeath) return false;
    const db = getConnection();
    return db.transaction(() => {
      const authority = db.prepare(`UPDATE usage_v3_preflight_authorities SET status = 'idle', active_preflight_id = NULL,
        active_run_id = NULL, token = token + 1, owner_process_identity_id = NULL, lease_deadline_monotonic_ns = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND provider = ? AND root_session_id = ?
          AND scope_fingerprint = ? AND attribution_fingerprint = ? AND status = 'running' AND active_preflight_id = ?
          AND active_run_id = ? AND token = ? AND owner_process_identity_id = ?
          AND EXISTS (SELECT 1 FROM usage_v3_process_identities p WHERE p.process_identity_id = ?
            AND p.host_boot_id = ? AND p.pid = ? AND p.proc_start_ticks = ?)`).run(
        key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
        expected.activePreflightId, expected.activeRunId, expected.token, expected.proof.processIdentityId,
        expected.proof.processIdentityId, expected.proof.hostBootId, expected.proof.pid, expected.proof.procStartTicks,
      );
      if (authority.changes !== 1) return false;
      if (db.prepare(`UPDATE usage_v3_canonical_runs SET status = 'superseded', failure_code = 'canonical_owner_dead',
        retain_until_ms = MAX(retain_until_ms, ?), completed_at = CURRENT_TIMESTAMP WHERE run_id = ?
          AND status = 'running' AND owner_user_id = ? AND root_session_id = ? AND preflight_receipt_id = ?`).run(
        retainUntilMs, expected.activeRunId, key.ownerUserId, key.rootSessionId, expected.activePreflightId,
      ).changes !== 1) throw new Error('USAGE_V3_CANONICAL_DEAD_RECOVERY_CONFLICT');
      return true;
    }).immediate();
  },

  /** Recovers a dead owner after pass without consuming or rewriting the immutable passed receipt. */
  recoverDeadPassedContext(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple,
    death: UsageV3DeathProof, retainUntilMs: number): boolean {
    if (!v3FenceWritesEnabled() || expected.status !== 'preflight_passed' || expected.activeRunId !== null
      || !validProof(expected.proof) || !Number.isSafeInteger(retainUntilMs) || retainUntilMs < 0) return false;
    const validDeath = death.kind === 'host_rebooted'
      ? death.observedHostBootId !== expected.proof.hostBootId
      : death.observedHostBootId === expected.proof.hostBootId && death.observedPid === expected.proof.pid
        && (death.kind === 'process_missing' || death.observedProcStartTicks !== expected.proof.procStartTicks);
    if (!validDeath) return false;
    return getConnection().transaction(() => getConnection().prepare(`UPDATE usage_v3_preflight_authorities
      SET status = 'idle', active_preflight_id = NULL, active_run_id = NULL, token = token + 1,
        owner_process_identity_id = NULL, lease_deadline_monotonic_ns = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE owner_user_id = ? AND provider = ? AND root_session_id = ? AND scope_fingerprint = ?
        AND attribution_fingerprint = ? AND status = 'preflight_passed' AND active_preflight_id = ?
        AND active_run_id IS NULL AND token = ? AND owner_process_identity_id = ? AND lease_deadline_monotonic_ns = ?
        AND EXISTS (SELECT 1 FROM usage_v3_process_identities p WHERE p.process_identity_id = ?
          AND p.host_boot_id = ? AND p.pid = ? AND p.proc_start_ticks = ?)
        AND EXISTS (SELECT 1 FROM usage_v3_preflight_receipts r WHERE r.receipt_id = active_preflight_id
          AND r.status = 'passed')`).run(key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint,
      key.attributionFingerprint, expected.activePreflightId, expected.token, expected.proof.processIdentityId,
      monotonicText(expected.leaseDeadlineMonotonicNs), expected.proof.processIdentityId,
      expected.proof.hostBootId, expected.proof.pid, expected.proof.procStartTicks).changes === 1).immediate();
  },

  /** Releases a live owner after its service has proved the writer context is absent. */
  recoverMissingWriterContext(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple,
    nowMonotonicNs: bigint, contextAbsent: true): boolean {
    if (!v3FenceWritesEnabled() || contextAbsent !== true || expected.status !== 'preflight_passed'
      || expected.activeRunId !== null || !validProof(expected.proof)) return false;
    return getConnection().prepare(`UPDATE usage_v3_preflight_authorities SET status = 'idle',
      active_preflight_id = NULL, active_run_id = NULL, token = token + 1, owner_process_identity_id = NULL,
      lease_deadline_monotonic_ns = NULL, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND provider = ?
        AND root_session_id = ? AND scope_fingerprint = ? AND attribution_fingerprint = ?
        AND status = 'preflight_passed' AND active_preflight_id = ? AND active_run_id IS NULL AND token = ?
        AND owner_process_identity_id = ? AND lease_deadline_monotonic_ns = ?
        AND CAST(lease_deadline_monotonic_ns AS INTEGER) > CAST(? AS INTEGER)`).run(
      key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
      expected.activePreflightId, expected.token, expected.proof.processIdentityId,
      monotonicText(expected.leaseDeadlineMonotonicNs), monotonicText(nowMonotonicNs),
    ).changes === 1;
  },

  /**
   * Records a service-verified death proof by matching the stored process triple
   * inside BEGIN IMMEDIATE; the repository never interprets `/proc` itself.
   */
  supersedeDeadOwner(key: UsageV3AuthorityKey, expected: UsageV3AuthorityTuple,
    death: UsageV3DeathProof): boolean {
    if (!v3FenceWritesEnabled() || !validProof(expected.proof) || !['preflighting', 'running'].includes(expected.status)
      || !Number.isSafeInteger(death.observedPid) || death.observedPid <= 0
      || !validFenceText(death.observedHostBootId, 128)
      || (death.observedProcStartTicks !== null && !validFenceText(death.observedProcStartTicks, 64))) return false;
    const matchingDeath = death.kind === 'host_rebooted'
      ? death.observedHostBootId !== expected.proof.hostBootId
      : death.observedHostBootId === expected.proof.hostBootId && death.observedPid === expected.proof.pid
        && (death.kind === 'process_missing' || death.observedProcStartTicks !== expected.proof.procStartTicks);
    if (!matchingDeath) return false;
    return getConnection().transaction(() => getConnection().prepare(`UPDATE usage_v3_preflight_authorities
      SET status = 'superseded', token = token + 1, owner_process_identity_id = NULL,
        lease_deadline_monotonic_ns = NULL, updated_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND provider = ?
        AND root_session_id = ? AND scope_fingerprint = ? AND attribution_fingerprint = ? AND status = ?
        AND active_preflight_id = ? AND active_run_id IS ? AND token = ? AND owner_process_identity_id = ?
        AND EXISTS (SELECT 1 FROM usage_v3_process_identities p WHERE p.process_identity_id = ?
          AND p.host_boot_id = ? AND p.pid = ? AND p.proc_start_ticks = ?)` ).run(
      key.ownerUserId, key.provider, key.rootSessionId, key.scopeFingerprint, key.attributionFingerprint,
      expected.status, expected.activePreflightId, expected.activeRunId, expected.token,
      expected.proof.processIdentityId, expected.proof.processIdentityId, expected.proof.hostBootId,
      expected.proof.pid, expected.proof.procStartTicks,
    ).changes === 1).immediate();
  },

  /** Deletes only expired, unreferenced terminal evidence in a bounded batch. */
  cleanupPreflightReceipts(wallNowMs: number, batchSize = 100): number {
    if (!v3FenceWritesEnabled() || !Number.isSafeInteger(wallNowMs) || wallNowMs < 0
      || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) return 0;
    const db = getConnection();
    return db.transaction(() => {
      const rows = db.prepare(`SELECT receipt_id FROM usage_v3_preflight_receipts r WHERE r.status IN
        ('passed', 'quarantined', 'failed', 'superseded') AND r.retain_until_ms <= ? AND NOT EXISTS
        (SELECT 1 FROM usage_v3_canonical_runs c WHERE c.preflight_receipt_id = r.receipt_id
          AND (c.status = 'running' OR c.retain_until_ms > ?)) ORDER BY r.retain_until_ms LIMIT ?`).all(wallNowMs, wallNowMs, batchSize) as Array<{ receipt_id: string }>;
      let deleted = 0;
      for (const row of rows) {
        db.prepare('DELETE FROM usage_v3_preflight_sources WHERE receipt_id = ?').run(row.receipt_id);
        deleted += db.prepare(`DELETE FROM usage_v3_preflight_receipts WHERE receipt_id = ?
          AND retain_until_ms <= ? AND NOT EXISTS (SELECT 1 FROM usage_v3_canonical_runs
            WHERE preflight_receipt_id = ? AND (status = 'running' OR retain_until_ms > ?))`).run(
          row.receipt_id, wallNowMs, row.receipt_id, wallNowMs).changes;
      }
      return deleted;
    }).immediate();
  },

  /**
   * Returns the ready run for a root/scope/attribution tuple. The optional fourth argument fences reads by the
   * expected metrics fingerprint; the three-argument form is retained only for legacy callers that lack it.
   */
  getReadyRun(rootSessionId: string, scopeFingerprint: string, attributionFingerprint: string,
    metricsFingerprint?: string): { runId: string } | null {
    const metricsPredicate = metricsFingerprint === undefined ? '' : ' AND metrics_fingerprint = ?';
    const statement = getConnection().prepare(`SELECT run_id AS runId FROM usage_statistics_runs
      WHERE root_session_id = ? AND scope_fingerprint = ? AND attribution_fingerprint = ? AND status = 'ready'
      AND parent_run_id IS NULL${metricsPredicate}`);
    const row = metricsFingerprint === undefined
      ? statement.get(rootSessionId, scopeFingerprint, attributionFingerprint)
      : statement.get(rootSessionId, scopeFingerprint, attributionFingerprint, metricsFingerprint);
    return row as { runId: string } | undefined ?? null;
  },

  /** Returns a ready run only when its stored metrics fingerprint exactly matches the expected value. */
  getReadyRunForMetrics(rootSessionId: string, scopeFingerprint: string, attributionFingerprint: string,
    metricsFingerprint: string): { runId: string } | null {
    if (!metricsFingerprint) return null;
    return usageStatisticsV3Db.getReadyRun(
      rootSessionId, scopeFingerprint, attributionFingerprint, metricsFingerprint,
    );
  },

  /** Lists immutable facts for a published run; this read performs no lease mutation or fallback. */
  listFacts(runId: string): UsageStatisticsV3Fact[] {
    return getConnection().prepare(`SELECT event_key AS eventKey, occurred_at AS occurredAt, model,
      input_tokens AS inputTokens, output_tokens AS outputTokens, cached_input_tokens AS cachedInputTokens,
      request_count AS requestCount, is_subagent AS isSubagent, evidence_json AS evidenceJson
      FROM usage_statistics_facts WHERE run_id = ? ORDER BY occurred_at, event_key`).all(runId).map((row) => {
      const value = row as {
        eventKey: string; occurredAt: string; model: string; inputTokens: number; outputTokens: number;
        cachedInputTokens: number; requestCount: number; isSubagent: number; evidenceJson: string;
      };
      return {
        eventKey: value.eventKey, occurredAt: value.occurredAt, model: value.model,
        inputTokens: value.inputTokens, outputTokens: value.outputTokens,
        cachedInputTokens: value.cachedInputTokens, requestCount: value.requestCount,
        isSubagent: value.isSubagent === 1,
        evidence: JSON.parse(value.evidenceJson) as UsageStatisticsV3Fact['evidence'],
      };
    });
  },

  /** Returns aggregate-only projection metadata for a ready run, without exposing stored source identities. */
  getReadyProjectionMeta(runId: string): UsageReadyProjectionMetaV3 | null {
    return getConnection().prepare(`SELECT
      (SELECT COUNT(*) FROM usage_source_snapshots_v3 s WHERE s.run_id = r.run_id) AS sourceCount,
      (SELECT COUNT(*) FROM usage_statistics_lineage l WHERE l.run_id = r.run_id) AS lineageCount,
      (SELECT COUNT(*) FROM (SELECT e.source_identity_hash, e.source_generation
        FROM usage_run_events_v3 e JOIN usage_statistics_facts f
          ON f.run_id = e.run_id AND f.event_key = e.event_key_hash
        WHERE e.run_id = r.run_id AND f.is_subagent = 1
        GROUP BY e.source_identity_hash, e.source_generation)) AS subagentRolloutCount,
      r.work_duration_ms AS workDurationMs
      FROM usage_statistics_runs r WHERE r.run_id = ? AND r.status = 'ready'`)
      .get(runId) as UsageReadyProjectionMetaV3 | undefined ?? null;
  },

  /** Claims root authority with a new monotonic token; returns false when the run id already exists. */
  claimRun(input: UsageStatisticsV3Run): boolean {
    assertInteger('generation', input.generation);
    assertInteger('leaseExpiresAtMs', input.leaseExpiresAtMs);
    const db = getConnection();
    return db.transaction(() => {
      if (db.prepare('SELECT 1 FROM usage_statistics_runs WHERE run_id = ?').get(input.runId)) return false;
      db.prepare(`INSERT INTO usage_root_authority_v3 (root_session_id, authority_token, active_run_id)
        VALUES (?, 1, ?) ON CONFLICT(root_session_id) DO UPDATE SET
          authority_token = authority_token + 1, active_run_id = excluded.active_run_id,
          updated_at = CURRENT_TIMESTAMP`).run(input.rootSessionId, input.runId);
      const authority = db.prepare('SELECT authority_token AS token FROM usage_root_authority_v3 WHERE root_session_id = ?')
        .get(input.rootSessionId) as { token: number };
      return db.prepare(`INSERT INTO usage_statistics_runs (
        run_id, session_id, root_session_id, provider, status, manifest_fingerprint,
        scope_fingerprint, attribution_fingerprint, metrics_fingerprint, pricing_version,
        generation, authority_token, parent_run_id, lease_owner, lease_expires_at_ms,
        fenced_by_generation, evidence_json
      ) VALUES (?, ?, ?, ?, 'building', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO NOTHING`).run(input.runId, input.sessionId, input.rootSessionId, input.provider,
        input.manifestFingerprint, input.scopeFingerprint, input.attributionFingerprint,
        input.metricsFingerprint, input.pricingVersion, input.generation, authority.token,
        input.parentRunId ?? null, input.leaseOwner, input.leaseExpiresAtMs, input.generation,
        evidenceJson(input.evidence)).changes === 1;
    }).immediate();
  },

  /**
   * Appends one fenced fact. Returns false when authority/lease/building state is lost or limits are reached;
   * an exact duplicate returns true, while a conflicting duplicate quarantines the run and returns false.
   */
  appendFact(runId: string, leaseOwner: string, generation: number, fact: UsageStatisticsV3Fact): boolean {
    assertInteger('generation', generation);
    assertInteger('inputTokens', fact.inputTokens); assertInteger('outputTokens', fact.outputTokens);
    assertInteger('cachedInputTokens', fact.cachedInputTokens); assertInteger('requestCount', fact.requestCount);
    if (!fact.eventKey || !fact.model || !Number.isFinite(Date.parse(fact.occurredAt))) throw new RangeError('Fact requires eventKey, model, and occurredAt');
    const canonicalEvidence = evidenceJson(fact.evidence);
    const sourceKey = typeof fact.evidence.sourceKey === 'string' ? fact.evidence.sourceKey : '';
    const sourceGeneration = typeof fact.evidence.generation === 'number' ? fact.evidence.generation : -1;
    const byteStart = typeof fact.evidence.byteStart === 'number' ? fact.evidence.byteStart : -1;
    if (!sourceKey) throw new RangeError('Fact evidence requires sourceKey');
    assertInteger('sourceGeneration', sourceGeneration);
    assertInteger('byteStart', byteStart);
    const sourceIdentityHash = sha256(sourceKey);
    const canonicalEventKey = `${sourceKey}+${sourceGeneration}+${byteStart}`;
    if (fact.eventKey !== canonicalEventKey) throw new RangeError('eventKey must equal sourceKey+generation+byteStart');
    const eventKeyHash = sha256(canonicalEventKey);
    const payload = JSON.stringify({
      eventKey: eventKeyHash, occurredAt: fact.occurredAt, model: fact.model,
      inputTokens: fact.inputTokens, outputTokens: fact.outputTokens,
      cachedInputTokens: fact.cachedInputTokens, requestCount: fact.requestCount,
      isSubagent: fact.isSubagent, evidence: canonicalEvidence,
    });
    const bytes = Buffer.byteLength(payload, 'utf8');
    const payloadHash = sha256(payload);
    const db = getConnection();
    return db.transaction(() => {
      const authorized = db.prepare(`SELECT 1 FROM usage_statistics_runs r
        JOIN usage_root_authority_v3 a ON a.root_session_id = r.root_session_id
          AND a.authority_token = r.authority_token AND a.active_run_id = r.run_id
        WHERE r.run_id = ? AND r.status = 'building' AND r.lease_owner = ?
          AND r.generation = ? AND r.fenced_by_generation = ? AND r.lease_expires_at_ms >= ?`)
        .get(runId, leaseOwner, generation, generation, Date.now());
      if (!authorized) return false;
      const existing = db.prepare(`SELECT occurred_at, model, input_tokens, output_tokens,
        cached_input_tokens, request_count, is_subagent, evidence_json FROM usage_statistics_facts
        WHERE run_id = ? AND event_key = ?`).get(runId, eventKeyHash) as Record<string, unknown> | undefined;
      const existingMembership = db.prepare(`SELECT source_identity_hash, source_generation, byte_start,
        fact_payload_sha256 FROM usage_run_events_v3 WHERE run_id = ? AND event_key_hash = ?`)
        .get(runId, eventKeyHash) as Record<string, unknown> | undefined;
      if (existing || existingMembership) {
        const matches = Boolean(existing && existingMembership)
          && existing?.occurred_at === fact.occurredAt && existing.model === fact.model
          && existing.input_tokens === fact.inputTokens && existing.output_tokens === fact.outputTokens
          && existing.cached_input_tokens === fact.cachedInputTokens && existing.request_count === fact.requestCount
          && existing.is_subagent === (fact.isSubagent ? 1 : 0) && existing.evidence_json === canonicalEvidence
          && existingMembership?.source_identity_hash === sourceIdentityHash
          && existingMembership.source_generation === sourceGeneration
          && existingMembership.byte_start === byteStart
          && existingMembership.fact_payload_sha256 === payloadHash;
        if (!matches) db.prepare(`UPDATE usage_statistics_runs SET status = 'quarantined',
          failure_code = 'duplicate_event_payload_mismatch', completed_at = CURRENT_TIMESTAMP
          WHERE run_id = ? AND status = 'building'`).run(runId);
        return matches;
      }
      const run = db.prepare(`UPDATE usage_statistics_runs SET fact_bytes = fact_bytes + ?, fact_count = fact_count + 1
        WHERE run_id = ? AND status = 'building' AND lease_owner = ? AND generation = ?
          AND fenced_by_generation = ? AND lease_expires_at_ms >= ?
          AND fact_bytes + source_bytes + ? <= ? AND fact_count < ${MAX_USAGE_V3_FACTS_PER_RUN}`).run(
        bytes, runId, leaseOwner, generation, generation, Date.now(), bytes, MAX_RUN_BYTES,
      );
      if (run.changes !== 1) return false;
      db.prepare(`INSERT INTO usage_statistics_facts (
        run_id, event_key, occurred_at, model, input_tokens, output_tokens, cached_input_tokens,
        request_count, is_subagent, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        runId, eventKeyHash, fact.occurredAt, fact.model, fact.inputTokens, fact.outputTokens,
        fact.cachedInputTokens, fact.requestCount, fact.isSubagent ? 1 : 0, canonicalEvidence,
      );
      db.prepare(`INSERT INTO usage_run_events_v3 (
        run_id, event_key_hash, source_identity_hash, source_generation, byte_start, fact_payload_sha256
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(runId, eventKeyHash, sourceIdentityHash, sourceGeneration, byteStart, payloadHash);
      return true;
    }).immediate();
  },

  /**
   * Stores one fenced source snapshot. Returns false after fence/lease loss or a run/source bound; an identity
   * collision with different evidence quarantines the run and returns false.
   */
  recordSourceSnapshot(runId: string, leaseOwner: string, generation: number, snapshot: UsageSourceSnapshotV3): boolean {
    assertInteger('generation', generation);
    assertInteger('sourceGeneration', snapshot.sourceGeneration);
    assertInteger('sizeBytes', snapshot.sizeBytes);
    assertInteger('factCount', snapshot.factCount);
    if (snapshot.factCount > MAX_USAGE_V3_FACTS_PER_SOURCE) return false;
    if (!snapshot.sourceKey || !SHA256_PATTERN.test(snapshot.contentSha256)
      || !SHA256_PATTERN.test(snapshot.terminalVectorSha256) || !snapshot.manifestFingerprint) {
      throw new RangeError('Source snapshot requires canonical identities and SHA-256 vectors');
    }
    const sourceIdentityHash = sha256(snapshot.sourceKey);
    const db = getConnection();
    return db.transaction(() => {
      const authorized = db.prepare(`SELECT 1 FROM usage_statistics_runs r
        JOIN usage_root_authority_v3 a ON a.root_session_id = r.root_session_id
          AND a.authority_token = r.authority_token AND a.active_run_id = r.run_id
        WHERE r.run_id = ? AND r.status = 'building' AND r.lease_owner = ?
          AND r.generation = ? AND r.fenced_by_generation = ? AND r.lease_expires_at_ms >= ?`)
        .get(runId, leaseOwner, generation, generation, Date.now());
      if (!authorized) return false;
      const existing = db.prepare(`SELECT content_sha256, size_bytes, fact_count, terminal_vector_sha256,
        manifest_fingerprint FROM usage_source_snapshots_v3
        WHERE run_id = ? AND source_identity_hash = ? AND source_generation = ?`)
        .get(runId, sourceIdentityHash, snapshot.sourceGeneration) as Record<string, unknown> | undefined;
      if (existing) {
        const matches = existing.content_sha256 === snapshot.contentSha256
          && existing.size_bytes === snapshot.sizeBytes && existing.fact_count === snapshot.factCount
          && existing.terminal_vector_sha256 === snapshot.terminalVectorSha256
          && existing.manifest_fingerprint === snapshot.manifestFingerprint;
        if (!matches) db.prepare(`UPDATE usage_statistics_runs SET status = 'quarantined',
          failure_code = 'source_snapshot_mismatch', completed_at = CURRENT_TIMESTAMP
          WHERE run_id = ? AND status = 'building'`).run(runId);
        return matches;
      }
      const updated = db.prepare(`UPDATE usage_statistics_runs
        SET source_bytes = source_bytes + ?, source_count = source_count + 1
        WHERE run_id = ? AND status = 'building' AND lease_owner = ? AND generation = ?
          AND fenced_by_generation = ? AND lease_expires_at_ms >= ?
          AND fact_bytes + source_bytes + ? <= ? AND source_count < ${MAX_USAGE_V3_SOURCES}`).run(
        snapshot.sizeBytes, runId, leaseOwner, generation, generation, Date.now(), snapshot.sizeBytes, MAX_RUN_BYTES,
      );
      if (updated.changes !== 1) return false;
      db.prepare(`INSERT INTO usage_source_snapshots_v3 (
        run_id, source_identity_hash, source_generation, content_sha256, size_bytes,
        fact_count, terminal_vector_sha256, manifest_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        runId, sourceIdentityHash, snapshot.sourceGeneration, snapshot.contentSha256, snapshot.sizeBytes,
        snapshot.factCount, snapshot.terminalVectorSha256, snapshot.manifestFingerprint,
      );
      return true;
    }).immediate();
  },

  /** Marks a fenced building run terminal; returns false when authority, lease, generation, or state no longer matches. */
  markRunTerminal(
    runId: string,
    leaseOwner: string,
    generation: number,
    status: UsageStatisticsTerminalRunStatus,
    failureCode: UsageStatisticsFailureCode,
  ): boolean {
    assertInteger('generation', generation);
    if (!TERMINAL_STATUSES.has(status)) throw new RangeError('Run terminal status is not allowlisted');
    if (!FAILURE_CODES.has(failureCode) || Buffer.byteLength(failureCode, 'utf8') > 128) {
      throw new RangeError('Run failure code is not allowlisted or exceeds 128 bytes');
    }
    return getConnection().prepare(`UPDATE usage_statistics_runs
      SET status = ?, failure_code = ?, completed_at = CURRENT_TIMESTAMP
      WHERE run_id = ? AND status = 'building' AND lease_owner = ? AND generation = ?
        AND fenced_by_generation = ? AND lease_expires_at_ms >= ?
        AND EXISTS (SELECT 1 FROM usage_root_authority_v3 a
          WHERE a.root_session_id = usage_statistics_runs.root_session_id
            AND a.authority_token = usage_statistics_runs.authority_token
            AND a.active_run_id = usage_statistics_runs.run_id)`).run(
      status, failureCode, runId, leaseOwner, generation, generation, Date.now(),
    ).changes === 1;
  },

  /** Sets measured work duration on a fenced building run; returns false after authority/lease/state loss. */
  setRunWorkDuration(runId: string, leaseOwner: string, generation: number, workDurationMs: number): boolean {
    assertInteger('generation', generation);
    assertInteger('workDurationMs', workDurationMs);
    return getConnection().prepare(`UPDATE usage_statistics_runs SET work_duration_ms = ?
      WHERE run_id = ? AND status = 'building' AND lease_owner = ? AND generation = ?
        AND fenced_by_generation = ? AND lease_expires_at_ms >= ?
        AND EXISTS (SELECT 1 FROM usage_root_authority_v3 a
          WHERE a.root_session_id = usage_statistics_runs.root_session_id
            AND a.authority_token = usage_statistics_runs.authority_token
            AND a.active_run_id = usage_statistics_runs.run_id)`).run(
      workDurationMs, runId, leaseOwner, generation, generation, Date.now(),
    ).changes === 1;
  },

  /** Stores one fenced lineage edge; returns false after authority/lease loss and true for an exact duplicate. */
  appendLineage(runId: string, leaseOwner: string, generation: number, lineage: UsageStatisticsV3Lineage): boolean {
    assertInteger('generation', generation);
    assertInteger('childGeneration', lineage.childGeneration);
    if (!lineage.sourceKey) throw new RangeError('Lineage requires sourceKey');
    const db = getConnection();
    return db.transaction(() => {
      const authorized = db.prepare(`SELECT 1 FROM usage_statistics_runs r
        JOIN usage_root_authority_v3 a ON a.root_session_id = r.root_session_id
          AND a.authority_token = r.authority_token AND a.active_run_id = r.run_id
        WHERE r.run_id = ? AND r.status = 'building' AND r.lease_owner = ?
          AND r.generation = ? AND r.fenced_by_generation = ? AND r.lease_expires_at_ms >= ?`)
        .get(runId, leaseOwner, generation, generation, Date.now());
      if (!authorized) return false;
      const inserted = db.prepare(`INSERT INTO usage_statistics_lineage (
        run_id, root_session_id, parent_thread_id, spawn_call_id, agent_thread_id, child_generation, source_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(
        runId, lineage.rootSessionId, lineage.parentThreadId, lineage.spawnCallId,
        lineage.agentThreadId, lineage.childGeneration, sha256(lineage.sourceKey),
      );
      if (inserted.changes !== 1) return true;
      const updated = db.prepare(`UPDATE usage_statistics_runs SET lineage_count = lineage_count + 1
        WHERE run_id = ? AND status = 'building' AND lease_owner = ? AND generation = ?
          AND fenced_by_generation = ? AND lease_expires_at_ms >= ? AND lineage_count < 4096`)
        .run(runId, leaseOwner, generation, generation, Date.now());
      if (updated.changes !== 1) throw new Error('USAGE_V3_LINEAGE_BOUND_OR_FENCE');
      return true;
    }).immediate();
  },

  /**
   * Revalidates all stored coverage under the highest fence and atomically publishes ready. Returns false when
   * the initial fence/lease check fails; validation or a fence lost during publish throws and rolls back.
   */
  finalizeReady(runId: string, leaseOwner: string, generation: number): boolean {
    assertInteger('generation', generation);
    const db = getConnection();
    return db.transaction(() => {
      const run = db.prepare(`SELECT r.root_session_id, r.scope_fingerprint, r.attribution_fingerprint,
        r.manifest_fingerprint, r.fact_count, r.source_count, r.lineage_count,
        r.work_duration_ms, r.evidence_json
        FROM usage_statistics_runs r JOIN usage_root_authority_v3 a
          ON a.root_session_id = r.root_session_id AND a.authority_token = r.authority_token
          AND a.active_run_id = r.run_id
        WHERE r.run_id = ? AND r.status = 'building' AND r.lease_owner = ?
          AND r.generation = ? AND r.fenced_by_generation = ? AND r.lease_expires_at_ms >= ?`).get(
        runId, leaseOwner, generation, generation, Date.now()) as {
          root_session_id: string; scope_fingerprint: string; attribution_fingerprint: string;
          manifest_fingerprint: string; fact_count: number; source_count: number; lineage_count: number;
          work_duration_ms: number | null; evidence_json: string;
        } | undefined;
      if (!run) return false;
      const runEvidence = JSON.parse(run.evidence_json) as Record<string, unknown>;
      const durationValid = run.work_duration_ms === null
        || (Number.isSafeInteger(run.work_duration_ms) && run.work_duration_ms >= 0);
      if (!durationValid || (runEvidence.workDurationRequired === true && run.work_duration_ms === null)) {
        throw new Error('USAGE_V3_WORK_DURATION_INVALID');
      }
      const coverage = db.prepare(`SELECT
        (SELECT COUNT(*) FROM usage_statistics_facts WHERE run_id = ?) AS facts,
        (SELECT COUNT(*) FROM usage_run_events_v3 WHERE run_id = ?) AS events,
        (SELECT COUNT(*) FROM usage_source_snapshots_v3 WHERE run_id = ?) AS sources,
        (SELECT COALESCE(SUM(fact_count), 0) FROM usage_source_snapshots_v3 WHERE run_id = ?) AS coveredFacts,
        (SELECT COUNT(*) FROM usage_statistics_lineage WHERE run_id = ?) AS lineage,
        (SELECT COUNT(*) FROM usage_source_snapshots_v3 WHERE run_id = ? AND manifest_fingerprint <> ?) AS badManifest,
        (SELECT COUNT(*) FROM usage_run_events_v3 e LEFT JOIN usage_statistics_facts f
          ON f.run_id = e.run_id AND f.event_key = e.event_key_hash
          LEFT JOIN usage_source_snapshots_v3 s ON s.run_id = e.run_id
            AND s.source_identity_hash = e.source_identity_hash AND s.source_generation = e.source_generation
          WHERE e.run_id = ? AND (f.event_key IS NULL OR s.source_identity_hash IS NULL
            OR e.byte_start >= s.size_bytes)) AS badEvents,
        (SELECT COUNT(*) FROM usage_statistics_facts f LEFT JOIN usage_run_events_v3 e
          ON e.run_id = f.run_id AND e.event_key_hash = f.event_key
          WHERE f.run_id = ? AND e.event_key_hash IS NULL) AS orphanFacts,
        (SELECT COUNT(*) FROM usage_statistics_lineage l LEFT JOIN usage_source_snapshots_v3 s
          ON s.run_id = l.run_id AND s.source_identity_hash = l.source_key
            AND s.source_generation = l.child_generation
          WHERE l.run_id = ? AND s.source_identity_hash IS NULL) AS badLineage`).get(
        runId, runId, runId, runId, runId, runId, run.manifest_fingerprint, runId, runId, runId,
      ) as Record<string, number>;
      const valid = coverage.facts === run.fact_count && coverage.events === run.fact_count
        && coverage.sources === run.source_count && coverage.coveredFacts === run.fact_count
        && coverage.lineage === run.lineage_count && coverage.badManifest === 0
        && coverage.badEvents === 0 && coverage.orphanFacts === 0 && coverage.badLineage === 0;
      if (!valid) throw new Error('USAGE_V3_FINALIZE_VALIDATION_FAILED');
      db.prepare(`UPDATE usage_statistics_runs SET status = 'superseded', completed_at = CURRENT_TIMESTAMP
        WHERE root_session_id = ? AND status = 'ready' AND run_id <> ?`).run(run.root_session_id, runId);
      const published = db.prepare(`UPDATE usage_statistics_runs SET status = 'ready', completed_at = CURRENT_TIMESTAMP
        WHERE run_id = ? AND status = 'building' AND lease_owner = ? AND generation = ?
          AND fenced_by_generation = ? AND lease_expires_at_ms >= ?
          AND authority_token = (SELECT authority_token FROM usage_root_authority_v3
            WHERE root_session_id = usage_statistics_runs.root_session_id
              AND active_run_id = usage_statistics_runs.run_id)`).run(
        runId, leaseOwner, generation, generation, Date.now());
      if (published.changes !== 1) throw new Error('USAGE_V3_PUBLISH_FENCE_LOST');
      return true;
    }).immediate();
  },
};
