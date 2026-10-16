/**
 * B-1626 (ADR-207 slice R): retention for git-checkout-v2 update candidates.
 *
 * Every update leaves `<common-git-dir>/nassaj-source-update/candidates/<tx>`
 * (about 1.3 GB: a linked Git worktree under `source/` plus the exchanged
 * generations). Nothing removed them. This sweep removes OLD candidates, best
 * effort, and refuses whenever the evidence is not plain:
 *
 * - it runs only under the maintenance-gate writer lease (kind
 *   `source-update-retention`), so no update, activation or recovery can begin
 *   while it decides (they take admission exclusively); contention skips;
 * - the journal must be OPEN with an open gate, no degraded reopen, no pending
 *   OID admission and a phase of null or ACTIVE_VERIFIED. RECOVERING, MANUAL,
 *   DRAINING, UPDATING and every rollback phase delete nothing;
 * - a job still before its seal (its candidate may not carry a transaction id
 *   on the row yet) skips the whole sweep;
 * - never removed: the journal's transaction, the bootstrap handoff's
 *   transaction, any job that is not terminal (manual_recovery_required counts
 *   as not terminal: its candidate is the manual exit), and the LAST ACTIVATED
 *   candidate, whose exchanged generations are the rollback. When the last
 *   activated candidate cannot be named the sweep removes nothing;
 * - `update-pre-*` (ADR-207 §3.3, qa S2 condition): while NO job references
 *   it, it belongs to the prestager (slot.json, its own recovery and the
 *   one-un-adopted invariant) and is never touched here, whatever its age —
 *   neither the directory nor its worktree registration; the orphan grace
 *   rule never applies to it. Once a job carries it as its transaction (an
 *   adopted slot), it follows normal job retention like any job candidate;
 * - never removed either: a transaction named by a pending or executing
 *   safe-command row (`listActionReferences`); its restart activates it;
 * - any other candidate with no job row is removed only after a grace period.
 *
 * Removal renames `<tx>` to `.retired-<tx>-<nonce>` under the lease (readers see
 * the candidate whole or absent), drops its Git worktree registration and plan
 * file, then deletes the retired tree asynchronously after the lease is
 * released. Registrations whose directory is already missing are dropped the
 * same way; a leftover `.retired-*` from a crash is deleted by the next sweep.
 *
 * Kill switch: `NASSAJ_UPDATE_CANDIDATE_RETENTION=0`.
 */
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CANDIDATE_RETENTION_KILL_SWITCH = 'NASSAJ_UPDATE_CANDIDATE_RETENTION';
export const CANDIDATE_RETENTION_LEASE_KIND = 'source-update-retention';
export const CANDIDATE_RETENTION_DEFAULTS = Object.freeze({
    maxRemovals: 4,
    orphanGraceMs: 24 * 60 * 60 * 1000,
    leaseWaitMs: 1_000,
    gitTimeoutMs: 60_000,
});

const TX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const PRESTAGE_PREFIX = 'update-pre-';
const RETIRED_PREFIX = '.retired-';
// manual_recovery_required is deliberately absent: its candidate stays.
const TERMINAL_STATES = new Set(['activated', 'rolled_back', 'failed', 'superseded', 'cancelled']);
const PRE_SEAL_STATES = new Set([
    'accepted', 'resolving', 'resolved', 'downloading', 'archive_verified', 'extracting', 'staging', 'candidate_sealed',
]);
const OPEN_PHASES = new Set([null, 'ACTIVE_VERIFIED']);

let sweepRunning = false;

