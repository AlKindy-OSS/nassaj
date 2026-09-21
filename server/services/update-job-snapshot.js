/**
 * Update-job snapshot contract (T-1750, ADR-141). Flattens the failure cause of
 * a source-update job into the flat fields the client reads, and sanitizes any
 * operator-facing message so a filesystem path or an embedded credential never
 * reaches the browser.
 */

import { resolvePublicPagePublisher } from './public-page-agent-guidance.js';

/** True when the public-page publisher exists on this host. Never throws. */
function isPublicPagePublisherInstalled() {
    try { return resolvePublicPagePublisher() !== null; } catch { return false; }
}

// Absolute cap for the human message the client renders.
export const UPDATE_SNAPSHOT_MESSAGE_CAP = 300;

// A machine error code: short identifier only, never free text.
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

// Only failure/rollback states carry a non-null failedPhase + errorCode; active
// and success states derive none. `cancelled` (T-1730 W7) is a clean terminal
// state, NOT a failure: it is deliberately absent so the client renders no red
// error panel for an owner-cancelled deferral.
export const UPDATE_FAILURE_STATES = new Set([
    'failed', 'rolled_back', 'rollback_pending', 'manual_recovery_required',
]);

/**
 * Redact URL userinfo and token-like values, collapse absolute filesystem paths
 * to their basename, and cap the length. Returns null for empty/non-string.
 */
