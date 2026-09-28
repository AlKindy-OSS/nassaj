/**
 * In-memory harness job store shared by the update, restore-compatible,
 * rollback and recovery flows (T-1749 item 10, T-1871 stage 3). Jobs are the
 * poll surface of `GET /update-jobs/:jobId`; the durable record of a snapshot
 * job is its manifest, never this map.
 *
 * Log lines are sanitized (tokens, query secrets and absolute paths redacted)
 * and capped, so no path or member id reaches the client.
 */

import type {
  HarnessUpdateJob,
  HarnessUpdateJobPhase,
  HarnessUpdateJobStatus,
} from '../../../../shared/harness-update.contract.js';

/** Max stored log lines (append-only, oldest dropped). */
const MAX_LOG_LINES = 500;
/** Max characters kept per log line. */
const MAX_LOG_LINE_LEN = 2_000;
/** Finished jobs expire, and the map is capped. */
const JOB_RETENTION_MS = 60 * 60 * 1000;
const MAX_JOBS = 50;

export type UpdateTrigger = 'manual' | 'scheduler' | 'recovery';

/** Audit sink of every harness job (action names are AuditAction values). */
export type HarnessAuditFn = (
  action: HarnessAuditAction,
  metadata: Record<string, unknown>,
  userId: number | null,
) => void;

export type HarnessAuditAction =
  | 'harness_update_started'
  | 'harness_update_succeeded'
  | 'harness_update_failed'
  | 'harness_update_noop'
  | 'harness_update_rolled_back'
  | 'harness_update_rollback_failed'
  | 'harness_snapshot_pruned'
  | 'harness_snapshot_aside_pruned'
  | 'harness_recovery_acknowledged'
  | 'harness_reconcile_resolved';

/** Output of one bounded child run. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** False only when a timed-out POSIX process group could not be proven dead. */
  quiesced?: boolean;
}

export interface InternalJob extends HarnessUpdateJob {
  userId: number | null;
  trigger: UpdateTrigger;
  finished: boolean;
  /** Epoch ms the job reached a terminal state (null while running). */
  finishedAt: number | null;
  /** git-shallow only: the pre-update `git rev-parse HEAD`, for rollback. */
  gitRev: string | null;
  /** Keep the lease held after an unverifiable rollback. */
  retainLease: boolean;
  /** Promise that settles when the job leaves a running state (for tests). */
  done: Promise<void>;
}

const jobs = new Map<string, InternalJob>();

/** Test hook: clear the job store. */
export function _resetHarnessJobs(): void {
  jobs.clear();
}

/** Test hook: resolves when the given job's async run has settled. */
export function _awaitHarnessJob(jobId: string): Promise<void> {
  return jobs.get(jobId)?.done ?? Promise.resolve();
}

/** Public (wire) view of a job. */
export function toPublic(job: InternalJob): HarnessUpdateJob {
  return {
    jobId: job.jobId,
    provider: job.provider,
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    log: [...job.log],
    fromVersion: job.fromVersion,
    toVersion: job.toVersion,
    error: job.error ? { ...job.error } : null,
  };
}

/** Returns the public view of a job, or null when unknown. */
export function getHarnessUpdateJob(jobId: string): HarnessUpdateJob | null {
  const job = jobs.get(jobId);
  return job ? toPublic(job) : null;
}

/** Applies `patch` to a job. */
export function setJob(job: InternalJob, patch: Partial<InternalJob>): void {
  Object.assign(job, patch);
}

/** Appends one sanitized, length-capped log line. */
export function appendLog(job: InternalJob, line: string): void {
  const trimmed = String(line)
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\b/giu, '[redacted]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/(^|\s)(?:\/[\w.@~+-]+)+(?:\/[\w.@~+:-]+)*/gu, '$1[path]')
    .replace(/(^|\s)[A-Za-z]:[\\/][^\s]*/gu, '$1[path]')
    .slice(0, MAX_LOG_LINE_LEN);
  job.log.push(trimmed);
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
}

/** Appends every non-empty stdout/stderr line of a child run. */
export function appendOutput(job: InternalJob, result: RunResult): void {
  for (const stream of [result.stdout, result.stderr]) {
    for (const raw of stream.split('\n')) {
      const line = raw.trimEnd();
      if (line !== '') appendLog(job, line);
    }
  }
}

/** Builds a job record (not yet stored). */
export function makeJob(
  jobId: string,
  provider: string,
  userId: number | null,
  trigger: UpdateTrigger,
  status: HarnessUpdateJobStatus,
  phase: HarnessUpdateJobPhase,
  percent: number,
): InternalJob {
  return {
    jobId, provider, status, phase, percent,
    log: [], fromVersion: null, toVersion: null, error: null,
    userId, trigger, finished: false, finishedAt: null, gitRev: null, retainLease: false,
    done: Promise.resolve(),
  };
}

