/**
 * B-1605: `POST /api/system/update/jobs/:jobId/abandon` and the active-job
 * payload that tells the update dialog whether to offer it.
 *
 * Contract (shared with the client):
 *   body    { "confirm": true }
 *   200     { job: <active-job shape>, abandoned: true }        (also on a repeat)
 *   400     { error: { code: 'update_abandon_confirmation_required', message } }
 *   403     non-owner (requireRole) or owner identity unavailable
 *   404     { error: { code: 'update_job_not_found', message } }
 *   409     { error: { code: 'update_not_abandonable', message, reason }, reason }
 *           reason ∈ in_flight_restart | gate_closed | head_moved_unverified | terminal
 */

const MESSAGES = Object.freeze({
    update_abandon_confirmation_required: 'Confirm abandoning this update.',
    update_job_not_found: 'Update job not found.',
    update_not_abandonable: 'This update cannot be abandoned safely right now.',
    owner_identity_unavailable: 'Owner identity unavailable.',
    update_abandon_failed: 'The update could not be abandoned.',
});

const failure = (res, status, code, extra = {}) => res.status(status)
    .json({ error: { code, message: MESSAGES[code], ...extra }, ...extra });

/**
 * The two abandon fields of an evaluation, as every job payload publishes them
 * (GET /jobs/active, GET /jobs/:jobId and the abandon reply).
 *
 * @param {{ abandonable: boolean, abandonBlockedReason: string | null } | null} evaluation
 */
export function abandonFields(evaluation) {
    const abandonable = evaluation?.abandonable === true;
    return { abandonable, abandonBlockedReason: abandonable ? null : (evaluation?.abandonBlockedReason ?? null) };
}

/**
 * The active-job shape: the four discovery fields plus whether the owner may
 * abandon it now and, when not, why.
 *
 * @param {object} job a source_update_jobs row
 * @param {{ abandonable: boolean, abandonBlockedReason: string | null }} evaluation
 */
export function toActiveUpdateJobPayload(job, evaluation) {
    return {
        jobId: job.id, state: job.state, targetVersion: job.expected_version,
        statusUrl: `/api/system/update/jobs/${encodeURIComponent(job.id)}`,
        ...abandonFields(evaluation),
    };
}

/**
 * Build the abandon handler. The caller mounts it after authenticateToken →
 * requireRole('owner') → its rate limiter; the handler re-checks the role.
 *
 * @param {object} deps
 * @param {ReturnType<import('../services/update-job-abandon.js').createUpdateJobAbandoner>} deps.abandoner
 * @returns {import('express').RequestHandler}
 */
export function createAbandonUpdateJobHandler({ abandoner }) {
    if (typeof abandoner?.abandon !== 'function' || typeof abandoner?.evaluate !== 'function') {
        throw new TypeError('abandon route dependencies are required');
    }
    return (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Insufficient permissions' });
        const ownerId = req.user?.id;
        if (!Number.isSafeInteger(ownerId) || ownerId < 1) return failure(res, 403, 'owner_identity_unavailable');
        if (req.body?.confirm !== true) return failure(res, 400, 'update_abandon_confirmation_required');
        let result;
        try { result = abandoner.abandon({ jobId: String(req.params.jobId), ownerId }); } catch {
            console.error('[update-abandon] abandon failed: update_abandon_failed');
            return failure(res, 500, 'update_abandon_failed');
        }
        if (result.outcome === 'not_found') return failure(res, 404, 'update_job_not_found');
        if (result.outcome === 'blocked') {
            console.warn(`[WARN] Update abandon refused: ${result.reason}`);
            return failure(res, 409, 'update_not_abandonable', { reason: result.reason });
        }
        return res.json({ job: toActiveUpdateJobPayload(result.job, abandoner.evaluate(result.job)), abandoned: true });
    };
}