export function sanitizeUpdateJobMessage(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    let out = raw
        // Strip credentials embedded in URLs: scheme://user:token@host → scheme://host
        .replace(/([a-zA-Z][\w+.-]*:\/\/)[^/\s@]+@/g, '$1')
        // Redact token-like assignments (token=…, "api_key": …, Authorization: …)
        .replace(/((?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|secret|authorization)"?\s*[=:]\s*"?)\S+/gi, '$1…')
        // Collapse absolute filesystem paths to their basename (or "…")
        .replace(/(?:\/[^\s/\\:*?"<>|]+)+\/?/g, (match) => {
            const trimmed = match.replace(/\/+$/, '');
            const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
            return base || '…';
        })
        .trim();
    if (out.length > UPDATE_SNAPSHOT_MESSAGE_CAP) out = `${out.slice(0, UPDATE_SNAPSHOT_MESSAGE_CAP - 1)}…`;
    return out.length > 0 ? out : null;
}

/** Bounds for the structured drift lists (T-1804): a UI hint, not a file browser. */
const DRIFT_MAX_SAMPLE = 20;
const DRIFT_MAX_PATH_LENGTH = 200;
const DRIFT_GROUPS = ['unexpected', 'missing', 'changed'];
// A dist-relative path and nothing else: no leading `/`, no `..`, no backslash,
// no control bytes. Anything failing this is dropped, so no absolute filesystem
// path can ride this channel into the browser.
const DRIFT_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*(?:\/[A-Za-z0-9][A-Za-z0-9._@-]*)*$/;

/** One validated `{ total, sample }` group, or null when the shape is wrong. */
function normalizeDriftGroup(value) {
    if (!value || typeof value !== 'object') return null;
    if (!Number.isSafeInteger(value.total) || value.total < 0) return null;
    if (!Array.isArray(value.sample)) return null;
    const sample = value.sample
        .filter((item) => typeof item === 'string' && item.length <= DRIFT_MAX_PATH_LENGTH
            && DRIFT_PATH_PATTERN.test(item))
        .slice(0, DRIFT_MAX_SAMPLE);
    return { total: value.total, sample };
}

/**
 * Validate the manifest-drift detail into the exact shape the client renders.
 *
 * This is the reason the paths survive at all: `sanitizeUpdateJobMessage` folds
 * every `a/b/c` in free text down to `c`, so a drifted path named inside the
 * message reached the operator as a filename that exists nowhere. A structured,
 * shape-checked field bypasses that filter honestly — the filter exists to stop
 * ABSOLUTE paths and secrets, and `DRIFT_PATH_PATTERN` refuses both by
 * construction rather than by trusting the producer.
 *
 * @param {unknown} details the thrown error's `details`, from any source.
 * @param {{publisherInstalled?: () => boolean}} [options] whether this host can
 *   run the public-page publisher; decided here, at read time, because the
 *   producer is inlined into the OID capsule and must not locate itself.
 * @returns {{unexpected: object, missing: object, changed: object,
 *   recoveryCommandAvailable: boolean}|null} null when it is not drift detail.
 */
export function normalizeManifestDrift(details, { publisherInstalled = isPublicPagePublisherInstalled } = {}) {
    if (!details || typeof details !== 'object') return null;
    const groups = {};
    for (const group of DRIFT_GROUPS) {
        const normalized = normalizeDriftGroup(details[group]);
        if (!normalized) return null;
        groups[group] = normalized;
    }
    if (!DRIFT_GROUPS.some((group) => groups[group].total > 0)) return null;
    return { ...groups, recoveryCommandAvailable: publisherInstalled() === true };
}

/**
 * Flatten the failure cause the client depends on. The staging worker records
 * error_code/error_message on the job row; activation failures (system.js) do
 * not write to the row — their code lives only in the last rollback/recovery
 * receipt (facts.code / facts.failedPhase). failedPhase is the phase the job
 * was in when it failed: the last rollback/recovery receipt's facts.failedPhase,
 * else that receipt's phase (which the worker sets to the job state at failure).
 *
 * @param {{ id: string, state: string, error_code?: string, error_message?: string }} job
 * @param {{ listReceipts: (id: string) => Array<Record<string, unknown>> }} jobsDb
 */
export function deriveUpdateJobFailure(job, jobsDb) {
    if (!UPDATE_FAILURE_STATES.has(job.state)) {
        return { failedPhase: null, errorCode: null, message: null, manifestDrift: null };
    }
    let errorCode = (typeof job.error_code === 'string' && job.error_code) ? job.error_code : null;
    let message = sanitizeUpdateJobMessage(job.error_message);
    let failedPhase = null;
    let receiptCode = null;
    let receiptMessage = null;
    let manifestDrift = null;
    let receipts = [];
    try { receipts = jobsDb.listReceipts(job.id) || []; } catch { receipts = []; }
    for (const row of receipts) {
        if (row.kind !== 'rollback' && row.kind !== 'recovery') continue;
        let facts = {};
        try { facts = JSON.parse(row.facts_json) || {}; } catch { facts = {}; }
        const phase = (typeof facts.failedPhase === 'string' && facts.failedPhase) ? facts.failedPhase : row.phase;
        if (typeof phase === 'string' && phase) failedPhase = phase;
        if (typeof facts.code === 'string' && facts.code) receiptCode = facts.code;
        if (typeof facts.message === 'string') receiptMessage = facts.message;
        // T-1804: revalidated on the way OUT too — the receipt is durable, so a
        // row written by an older or tampered build is not trusted on read.
        manifestDrift = normalizeManifestDrift(facts.manifestDrift) || manifestDrift;
    }
    errorCode = errorCode || receiptCode;
    // Activation may record a raw error message as its code; never expose it as one.
    if (errorCode && !ERROR_CODE_PATTERN.test(errorCode)) {
        receiptMessage = receiptMessage || errorCode;
        errorCode = 'unknown';
    }
    message = message || sanitizeUpdateJobMessage(receiptMessage);
    return { failedPhase: failedPhase || null, errorCode, message, manifestDrift };
}

/**
 * Build the `deferral` snapshot field (ADR-156 §3.3, M15). deadlineAt and
 * rearmCount come from the durable job row; sessionCount and gateReason are LIVE
 * values the server reads at request time (they are not persisted on the row).
 * Returns null unless the job is parked in awaiting_sessions, so the field only
 * appears while a deferral is actually waiting.
 *
 * @param {{ state?: string, deferral_deadline_at?: number|null, deferral_rearm_count?: number|null }} job
 * @param {{ sessionCount?: number|null, gateReason?: string|null }} [live]
 */
export function deriveUpdateJobDeferral(job, live = {}) {
    if (!job || job.state !== 'awaiting_sessions') return null;
    const deadlineAt = Number.isFinite(Number(job.deferral_deadline_at)) && job.deferral_deadline_at != null
        ? Number(job.deferral_deadline_at) : null;
    const rearmCount = Number.isSafeInteger(Number(job.deferral_rearm_count))
        ? Number(job.deferral_rearm_count) : 0;
    const sessionCount = Number.isSafeInteger(Number(live.sessionCount)) && live.sessionCount != null
        ? Number(live.sessionCount) : null;
    const gateReason = typeof live.gateReason === 'string' && live.gateReason.length > 0
        ? live.gateReason : null;
    return { deadlineAt, sessionCount, gateReason, rearmCount };
}
