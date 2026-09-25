import path from 'node:path';

import { conversationUsageSnapshotsDb, participantsDb, sessionsDb, usageIngestionDb } from '@/modules/database/index.js';
import {
  readCodexRolloutMetadata,
  resolveCodexLinkedRollouts,
} from '@/modules/providers/list/codex/codex-rollout-links.js';
import type { LLMProvider } from '@/shared/types.js';

import { isDeferrableGateDenial, withLocalUpdateWriterLease } from '../../../../services/update-writer-lease.js';

import {
  ingestConversationUsage,
  usageIngestWriterMode,
  type ConversationIngestOutcome,
  type IngestContext,
} from './usage-ingestion.service.js';
import { runUsageV3CleanupMaintenance } from './usage-statistics-v3.service.js';

const BACKFILL_PARSER_VERSION = 1;
const DEFAULT_CONCURRENCY = 2;
const MAX_RETRIES = 3;
/**
 * Bounds for waiting out a TRANSIENT update-gate refusal.
 *
 * Chosen so an ordinary maintenance window is ridden out without noise, while a
 * stuck lock holder can never hold an ingestion slot indefinitely:
 * 1s, 2s, 4s, 8s, 16s, 30s, 30s … capped at 30s over 10 attempts ≈ 3 minutes,
 * well past a normal `transition()` and far short of "forever".
 */
const GATE_WAIT_BASE_DELAY_MS = 1_000;
const GATE_WAIT_MAX_DELAY_MS = 30_000;
const GATE_WAIT_MAX_ATTEMPTS = 10;

export type UsageIngestionScheduleRequest = {
  provider: LLMProvider;
  filePath: string;
  sessionId?: string | null;
};

type SchedulerDeps = {
  concurrency?: number;
  retryDelayMs?: number;
  /** Bounds for waiting out a transient update-gate refusal (see the constants). */
  gateBaseDelayMs?: number;
  gateMaxDelayMs?: number;
  gateMaxWaits?: number;
  /** Injected so a test can prove the backoff schedule without real waiting. */
  sleep?: (ms: number) => Promise<void>;
  writerMode?: () => 'off' | 'shadow' | 'on';
  resolveContext?: (request: UsageIngestionScheduleRequest) => Promise<IngestContext | null>;
  ingest?: (context: IngestContext) => Promise<ConversationIngestOutcome>;
  recordFailure?: (sessionId: string | null, key: string, error: unknown) => void;
  maintenance?: () => void;
};

type PendingJob = {
  key: string;
  request: UsageIngestionScheduleRequest;
  context?: IngestContext;
  dirty: boolean;
  promise: Promise<ConversationIngestOutcome>;
  resolve: (outcome: ConversationIngestOutcome) => void;
  reject: (error: unknown) => void;
  eventsWritten: number;
};

const measurable = (provider: string): provider is 'claude' | 'codex' =>
  provider === 'claude' || provider === 'codex';

async function resolveDefaultContext(request: UsageIngestionScheduleRequest): Promise<IngestContext | null> {
  if (!measurable(request.provider)) return null;
  const absolute = path.resolve(request.filePath);
  const rows = sessionsDb.getAllSessions().filter((row) => measurable(row.provider) && row.jsonl_path);
  let row = rows.find((candidate) => path.resolve(candidate.jsonl_path!) === absolute);
  if (!row && request.provider === 'claude') {
    row = rows.find((candidate) =>
      candidate.provider === 'claude' && absolute.startsWith(`${candidate.jsonl_path!.replace(/\.jsonl$/, '')}${path.sep}`));
  }
  if (!row && request.provider === 'codex') {
    try {
      const metadata = await readCodexRolloutMetadata(absolute);
      const rootId = metadata.sessionId ?? metadata.parentThreadId;
      if (rootId) row = rows.find((candidate) => candidate.provider === 'codex' && candidate.session_id === rootId);
    } catch {
      // A half-written child is retried by the next watcher change.
    }
  }
  if (!row && request.sessionId) row = rows.find((candidate) => candidate.session_id === request.sessionId);
  if (!row?.jsonl_path || !measurable(row.provider)) return null;
  const context: IngestContext = {
    sessionId: row.session_id,
    // The DB helper accepts only the sole owner+spawn row; null deliberately
    // reaches the v3 writer as absent context and fails closed without fallback.
    ownerUserId: participantsDb.resolveStrictSpawnOwnerUserId(row.session_id) ?? undefined,
    provider: row.provider,
    transcriptPath: row.jsonl_path,
    projectPath: row.project_path,
  };
  if (row.provider === 'codex') context.manifest = await resolveCodexLinkedRollouts(row.jsonl_path);
  return context;
}