/** Stores a running job. */
export function storeJob(job: InternalJob, nowMs: number): void {
  jobs.set(job.jobId, job);
  pruneJobs(nowMs);
}

/** Stores an already-terminal job (pin refusal / live-session skip). */
export function finishNow(job: InternalJob, now: () => number): void {
  job.finished = true;
  job.finishedAt = now();
  job.done = Promise.resolve();
  storeJob(job, now());
}

/**
 * Bounds the job store: finished jobs older than JOB_RETENTION_MS are dropped,
 * then the map is capped at MAX_JOBS by dropping the OLDEST finished entries
 * (a running job is never evicted, so an active poll can always find it).
 */
function pruneJobs(nowMs: number): void {
  for (const [id, job] of jobs) {
    if (job.finished && job.finishedAt !== null && nowMs - job.finishedAt > JOB_RETENTION_MS) {
      jobs.delete(id);
    }
  }
  if (jobs.size <= MAX_JOBS) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.finished) jobs.delete(id);
  }
}

/** Arabic renderings of the machine failure codes (UI is ar-first). */
const FAILURE_MESSAGES_AR: Readonly<Record<string, string>> = Object.freeze({
  update_failed: 'فشل تنفيذ أمر التحديث.',
  update_timeout: 'تجاوز التحديث المهلة المحدّدة فأُوقف.',
  verify_failed: 'تعذّر التحقّق بعد التحديث: لا إصدار مقروء.',
  no_update_argv: 'لا أمر تحديث معرَّفاً لهذه الواجهة.',
  update_exception: 'خطأ غير متوقّع أثناء التحديث.',
  installation_unrecognized: 'تعذّر التحقق من طريقة تثبيت أداة التشغيل.',
  dirty_installation: 'يحوي تثبيت Git تعديلات محلية، لذلك رُفض التحديث.',
  update_unverified: 'انتهى أمر التحديث دون إثبات انتقال إلى إصدار أحدث.',
  recovery_intent_failed: 'تعذّر تثبيت حاجز الاسترجاع قبل بدء التحديث.',
  recovery_failed: 'تعذّر استرجاع هوية أداة التشغيل السابقة؛ أُوقفت التشغيلات حتى الإصلاح.',
  rollback_failed: 'تعذّر التحقق من الاسترجاع؛ أُوقفت تشغيلات هذه الأداة وحدها حتى يعالجها المالك.',
  rolled_back: 'فشل التحديث وأُعيدت النسخة السابقة وتُحقِّق منها.',
  PREFLIGHT_CHANGED: 'تغيّر التثبيت بين الفحص والتحديث، فأُلغي التحديث دون تغيير.',
  SNAPSHOT_TAMPERED: 'النسخة الاحتياطية لا تطابق بصمتها، فلم يُمسّ التثبيت.',
  STORE_IN_USE: 'مخزن بيانات مفتوح لدى عملية أخرى، فأُلغي التحديث.',
  STORE_ACCESS_UNPROVABLE: 'تعذّر إثبات أن مخازن البيانات غير مستخدمة، فأُلغي التحديث.',
  SNAPSHOT_LAYOUT_MISMATCH: 'بنية التثبيت لا تطابق المتوقَّع، فرُفض التحديث.',
});

/** Marks `job` failed with `code` and writes the failure audit row. */
export function failJob(
  job: InternalJob,
  code: string,
  message: string,
  audit: HarnessAuditFn,
  exitCode: number | null = null,
): void {
  setJob(job, {
    status: 'failed',
    phase: 'done',
    percent: 100,
    error: { code, message, messageAr: FAILURE_MESSAGES_AR[code] ?? 'فشل تحديث الواجهة.' },
    finished: true,
    finishedAt: Date.now(),
  });
  audit('harness_update_failed', {
    provider: job.provider,
    fromVersion: job.fromVersion,
    toVersion: job.toVersion,
    exitCode,
    trigger: job.trigger,
    code,
  }, job.userId);
}

/** Marks `job` terminal with a non-failure status (noop, rolled_back, …). */
export function finishJob(
  job: InternalJob,
  status: HarnessUpdateJobStatus,
  error: { code: string; message: string } | null = null,
): void {
  setJob(job, {
    status,
    phase: 'done',
    percent: 100,
    error: error ? { ...error, messageAr: FAILURE_MESSAGES_AR[error.code] ?? 'فشل تحديث الواجهة.' } : null,
    finished: true,
    finishedAt: Date.now(),
  });
}
