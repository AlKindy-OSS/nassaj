import crypto from 'node:crypto';
/**
 * One-click activation (T-1751; ADR-159, owner decision 2026-09-12).
 *
 * The owner's "Update now" click is recorded on the job as consent to activate
 * (`auto_activate = 1`). Once the worker has sealed the candidate and queued the
 * job's bound safe-restart row, this loop executes THAT row through the command
 * board's own executor — the same durable claim, role, config and safe-restart
 * gates as the button — as the consenting owner. Nothing here can kill a
 * session: the in-process count is read first, and the safe-restart gate defers
 * on anything it sees (PTY shells, orphan CLIs), returning the row to pending.
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

/** Map the executor's HTTP-shaped reply onto the activator's own status. */
function outcomeOf(reply) {
    const body = reply?.body && typeof reply.body === 'object' ? reply.body : {};
    if (body.status === 'deferred') {
        return { state: 'waiting_sessions', code: body.reasonCode || 'deferred',
            liveSessions: Number.isSafeInteger(body.sessionCount) ? body.sessionCount : null };
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
    return { state: 'refused', code: typeof body.code === 'string' ? body.code : `http_${reply?.status ?? 'unknown'}`, liveSessions: null };
}

/**
 * @param {object} deps
 * @param {{ listAutoActivatable: () => any[], listReceipts: (id: string) => any[] }} deps.jobs
 * @param {() => any[]} deps.listQueuedRestarts actionable safe-restart rows
 * @param {() => number} deps.countSessions the in-process governed session count
 * @param {(input: { id: number, user: object }) => Promise<{ status: number, body: any }>} deps.executeAsOwner
 * @param {(id: number) => ({ id: number, role: string, username?: string } | undefined)} deps.getUser
 * @param {(action: string, details: object) => void} [deps.audit]
 * @param {{ line: (jobId: string, message: string) => void }} [deps.jobLog]
 * @param {() => ({ count: number, earliestAt: string | null } | null)} [deps.scheduledDueSoon]
 *   T-1912: scheduled messages due within the window; absent or window 0 disables the hold
 * @param {number} [deps.scheduledCapMs] cumulative hold after which the scheduled condition is ignored
 */
export function createUpdateAutoActivator({
    jobs, listQueuedRestarts, countSessions, executeAsOwner, getUser,
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
    let running = false;
    let timer = null;

    const say = (jobId, message) => { try { jobLog?.line(jobId, message); } catch { /* never fatal */ } };

    /** Record a status; log only when what the owner would read has changed. */
    const settle = (job, deadlineAt, next, message) => {
        const previous = statuses.get(job.id);
        const status = { ...next, deadlineAt, checkedAt: now() };
        statuses.set(job.id, status);
        if (message && (previous?.state !== status.state || previous?.liveSessions !== status.liveSessions
            || previous?.code !== status.code)) say(job.id, message);
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
        say(job.id, job.activationAuthority?.kind === 'policy'
            ? '▶ Node is idle; running the governed safe restart under the enabled development policy.'
            : '▶ Node is idle; running the governed safe restart (consented at update start).');
        audit('update_auto_activate_attempt', { sourceUpdateJobId: job.id, pendingActionId: row.id });
        const outcome = outcomeOf(await executeAsOwner({ id: row.id, user: currentOwner }));
        const message = outcome.state === 'restarting'
            ? '↻ Safe restart started; activation continues in the new process.'
            : outcome.state === 'waiting_sessions'
                ? `⏸ The restart gate deferred (${outcome.code}); retrying when the node is idle.`
                : `⚠ Safe restart was refused (${outcome.code}); retrying.`;
        return settle(job, deadlineAt, outcome, message);
    };

    const tick = async () => {
        if (running) return;
        running = true;
        try {
            if (await beforeTick() === false) return;
            const pending = jobs.listAutoActivatable();
            const live = new Set(pending.map((job) => job.id));
            for (const id of statuses.keys()) if (!live.has(id)) statuses.delete(id);
            for (const id of scheduledHolds.keys()) if (!live.has(id)) scheduledHolds.delete(id);
            for (const id of scheduledOverrides) if (!live.has(id)) scheduledOverrides.delete(id);
            // One restart ends this process; never attempt a second in the same tick.
            for (const job of pending) {
                const status = await considerJob(job);
                if (status.state === 'restarting') break;
            }
        } catch (error) {
            console.error('[update-auto-activate] tick failed:', error?.message || 'unknown error');
        } finally {
            running = false;
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
