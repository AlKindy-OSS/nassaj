/**
 * B-1605: let the owner abandon an update job that is stuck where no button
 * reaches it (a `restart_queued` job whose safe-restart row is `executing`, a
 * sealed or staging job whose worker died). Abandoning is fail closed: it is
 * allowed only when nothing was launched for the attempt, the maintenance gate
 * is OPEN and the running runtime is provably still the pre-update one. Its
 * effects are database only — the job becomes `failed` with
 * `update_abandoned_by_owner`, its bound command-board rows are settled, the
 * worker lease is released and a human receipt plus an audit entry are
 * written, all in one transaction. Candidate directories are left for cleanup.
 *
 * B-1603: `readQueuedActionEvidence`, `readOpenMaintenanceGate`, `isBootstrapHandoffPending` and
 * `settleSourceUpdateJobRows` are shared with the boot reconciliation in
 * routes/system.js, which settles a queued job whose action is unusable.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const UPDATE_ABANDONED_BY_OWNER = 'update_abandoned_by_owner';
const ABANDONED_MESSAGE = 'The owner abandoned this update; nothing was activated. Start the update again.';
export const ABANDON_BLOCKED_REASONS = Object.freeze(['in_flight_restart', 'gate_closed', 'head_moved_unverified', 'terminal']);

const TERMINAL_STATES = new Set(['activated', 'rolled_back', 'failed', 'superseded', 'manual_recovery_required', 'cancelled']);
// Activation has begun (the gate was claimed and a restart may be under way).
const ACTIVATION_STATES = new Set(['activating', 'runtime_verifying', 'rollback_pending']);
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

const sha40 = (value) => (typeof value === 'string' && SHA40.test(value) ? value : null);

/**
 * What the job's own records prove about the commit it was prepared from:
 * the activation action when its bytes hash to the job's activation identity
 * (even when the strict reader rejects its shape), else a receipt fact naming
 * `originalHead` for the job's transaction. Null when nothing proves it.
 *
 * @returns {{ originalHead: string, previousRuntimeOid: string | null, source: 'action' | 'receipt' } | null}
 */
export function readQueuedActionEvidence(job, controlRoot, receipts = []) {
    return actionFileEvidence(job, controlRoot) || receiptEvidence(job, receipts);
}

function actionFileEvidence(job, controlRoot) {
    if (!controlRoot || !TX.test(job?.transaction_id || '') || !SHA256.test(job?.activation_identity_sha256 || '')) return null;
    try {
        const file = path.join(controlRoot, 'candidates', job.transaction_id, 'activation-action.json');
        const metadata = fs.lstatSync(file, { throwIfNoEntry: false });
        // Same file discipline as the strict readers: a regular 0600 file of this account.
        if (!metadata?.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600
            || metadata.size > 16 * 1024 || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) return null;
        const raw = fs.readFileSync(file, 'utf8');
        if (crypto.createHash('sha256').update(raw.trim()).digest('hex') !== job.activation_identity_sha256) return null;
        const action = JSON.parse(raw);
        const originalHead = sha40(action?.originalHead);
        if (!originalHead || action.transactionId !== job.transaction_id) return null;
        return { originalHead, previousRuntimeOid: sha40(action.previousRuntimeOid), source: 'action' };
    } catch { return null; }
}

function receiptEvidence(job, receipts) {
    for (const row of [...receipts].reverse()) {
        let facts = null;
        try { facts = JSON.parse(row?.facts_json ?? 'null'); } catch { facts = null; }
        const originalHead = sha40(facts?.originalHead);
        if (originalHead && facts.transactionId === job.transaction_id) {
            return { originalHead, previousRuntimeOid: sha40(facts.previousRuntimeOid), source: 'receipt' };
        }
    }
    return null;
}

/** Settle the open command-board rows bound to one job; nonce-guarded for an executing attempt. */
export function settleSourceUpdateJobRows(jobId, code, actions) {
    let settled = 0;
    for (const row of actions.listOpenForSourceUpdateJob(jobId)) {
        settled += row.status === 'executing'
            ? actions.failExecutingAttempt(row.id, row.executionAttemptNonce, code)
            : actions.supersedeQueued(row.id, code);
    }
    return settled;
}

/**
 * The gate journal when it is OPEN with nothing pending, else null. Read fail
 * closed: a throw, a closed gate, a degraded reopen, a pending OID intent or a
 * RESTARTING_HANDOFF phase all read as not open.
 */
export function readOpenMaintenanceGate(readGate) {
    let gate;
    try { gate = readGate(); } catch { return null; }
    const open = Boolean(gate) && gate.state === 'OPEN' && gate.gateClosed === false
        && gate.phase !== 'RESTARTING_HANDOFF' && !gate.degraded && !gate.oidAdmissionIntentPending;
    return open ? gate : null;
}

