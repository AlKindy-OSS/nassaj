/**
 * Declared session-deferral scheduler (T-1730 W7, ADR-156 §3.3).
 *
 * A standalone loop — never inside the updater call, which would block the
 * fence and never survive a restart — that advances jobs parked in
 * `awaiting_sessions`. Its rules, all owner-safe and kill-free:
 *
 *  - Promote to `accepted` only when BOTH counters read zero (M2): the
 *    in-process governed-session counter AND the command-board `/proc` gate,
 *    across two samples one debounce apart. The first zero sample stamps
 *    `idle_observed_at`; a session reappearing before the second resets it.
 *  - Expiry to `failed(deferral_expired)` once the absolute deadline passes —
 *    on every tick and once at boot.
 *  - `failed(deferral_capability_lost)` when the node has lost update
 *    capability, INDEPENDENT of the worker (which is never even built in that
 *    state), so a parked job never blocks every future update forever (M7).
 *  - A single owner push when a deferred job reaches `restart_queued` (M3), via
 *    an injected notifier — the command-board confirmation stays human.
 *
 * It presses no restart and confirms nothing itself. Every dependency is
 * injected so the loop is deterministic under test.
 */

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_DEBOUNCE_MS = 30_000;

export function createUpdateDeferralScheduler({
    jobs,
    countGovernedActiveSessions,
    readGateSessionCount,
    isReleaseSourceInvalid = () => false,
    wakeWorker = () => undefined,
    notifyOwner = () => undefined,
    auditLog = null,
    now = Date.now,
    intervalMs = DEFAULT_INTERVAL_MS,
    idleDebounceMs = DEFAULT_IDLE_DEBOUNCE_MS,
} = {}) {
    if (!jobs || typeof jobs.listAwaitingSessions !== 'function') {
        throw new TypeError('update deferral scheduler requires a jobs repository');
    }
    if (typeof countGovernedActiveSessions !== 'function' || typeof readGateSessionCount !== 'function') {
        throw new TypeError('update deferral scheduler requires both session counters');
    }

    const alerted = new Set();
    let ticking = false;
    let stopped = false;
    let timer = null;

    const audit = (action, job, extra = {}) => {
        try {
            auditLog?.record?.({ action, resource: 'source_update_job', resourceId: job.id,
                userId: job.owner_id ?? null, ...extra });
        } catch { /* audit is best-effort; never fail the tick */ }
    };

    // A counter that throws must BLOCK promotion, never wave it through: return a
    // non-zero sentinel so "both zero" cannot be satisfied on missing data.
    const inProcessCount = () => {
        try {
            const value = countGovernedActiveSessions();
            return Number.isSafeInteger(value) && value >= 0 ? value : 1;
        } catch { return 1; }
    };
    const readGate = async () => {
        try {
            const result = await readGateSessionCount();
            const count = Number.isSafeInteger(result?.count) && result.count >= 0 ? result.count : 1;
            const reason = typeof result?.reason === 'string' ? result.reason : null;
            return { count, reason };
        } catch { return { count: 1, reason: 'gate_unavailable' }; }
    };

    // The gate reason of the most recent tick, surfaced to the waiting panel.
    let lastGateReason = null;

    const alertQueued = () => {
        for (const job of jobs.listRestartQueuedDeferred?.() || []) {
            if (alerted.has(job.id)) continue;
            alerted.add(job.id);
            try { notifyOwner({ userId: job.owner_id, jobId: job.id }); } catch { /* push is best-effort */ }
            audit('update_deferral_awaiting_confirmation', job);
        }
    };

    const tick = async () => {
        if (ticking || stopped) return;
        ticking = true;
        try {
            const waiting = jobs.listAwaitingSessions();
            if (waiting.length && isReleaseSourceInvalid()) {
                // Capability loss is terminal and worker-independent.
                for (const job of waiting) {
                    if (jobs.failDeferred(job.id, 'deferral_capability_lost',
                        'The node can no longer perform source updates.')) {
                        audit('update_deferral_capability_lost', job);
                    }
                }
            } else if (waiting.length) {
                const nowMs = now();
                const stillWaiting = [];
                for (const job of waiting) {
                    const deadline = Number(job.deferral_deadline_at) || 0;
                    if (deadline > 0 && nowMs >= deadline) {
                        if (jobs.failDeferred(job.id, 'deferral_expired',
                            'The deferred update waited past its maximum window.')) {
                            audit('update_deferral_expired', job);
                        }
                    } else {
                        stillWaiting.push(job);
                    }
                }
                if (stillWaiting.length) {
                    // Read BOTH counters once for the whole tick (M2). The gate
                    // is a /proc walk (a spawn), so only consult it when the
                    // in-process counter is already zero; otherwise sessions are
                    // live and the panel shows the count, not a gate reason.
                    const inProc = inProcessCount();
                    const gate = inProc === 0 ? await readGate() : { count: 1, reason: null };
                    const idle = inProc === 0 && gate.count === 0;
                    lastGateReason = idle ? null : gate.reason;
                    for (const job of stillWaiting) {
                        if (!idle) { jobs.clearIdleObservation(job.id); continue; }
                        if (job.idle_observed_at == null) { jobs.recordIdleObservation(job.id, nowMs); continue; }
                        if (nowMs - Number(job.idle_observed_at) >= idleDebounceMs) {
                            if (jobs.promoteIdle(job.id)) {
                                audit('update_deferral_promoted', job);
                                try { wakeWorker(); } catch { /* worker kick is best-effort */ }
                            }
                        }
                    }
                }
            }
            alertQueued();
        } finally {
            ticking = false;
        }
    };

    // At boot: expire what timed out while down, and resume the debounce from
    // zero for the rest (a pre-restart idle sample is not trustworthy).
    const reconcileOnStartup = () => {
        try { jobs.expireDeferrals(now()); } catch { /* boot must not crash on this */ }
        for (const job of jobs.listAwaitingSessions()) {
            try { jobs.clearIdleObservation(job.id); } catch { /* best-effort */ }
        }
    };

    return Object.freeze({
        tick,
        reconcileOnStartup,
        getLastGateReason: () => lastGateReason,
        start() {
            if (timer || stopped) return;
            reconcileOnStartup();
            timer = setInterval(() => { void tick(); }, intervalMs);
            timer.unref?.();
            void tick();
        },
        stop() { stopped = true; if (timer) clearInterval(timer); timer = null; },
    });
}