/**
 * Run one bounded retention sweep. Never throws: every refusal or failure is
 * returned (and logged) as `{ status: 'skipped' | 'error', reason }`.
 *
 * @param {object} deps
 * @param {() => object} deps.createGate builds the maintenance gate (writer lease, journal evidence, paths)
 * @param {() => Array<{state: string, transactionId: string|null, completedAt: string|null, rowOrder: number}>} deps.listJobReferences
 * @param {() => Iterable<string>} [deps.listActionReferences] transactions of pending/executing safe-command rows
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {{info: Function, warn: Function}} [deps.logger]
 * @param {() => number} [deps.now]
 * @param {(args: string[], options: {cwd: string, timeoutMs: number}) => Promise<{code: number}>} [deps.runGit]
 * @param {Partial<typeof CANDIDATE_RETENTION_DEFAULTS>} [deps.options]
 */
export async function pruneSourceUpdateCandidates({
    createGate, listJobReferences, listActionReferences = () => [], env = process.env, logger = console, now = Date.now,
    runGit = runGitCommand, options = {},
} = {}) {
    if (env[CANDIDATE_RETENTION_KILL_SWITCH] === '0') return report(logger, { status: 'skipped', reason: 'disabled' });
    if (sweepRunning) return report(logger, { status: 'skipped', reason: 'already_running' });
    sweepRunning = true;
    try {
        const settings = { ...CANDIDATE_RETENTION_DEFAULTS, ...options };
        return report(logger, await sweep({ createGate, listJobReferences, listActionReferences, now, runGit, settings }));
    } catch (error) {
        return report(logger, { status: 'error', reason: reasonOf(error) });
    } finally {
        sweepRunning = false;
    }
}

async function sweep({ createGate, listJobReferences, listActionReferences, now, runGit, settings }) {
    const gate = createGate();
    if (gate.paths.artifact || !gate.paths.commonGitDir) return { status: 'skipped', reason: 'not_git_checkout' };
    const candidatesRoot = path.join(gate.paths.controlRoot, 'candidates');
    if (!fs.existsSync(candidatesRoot)) return { status: 'done', removed: [], registrations: 0, deleted: 0 };
    let lease;
    try {
        lease = await gate.acquireWriterLease({ kind: CANDIDATE_RETENTION_LEASE_KIND, waitMs: settings.leaseWaitMs });
    } catch (error) {
        return { status: 'skipped', reason: reasonOf(error) };
    }
    let decided;
    try {
        decided = await decideAndRetire({ gate, candidatesRoot, listJobReferences, listActionReferences, now, runGit, settings });
    } finally {
        lease.release();
    }
    if (decided.status !== 'done') return decided;
    const deleted = await deleteRetiredTrees(candidatesRoot);
    return { ...decided, deleted };
}

/** Everything that must happen under the writer lease: the decision and the atomic retirement. */
async function decideAndRetire({ gate, candidatesRoot, listJobReferences, listActionReferences, now, runGit, settings }) {
    const journal = gate.readRecoveryEvidence();
    const refusal = journalRefusal(journal);
    if (refusal) return { status: 'skipped', reason: refusal };
    // Directory listing BEFORE the job query: a candidate created after the
    // listing is not considered, and one listed earlier already had its job
    // past `accepted`, so the job query below sees it.
    const entries = listCandidateEntries(candidatesRoot);
    const jobs = listJobReferences();
    if (jobs.some((job) => PRE_SEAL_STATES.has(job.state))) return { status: 'skipped', reason: 'job_before_seal' };
    const keep = protectedTransactions(journal, jobs, gate.paths.controlRoot);
    if (!keep.ok) return { status: 'skipped', reason: keep.reason };
    let actionTransactions;
    try { actionTransactions = [...listActionReferences()]; } catch { return { status: 'skipped', reason: 'action_references_unavailable' }; }
    for (const transactionId of actionTransactions) if (typeof transactionId === 'string' && transactionId) keep.transactions.add(transactionId);
    const selected = selectRemovals(entries, keep.transactions, jobs, now(), settings);
    const retired = retireCandidates(candidatesRoot, selected);
    const registrations = await dropWorktreeRegistrations({
        root: gate.paths.root, candidatesRoot, retired, keep: keep.transactions,
        present: new Set(entries.map((entry) => entry.name)), jobs, runGit, settings,
    });
    for (const transactionId of retired) {
        fs.rmSync(path.join(gate.paths.controlRoot, `plan-${transactionId}.json`), { force: true });
    }
    return { status: 'done', removed: retired, kept: [...keep.transactions].sort(), registrations };
}