/**
 * Whether a bootstrap handoff may still be pending. complete() reopens the
 * journal (OPEN/ACTIVE_VERIFIED) without deleting bootstrap-handoff.json, and
 * bootstrap reads the file only while the journal is in RESTARTING_HANDOFF, so
 * a descriptor is an inert leftover exactly when: the journal is open (see
 * readOpenMaintenanceGate), the descriptor names the SAME transaction as that
 * open journal (the one that already finished), and it is not the transaction
 * of the job being judged. Any other descriptor — another transaction, no
 * transaction, unreadable or not a regular file — reads as pending.
 *
 * @param {string} controlRoot
 * @param {object | null} openGate the result of readOpenMaintenanceGate
 * @param {string | null} [jobTransactionId]
 */
export function isBootstrapHandoffPending(controlRoot, openGate, jobTransactionId = null) {
    const file = path.join(controlRoot, 'bootstrap-handoff.json');
    let metadata;
    try { metadata = fs.lstatSync(file, { throwIfNoEntry: false }); } catch { return true; }
    if (!metadata) return false;
    if (!openGate || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) return true;
    try {
        const transactionId = JSON.parse(fs.readFileSync(file, 'utf8'))?.transactionId;
        return typeof transactionId !== 'string' || !transactionId
            || transactionId !== openGate.transactionId || transactionId === jobTransactionId;
    } catch { return true; }
}

/** Whether the job's worker lease is still held by a live or unexpired worker. */
function workerLeaseHeld(job, control, isLeaseOwnerAlive, nowMs) {
    if (!control || control.active_job_id !== job.id || !control.worker_id) return false;
    return Number(control.lease_expires_at || 0) > nowMs || isLeaseOwnerAlive(control);
}

/**
 * The running runtime is the pre-update one: proven by the job's own evidence
 * (HEAD or the loaded runtime is at originalHead/previousRuntimeOid), or — when
 * no record names originalHead — by both HEAD and the loaded runtime being
 * readable and different from the job's target. Release-layout jobs have no Git
 * HEAD and rely on the loaded runtime alone.
 */
function runtimeIsPreUpdate(job, { head, runtime, evidence }) {
    const target = sha40(job.release_commit);
    if (target && (runtime === target || head === target)) return false;
    if (job.strategy === 'release-layout-v2') return Boolean(runtime);
    if (evidence) {
        return head === evidence.originalHead
            || (Boolean(runtime) && (runtime === evidence.originalHead || runtime === evidence.previousRuntimeOid));
    }
    return Boolean(head && runtime) && head !== target;
}

/**
 * Build the abandoner. Every probe is injected so routes and tests share it.
 *
 * @param {object} deps
 * @param {object} deps.jobs sourceUpdateJobsDb (getForOwner, listReceipts, readControl, hasRunningEffects, abandonByOwner)
 * @param {object} deps.actions pendingServerActionsDb (listOpenForSourceUpdateJob, failExecutingAttempt, supersedeQueued)
 * @param {{ record(action: string, details: object): void }} deps.audit
 * @param {(fn: () => any) => any} deps.transact runs fn in one database transaction
 * @param {() => object} deps.readGate maintenance-gate recovery evidence; a throw reads as closed
 * @param {() => string | null} deps.controlRoot the update control root (candidates/ and the handoff file)
 * @param {() => boolean} deps.isRestartInFlight this process launched a restart that has not ended
 * @param {() => boolean} deps.isSafeRestartRunning a safe-restart process of this account is alive
 * @param {(control: object) => boolean} deps.isLeaseOwnerAlive exact worker process identity probe
 * @param {() => string | null} deps.readHead the source HEAD commit
 * @param {() => string | null} deps.runtimeCommit the commit of the loaded server runtime
 * @param {() => number} [deps.now]
 */
