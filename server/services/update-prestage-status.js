/**
 * ADR-207 §7 S5 (T-2024): the owner-facing view of the update prestager.
 *
 * The prestager's internal `status()` carries raw reason codes (some with a
 * free-form suffix such as `blocked:<preflight code>` or `failed:<error>`).
 * The UI needs a small, closed vocabulary it can translate, so this module
 * folds the internal status into {@link OwnerPrestageStatus}. It is pure and
 * never throws; anything it does not recognise becomes `other`.
 *
 * Owner-only: the route attaches it for the owner role alone.
 */

/**
 * @typedef {'none'|'waiting'|'quarantine'|'building'|'ready'|'adopted'} OwnerPrestageState
 *   - `none`: nothing to prepare (up to date, not started) or prestaging is off
 *     (`notPrestagedReason` then says why: policy_off, kill_switch, unsupported_mode)
 *   - `waiting`: a newer release is known but is not being prepared now; `notPrestagedReason` says why
 *   - `quarantine`: the release is held by the quarantine window until `quarantineUntil`
 *   - `building`: being prepared in the background
 *   - `ready`: prepared; the next click adopts it (this is the in-app badge signal)
 *   - `adopted`: taken over by an update job
 */

/**
 * @typedef {'settling'|'quarantine'|'policy_off'|'kill_switch'|'unsupported_mode'|'not_owner_node'
 *   |'release_unverified'|'job_active'|'maintenance'|'blocked'|'low_memory'|'low_disk'|'resource_busy'
 *   |'backoff'|'failed'|'interrupted'|'rejected'|'slot_busy'|'discovery_failed'|'other'} NotPrestagedReason
 */

/**
 * @typedef {object} OwnerPrestageStatus
 * @property {OwnerPrestageState} state
 * @property {string|null} version            release the slot is about (null when none)
 * @property {string|null} quarantineUntil    ISO time the quarantine ends (state `quarantine` only)
 * @property {NotPrestagedReason|null} notPrestagedReason  why it is not prepared (none/waiting/quarantine)
 * @property {string|null} readySince         ISO time the candidate became ready (state `ready` only)
 */

const EXACT_REASONS = Object.freeze({
    settling: 'settling',
    quarantine: 'quarantine',
    policy_off: 'policy_off',
    killed: 'kill_switch',
    update_mode_not_release: 'unsupported_mode',
    platform_mode: 'unsupported_mode',
    update_host_not_ready: 'unsupported_mode',
    strategy_not_git_checkout: 'unsupported_mode',
    not_owner_node: 'not_owner_node',
    release_unverified: 'release_unverified',
    job_active: 'job_active',
    low_memory: 'low_memory',
    low_disk: 'low_disk',
    resource_ceiling_cpu: 'resource_busy',
    resource_ceiling_memory: 'resource_busy',
    resource_unavailable: 'resource_busy',
    failed_backoff: 'backoff',
    failed_gave_up: 'failed',
    superseded: 'interrupted',
    job_claimed: 'interrupted',
    drain: 'interrupted',
    stopped: 'interrupted',
    disabled: 'interrupted',
    slot_busy_elsewhere: 'slot_busy',
    build_in_progress: 'slot_busy',
    gate_closed: 'maintenance',
    oid_admission_pending: 'maintenance',
    oid_pair_identity: 'maintenance',
});

const PREFIX_REASONS = Object.freeze([
    ['journal_', 'maintenance'],
    ['blocked:', 'blocked'],
    ['failed:', 'failed'],
    ['cycle_failed:', 'failed'],
    ['rejected:', 'rejected'],
    ['discovery_failed:', 'discovery_failed'],
]);

/** The closed UI reason for an internal reason code; null for no code. */
export function normalizePrestageReason(code) {
    if (typeof code !== 'string' || !code) return null;
    if (Object.hasOwn(EXACT_REASONS, code)) return EXACT_REASONS[code];
    const prefix = PREFIX_REASONS.find(([head]) => code.startsWith(head));
    return prefix ? prefix[1] : 'other';
}

const SILENT_CODES = new Set(['up_to_date', 'not_started']);

/**
 * Fold the prestager's internal status into the owner-facing shape.
 * @param {Record<string, unknown> | null | undefined} status  `updatePrestager.status()`
 * @returns {OwnerPrestageStatus}
 */
export function toOwnerPrestageStatus(status) {
    const base = { state: 'none', version: null, quarantineUntil: null, notPrestagedReason: null, readySince: null };
    if (!status || typeof status !== 'object') return base;
    const version = typeof status.version === 'string' ? status.version : null;
    const reason = SILENT_CODES.has(status.reasonCode) ? null : normalizePrestageReason(status.reasonCode);
    switch (status.state) {
        case 'ready':
            return { ...base, state: 'ready', version, readySince: typeof status.readyAt === 'string' ? status.readyAt : null };
        case 'adopted':
            return { ...base, state: 'adopted', version };
        case 'building':
            return { ...base, state: 'building', version };
        case 'off':
            return { ...base, notPrestagedReason: reason };
        default:
            break;
    }
    if (reason === 'quarantine' && version) {
        return { ...base, state: 'quarantine', version, notPrestagedReason: 'quarantine',
            quarantineUntil: typeof status.quarantineUntil === 'string' ? status.quarantineUntil : null };
    }
    if (!version) return { ...base, notPrestagedReason: reason };
    return { ...base, state: 'waiting', version, notPrestagedReason: reason ?? 'other' };
}
