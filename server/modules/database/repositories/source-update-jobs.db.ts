/** Durable, owner-scoped source-update jobs with a singleton fencing lease. */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { getConnection } from '@/modules/database/connection.js';
import { registerPreparedRecoveryCandidate, type PreparedRecoveryRegistration } from '@/modules/database/repositories/source-update-recovery.db.js';

export const SOURCE_UPDATE_ACTIVE_STATES = [
  // `awaiting_sessions` (T-1730 W6) is active — it blocks a parallel job via the
  // one-active index — but is NOT a worker state: no lease, no fence, no gate.
  'awaiting_sessions',
  'accepted', 'resolving', 'resolved', 'downloading', 'archive_verified',
  'extracting', 'staging', 'candidate_sealed', 'restart_queued', 'activating',
  'runtime_verifying', 'rollback_pending',
] as const;
export type SourceUpdateState = typeof SOURCE_UPDATE_ACTIVE_STATES[number]
  | 'activated' | 'rolled_back' | 'failed' | 'superseded' | 'manual_recovery_required' | 'cancelled';
export type SourceUpdateStrategy = 'git-checkout-v2' | 'release-layout-v2';

type JobRow = Record<string, unknown> & { id: string; state: SourceUpdateState; worker_fence: number | null };
const ACTIVE_SQL = SOURCE_UPDATE_ACTIVE_STATES.map(() => '?').join(',');
// `cancelled` is terminal (T-1730 W6): an owner-cancelled deferral never restarts.
const TERMINAL = new Set<SourceUpdateState>(['activated', 'rolled_back', 'failed', 'superseded', 'manual_recovery_required', 'cancelled']);
const SHA256 = /^[a-f0-9]{64}$/;
const WORKER_STATES: SourceUpdateState[] = [
  'accepted','resolving','resolved','downloading','archive_verified','extracting','staging','candidate_sealed',
];
const WORKER_SQL = WORKER_STATES.map(() => '?').join(',');
// The states the updater can throw `active_sessions` from — every worker state
// BEFORE the candidate is sealed. Rearm is refused once sealed (ADR-156 §3.3,
// scenario S16): a sealed candidate goes to the command-board gate, not back to
// deferral.
const REARMABLE_STATES: SourceUpdateState[] = [
  'accepted','resolving','resolved','downloading','archive_verified','extracting','staging',
];
const REARMABLE_SQL = REARMABLE_STATES.map(() => '?').join(',');
const MAX_DEFERRAL_REARMS = 3;

function procIdentity(pid: number): { startTicks: string; pgid: number } | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    const pgid = Number(fields[2]);
    const startTicks = fields[19];
    return Number.isSafeInteger(pgid) && startTicks ? { pgid, startTicks } : null;
  } catch { return null; }
}

function currentBootId(): string | null {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { return null; }
}

function processGroupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (error) { return (error as { code?: string }).code === 'EPERM'; }
}

/** Exact Linux process identity; PID reuse and host reboot both fail closed. */
export function isSourceUpdateLeaseOwnerAlive(control: Record<string, unknown>): boolean {
  const pid = Number(control.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  let bootId: string;
  try { bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return false; }
  if (control.boot_id !== bootId) return false;
  const current = procIdentity(pid);
  if (!current || current.startTicks !== String(control.start_ticks)
    || current.pgid !== Number(control.pgid)) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === 'EPERM'; }
}

function mapJob(row: JobRow | undefined): JobRow | null {
  return row ? { ...row } : null;
}

/** Hash the secret idempotency key; raw keys never enter SQLite or logs. */
export function hashSourceUpdateIdempotencyKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Stable request identity used to reject reuse of a key with different input.
 * Activation consent is part of the request: a key reused with a different
 * answer must not silently inherit the first one (T-1751). It is omitted when
 * false so requests made before the flag existed keep their fingerprint.
 */