/** Why the journal forbids deleting anything now, or null when it is plainly OPEN. */
export function journalRefusal(journal) {
    if (!journal || typeof journal !== 'object') return 'journal_unavailable';
    if (journal.state !== 'OPEN') return `journal_${String(journal.state).toLowerCase()}`;
    if (journal.gateClosed !== false) return 'gate_closed';
    if (!OPEN_PHASES.has(journal.phase ?? null)) return `journal_phase_${String(journal.phase).toLowerCase()}`;
    if (journal.degraded) return 'journal_degraded';
    if (journal.oidAdmissionIntentPending) return 'oid_admission_pending';
    if (journal.identity?.kind === 'oid-pair') return 'oid_pair_identity';
    return null;
}

/**
 * The transactions no sweep may remove. `ok: false` when the set cannot be
 * proven complete (an unreadable handoff, an unnamed last activation).
 */
export function protectedTransactions(journal, jobs, controlRoot) {
    const transactions = new Set();
    if (typeof journal?.transactionId === 'string' && journal.transactionId) transactions.add(journal.transactionId);
    const handoff = readHandoffTransaction(controlRoot);
    if (handoff === undefined) return { ok: false, reason: 'handoff_unreadable' };
    if (handoff) transactions.add(handoff);
    for (const job of jobs) {
        if (job.transactionId && !TERMINAL_STATES.has(job.state)) transactions.add(job.transactionId);
    }
    // The journal keeps the transaction of its last completed activation, so
    // either source names the rollback candidate; with neither, nothing goes.
    const lastActivated = lastActivatedTransaction(jobs);
    if (!lastActivated && !journal?.transactionId) return { ok: false, reason: 'last_activated_unknown' };
    if (lastActivated) transactions.add(lastActivated);
    return { ok: true, transactions };
}

function lastActivatedTransaction(jobs) {
    let best = null;
    for (const job of jobs) {
        if (job.state !== 'activated' || !job.transactionId) continue;
        const key = [String(job.completedAt ?? ''), Number(job.rowOrder) || 0];
        if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) best = { key, tx: job.transactionId };
    }
    return best?.tx ?? null;
}

/** The handoff's transaction; null when there is no file, undefined when it cannot be read safely. */
function readHandoffTransaction(controlRoot) {
    const file = path.join(controlRoot, 'bootstrap-handoff.json');
    let metadata;
    try { metadata = fs.lstatSync(file, { throwIfNoEntry: false }); } catch { return undefined; }
    if (!metadata) return null;
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) return undefined;
    try {
        const transactionId = JSON.parse(fs.readFileSync(file, 'utf8'))?.transactionId;
        return typeof transactionId === 'string' && TX.test(transactionId) ? transactionId : undefined;
    } catch { return undefined; }
}

function listCandidateEntries(candidatesRoot) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const entries = [];
    for (const name of fs.readdirSync(candidatesRoot)) {
        if (!TX.test(name)) continue;
        const metadata = fs.lstatSync(path.join(candidatesRoot, name), { throwIfNoEntry: false });
        if (!metadata?.isDirectory() || metadata.isSymbolicLink() || (uid !== null && metadata.uid !== uid)) continue;
        entries.push({ name, mtimeMs: metadata.mtimeMs });
    }
    return entries.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
}

function jobsByTransaction(jobs) {
    return new Map(jobs.filter((job) => job.transactionId).map((job) => [job.transactionId, job]));
}

/** True for an `update-pre-*` candidate no job references: the prestager's alone. */
export function isPrestagerOwned(transactionId, jobByTransaction) {
    return transactionId.startsWith(PRESTAGE_PREFIX) && !jobByTransaction.has(transactionId);
}