export function createUpdateJobAbandoner({
    jobs, actions, audit, transact, readGate, controlRoot, isRestartInFlight, isSafeRestartRunning,
    isLeaseOwnerAlive, readHead, runtimeCommit, now = Date.now,
}) {
    const safely = (probe, fallback) => { try { return probe(); } catch { return fallback; } };
    /** A worker still holding the job's lease, or a detached effect of it still running. */
    const workerOrEffectLive = (job) => workerLeaseHeld(job, safely(() => jobs.readControl(), null), isLeaseOwnerAlive, now())
        || safely(() => jobs.hasRunningEffects(job.id), true);

    /** Why this job cannot be abandoned now, or null when it can. Reads only. */
    const blockedReason = (job) => {
        if (TERMINAL_STATES.has(job.state)) return 'terminal';
        if (ACTIVATION_STATES.has(job.state)) return 'in_flight_restart';
        if (safely(isRestartInFlight, true)) return 'in_flight_restart';
        if (workerOrEffectLive(job)) return 'in_flight_restart';
        const root = safely(controlRoot, null);
        if (!root) return 'in_flight_restart';
        const gate = readOpenMaintenanceGate(readGate);
        if (!gate) return 'gate_closed';
        if (isBootstrapHandoffPending(root, gate, job.transaction_id)) return 'in_flight_restart';
        if (safely(isSafeRestartRunning, true)) return 'in_flight_restart';
        const evidence = readQueuedActionEvidence(job, root, safely(() => jobs.listReceipts(job.id), []));
        const head = job.strategy === 'release-layout-v2' ? null : sha40(safely(readHead, null));
        if (!runtimeIsPreUpdate(job, { head, runtime: sha40(safely(runtimeCommit, null)), evidence })) return 'head_moved_unverified';
        return null;
    };

    /** The abandonability of a job as published on the active-job payload. */
    const evaluate = (job) => {
        if (job?.state === 'failed' && job.error_code === UPDATE_ABANDONED_BY_OWNER) {
            return { abandonable: false, abandonBlockedReason: 'terminal', abandoned: true };
        }
        const reason = blockedReason(job);
        return { abandonable: reason === null, abandonBlockedReason: reason, abandoned: false };
    };

    /**
     * Abandon the owner's job. Probe, decide and write run with no await in
     * between, and the write is a CAS on (state, progress_seq).
     *
     * @returns {{ outcome: 'not_found' } | { outcome: 'blocked', reason: string, job: object }
     *   | { outcome: 'abandoned' | 'already', job: object, rows: number }}
     */
    const abandon = ({ jobId, ownerId }) => {
        const job = jobs.getForOwner(jobId, ownerId);
        if (!job) return { outcome: 'not_found' };
        if (evaluate(job).abandoned) return { outcome: 'already', job, rows: 0 };
        const reason = blockedReason(job);
        if (reason) return { outcome: 'blocked', reason, job };
        return transact(() => {
            // Re-read under the writer lock: a worker may have claimed it since the probe.
            if (workerOrEffectLive(job)) return { outcome: 'blocked', reason: 'in_flight_restart', job };
            const result = jobs.abandonByOwner({
                jobId: job.id, ownerId, expectedState: job.state, expectedProgressSeq: Number(job.progress_seq),
                code: UPDATE_ABANDONED_BY_OWNER, message: ABANDONED_MESSAGE,
                facts: { code: UPDATE_ABANDONED_BY_OWNER, failedPhase: job.state, intervention: 'human', actorId: ownerId },
            });
            if (result.outcome === 'already') return { outcome: 'already', job: result.job, rows: 0 };
            if (result.outcome === 'not_found') return { outcome: 'not_found' };
            if (result.outcome !== 'abandoned') {
                return { outcome: 'blocked', reason: result.outcome === 'terminal' ? 'terminal' : 'in_flight_restart', job: result.job };
            }
            const rows = settleSourceUpdateJobRows(job.id, UPDATE_ABANDONED_BY_OWNER, actions);
            audit.record('update_job_abandoned', {
                userId: ownerId,
                metadata: { jobId: job.id, fromState: job.state, rows, receiptSequence: result.receipt.sequence },
            });
            return { outcome: 'abandoned', job: result.job, rows };
        });
    };

    return Object.freeze({ evaluate, abandon });
}

/**
 * Whether a restarting safe-restart process owned by this account is alive:
 * a safe-restart.sh invocation carrying `--exec`. The periodic read-only
 * `--json` / gate probes are not restarts and do not count. Reads only
 * /proc/<pid>/cmdline for a match and never logs it. An unreadable /proc reads
 * as running (fail closed).
 */
export function isSafeRestartProcessRunning({ procRoot = '/proc', uid = process.getuid?.() } = {}) {
    let entries;
    try { entries = fs.readdirSync(procRoot); } catch { return true; }
    for (const name of entries) {
        if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
        try {
            if (uid !== undefined && fs.statSync(path.join(procRoot, name)).uid !== uid) continue;
            const argv = fs.readFileSync(path.join(procRoot, name, 'cmdline'), 'utf8').split('\0');
            const script = argv.some((arg) => arg.endsWith('/safe-restart.sh') || arg === 'safe-restart.sh');
            if (script && argv.includes('--exec')) return true;
        } catch { /* the process exited while we looked */ }
    }
    return false;
}