export function sourceUpdateRequestFingerprint(ownerId: number, expectedVersion: string, strategy: SourceUpdateStrategy, autoActivate = false, deferUntilIdle = false): string {
  // Each flag is part of the request: a key reused with a different answer must
  // not silently inherit the first one (T-1751, T-1730 M4). Both are omitted
  // when false so requests made before a flag existed keep their fingerprint.
  const request: { ownerId: number; expectedVersion: string; strategy: SourceUpdateStrategy; autoActivate?: true; deferUntilIdle?: true } =
    { ownerId, expectedVersion, strategy };
  if (autoActivate) request.autoActivate = true;
  if (deferUntilIdle) request.deferUntilIdle = true;
  return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export const sourceUpdateJobsDb = {
  /** Discover only this owner's active job; reading never renews activation consent. */
  getActiveForOwner(ownerId: number) {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) return null;
    return mapJob(getConnection().prepare(
      `SELECT * FROM source_update_jobs WHERE owner_id = ? AND state IN (${ACTIVE_SQL}) ORDER BY created_at, rowid LIMIT 1`,
    ).get(ownerId, ...SOURCE_UPDATE_ACTIVE_STATES) as JobRow | undefined);
  },
  /** Adopt an operator-verified local candidate without running the ordinary release worker. */
  registerPreparedRecoveryCandidate(input: PreparedRecoveryRegistration) {
    return registerPreparedRecoveryCandidate(getConnection(), input, SOURCE_UPDATE_ACTIVE_STATES);
  },
  createOrReuse(input: { id: string; ownerId: number; expectedVersion: string; idempotencyKeyHash: string; requestFingerprint: string; strategy: SourceUpdateStrategy; autoActivate?: boolean }) {
    const db = getConnection();
    return db.transaction(() => {
      const existing = db.prepare(
        'SELECT * FROM source_update_jobs WHERE owner_id = ? AND idempotency_key_hash = ?',
      ).get(input.ownerId, input.idempotencyKeyHash) as JobRow | undefined;
      if (existing) return { job: mapJob(existing), reused: true, mismatch: existing.request_fingerprint !== input.requestFingerprint };
      const active = db.prepare(
        `SELECT * FROM source_update_jobs WHERE state IN (${ACTIVE_SQL}) ORDER BY created_at, rowid LIMIT 1`,
      ).get(...SOURCE_UPDATE_ACTIVE_STATES) as JobRow | undefined;
      if (active) return { job: mapJob(active), reused: true, mismatch: active.request_fingerprint !== input.requestFingerprint, activeConflict: true };
      db.prepare(
        `INSERT INTO source_update_jobs
          (id, expected_version, owner_id, idempotency_key_hash, request_fingerprint, strategy, auto_activate)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.expectedVersion, input.ownerId, input.idempotencyKeyHash, input.requestFingerprint,
        input.strategy, input.autoActivate === true ? 1 : 0);
      return { job: this.getById(input.id), reused: false, mismatch: false };
    })();
  },

  /** Renew explicit owner consent for this sealed target atomically with its immutable receipt. */
  renewActivationConsent(jobId: string, ownerId: number, expectedVersion: string, targetDigest: string): boolean {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || !SHA256.test(targetDigest)) return false;
    const db = getConnection();
    return db.transaction(() => {
      const changed = db.prepare(`UPDATE source_update_jobs SET auto_activate = 1,
        progress_seq = progress_seq + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND owner_id = ? AND expected_version = ? AND activation_identity_sha256 = ?
          AND state = 'restart_queued' AND worker_fence IS NOT NULL`)
        .run(jobId, ownerId, expectedVersion, targetDigest).changes;
      if (changed !== 1) return false;
      const row = db.prepare('SELECT worker_fence FROM source_update_jobs WHERE id = ?').get(jobId) as { worker_fence: number };
      this.appendReceipt(jobId, row.worker_fence, 'restart_queued', 'recovery', {
        code: 'owner_activation_consent', ownerId, expectedVersion, targetDigest, confirmedAt: Date.now(),
      });
      return true;
    })();
  },

  /** Jobs whose owner consented to activation and whose restart is now queued (T-1751). */
  listAutoActivatable() {
    return (getConnection().prepare(
      "SELECT * FROM source_update_jobs WHERE state = 'restart_queued' AND auto_activate = 1 ORDER BY created_at, rowid",
    ).all() as JobRow[]).map((row) => ({ ...row }));
  },

  // ── T-1730 W6: declared session deferral (ADR-156 §3.3, M8) ──────────────
  // These transitions are UN-FENCED on purpose: a deferred job carries a NULL
  // worker_fence, so they gate on `state` alone (no `control`/fence predicate)
  // and never pass through transition(). They are the scheduler's and create
  // path's only writers of the deferral columns.

  /**
   * Insert a job that defers to session idle. `initialState` is
   * `awaiting_sessions` when live sessions exist, or `accepted` when idle now
   * (both carry defer_until_idle = 1 so a later worker `active_sessions` refusal
   * can rearm within the same absolute deadline). Mirrors createOrReuse's
   * idempotency and single-active-conflict checks.
   */
  createDeferred(input: { id: string; ownerId: number; expectedVersion: string; idempotencyKeyHash: string; requestFingerprint: string; strategy: SourceUpdateStrategy; autoActivate?: boolean; deferralDeadlineAt: number }, initialState: 'awaiting_sessions' | 'accepted') {
    const db = getConnection();
    return db.transaction(() => {
      const existing = db.prepare(
        'SELECT * FROM source_update_jobs WHERE owner_id = ? AND idempotency_key_hash = ?',
      ).get(input.ownerId, input.idempotencyKeyHash) as JobRow | undefined;
      if (existing) return { job: mapJob(existing), reused: true, mismatch: existing.request_fingerprint !== input.requestFingerprint };
      const active = db.prepare(
        `SELECT * FROM source_update_jobs WHERE state IN (${ACTIVE_SQL}) ORDER BY created_at, rowid LIMIT 1`,
      ).get(...SOURCE_UPDATE_ACTIVE_STATES) as JobRow | undefined;
      if (active) return { job: mapJob(active), reused: true, mismatch: active.request_fingerprint !== input.requestFingerprint, activeConflict: true };
      db.prepare(
        `INSERT INTO source_update_jobs
          (id, expected_version, owner_id, idempotency_key_hash, request_fingerprint, strategy,
           state, auto_activate, defer_until_idle, deferral_deadline_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).run(input.id, input.expectedVersion, input.ownerId, input.idempotencyKeyHash, input.requestFingerprint,
        input.strategy, initialState, input.autoActivate === true ? 1 : 0, input.deferralDeadlineAt);
      return { job: this.getById(input.id), reused: false, mismatch: false };
    })();
  },

  /** Every job parked on session idle (scheduler read). */
  listAwaitingSessions() {
    return (getConnection().prepare(
      "SELECT * FROM source_update_jobs WHERE state = 'awaiting_sessions' ORDER BY created_at, rowid",
    ).all() as JobRow[]).map((row) => ({ ...row }));
  },

  /** Deferred jobs whose candidate is now queued — the scheduler alerts the owner. */
  listRestartQueuedDeferred() {
    return (getConnection().prepare(
      "SELECT * FROM source_update_jobs WHERE state = 'restart_queued' AND defer_until_idle = 1 ORDER BY created_at, rowid",
    ).all() as JobRow[]).map((row) => ({ ...row }));
  },

  /** Stamp the first zero-session sample; the debounce measures from here. */
  recordIdleObservation(jobId: string, nowMs: number): boolean {
    return getConnection().prepare(
      `UPDATE source_update_jobs SET idle_observed_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'awaiting_sessions' AND idle_observed_at IS NULL`,
    ).run(nowMs, jobId).changes === 1;
  },

  /** A session reappeared before the second sample: reset the debounce. */
  clearIdleObservation(jobId: string): boolean {
    return getConnection().prepare(
      `UPDATE source_update_jobs SET idle_observed_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'awaiting_sessions' AND idle_observed_at IS NOT NULL`,
    ).run(jobId).changes === 1;
  },

  /** awaiting_sessions → accepted once both counters read zero twice. */
  promoteIdle(jobId: string): boolean {
    return getConnection().prepare(
      `UPDATE source_update_jobs SET state = 'accepted', idle_observed_at = NULL,
         progress_seq = progress_seq + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'awaiting_sessions'`,
    ).run(jobId).changes === 1;
  },

  /** awaiting_sessions → cancelled (owner only); any other state ⇒ no change. */
  cancelDeferred(jobId: string, ownerId?: number): boolean {
    const db = getConnection();
    const sql = `UPDATE source_update_jobs SET state = 'cancelled',
        progress_seq = progress_seq + 1, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'awaiting_sessions'${ownerId === undefined ? '' : ' AND owner_id = ?'}`;
    const params = ownerId === undefined ? [jobId] : [jobId, ownerId];
    return db.prepare(sql).run(...params).changes === 1;
  },

  /** Batch expiry once the absolute deadline passes (scheduler tick + boot). */
  expireDeferrals(nowMs: number): number {
    return getConnection().prepare(
      `UPDATE source_update_jobs SET state = 'failed', error_code = 'deferral_expired',
         error_message = 'The deferred update waited past its maximum window.',
         progress_seq = progress_seq + 1, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
        WHERE state = 'awaiting_sessions' AND deferral_deadline_at IS NOT NULL AND deferral_deadline_at <= ?`,
    ).run(nowMs).changes;
  },

  /** awaiting_sessions → failed with a named code (e.g. deferral_capability_lost). */
  failDeferred(jobId: string, errorCode: string, errorMessage: string): boolean {
    return getConnection().prepare(
      `UPDATE source_update_jobs SET state = 'failed', error_code = ?, error_message = ?,
         progress_seq = progress_seq + 1, updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND state = 'awaiting_sessions'`,
    ).run(errorCode, errorMessage, jobId).changes === 1;
  },

  /**
   * A pre-seal worker state → awaiting_sessions when the updater refuses on
   * `active_sessions`. Returns why: 'rearmed', 'exhausted' (hit the cap),
   * 'expired' (past the deadline), or 'noop' (already sealed/terminal or lost a
   * race). The worker fence is cleared because awaiting_sessions has none.
   */
  rearmDeferred(jobId: string, nowMs: number): 'rearmed' | 'exhausted' | 'expired' | 'noop' {
    const db = getConnection();
    return db.transaction(() => {
      const row = db.prepare('SELECT state, defer_until_idle, deferral_rearm_count, deferral_deadline_at FROM source_update_jobs WHERE id = ?')
        .get(jobId) as { state: SourceUpdateState; defer_until_idle: number; deferral_rearm_count: number; deferral_deadline_at: number | null } | undefined;
      if (!row || Number(row.defer_until_idle) !== 1 || !REARMABLE_STATES.includes(row.state)) return 'noop';
      if (row.deferral_deadline_at != null && nowMs >= Number(row.deferral_deadline_at)) return 'expired';
      if (Number(row.deferral_rearm_count) >= MAX_DEFERRAL_REARMS) return 'exhausted';
      const changed = db.prepare(
        `UPDATE source_update_jobs SET state = 'awaiting_sessions', worker_fence = NULL,
           idle_observed_at = NULL, deferral_rearm_count = deferral_rearm_count + 1,
           progress_seq = progress_seq + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND state IN (${REARMABLE_SQL}) AND defer_until_idle = 1
            AND deferral_rearm_count < ?`,
      ).run(jobId, ...REARMABLE_STATES, MAX_DEFERRAL_REARMS).changes;
      return changed === 1 ? 'rearmed' : 'noop';
    })();
  },

  getById(id: string) {
    return mapJob(getConnection().prepare('SELECT * FROM source_update_jobs WHERE id = ?').get(id) as JobRow | undefined);
  },

  getForOwner(id: string, ownerId: number) {
    return mapJob(getConnection().prepare(
      'SELECT * FROM source_update_jobs WHERE id = ? AND owner_id = ?',
    ).get(id, ownerId) as JobRow | undefined);
  },

  getByTransactionId(transactionId: string) {
    return mapJob(getConnection().prepare(
      'SELECT * FROM source_update_jobs WHERE transaction_id = ?',
    ).get(transactionId) as JobRow | undefined);
  },

  claim(worker: { workerId: string; pid: number; startTicks: string; bootId: string; pgid: number }, nowMs: number, leaseMs: number, ownerAlive = isSourceUpdateLeaseOwnerAlive) {
    const db = getConnection();
    return db.transaction(() => {
      const control = db.prepare('SELECT * FROM source_update_control WHERE singleton = 1').get() as Record<string, unknown>;
      const orphan = db.prepare("SELECT 1 FROM source_update_effects WHERE state = 'running' LIMIT 1").get();
      if (orphan) return null;
      if (control.worker_id && control.worker_id !== worker.workerId) {
        if (Number(control.lease_expires_at || 0) > nowMs || ownerAlive(control)) return null;
      }
      if (control.active_job_id) {
        const controlled = db.prepare('SELECT state FROM source_update_jobs WHERE id = ?').get(control.active_job_id) as { state: SourceUpdateState } | undefined;
        if (controlled && SOURCE_UPDATE_ACTIVE_STATES.includes(controlled.state as typeof SOURCE_UPDATE_ACTIVE_STATES[number])
          && !WORKER_STATES.includes(controlled.state)) return null;
      }
      let job = control.active_job_id
        ? db.prepare(`SELECT * FROM source_update_jobs WHERE id = ? AND state IN (${WORKER_SQL})`).get(control.active_job_id, ...WORKER_STATES) as JobRow | undefined
        : undefined;
      job ||= db.prepare(`SELECT * FROM source_update_jobs WHERE state IN (${WORKER_SQL}) ORDER BY created_at, rowid LIMIT 1`).get(...WORKER_STATES) as JobRow | undefined;
      if (!job) {
        db.prepare(`UPDATE source_update_control SET active_job_id = NULL, worker_id = NULL, pid = NULL,
          start_ticks = NULL, boot_id = NULL, pgid = NULL, lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE singleton = 1`).run();
        return null;
      }
      const fence = Number(control.fence_epoch) + 1;
      db.prepare(`UPDATE source_update_control SET fence_epoch = ?, active_job_id = ?, worker_id = ?,
        pid = ?, start_ticks = ?, boot_id = ?, pgid = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE singleton = 1`).run(fence, job.id, worker.workerId, worker.pid, worker.startTicks, worker.bootId, worker.pgid, nowMs + leaseMs);
      const changed = db.prepare(`UPDATE source_update_jobs SET worker_fence = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state IN (${WORKER_SQL})`).run(fence, job.id, ...WORKER_STATES).changes;
      return changed === 1 ? { ...job, worker_fence: fence } : null;
    })();
  },

  renew(jobId: string, workerId: string, fence: number, nowMs: number, leaseMs: number): boolean {
    return getConnection().prepare(`UPDATE source_update_control SET lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE singleton = 1 AND active_job_id = ? AND worker_id = ? AND fence_epoch = ?`).run(nowMs + leaseMs, jobId, workerId, fence).changes === 1;
  },

  assertFence(jobId: string, workerId: string, fence: number, nowMs: number): boolean {
    return Boolean(getConnection().prepare(`SELECT 1 FROM source_update_control c
      JOIN source_update_jobs j ON j.id = c.active_job_id
      WHERE c.singleton = 1 AND c.active_job_id = ? AND c.worker_id = ?
        AND c.fence_epoch = ? AND c.lease_expires_at > ? AND j.worker_fence = ?`).get(
      jobId, workerId, fence, nowMs, fence,
    ));
  },

  transition(jobId: string, fence: number, expected: SourceUpdateState[], next: SourceUpdateState, fields: Record<string, unknown> = {}): boolean {
    const allowed = new Set(['transaction_id','release_id','release_tag','release_asset_id','release_asset_name','release_asset_size','release_asset_sha256','archive_sha256','activation_identity_sha256','release_commit','source_tree_sha256','expected_server_build_id','expected_client_build_id','error_code','error_message']);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    const terminal = TERMINAL.has(next);
    const sql = `UPDATE source_update_jobs SET state = ?, progress_seq = progress_seq + 1,
      updated_at = CURRENT_TIMESTAMP${terminal ? ', completed_at = CURRENT_TIMESTAMP' : ''}
      ${entries.map(([key]) => `, ${key} = ?`).join('')}
      WHERE id = ? AND worker_fence = ? AND state IN (${expected.map(() => '?').join(',')})`;
    return getConnection().prepare(sql).run(next, ...entries.map(([, value]) => value), jobId, fence, ...expected).changes === 1;
  },

  appendReceipt(jobId: string, fence: number, phase: string, kind: 'intent'|'done'|'recovery'|'rollback', facts: Record<string, unknown> = {}) {
    const db = getConnection();
    return db.transaction(() => {
      const owned = db.prepare('SELECT 1 FROM source_update_jobs WHERE id = ? AND worker_fence = ?').get(jobId, fence);
      if (!owned) throw new Error('source_update_worker_fenced');
      const factsJson = JSON.stringify(facts);
      const factsSha256 = crypto.createHash('sha256').update(factsJson).digest('hex');
      if (!SHA256.test(factsSha256)) throw new Error('source_update_receipt_hash_invalid');
      const row = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM source_update_receipts WHERE job_id = ?').get(jobId) as { sequence: number };
      db.prepare(`INSERT INTO source_update_receipts(job_id, sequence, worker_fence, phase, kind, facts_json, facts_sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(jobId, row.sequence, fence, phase, kind, factsJson, factsSha256);
      return { sequence: row.sequence, factsSha256, factsJson };
    })();
  },

  listReceipts(jobId: string) {
    return getConnection().prepare(`SELECT job_id, sequence, worker_fence, phase, kind, facts_json, facts_sha256, created_at
      FROM source_update_receipts WHERE job_id = ? ORDER BY sequence`).all(jobId);
  },

  registerEffect(jobId: string, workerId: string, fence: number, effect: {
    effectId: string; kind: string; pid: number; startTicks: string; bootId: string; pgid: number;
  }): boolean {
    const db = getConnection();
    return db.transaction(() => {
      const owned = db.prepare(`SELECT 1 FROM source_update_control c JOIN source_update_jobs j ON j.id = c.active_job_id
        WHERE c.singleton = 1 AND c.active_job_id = ? AND c.worker_id = ? AND c.fence_epoch = ?
          AND j.worker_fence = ?`).get(jobId, workerId, fence, fence);
      if (!owned) return false;
      return db.prepare(`INSERT INTO source_update_effects
        (job_id, effect_id, worker_fence, effect_kind, pid, start_ticks, boot_id, pgid)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(jobId, effect.effectId, fence, effect.kind, effect.pid, effect.startTicks, effect.bootId, effect.pgid).changes === 1;
    })();
  },

  completeEffect(jobId: string, fence: number, effectId: string): boolean {
    const db = getConnection();
    const effect = db.prepare(`SELECT * FROM source_update_effects
      WHERE job_id = ? AND effect_id = ? AND worker_fence = ? AND state = 'running'`
    ).get(jobId, effectId, fence) as Record<string, unknown> | undefined;
    if (!effect) return false;
    const bootId = currentBootId();
    if (!bootId) return false;
    const pid = Number(effect.pid); const pgid = Number(effect.pgid);
    const observed = procIdentity(pid);
    const exact = effect.boot_id === bootId && observed
      && observed.startTicks === String(effect.start_ticks) && observed.pgid === pgid;
    if (exact || (!observed && effect.boot_id === bootId && processGroupAlive(pgid))) return false;
    return db.prepare(`UPDATE source_update_effects SET state = 'terminated', terminated_at = CURRENT_TIMESTAMP
      WHERE job_id = ? AND effect_id = ? AND worker_fence = ? AND state = 'running'`
    ).run(jobId, effectId, fence).changes === 1;
  },

  /** Kill or prove dead every detached effect before a new fence epoch exists. */
  reapOrphanEffects(): boolean {
    const db = getConnection();
    const control = db.prepare('SELECT * FROM source_update_control WHERE singleton = 1').get() as Record<string, unknown>;
    if (control?.worker_id && isSourceUpdateLeaseOwnerAlive(control)) return false;
    const effects = db.prepare("SELECT * FROM source_update_effects WHERE state = 'running' ORDER BY started_at").all() as Record<string, unknown>[];
    const bootId = currentBootId();
    for (const effect of effects) {
      const pid = Number(effect.pid); const pgid = Number(effect.pgid);
      const observed = procIdentity(pid);
      if (bootId === null) return false;
      const sameBoot = effect.boot_id === bootId;
      const exact = sameBoot && observed
        && observed.startTicks === String(effect.start_ticks) && observed.pgid === pgid;
      // A reboot proves the old process namespace is gone. A live PID with a
      // different start tick proves reuse and therefore that the old group had
      // already become empty before the id was reusable.
      if (!sameBoot || (observed && !exact)) {
        db.prepare("UPDATE source_update_effects SET state = 'terminated', terminated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND effect_id = ? AND state = 'running'")
          .run(effect.job_id, effect.effect_id);
        continue;
      }
      if (!observed && !processGroupAlive(pgid)) {
        db.prepare("UPDATE source_update_effects SET state = 'terminated', terminated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND effect_id = ? AND state = 'running'")
          .run(effect.job_id, effect.effect_id);
        continue;
      }
      // Either the exact leader or its leaderless descendant group survives.
      try { process.kill(-pgid, 'SIGKILL'); } catch (error) {
        if ((error as { code?: string }).code !== 'ESRCH') return false;
      }
      if (processGroupAlive(pgid)) return false;
      db.prepare("UPDATE source_update_effects SET state = 'terminated', terminated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND effect_id = ? AND state = 'running'")
        .run(effect.job_id, effect.effect_id);
    }
    return true;
  },

  appendActivationReceipt(identity: { jobId: string; transactionId: string; activationIdentitySha256: string }, phase: string, kind: 'intent'|'done'|'recovery'|'rollback', facts: Record<string, unknown> = {}) {
    const db = getConnection();
    return db.transaction(() => {
      const job = db.prepare(`SELECT worker_fence FROM source_update_jobs WHERE id = ? AND transaction_id = ?
        AND activation_identity_sha256 = ?`).get(identity.jobId, identity.transactionId, identity.activationIdentitySha256) as { worker_fence: number | null } | undefined;
      if (!job) throw new Error('source_update_activation_identity_mismatch');
      const factsJson = JSON.stringify(facts);
      const factsSha256 = crypto.createHash('sha256').update(factsJson).digest('hex');
      const row = db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM source_update_receipts WHERE job_id = ?').get(identity.jobId) as { sequence: number };
      db.prepare(`INSERT INTO source_update_receipts(job_id, sequence, worker_fence, phase, kind, facts_json, facts_sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(identity.jobId, row.sequence, job.worker_fence ?? 0, phase, kind, factsJson, factsSha256);
      return { sequence: row.sequence, workerFence: job.worker_fence ?? 0, factsSha256, factsJson };
    })();
  },

  listRuntimeVerifying() {
    return getConnection().prepare(`SELECT * FROM source_update_jobs WHERE state = 'runtime_verifying' ORDER BY created_at`).all();
  },

  /** Jobs stranded during activation; runtime_verifying requires positive recovery evidence (B-1147). */
  listStrandedActivations() {
    return getConnection().prepare(`SELECT * FROM source_update_jobs
      WHERE state IN ('activating', 'runtime_verifying', 'rollback_pending') ORDER BY created_at, rowid`).all() as JobRow[];
  },

  listRuntimeReferences() {
    return getConnection().prepare(`SELECT id AS jobId, state, transaction_id AS transactionId,
      activation_identity_sha256 AS activationIdentitySha256,
      release_commit AS releaseCommit, source_tree_sha256 AS sourceTreeSha256,
      release_id AS releaseId, release_asset_id AS assetId,
      release_asset_sha256 AS assetSha256, archive_sha256 AS archiveSha256,
      expected_server_build_id AS serverBuildId, expected_client_build_id AS clientBuildId
      FROM source_update_jobs
      WHERE state IN (${ACTIVE_SQL}) OR state = 'manual_recovery_required'`
    ).all(...SOURCE_UPDATE_ACTIVE_STATES);
  },

  /** Activation-side CAS, fenced by the immutable job/tx/action identity. */
  transitionActivation(identity: { jobId: string; transactionId: string; activationIdentitySha256: string }, expected: SourceUpdateState[], next: SourceUpdateState): boolean {
    const terminal = TERMINAL.has(next);
    const db = getConnection();
    return db.transaction(() => {
      const changed = db.prepare(`UPDATE source_update_jobs SET state = ?, progress_seq = progress_seq + 1,
        updated_at = CURRENT_TIMESTAMP${terminal ? ', completed_at = CURRENT_TIMESTAMP' : ''}
        WHERE id = ? AND transaction_id = ? AND activation_identity_sha256 = ?
          AND state IN (${expected.map(() => '?').join(',')})`).run(
        next, identity.jobId, identity.transactionId, identity.activationIdentitySha256, ...expected,
      ).changes === 1;
      if (changed && terminal) {
        db.prepare(`UPDATE source_update_control SET active_job_id = NULL, worker_id = NULL,
          pid = NULL, start_ticks = NULL, boot_id = NULL, pgid = NULL, lease_expires_at = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE singleton = 1 AND active_job_id = ?`).run(identity.jobId);
      }
      return changed;
    })();
  },

  release(jobId: string, workerId: string, fence: number): boolean {
    return getConnection().prepare(`UPDATE source_update_control SET
      active_job_id = CASE WHEN EXISTS (
        SELECT 1 FROM source_update_jobs WHERE id = ? AND state = 'restart_queued'
      ) THEN active_job_id ELSE NULL END, worker_id = NULL,
      pid = NULL, start_ticks = NULL, boot_id = NULL, pgid = NULL, lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE singleton = 1 AND active_job_id = ? AND worker_id = ? AND fence_epoch = ?`
    ).run(jobId, jobId, workerId, fence).changes === 1;
  },
};
