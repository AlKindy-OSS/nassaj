/**
 * B-1448 slice 2: the owner's "close N terminals and update".
 *
 * An open terminal (a standalone terminal or a Shell tab, attached or in its
 * detached tail) holds the update's activity lock, so an activation waits for it
 * — up to the 24 h consent deadline. This route lets the OWNER end that wait on
 * purpose: it closes every open terminal, of every member, and lets the queued
 * activation run at once.
 *
 * Optimistic concurrency, never a silent kill: the request echoes the terminal
 * snapshot the owner was shown. If the set changed since (a new terminal, a
 * different holder), nothing is closed and the fresh set comes back as 409
 * `terminals_changed` for the owner to confirm again. An empty set is success
 * with nothing closed, so a double-click is harmless.
 *
 * Nothing is closed unless open terminals are the ONLY thing holding the
 * activation (qa M1): the refusal reasons are local_main, activator_failed,
 * sessions_active, scheduled_wait and not_waiting_terminals, all as
 * 409 update_not_overridable.
 */

const SNAPSHOT = /^[a-f0-9]{32}$/;

/**
 * Build the handler for `POST /api/system/update/jobs/:jobId/close-terminals`.
 * The caller mounts it after authenticateToken → requireRole('owner') → its
 * rate limiter (pinned by a wiring test); the handler re-checks the role too.
 *
 * @param {object} deps
 * @param {(jobId: string, ownerId: number) => any} deps.getJobForOwner the owner's own job, or null
 * @param {() => { count: number, attached: number, detached: number, usernames: string[],
 *   detachedClosesAt: number | null, snapshot: string }} deps.summarizeOpenTerminals
 * @param {() => number} deps.closeAllTerminals closes every terminal; returns how many
 * @param {((jobId: string) => boolean) | null} deps.activateNow runs the job's activation now
 * @param {((jobId: string) => string | null) | null} deps.closeTerminalsRefusal why closing is refused now,
 *   or null when open terminals are the only thing holding the activation
 * @param {() => boolean} [deps.isLocalMain] local-main hosts have no release activation to unblock
 * @param {(action: string, details: object) => void} deps.audit
 * @returns {import('express').RequestHandler}
 */
export function createCloseTerminalsHandler({
    getJobForOwner, summarizeOpenTerminals, closeAllTerminals, activateNow, closeTerminalsRefusal, audit,
    isLocalMain = () => process.env.NASSAJ_UPDATE_MODE === 'local-main',
}) {
    if (typeof getJobForOwner !== 'function' || typeof summarizeOpenTerminals !== 'function'
        || typeof closeAllTerminals !== 'function' || typeof audit !== 'function') {
        throw new TypeError('close-terminals route dependencies are required');
    }
    const notOverridable = (res, reason) => res.status(409).json({ success: false, code: 'update_not_overridable', reason });
    return (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Insufficient permissions' });
        // M3: mirrors POST /api/system/update/jobs, which refuses local-main first.
        if (isLocalMain()) return notOverridable(res, 'local_main');
        const ownerId = req.user?.id;
        if (!Number.isSafeInteger(ownerId)) return res.status(403).json({ success: false, code: 'owner_identity_unavailable' });
        const expectedSnapshot = req.body?.expectedSnapshot;
        if (typeof expectedSnapshot !== 'string' || !SNAPSHOT.test(expectedSnapshot)) {
            return res.status(400).json({ success: false, code: 'terminal_snapshot_invalid' });
        }
        const job = getJobForOwner(req.params.jobId, ownerId);
        if (!job) return res.status(404).json({ success: false, code: 'update_job_not_found' });
        if (job.state !== 'restart_queued' || job.auto_activate !== 1) return notOverridable(res, 'not_waiting_terminals');
        if (typeof activateNow !== 'function' || typeof closeTerminalsRefusal !== 'function') {
            return notOverridable(res, 'activator_failed');
        }
        // Read, check, compare and close with no await in between: nothing can
        // open a terminal or change the activator's reading in the meantime.
        const before = summarizeOpenTerminals();
        const refusal = before.count > 0 ? closeTerminalsRefusal(job.id) : null;
        if (refusal) return notOverridable(res, refusal);
        if (before.count > 0 && before.snapshot !== expectedSnapshot) {
            return res.status(409).json({ success: false, code: 'terminals_changed', openTerminals: before });
        }
        const closed = before.count > 0 ? closeAllTerminals() : 0;
        const remaining = summarizeOpenTerminals().count;
        audit('update_terminals_closed', {
            userId: ownerId,
            metadata: { jobId: job.id, count: closed, usernames: before.usernames, remaining },
        });
        activateNow(job.id);
        return res.json({ jobId: job.id, status: 'closed', closed, remaining, activation: 'triggered' });
    };
}