export class UsageIngestionScheduler {
  private readonly concurrency: number;
  private readonly retryDelayMs: number;
  private readonly gateBaseDelayMs: number;
  private readonly gateMaxDelayMs: number;
  private readonly gateMaxWaits: number;
  private readonly sleep: NonNullable<SchedulerDeps['sleep']>;
  private readonly writerMode: NonNullable<SchedulerDeps['writerMode']>;
  private readonly resolveContext: NonNullable<SchedulerDeps['resolveContext']>;
  private readonly ingest: NonNullable<SchedulerDeps['ingest']>;
  private readonly recordFailure: NonNullable<SchedulerDeps['recordFailure']>;
  private readonly maintenance: NonNullable<SchedulerDeps['maintenance']>;
  private readonly jobs = new Map<string, PendingJob>();
  private readonly canonicalJobs = new Map<string, PendingJob>();
  private readonly queue: PendingJob[] = [];
  private active = 0;
  private pumpScheduled = false;
  private closed = false;

  constructor(deps: SchedulerDeps = {}) {
    this.concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
    this.retryDelayMs = Math.max(0, deps.retryDelayMs ?? 100);
    this.gateBaseDelayMs = Math.max(0, deps.gateBaseDelayMs ?? GATE_WAIT_BASE_DELAY_MS);
    this.gateMaxDelayMs = Math.max(this.gateBaseDelayMs, deps.gateMaxDelayMs ?? GATE_WAIT_MAX_DELAY_MS);
    // A budget of 0 is legal and means "never wait"; it must never be negative,
    // or the bound would silently become "wait for ever" again.
    this.gateMaxWaits = Math.max(0, deps.gateMaxWaits ?? GATE_WAIT_MAX_ATTEMPTS);
    this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
    this.writerMode = deps.writerMode ?? usageIngestWriterMode;
    this.resolveContext = deps.resolveContext ?? resolveDefaultContext;
    this.ingest = deps.ingest ?? ingestConversationUsage;
    this.maintenance = deps.maintenance ?? runUsageV3CleanupMaintenance;
    this.recordFailure = deps.recordFailure ?? ((sessionId, key, error) => {
      if (sessionId) conversationUsageSnapshotsDb.markSessionError(
        sessionId, 'background_ingestion_failed', error instanceof Error ? error.message : String(error),
      );
      console.error('[usage-ingestion-background-failed]', {
        sessionId, key, error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  schedule(request: UsageIngestionScheduleRequest): Promise<ConversationIngestOutcome | null> {
    if (this.closed || this.writerMode() === 'off' || !measurable(request.provider)) return Promise.resolve(null);
    try { this.maintenance(); } catch {
      // Cleanup is bounded maintenance, never a reason to drop ingestion.
      // The next scheduler activity retries after the service's lazy window.
    }
    const key = request.sessionId
      ? `${request.provider}:session:${request.sessionId}`
      : `${request.provider}:file:${path.resolve(request.filePath)}`;
    const existing = this.jobs.get(key);
    if (existing) {
      existing.dirty = true;
      existing.request = request;
      return existing.promise;
    }
    let resolve!: PendingJob['resolve'];
    let reject!: PendingJob['reject'];
    const promise = new Promise<ConversationIngestOutcome>((ok, fail) => { resolve = ok; reject = fail; });
    const job: PendingJob = { key, request, dirty: false, promise, resolve, reject, eventsWritten: 0 };
    this.jobs.set(key, job);
    this.queue.push(job);
    this.schedulePump();
    return promise;
  }

  close(): void {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      this.jobs.delete(job.key);
      job.reject(new Error('Usage ingestion scheduler closed'));
    }
  }

  private pump(): void {
    this.pumpScheduled = false;
    while (!this.closed && this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.schedulePump();
      });
    }
  }

  private schedulePump(): void {
    if (this.closed || this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => this.pump());
  }

  private async run(job: PendingJob): Promise<void> {
    let gateWaits = 0;
    while (!this.closed) {
      try { await withLocalUpdateWriterLease('usage-ingestion', () => this.runAdmitted(job)); return; }
      catch (error) {
        // Wait out only a TRANSIENT gate refusal. The private list this
        // replaced watched for `update_lock_timeout` (a code the gate never
        // raises) and not `update_lock_contended` (what a real concurrent
        // update raises), so the very case worth retrying rejected the job
        // instead. Non-transient refusals and every other failure still reject:
        // an unreachable control plane must surface, not loop for ever.
        if (isDeferrableGateDenial(error) && gateWaits < this.gateMaxWaits) {
          // BOUNDED, not indefinite. The loop this replaced slept a fixed
          // second and counted nothing, so a holder that never releases (a
          // SIGSTOPped process still owning the flock — a pattern actually used
          // on this fleet to save quota) spun it for ever. `this.active` stays
          // raised for the whole spin, so `concurrency` slots leak one by one
          // and ALL usage ingestion stops with nothing in the log saying why.
          // Backoff widens the gap so a long maintenance window is cheap, and
          // the budget guarantees the slot is always given back.
          const delay = Math.min(
            this.gateBaseDelayMs * 2 ** gateWaits,
            this.gateMaxDelayMs,
          );
          gateWaits += 1;
          await this.sleep(delay);
          continue;
        }
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        if (isDeferrableGateDenial(error)) {
          // Budget exhausted: the refusal is AUDIBLE exactly once, then the job
          // is rejected so the slot is released and the caller learns of it.
          // Silence here is what made the old spin undiagnosable.
          console.error('[usage-ingestion-gate-wait-exhausted]', {
            key: job.key,
            attempts: gateWaits,
            code: error instanceof Error ? error.message : String(error),
          });
          // Durable trace too: without it the snapshot stays `ready` and the
          // ledger under-reports with nothing but one console line to show for it.
          this.recordFailure(job.context?.sessionId ?? job.request.sessionId ?? null, job.key, error);
          job.reject(new Error(
            `Usage ingestion gave up waiting for the update gate after ${gateWaits} attempts`,
          ));
          return;
        }
        job.reject(error);
        return;
      }
    }
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    job.reject(new Error('Usage ingestion scheduler closed'));
  }

  private async runAdmitted(job: PendingJob): Promise<void> {
    let canonicalKey: string | null = null;
    let requeued = false;
    try {
      let outcome!: ConversationIngestOutcome;
      let needsContext = true;
      do {
        job.dirty = false;
        let lastError: unknown;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
          try {
            if (needsContext) {
              const refreshed = await this.resolveContext(job.request);
              if (!refreshed) throw new Error(`Usage ingestion context disappeared for ${job.key}`);
              job.context = refreshed;
              needsContext = false;
              canonicalKey = `${refreshed.provider}:${path.resolve(refreshed.transcriptPath)}`;
              const canonical = this.canonicalJobs.get(canonicalKey);
              if (canonical && canonical !== job) {
                canonical.dirty = true;
                outcome = await canonical.promise;
                job.resolve(outcome);
                return;
              }
              this.canonicalJobs.set(canonicalKey, job);
            }
            outcome = await this.ingest(job.context!);
            job.eventsWritten += outcome.eventsWritten;
            outcome = { ...outcome, eventsWritten: job.eventsWritten };
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
            if (attempt + 1 < MAX_RETRIES) {
              await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
            }
          }
        }
        if (lastError) throw lastError;
        // No-progress commonly means the writer is in the middle of one JSONL
        // record. Only a real watcher event received while this pass was active
        // may dirty/re-run it; self-requeueing here would spin on the same bytes.
        if (job.dirty) needsContext = true;
      } while (job.dirty && !this.closed);
      if (!outcome.caughtUp && outcome.madeProgress && !this.closed) {
        // One bounded chunk made durable progress. Yield this job to the FIFO
        // tail so other sources get a turn, while keeping its singleflight.
        job.context = undefined;
        this.queue.push(job);
        requeued = true;
        return;
      }
      job.resolve(outcome);
    } catch (error) {
      try {
        this.recordFailure(job.context?.sessionId ?? job.request.sessionId ?? null, job.key, error);
      } catch (telemetryError) {
        console.error('[usage-ingestion-telemetry-failed]', {
          key: job.key,
          error: telemetryError instanceof Error ? telemetryError.message : String(telemetryError),
        });
      }
      job.reject(error);
    } finally {
      if (!requeued) {
        if (canonicalKey && this.canonicalJobs.get(canonicalKey) === job) this.canonicalJobs.delete(canonicalKey);
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      }
    }
  }
}

export const usageIngestionScheduler = new UsageIngestionScheduler();

export const usageIngestBackfillEnabled = (): boolean => process.env.USAGE_INGEST_BACKFILL === 'on';

let backfillFlight: Promise<void> | null = null;
let resumeRequestedDuringFlight = false;

export function startUsageIngestionBackfill(): Promise<void> {
  return launchBackfill(true);
}

/** Resume-only hook for watcher events; it can never create a new generation. */
export function resumeUsageIngestionBackfill(): Promise<void> {
  return launchBackfill(false);
}

function launchBackfill(createIfMissing: boolean): Promise<void> {
  if (!usageIngestBackfillEnabled() || usageIngestWriterMode() === 'off') return Promise.resolve();
  if (backfillFlight) {
    if (createIfMissing) return backfillFlight;
    resumeRequestedDuringFlight = true;
    const current = backfillFlight;
    return current.then(() => {
      if (!resumeRequestedDuringFlight) return;
      resumeRequestedDuringFlight = false;
      return launchBackfill(false);
    }, (error) => {
      resumeRequestedDuringFlight = false;
      throw error;
    });
  }
  if (!createIfMissing && !usageIngestionDb.getResumableBackfillGeneration(BACKFILL_PARSER_VERSION)) {
    return Promise.resolve();
  }
  backfillFlight = withLocalUpdateWriterLease('usage-backfill', () => runBackfill(createIfMissing))
    .finally(() => { backfillFlight = null; });
  return backfillFlight;
}

async function runBackfill(createIfMissing: boolean): Promise<void> {
  const boundary = sessionsDb.getAllSessions()
    .filter((row) => measurable(row.provider) && row.jsonl_path)
    .map((row) => ({
      key: `${row.provider}:${path.resolve(row.jsonl_path!)}`,
      provider: row.provider as LLMProvider,
      filePath: row.jsonl_path!,
      sessionId: row.session_id,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  let generation = usageIngestionDb.getResumableBackfillGeneration(BACKFILL_PARSER_VERSION);
  if (!generation) {
    if (!createIfMissing) return;
    const id = usageIngestionDb.createBackfillGeneration(BACKFILL_PARSER_VERSION, boundary.length);
    generation = usageIngestionDb.getResumableBackfillGeneration(BACKFILL_PARSER_VERSION)!;
    if (generation.generation !== id) throw new Error('Backfill generation identity mismatch');
  }
  if (generation.status === 'pending' && !usageIngestionDb.claimBackfillGeneration(generation.generation)) return;
  let processed = generation.sourcesProcessed;
  let eventsWritten = generation.eventsWritten;
  let cursorSourceKey = generation.cursorSourceKey;
  try {
    for (const source of boundary) {
      if (generation.cursorSourceKey && source.key <= generation.cursorSourceKey) continue;
      const outcome = await usageIngestionScheduler.schedule(source);
      if (!outcome?.caughtUp) {
        // Stable partial JSONL: do not spin, advance the durable cursor, or
        // claim completion. Persist newly merged facts while leaving the
        // running generation resumable at the exact same source boundary.
        eventsWritten += outcome?.eventsWritten ?? 0;
        const saved = usageIngestionDb.updateBackfillProgressCas({
          generation: generation.generation,
          expectedSourcesProcessed: processed,
          sourcesProcessed: processed,
          eventsWritten,
          cursorSourceKey,
        });
        if (!saved) throw new Error('Backfill partial progress CAS lost');
        return;
      }
      processed += 1;
      eventsWritten += outcome?.eventsWritten ?? 0;
      const advanced = usageIngestionDb.updateBackfillProgressCas({
        generation: generation.generation,
        expectedSourcesProcessed: processed - 1,
        sourcesProcessed: processed,
        eventsWritten,
        cursorSourceKey: source.key,
      });
      if (!advanced) throw new Error('Backfill progress CAS lost');
      cursorSourceKey = source.key;
    }
    usageIngestionDb.finishBackfillGeneration(generation.generation, 'complete');
  } catch (error) {
    usageIngestionDb.finishBackfillGeneration(
      generation.generation,
      'failed',
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}
