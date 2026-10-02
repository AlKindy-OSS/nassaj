import crypto from 'node:crypto';
/**
 * One-click activation (T-1751; ADR-159, owner decision 2026-09-12).
 *
 * The owner's "Update now" click is recorded on the job as consent to activate
 * (`auto_activate = 1`). Once the worker has sealed the candidate and queued the
 * job's bound safe-restart row, this loop executes THAT row through the command
 * board's own executor — the same durable claim, role, config and safe-restart
 * gates as the button — as the consenting owner. Nothing here can kill a
 * session: the in-process session count is read first, then the open-terminal
 * count (B-1448: terminals and Shell tabs hold the update's activity lock), and
 * the safe-restart gate defers on the live sessions and orphan CLIs it sees,
 * returning the row to pending. It does NOT see PTY shells; the executor's own
 * terminal check and the gate's lock contention do.
 * The loop retries until the node is idle or the deadline passes; after the
 * deadline the row is left for the manual button and the owner is told why.
 */

export const AUTO_ACTIVATE_INTERVAL_MS = 30_000;
export const AUTO_ACTIVATE_DEADLINE_MS = 24 * 60 * 60 * 1000;
/**
 * T-1912: a restart is softly held while a scheduled message is due within this
 * window, so scheduled deliveries are not cut by the restart. Never a hard
 * block: the owner can override it, and it lapses after SCHEDULED_DEFERRAL_CAP_MS.
 */
export const SCHEDULED_UPDATE_WINDOW_MS = 10 * 60 * 1000;
export const SCHEDULED_DEFERRAL_CAP_MS = 60 * 60 * 1000;
const MAX_SCHEDULED_WINDOW_MINUTES = 24 * 60;
/**
 * B-1448: backoff between attempts that keep contending on the update lock with
 * a holder that is not a terminal. Each attempt spawns the gate, writes two
 * audit rows and holds admission exclusively for the activity wait, so the
 * delay doubles per consecutive contention (30 s, 60 s, 120 s …) up to 10 min.
 */
export const CONTENTION_BACKOFF_BASE_MS = 30_000;
export const CONTENTION_BACKOFF_CAP_MS = 10 * 60 * 1000;

/** Delay before the next attempt after `streak` consecutive lock contentions. */
export function contentionBackoffMs(streak) {
    if (!Number.isSafeInteger(streak) || streak < 1) return 0;
    return Math.min(CONTENTION_BACKOFF_BASE_MS * 2 ** Math.min(streak - 1, 30), CONTENTION_BACKOFF_CAP_MS);
}

/**
 * The window from NASSAJ_UPDATE_SCHEDULED_WINDOW_MINUTES (0 disables); an
 * absent or malformed value keeps the default.
 */
export function resolveScheduledUpdateWindowMs(env = process.env) {
    const raw = env?.NASSAJ_UPDATE_SCHEDULED_WINDOW_MINUTES;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return SCHEDULED_UPDATE_WINDOW_MS;
    const minutes = Number(raw.trim());
    return minutes > MAX_SCHEDULED_WINDOW_MINUTES ? SCHEDULED_UPDATE_WINDOW_MS : minutes * 60 * 1000;
}

/** Sanitize the scheduled-due reading to {count, earliestAt}; anything else reads as none. */
function normalizeDueSoon(value) {
    const count = Number.isSafeInteger(value?.count) && value.count > 0 ? value.count : 0;
    if (count === 0) return null;
    const earliestAt = typeof value.earliestAt === 'string' && Number.isFinite(Date.parse(value.earliestAt))
        ? new Date(Date.parse(value.earliestAt)).toISOString() : null;
    return { count, earliestAt };
}

/** SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) or ISO → epoch ms. */
export function parseDbTimestamp(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

/** When the job entered restart_queued, from its durable receipt. */
function restartQueuedAt(jobs, job) {
    if (job.activationAuthority?.kind === 'policy') {
        const authority = jobs.readActivationAuthority?.(job);
        return authority?.kind === 'policy' && authority.grantDigest === job.activationAuthority.grantDigest
            && Number.isSafeInteger(authority.issuedAt) ? authority.issuedAt : null;
    }
    let receipts = [];
    try { receipts = jobs.listReceipts(job.id) || []; } catch { receipts = []; }
    for (let index = receipts.length - 1; index >= 0; index -= 1) {
        const row = receipts[index];
        if (row.phase === 'restart_queued' && row.kind === 'recovery') {
            try {
                const facts = JSON.parse(row.facts_json);
                if (crypto.createHash('sha256').update(row.facts_json).digest('hex') === row.facts_sha256
                    && facts.code === 'owner_activation_consent' && facts.ownerId === job.owner_id
                    && facts.expectedVersion === job.expected_version && facts.targetDigest === job.activation_identity_sha256
                    && Number.isSafeInteger(facts.confirmedAt) && facts.confirmedAt > 0) return facts.confirmedAt;
            } catch { /* unrelated or malformed receipt cannot renew authorization */ }
        }
        if (row.phase === 'restart_queued' && row.kind === 'done') return parseDbTimestamp(row.created_at);
    }
    return job.activation_identity_sha256 ? null : parseDbTimestamp(job.updated_at);
}

/** Recheck durable consent at execution time, rather than relying on an earlier scheduler tick. */
export function hasCurrentUpdateConsent(jobs, job, now = Date.now()) {
    const confirmed = job ? restartQueuedAt(jobs, job) : null;
    return Boolean(job?.state === 'restart_queued' && job.auto_activate === 1 && confirmed !== null
        && confirmed <= now && now < confirmed + AUTO_ACTIVATE_DEADLINE_MS);
}

/** Sanitize an open-terminal reading to {count, attached, detached, usernames, detachedClosesAt}. */
export function normalizeOpenTerminals(value) {
    const int = (field) => (Number.isSafeInteger(value?.[field]) && value[field] >= 0 ? value[field] : 0);
    const count = int('count');
    if (count === 0) return null;
    const usernames = Array.isArray(value.usernames)
        ? value.usernames.filter((name) => typeof name === 'string' && name).map((name) => name.slice(0, 64)).slice(0, 20)
        : [];
    const detachedClosesAt = Number.isSafeInteger(value.detachedClosesAt) ? value.detachedClosesAt : null;
    // Slice 2: the digest the owner echoes to confirm closing exactly these terminals.
    const snapshot = typeof value.snapshot === 'string' && /^[a-f0-9]{32}$/.test(value.snapshot) ? value.snapshot : null;
    return { count, attached: int('attached'), detached: int('detached'), usernames, detachedClosesAt, snapshot };
}

/** The owner-facing line for a terminal wait: count, whose, and when detached ones auto-close. */
function terminalWaitMessage(terminals) {
    const who = terminals.usernames.length ? ` (${terminals.usernames.join(', ')})` : '';
    const closesAt = new Date(terminals.detachedClosesAt ?? Number.NaN);
    const when = Number.isFinite(closesAt.getTime()) ? ` by ${closesAt.toISOString()}` : '';
    const detached = terminals.detached > 0
        ? ` ${terminals.detached} of them detached, closing by themselves${when}.`
        : '';
    return `⏸ Waiting for ${terminals.count} open terminal(s)${who} to close; no terminal will be closed.${detached}`;
}

/** Map the executor's HTTP-shaped reply onto the activator's own status. */
function outcomeOf(reply) {
    const body = reply?.body && typeof reply.body === 'object' ? reply.body : {};
    const requeued = body.requeued === false ? { requeued: false } : {};
    if (body.status === 'deferred' && body.reasonCode === 'open_terminals') {
        // B-1448: the executor found open terminals before touching the gate.
        const openTerminals = normalizeOpenTerminals({
            count: body.openTerminals, attached: body.attachedTerminals, detached: body.detachedTerminals,
            usernames: body.terminalUsers, detachedClosesAt: body.detachedClosesAt, snapshot: body.terminalSnapshot,
        });
        return { state: 'waiting_terminals', code: 'open_terminals', liveSessions: 0, openTerminals, ...requeued };
    }
    if (body.status === 'deferred') {
        return { state: 'waiting_sessions', code: body.reasonCode || 'deferred',
            liveSessions: Number.isSafeInteger(body.sessionCount) ? body.sessionCount : null, ...requeued };
    }
    // qa note 5 (ADR-159): a `confirm_required` reply is the two-step force-restart
    // gate asking a human to confirm killing live work/sessions. It carries a 2xx
    // status but NOTHING restarted; auto-activation never kills, so it is a WAIT,
    // not a restart — returning 'restarting' here would falsely end the loop on an
    // unrestarted node and drop the owed activation.
    if (body.status === 'confirm_required') {
        return { state: 'waiting_sessions', code: 'confirm_required',
            liveSessions: Number.isSafeInteger(body.sessionCount) ? body.sessionCount : null };
    }
    if (reply?.status >= 200 && reply.status < 300 && body.status !== 'error') {
        return { state: 'restarting', code: null, liveSessions: 0 };
    }
    const refused = { state: 'refused', code: typeof body.code === 'string' ? body.code : `http_${reply?.status ?? 'unknown'}`, liveSessions: null };
    return typeof body.reason === 'string' && body.reason ? { ...refused, reason: body.reason } : refused;
}

/**
 * Activation defect 2026-09-29: a refusal that SETTLED the queued row (gate_failed
 * marks it failed) can never be retried by this loop — the next tick would only
 * find no pending row and wait forever while the log still said "retrying". Such
 * a refusal is terminal until the owner confirms activation again. Chosen over
 * re-queueing the row: re-running a restart whose safety check failed, with no
 * proof the cause is gone, is not safe, and the confirm path already exists.
 */
function isRowSettled(listQueuedRestarts, rowId) {
    try {
        // Only a row the refusal marked `failed` is settled. An absent row is an
        // unresolved `executing` claim (listActionable excludes it; B-1158) that may
        // still return to pending, so it is never treated as terminal.
        return listQueuedRestarts().some((candidate) => candidate.id === rowId && candidate.status === 'failed');
    } catch {
        return false;
    }
}

/**
 * @param {object} deps
 * @param {{ listAutoActivatable: () => any[], listReceipts: (id: string) => any[] }} deps.jobs
 * @param {() => any[]} deps.listQueuedRestarts actionable safe-restart rows
 * @param {() => number} deps.countSessions the in-process governed session count
 * @param {() => ({ count: number, attached: number, detached: number, usernames: string[],
 *   detachedClosesAt: number | null })} [deps.openTerminals] B-1448: open terminals holding
 *   the update's activity lock; absent disables the pre-check (the executor still checks)
 * @param {(input: { id: number, user: object }) => Promise<{ status: number, body: any }>} deps.executeAsOwner
 * @param {(id: number) => ({ id: number, role: string, username?: string } | undefined)} deps.getUser
 * @param {(action: string, details: object) => void} [deps.audit]
 * @param {{ line: (jobId: string, message: string) => void }} [deps.jobLog]
 * @param {() => ({ count: number, earliestAt: string | null } | null)} [deps.scheduledDueSoon]
 *   T-1912: scheduled messages due within the window; absent or window 0 disables the hold
 * @param {number} [deps.scheduledCapMs] cumulative hold after which the scheduled condition is ignored
 */
export function createUpdateAutoActivator({
    jobs, listQueuedRestarts, countSessions, executeAsOwner, getUser, openTerminals = null,
    audit = () => undefined, jobLog = null, now = Date.now, prepareJob = async () => undefined,
    beforeTick = async () => true,
    intervalMs = AUTO_ACTIVATE_INTERVAL_MS, deadlineMs = AUTO_ACTIVATE_DEADLINE_MS,
    scheduledDueSoon = null, scheduledCapMs = SCHEDULED_DEFERRAL_CAP_MS,
} = {}) {
    if (!jobs || typeof listQueuedRestarts !== 'function' || typeof countSessions !== 'function'
        || typeof executeAsOwner !== 'function' || typeof getUser !== 'function') {
        throw new TypeError('update auto-activator dependencies are required');
    }
    const statuses = new Map();
    // T-1912: per-job scheduled-message hold (in-process; a restart ends the job's
    // wait anyway). `accumulatedMs` adds, on every tick the scheduled condition
    // defers, the interval since the job's previous tick (whatever its outcome),
    // so the first interval of each deferral streak is counted too.
    const scheduledHolds = new Map();
    const scheduledOverrides = new Set();
    // jobId → the consent time a terminal refusal belongs to; fresh consent clears it.
    const terminalFailures = new Map();
    // B-1448: jobId → { streak, nextAttemptAt } for consecutive update_lock_contended deferrals.
    const contentionBackoff = new Map();
    let running = false;
    // B-1448 T2: an activateNow that lands during a running tick re-runs it once.
    let rerunRequested = false;
    let timer = null;

    const say = (jobId, message) => { try { jobLog?.line(jobId, message); } catch { /* never fatal */ } };

    /** Record a status; log only when what the owner would read has changed. */
    const settle = (job, deadlineAt, next, message) => {
        const previous = statuses.get(job.id);
        const status = { ...next, deadlineAt, checkedAt: now() };
        statuses.set(job.id, status);
        if (message && (previous?.state !== status.state || previous?.liveSessions !== status.liveSessions
            || previous?.code !== status.code || previous?.openTerminals?.count !== status.openTerminals?.count
            || previous?.requeued !== status.requeued)) say(job.id, message);
        return status;
    };

    /** The scheduled reading; a failing reader never holds a restart (soft condition). */
    const readDueSoon = () => {
        if (typeof scheduledDueSoon !== 'function') return null;
        try { return normalizeDueSoon(scheduledDueSoon()); } catch { return null; }
    };

    /**
     * T-1912: whether a due scheduled message holds this job's restart now.
     * Returns the reading to report, or null to proceed. Consulted only once the
     * node is otherwise idle, so the cap counts scheduled-caused deferral alone.
     */
    const scheduledHoldFor = (job, hold, previousTickAt) => {
        const due = scheduledOverrides.has(job.id) ? null : readDueSoon();
        if (!due || hold.capped) return null;
        const at = now();
        if (previousTickAt !== null && at > previousTickAt) hold.accumulatedMs += at - previousTickAt;
        if (hold.accumulatedMs < scheduledCapMs) return due;
        hold.capped = true;
        audit('update_scheduled_deferral_capped', { sourceUpdateJobId: job.id, heldMs: hold.accumulatedMs });
        say(job.id, '⏭ Waited the maximum time for scheduled messages; continuing with the restart.');
        return null;
    };

    const considerJob = async (job) => {
        // Every tick stamps the job; a deferring tick charges the cap with the
        // interval since the previous stamp.
        const hold = scheduledHolds.get(job.id) ?? { accumulatedMs: 0, lastTickAt: null, capped: false };
        scheduledHolds.set(job.id, hold);
        const previousTickAt = hold.lastTickAt;
        hold.lastTickAt = now();
        const queuedAt = restartQueuedAt(jobs, job);
        if (queuedAt === null || queuedAt > now()) return settle(job, null, { state: 'refused', code: 'consent_evidence_unavailable', liveSessions: null }, null);
        const deadlineAt = queuedAt + deadlineMs;
        if (terminalFailures.get(job.id) === queuedAt && statuses.has(job.id)) return statuses.get(job.id);
        terminalFailures.delete(job.id);
        if (now() >= deadlineAt) {
            if (statuses.get(job.id)?.state !== 'expired') {
                audit('update_auto_activate_expired', { sourceUpdateJobId: job.id });
            }
            return settle(job, deadlineAt, { state: 'expired', code: 'auto_activate_deadline', liveSessions: null },
                '⚠ Automatic activation waited 24 h without an idle node; confirm activation again in the update dialog.');
        }
        const owner = getUser(job.owner_id);
        if (!owner || owner.role !== 'owner') {
            return settle(job, deadlineAt, { state: 'refused', code: 'owner_unavailable', liveSessions: null },
                '⚠ The authorizing owner is no longer active; activation is blocked.');
        }
        await prepareJob(job);
        const row = listQueuedRestarts().find((candidate) => candidate.sourceUpdateJobId === job.id
            && candidate.status === 'pending');
        if (!row) {
            return settle(job, deadlineAt, { state: 'waiting_row', code: null, liveSessions: null }, null);
        }
        let sessions;
        try { sessions = countSessions(); } catch { sessions = null; }
        if (!Number.isSafeInteger(sessions) || sessions > 0) {
            return settle(job, deadlineAt, { state: 'waiting_sessions', code: 'live_sessions', liveSessions: sessions },
                `⏸ Waiting for ${sessions ?? 'unknown'} live session(s) to finish; no session will be stopped.`);
        }
        // B-1448: an open terminal would only make the attempt contend; wait
        // here without spawning the gate. A failing reader never holds.
        let terminals = null;
        try { terminals = typeof openTerminals === 'function' ? normalizeOpenTerminals(openTerminals()) : null; } catch { terminals = null; }
        if (terminals) {
            return settle(job, deadlineAt, {
                state: 'waiting_terminals', code: 'open_terminals', liveSessions: 0, openTerminals: terminals,
            }, terminalWaitMessage(terminals));
        }
        const dueSoon = scheduledHoldFor(job, hold, previousTickAt);
        if (dueSoon) {
            return settle(job, deadlineAt, {
                state: 'waiting_scheduled', code: 'scheduled_messages_due', liveSessions: 0, scheduledDueSoon: dueSoon,
            }, `⏸ Waiting for ${dueSoon.count} scheduled message(s) due soon; the restart follows their delivery.`);
        }
        const currentOwner = getUser(job.owner_id);
        if (!currentOwner || currentOwner.role !== 'owner' || restartQueuedAt(jobs, job) !== queuedAt) {
            return settle(job, deadlineAt, { state: 'refused', code: 'owner_unavailable', liveSessions: null },
                '⚠ Activation authority changed while waiting; activation is blocked.');
        }
        const backoff = contentionBackoff.get(job.id);
        if (backoff && now() < backoff.nextAttemptAt) {
            const { deadlineAt: _deadline, checkedAt: _checked, ...waiting } = statuses.get(job.id) ?? {
                state: 'waiting_sessions', code: 'update_lock_contended', liveSessions: null,
            };
            return settle(job, deadlineAt, { ...waiting, retryAt: backoff.nextAttemptAt }, null);
        }
        say(job.id, job.activationAuthority?.kind === 'policy'
            ? '▶ Node is idle; running the governed safe restart under the enabled development policy.'
            : '▶ Node is idle; running the governed safe restart (consented at update start).');
        audit('update_auto_activate_attempt', { sourceUpdateJobId: job.id, pendingActionId: row.id });
        const outcome = outcomeOf(await executeAsOwner({ id: row.id, user: currentOwner }));
        if (outcome.code === 'update_lock_contended' && outcome.state === 'waiting_sessions') {
            const streak = (backoff?.streak ?? 0) + 1;
            const nextAttemptAt = now() + contentionBackoffMs(streak);
            contentionBackoff.set(job.id, { streak, nextAttemptAt });
            outcome.retryAt = nextAttemptAt;
        } else {
            contentionBackoff.delete(job.id);
        }
        if (outcome.state === 'refused' && isRowSettled(listQueuedRestarts, row.id)) {
            terminalFailures.set(job.id, queuedAt);
            audit('update_auto_activate_failed', { sourceUpdateJobId: job.id, pendingActionId: row.id, code: outcome.code });
            const cause = outcome.reason ? `${outcome.code}: ${outcome.reason}` : outcome.code;
            return settle(job, deadlineAt, { ...outcome, terminal: true },
                `✖ Safe restart failed its safety check (${cause}); automatic activation stopped. `
                + 'Fix the cause, then confirm activation again in the update dialog.');
        }
        const base = outcome.state === 'restarting'
            ? '↻ Safe restart started; activation continues in the new process.'
            : outcome.state === 'waiting_terminals' && outcome.openTerminals
                ? terminalWaitMessage(outcome.openTerminals)
                : outcome.state === 'waiting_sessions' || outcome.state === 'waiting_terminals'
                    ? `⏸ The restart gate deferred (${outcome.code}); retrying when the node is idle.`
                    : `⚠ Safe restart was refused (${outcome.code}); retrying.`;
        // B-1448 (R3): a deferral whose row could not return to the queue would
        // otherwise leave the job silently in waiting_row until the deadline.
        const message = outcome.requeued === false
            ? `${base} The queued restart could not be returned to the queue; confirm activation again if it does not resume.`
            : base;
        return settle(job, deadlineAt, outcome, message);
    };

    const tick = async () => {
        if (running) return;
        running = true;
        // This run sees every activateNow made before it started.
        rerunRequested = false;
        try {
            if (await beforeTick() === false) return;
            const pending = jobs.listAutoActivatable();
            const live = new Set(pending.map((job) => job.id));
            for (const id of statuses.keys()) if (!live.has(id)) statuses.delete(id);
            for (const id of scheduledHolds.keys()) if (!live.has(id)) scheduledHolds.delete(id);
            for (const id of scheduledOverrides) if (!live.has(id)) scheduledOverrides.delete(id);
            for (const id of contentionBackoff.keys()) if (!live.has(id)) contentionBackoff.delete(id);
            for (const id of terminalFailures.keys()) if (!live.has(id)) terminalFailures.delete(id);
            // One restart ends this process; never attempt a second in the same tick.
            for (const job of pending) {
                const status = await considerJob(job);
                if (status.state === 'restarting') break;
            }
        } catch (error) {
            console.error('[update-auto-activate] tick failed:', error?.message || 'unknown error');
        } finally {
            running = false;
            if (rerunRequested) {
                rerunRequested = false;
                setImmediate(() => { void tick(); });
            }
        }
    };

    return Object.freeze({
        tick,
        /** What the job's status endpoint reports; null when the job is not waiting on activation. */
        statusFor: (jobId) => {
            const status = statuses.get(jobId);
            if (!status) return null;
            // Present only once the owner overrode, so the pre-T-1912 shape is unchanged.
            return scheduledOverrides.has(jobId) ? { ...status, scheduledOverride: true } : status;
        },
        /**
         * B-1448 slice 2: why the owner may NOT close terminals for this job right
         * now, or null when open terminals are the only thing holding it. Read
         * synchronously, right before the close, so nothing is closed for an
         * activation that would still wait on something else afterwards:
         * activator_failed (terminal refusal or expired), sessions_active,
         * scheduled_wait (use skip-scheduled-wait first; never overridden here)
         * and not_waiting_terminals.
         */
        closeTerminalsRefusal(jobId) {
            const status = statuses.get(jobId);
            if (terminalFailures.has(jobId) || status?.terminal || ['refused', 'expired'].includes(status?.state)) {
                return 'activator_failed';
            }
            let sessions;
            try { sessions = countSessions(); } catch { sessions = null; }
            if (!Number.isSafeInteger(sessions) || sessions > 0) return 'sessions_active';
            // Checked even though terminals are evaluated first in considerJob:
            // once they close, a due scheduled message would hold the restart.
            const hold = scheduledHolds.get(jobId);
            if (!scheduledOverrides.has(jobId) && !hold?.capped && readDueSoon()) return 'scheduled_wait';
            return status?.state === 'waiting_terminals' ? null : 'not_waiting_terminals';
        },
        /**
         * B-1448 slice 2: after the owner closed the terminals, try this job now:
         * its lock-contention backoff is cleared and a tick is scheduled (never
         * awaited: a successful tick restarts this process). The caller authorizes.
         */
        activateNow(jobId) {
            if (typeof jobId !== 'string' || jobId.length === 0) return false;
            contentionBackoff.delete(jobId);
            // T2: if a tick is running it already read the old state; it re-runs
            // in its finally. Otherwise the scheduled tick clears the flag.
            rerunRequested = true;
            setImmediate(() => { void tick(); });
            return true;
        },
        /**
         * T-1912 owner "update now": skip ONLY the scheduled-message condition for
         * this job; the live-session condition and every restart gate still apply.
         * The caller authorizes (owner role, owned job in restart_queued).
         */
        overrideScheduled(jobId) {
            if (typeof jobId !== 'string' || jobId.length === 0) return false;
            scheduledOverrides.add(jobId);
            return true;
        },
        start() {
            if (timer) return;
            timer = setInterval(() => { void tick(); }, intervalMs);
            timer.unref?.();
            void tick();
        },
        stop() { if (timer) clearInterval(timer); timer = null; },
    });
}