/**
 * Oldest first, bounded: a terminal job's candidate (an adopted `update-pre-*`
 * included), or a non-prestage unknown one past the grace period.
 */
export function selectRemovals(entries, keep, jobs, nowMs, settings) {
    const jobByTransaction = jobsByTransaction(jobs);
    const selected = [];
    for (const entry of entries) {
        if (selected.length >= settings.maxRemovals) break;
        if (keep.has(entry.name) || isPrestagerOwned(entry.name, jobByTransaction)) continue;
        const job = jobByTransaction.get(entry.name);
        if (job ? TERMINAL_STATES.has(job.state) : nowMs - entry.mtimeMs >= settings.orphanGraceMs) selected.push(entry.name);
    }
    return selected;
}

function retireCandidates(candidatesRoot, names) {
    const retired = [];
    for (const name of names) {
        const target = path.join(candidatesRoot, `${RETIRED_PREFIX}${name}-${crypto.randomBytes(6).toString('hex')}`);
        try {
            fs.renameSync(path.join(candidatesRoot, name), target);
            retired.push(name);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    if (retired.length) {
        const fd = fs.openSync(candidatesRoot, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return retired;
}

/**
 * Drop the Git worktree registrations of retired candidates, and of any
 * unprotected candidate whose directory is already gone. Only paths inside
 * `candidates/` are touched; no repository-wide prune.
 */
async function dropWorktreeRegistrations({ root, candidatesRoot, retired, keep, present, jobs, runGit, settings }) {
    const listed = await runGit(['worktree', 'list', '--porcelain'], { cwd: root, timeoutMs: settings.gitTimeoutMs });
    if (listed.code !== 0) throw Object.assign(new Error('worktree_list_failed'), { code: 'worktree_list_failed' });
    const retiredSet = new Set(retired);
    const jobByTransaction = jobsByTransaction(jobs);
    let dropped = 0;
    for (const worktree of parseWorktreePaths(listed.stdout)) {
        const relative = path.relative(candidatesRoot, worktree);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
        const transactionId = relative.split(path.sep)[0];
        const orphan = !keep.has(transactionId) && !present.has(transactionId) && !fs.existsSync(worktree)
            && !isPrestagerOwned(transactionId, jobByTransaction);
        if (!retiredSet.has(transactionId) && !orphan) continue;
        const removed = await runGit(['worktree', 'remove', '--force', worktree], { cwd: root, timeoutMs: settings.gitTimeoutMs });
        if (removed.code === 0) dropped += 1;
    }
    return dropped;
}

export function parseWorktreePaths(porcelain) {
    return String(porcelain || '').split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));
}

/** Delete every retired tree (this sweep's and any a crash left), off the event loop. */
async function deleteRetiredTrees(candidatesRoot) {
    let deleted = 0;
    for (const name of fs.readdirSync(candidatesRoot)) {
        if (!name.startsWith(RETIRED_PREFIX)) continue;
        try {
            await fs.promises.rm(path.join(candidatesRoot, name), { recursive: true, force: true });
            deleted += 1;
        } catch { /* the next sweep retries */ }
    }
    return deleted;
}

function runGitCommand(args, { cwd, timeoutMs }) {
    return new Promise((resolve) => {
        const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
            cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs,
        });
        let stdout = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { if (stdout.length < 1024 * 1024) stdout += chunk; });
        child.once('error', () => resolve({ code: -1, stdout }));
        child.once('close', (code) => resolve({ code: code ?? -1, stdout }));
    });
}

function reasonOf(error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_]+$/.test(error.code) ? error.code : null;
    const message = typeof error?.message === 'string' && /^[a-z0-9_]+$/.test(error.message) ? error.message : null;
    return code || message || 'retention_failed';
}

function report(logger, result) {
    const line = { event: 'source_update_candidate_retention', ...result };
    if (result.status === 'error') logger.warn('[source-update-retention]', JSON.stringify(line));
    else logger.info('[source-update-retention]', JSON.stringify(line));
    return result;
}
