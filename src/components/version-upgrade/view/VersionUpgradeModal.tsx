import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Clock, Loader2 } from "lucide-react";

import { authenticatedFetch } from "../../../utils/api";
import { ReleaseInfo } from "../../../types/sharedTypes";
import { copyTextToClipboard } from "../../../utils/clipboard";
import type { InstallMode } from "../../../hooks/useVersionCheck";
import {
    clearStoredUpdateAttempt,
    createIdempotencyKey,
    GIT_CHECKOUT_V2_PHASES,
    inferStrategy,
    isTerminalUpdateState,
    normalizeUpdateJob,
    phaseListForStrategy,
    pollingDelay,
    readStoredUpdateAttempt,
    RELEASE_LAYOUT_V2_PHASES,
    safeStatusPath,
    storeUpdateAttempt,
    updateJobPercent,
    type StoredUpdateAttempt,
    type ManifestDrift,
    type UpdateJobSnapshot,
    type UpdateJobState,
} from "../updateJobClient";
import { useUpdatePreflight } from "../useUpdatePreflight";
import { UpdatePreflightNotice } from "./UpdatePreflightNotice";
import { UpdateTerminalLog } from "./UpdateTerminalLog";
import { UpdateConsentPanel } from "./UpdateConsentPanel";
import { DeferralWaitingPanel } from "./DeferralWaitingPanel";

type Translate = ReturnType<typeof useTranslation>['t'];

/** What the restart_queued box says when the owner consented at start (T-1751). */
function autoActivationMessage(job: UpdateJobSnapshot, t: Translate): string {
    const status = job.autoActivation;
    if (status?.state === 'waiting_sessions') {
        return t('versionUpdate.autoActivate.waiting', { count: status.liveSessions ?? 0 });
    }
    if (status?.state === 'restarting') return t('versionUpdate.autoActivate.restarting');
    if (status?.state === 'expired') return t('versionUpdate.autoActivate.expired');
    if (status?.state === 'refused') return t('versionUpdate.autoActivate.refused', { code: status.code ?? 'unknown' });
    return t('versionUpdate.autoActivate.pending');
}

interface VersionUpgradeModalProps {
    isOpen: boolean;
    onClose: () => void;
    releaseInfo: ReleaseInfo | null;
    /** The RUNNING version (runtimeVersion, falling back to source) — ADR-156 M1. */
    currentVersion: string;
    /**
     * The working tree's version. Shown on its own row only when it differs
     * from the running one: staged but not activated, or a degraded reopen
     * that left the source at the target (ADR-156 ب.5).
     */
    sourceVersion?: string | null;
    latestVersion: string | null;
    installMode: InstallMode;
    /**
     * B-1055 (ADR-156 WI-5): a build is already staged or promoted on this node
     * and only its governed activation is still owed. Rendered as an explicit
     * third state so the modal never reads as "nothing to do" in the one window
     * where the owner must act.
     */
    updatePrepared?: boolean;
}

interface LocalUpdateStatus {
    oid: string;
    available: boolean;
    activationReady: boolean;
    blockedReasonCode?: string;
    policy?: { mode: 'disabled' | 'dev-full-auto'; revision: number; available: boolean };
    serverLoadedOid?: string | null;
    pendingOid?: string | null;
    waitReasonCode?: string | null;
    update: { sequence: number; revision: number; oid: string; phase: string; targetDigest: string | null; consentExpiresAt?: number | null; authorityKind?: 'manual' | 'policy' | null; outcome: string | null } | null;
}

interface UpdateCapability {
    loading: boolean;
    ready: boolean;
    strategy?: string;
    reason?: string;
}

/** Terminal state translation key — kept for terminal states per spec. */
const terminalStatusKey = (state: UpdateJobState): string | null => {
    if (state === 'activated') return 'versionUpdate.jobStatus.verified';
    if (state === 'rollback_pending' || state === 'rolled_back') return 'versionUpdate.jobStatus.rollback';
    if (state === 'manual_recovery_required') return 'versionUpdate.jobStatus.manual';
    if (state === 'failed') return 'versionUpdate.jobStatus.failed';
    if (state === 'superseded') return 'versionUpdate.jobStatus.superseded';
    // T-1730: cancelled is terminal but not a failure — neutral message, no red panel.
    if (state === 'cancelled') return 'versionUpdate.deferral.cancelledMessage';
    return null;
};

const FAILURE_STATES = new Set<UpdateJobState>([
    'failed', 'rolled_back', 'rollback_pending', 'manual_recovery_required', 'superseded',
    // Note: 'cancelled' is intentionally NOT here — it is terminal but not a failure.
]);

/** Resolve which strategy's phase list to show, falling back to git-checkout-v2. */
function resolvePhases(job: UpdateJobSnapshot): ReadonlyArray<UpdateJobState> {
    const strategy = inferStrategy(job.state, job.strategy);
    return phaseListForStrategy(strategy);
}

/**
 * Resolve which phase index is "failed". Uses `failedPhase` from server if present,
 * otherwise falls back to the current job state if it is a failure state.
 */
function resolveFailedPhaseIndex(
    job: UpdateJobSnapshot,
    phases: ReadonlyArray<UpdateJobState>,
): number {
    if (!FAILURE_STATES.has(job.state)) return -1;
    const fp = job.failedPhase;
    if (fp) {
        const idx = phases.indexOf(fp as UpdateJobState);
        if (idx !== -1) return idx;
    }
    // Fall back to the last known active state visible in the phase list.
    const stateIdx = phases.indexOf(job.state);
    if (stateIdx !== -1) return stateIdx;
    // If the failure state itself (e.g. 'failed') isn't in the list, mark the last phase before terminal.
    return Math.max(0, phases.length - 2);
}

// ─── Phase Stepper ────────────────────────────────────────────────────────────

interface PhaseStepperProps {
    job: UpdateJobSnapshot;
}

function PhaseStepper({ job }: PhaseStepperProps) {
    const { t } = useTranslation('common');
    const phases = resolvePhases(job);
    const strategy = inferStrategy(job.state, job.strategy);
    const isFailed = FAILURE_STATES.has(job.state);
    const isSuccess = job.state === 'activated';

    const currentIdx = isFailed || isSuccess
        ? phases.length  // all phases "passed" visually on success; failed handled separately
        : phases.indexOf(job.state);
    const failedIdx = resolveFailedPhaseIndex(job, phases);

    // For activated: show all completed. For active states: up to currentIdx - 1 are completed.
    const completedCount = isSuccess ? phases.length : (currentIdx === -1 ? 0 : currentIdx);

    const percent = updateJobPercent(job.state, strategy ?? undefined);
    const phaseNumber = currentIdx === -1 ? (isSuccess ? phases.length : phases.length) : currentIdx + 1;
    const displayPhaseNumber = isSuccess ? phases.length : (isFailed ? Math.max(0, failedIdx + 1) : phaseNumber);
    const total = phases.length;

    return (
        <div className="space-y-3">
            {/* Progress summary line */}
            {percent !== null && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                        {t('versionUpdate.stepperProgress', {
                            current: displayPhaseNumber,
                            total,
                            percent,
                        })}
                    </span>
                    <span dir="ltr" className="tabular-nums font-medium">
                        {percent}%
                    </span>
                </div>
            )}

            {/* Thin progress bar */}
            {!isSuccess && !isFailed && (
                <div
                    role="progressbar"
                    aria-label={percent !== null
                        ? t('versionUpdate.ariaLabels.updateProgress', { percent })
                        : t('versionUpdate.ariaLabels.updateInProgress')}
                    {...(percent !== null
                        ? { 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 }
                        : { 'aria-busy': 'true' })}
                    className="relative h-1 w-full overflow-hidden rounded-full bg-blue-100 motion-reduce:hidden dark:bg-blue-900/40"
                >
                    {percent !== null && job.state !== 'restart_queued' ? (
                        /* Determinate fill — logical start so it fills correctly in RTL */
                        <div
                            aria-hidden="true"
                            className="absolute top-0 bottom-0 h-full rounded-full bg-blue-500 transition-[width] duration-500 ease-out dark:bg-blue-400"
                            style={{ insetInlineStart: 0, width: `${percent}%` }}
                        />
                    ) : (
                        /* Indeterminate / paused bar for restart_queued.
                           design-ok: `left-0` is physical on purpose — the
                           `indeterminate-bar` keyframes translate on the
                           physical X axis, and RTL is handled by reversing the
                           animation direction, not by moving the anchor. */
                        <div
                            aria-hidden="true"
                            className="absolute left-0 top-0 bottom-0 h-full w-1/3 rounded-full bg-amber-400 animate-indeterminate-bar rtl:[animation-direction:reverse] motion-reduce:hidden dark:bg-amber-500"
                        />
                    )}
                </div>
            )}

            {/* Phase list */}
            <ol
                aria-label={t('versionUpdate.stepperAriaLabel')}
                className="space-y-1"
            >
                {phases.map((phase, idx) => {
                    const isCompleted = isSuccess || (isFailed ? idx < failedIdx : idx < completedCount);
                    const isCurrent = !isFailed && !isSuccess && idx === currentIdx;
                    const isFailedPhase = isFailed && idx === failedIdx;
                    const isFuture = !isCompleted && !isCurrent && !isFailedPhase;
                    const isRestartQueued = isCurrent && phase === 'restart_queued';
                    const phaseKey = phase === 'restart_queued' && job.autoActivate ? 'restart_queued_auto' : phase;

                    return (
                        <li
                            key={phase}
                            aria-current={isCurrent ? 'step' : undefined}
                            className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                                isCurrent
                                    ? 'bg-blue-50 dark:bg-blue-950/30'
                                    : isFailedPhase
                                    ? 'bg-red-50 dark:bg-red-950/20'
                                    : ''
                            }`}
                        >
                            {/* Phase icon */}
                            <span className="mt-0.5 shrink-0">
                                {isCompleted && (
                                    <CheckCircle2
                                        aria-hidden="true"
                                        className="h-4 w-4 text-green-600 dark:text-green-400"
                                    />
                                )}
                                {isRestartQueued && (
                                    <Clock
                                        aria-hidden="true"
                                        className="h-4 w-4 text-amber-500 dark:text-amber-400"
                                    />
                                )}
                                {isCurrent && !isRestartQueued && (
                                    <Loader2
                                        aria-hidden="true"
                                        className="h-4 w-4 animate-spin text-blue-600 motion-reduce:animate-none dark:text-blue-400"
                                    />
                                )}
                                {isFailedPhase && (
                                    <AlertCircle
                                        aria-hidden="true"
                                        className="h-4 w-4 text-red-600 dark:text-red-400"
                                    />
                                )}
                                {isFuture && (
                                    <span
                                        aria-hidden="true"
                                        className="flex h-4 w-4 items-center justify-center"
                                    >
                                        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
                                    </span>
                                )}
                            </span>

                            {/* Phase name + description */}
                            <div className="min-w-0 flex-1">
                                <span
                                    className={`font-medium leading-tight ${
                                        isFuture
                                            ? 'text-muted-foreground/50'
                                            : isFailedPhase
                                            ? 'text-red-700 dark:text-red-300'
                                            : isCurrent
                                            ? 'text-foreground'
                                            : 'text-muted-foreground'
                                    }`}
                                >
                                    {t(`versionUpdate.phases.${phaseKey}.name`)}
                                </span>
                                {isCurrent && (
                                    <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                                        {t(`versionUpdate.phases.${phaseKey}.description`)}
                                    </p>
                                )}
                                {isFailedPhase && (
                                    <p className="mt-0.5 text-xs leading-snug text-red-600/80 dark:text-red-400/80">
                                        {t(`versionUpdate.phases.${phaseKey}.description`)}
                                    </p>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ol>

            {/* Owner action text for restart_queued */}
            {job.state === 'restart_queued' && (job.autoActivate
                && job.autoActivation?.state !== 'expired' && job.autoActivation?.state !== 'refused' ? (
                <div
                    role="status"
                    className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-800/50 dark:bg-blue-950/30 dark:text-blue-200"
                >
                    {autoActivationMessage(job, t)}
                </div>
            ) : (
                <div
                    role="status"
                    className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200"
                >
                    {job.autoActivate ? autoActivationMessage(job, t) : t('versionUpdate.ownerActionRequired')}
                </div>
            ))}
        </div>
    );
}

// ─── Error Panel ──────────────────────────────────────────────────────────────

interface ErrorPanelProps {
    job: UpdateJobSnapshot;
}

function ErrorPanel({ job }: ErrorPanelProps) {
    const { t } = useTranslation('common');
    const code = job.errorCode || 'unknown';
    const titleKey = `versionUpdate.errorCodes.${code}.title`;
    const hintKey = `versionUpdate.errorCodes.${code}.hint`;

    // Fall back to generic "unknown" if the code key doesn't exist.
    const title = t(titleKey, { defaultValue: t('versionUpdate.errorCodes.unknown.title') });
    const hint = t(hintKey, { defaultValue: t('versionUpdate.errorCodes.unknown.hint') });

    return (
        <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs dark:border-red-900/40 dark:bg-red-900/20"
        >
            <p className="font-semibold text-red-800 dark:text-red-200">{title}</p>
            <p className="mt-1 text-red-700 dark:text-red-300">{hint}</p>
            {job.message && (
                <p className="mt-1 text-red-600/70 dark:text-red-400/70">
                    <bdi>{job.message}</bdi>
                </p>
            )}
            {job.manifestDrift && <ManifestDriftList drift={job.manifestDrift} />}
        </div>
    );
}

/**
 * The drifted file names, inside the panel that already reports the failure.
 *
 * They arrive as a structured field and not inside `message` on purpose: the
 * server sanitizes that message and folds every `a/b/c` to `c`, which turned
 * `uqud-x/lifetrip/logo.svg` into a filename the operator could not find
 * (T-1804). Paths are dist-relative and rendered as plain text — `<bdi>` keeps
 * a Latin path readable inside the Arabic panel.
 */
function ManifestDriftList({ drift }: { drift: ManifestDrift }) {
    const { t } = useTranslation('common');
    const groups = (['unexpected', 'missing', 'changed'] as const)
        .map((key) => ({ key, group: drift[key] }))
        .filter(({ group }) => group.total > 0);
    if (groups.length === 0) return null;
    return (
        <div className="mt-2 space-y-1 text-red-700 dark:text-red-300">
            {groups.map(({ key, group }) => (
                <div key={key}>
                    <p className="font-medium">{t(`versionUpdate.manifestDrift.${key}`, { count: group.total })}</p>
                    <ul className="mt-0.5 list-disc ps-4 marker:text-red-400">
                        {group.sample.map((file) => (
                            <li key={file} className="break-all font-mono text-[11px]"><bdi>{file}</bdi></li>
                        ))}
                    </ul>
                    {group.total > group.sample.length && (
                        <p className="ps-4 text-red-600/70 dark:text-red-400/70">
                            {t('versionUpdate.manifestDrift.more', { count: group.total - group.sample.length })}
                        </p>
                    )}
                </div>
            ))}
            <p className="text-red-600/80 dark:text-red-400/80">
                {t(drift.recoveryCommandAvailable
                    ? 'versionUpdate.manifestDrift.recoveryAvailable'
                    : 'versionUpdate.manifestDrift.recoveryUnavailable')}
            </p>
        </div>
    );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function responseJson(response: Response): Promise<Record<string, unknown>> {
    return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

// ─── Modal ───────────────────────────────────────────────────────────────────

export function VersionUpgradeModal({
    isOpen,
    onClose,
    releaseInfo,
    currentVersion,
    sourceVersion = null,
    latestVersion,
    updatePrepared = false,
    installMode,
}: VersionUpgradeModalProps) {
    const { t } = useTranslation('common');
    const upgradeCommand = installMode === 'npm' ? t('versionUpdate.npmUpgradeCommand') : null;
    const [job, setJob] = useState<UpdateJobSnapshot | null>(null);
    const [updateError, setUpdateError] = useState('');
    const [reused, setReused] = useState(false);
    const [capability, setCapability] = useState<UpdateCapability>({ loading: true, ready: false });
    /**
     * Phase 1 (T-1730): When true the consent panel is rendered in place of the
     * "Update Now" button. Set to false on cancel or after the POST is submitted.
     */
    const [showConsent, setShowConsent] = useState(false);
    const [hostMode, setHostMode] = useState<'release' | 'local-main'>('release');
    const [localStatus, setLocalStatus] = useState<LocalUpdateStatus | null>(null);
    const [localBusy, setLocalBusy] = useState(false);
    const [localDisconnected, setLocalDisconnected] = useState(false);
    const localConsentRef = useRef<string | null>(null);
    const policyAttemptRef = useRef<{ mode: string; revision: number; key: string } | null>(null);
    const localAttemptRef = useRef<{ oid: string; key: string } | null>(null);

    const refreshLocalStatus = useCallback(async () => {
        const response = await authenticatedFetch('/api/system/update/local');
        if (!response.ok) throw new Error('local_status_unavailable');
        const data = await response.json();
        if (data.mode !== 'local-main' || !/^[a-f0-9]{40}$/.test(data.oid)) throw new Error('local_status_invalid');
        if (['cancelled', 'failed', 'superseded', 'activated'].includes(data.update?.phase)) localAttemptRef.current = null;
        setLocalStatus(data);
        setLocalDisconnected(false);
    }, []);

    useEffect(() => {
        if (!isOpen || hostMode !== 'local-main') return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try { await refreshLocalStatus(); } catch { if (!stopped) setLocalDisconnected(true); }
            if (!stopped) timer = setTimeout(poll, 5_000);
        };
        void poll();
        return () => { stopped = true; clearTimeout(timer); };
    }, [hostMode, isOpen, refreshLocalStatus]);

    const submitLocalUpdate = useCallback(async (action: 'prepare' | 'confirm' | 'cancel') => {
        if (!localStatus || localBusy) return;
        const update = localStatus.update;
        if (action !== 'prepare' && !update) return;
        if (action === 'confirm' && localConsentRef.current !== JSON.stringify([update!.sequence, update!.revision, update!.targetDigest])) {
            setShowConsent(false); setUpdateError(t('versionUpdate.local.failed')); return;
        }
        if (!localAttemptRef.current || localAttemptRef.current.oid !== localStatus.oid) {
            localAttemptRef.current = { oid: localStatus.oid, key: createIdempotencyKey() };
        }
        setLocalBusy(true);
        setUpdateError('');
        try {
            const response = await authenticatedFetch(`/api/system/update/local/${action === 'prepare' ? 'prepare' : `${update!.sequence}/${action}`}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Idempotency-Key': localAttemptRef.current.key },
                body: JSON.stringify(action === 'prepare' ? { expectedOid: localStatus.oid }
                    : { expectedRevision: update!.revision, targetDigest: update!.targetDigest }),
            });
            if (!response.ok) {
                const data = await responseJson(response);
                setUpdateError(t(`versionUpdate.local.errors.${data.code}`, { defaultValue: t('versionUpdate.local.failed') }));
            } else {
                setShowConsent(false);
                if (action === 'cancel') localAttemptRef.current = null;
            }
            await refreshLocalStatus();
        } catch { setLocalDisconnected(true); }
        finally { setLocalBusy(false); }
    }, [localBusy, localStatus, refreshLocalStatus, t]);
    const changeDevelopmentPolicy = useCallback(async () => {
        const policy = localStatus?.policy;
        if (!policy || localBusy || localDisconnected) return;
        const mode = policy.mode === 'dev-full-auto' ? 'disabled' : 'dev-full-auto';
        if (policyAttemptRef.current?.mode !== mode || policyAttemptRef.current.revision !== policy.revision) {
            policyAttemptRef.current = { mode, revision: policy.revision, key: createIdempotencyKey() };
        }
        setLocalBusy(true); setUpdateError('');
        try {
            const response = await authenticatedFetch('/api/system/update/local/policy', {
                method: 'PUT', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': policyAttemptRef.current.key },
                body: JSON.stringify({ mode, expectedRevision: policy.revision }),
            });
            if (!response.ok) {
                const data = await responseJson(response);
                setUpdateError(t(`versionUpdate.local.errors.${data.code}`, { defaultValue: t('versionUpdate.local.failed') }));
            } else policyAttemptRef.current = null;
            await refreshLocalStatus();
        } catch { setLocalDisconnected(true); }
        finally { setLocalBusy(false); }
    }, [localBusy, localDisconnected, localStatus, refreshLocalStatus, t]);
    const pollTimerRef = useRef<number | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const lifecycleRef = useRef(0);
    const submissionRef = useRef(0);

    const stopPolling = useCallback(() => {
        if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
        abortRef.current?.abort();
        abortRef.current = null;
    }, []);

    const pollJob = useCallback((attempt: StoredUpdateAttempt, pollNumber = 0) => {
        const statusPath = safeStatusPath(attempt.statusUrl);
        if (!statusPath) {
            clearStoredUpdateAttempt();
            setUpdateError(t('versionUpdate.errors.invalidStatusUrl'));
            return;
        }

        const schedule = (nextPoll: number, requestedDelay?: unknown) => {
            const serverDelay = typeof requestedDelay === 'number' && Number.isFinite(requestedDelay)
                ? Math.max(500, Math.min(requestedDelay, 30_000))
                : pollingDelay(nextPoll);
            pollTimerRef.current = window.setTimeout(() => pollJob(attempt, nextPoll), serverDelay);
        };

        const controller = new AbortController();
        abortRef.current = controller;
        void authenticatedFetch(statusPath, { signal: controller.signal })
            .then(async response => {
                const data = await responseJson(response);
                if (controller.signal.aborted) return;
                if (response.status === 401 || response.status === 403) {
                    setUpdateError(t('versionUpdate.errors.authorization'));
                    return;
                }
                if (response.status === 404) {
                    clearStoredUpdateAttempt();
                    setJob(null);
                    return;
                }
                if (!response.ok) {
                    schedule(pollNumber + 1, data.retryAfterMs);
                    return;
                }
                const snapshot = normalizeUpdateJob(data, statusPath);
                setJob(snapshot);
                setUpdateError('');
                if (isTerminalUpdateState(snapshot.state)) {
                    if (snapshot.state !== 'manual_recovery_required') clearStoredUpdateAttempt();
                    return;
                }
                schedule(pollNumber + 1, data.retryAfterMs);
            })
            .catch(error => {
                if (controller.signal.aborted) return;
                if (error instanceof DOMException && error.name === 'AbortError') return;
                schedule(pollNumber + 1);
            });
    }, [t]);

    useEffect(() => {
        if (!isOpen || installMode !== 'git') return;
        let cancelled = false;
        lifecycleRef.current += 1;
        const submission = submissionRef.current;
        setCapability({ loading: true, ready: false });
        void fetch('/health', { cache: 'no-store' })
            .then(response => responseJson(response))
            .then(data => {
                if (cancelled) return;
                setHostMode(data.updateMode === 'local-main' ? 'local-main' : 'release');
                const systemUpdate = data.systemUpdate && typeof data.systemUpdate === 'object'
                    ? data.systemUpdate as Record<string, unknown>
                    : data;
                const protocol = systemUpdate.updaterProtocol;
                const ready = systemUpdate.updateReady === true && protocol === 'async-v2';
                setCapability({
                    loading: false,
                    ready,
                    strategy: typeof systemUpdate.updaterStrategy === 'string' ? systemUpdate.updaterStrategy : undefined,
                    reason: typeof systemUpdate.blockedReasonCode === 'string'
                        ? systemUpdate.blockedReasonCode
                        : ready ? undefined : 'protocol_unavailable',
                });
            })
            .catch(() => {
                if (!cancelled) setCapability({ loading: false, ready: false, reason: 'capability_unavailable' });
            });

        const stored = readStoredUpdateAttempt();
        if (stored?.statusUrl) {
            setJob({ state: 'accepted', statusUrl: stored.statusUrl, targetVersion: stored.targetVersion });
            pollJob(stored);
        }
        const discovery = new AbortController();
        void authenticatedFetch('/api/system/update/jobs/active', { signal: discovery.signal })
            .then(async response => {
                const data = await responseJson(response);
                if (cancelled || submissionRef.current !== submission) return;
                if (response.status === 401 || response.status === 403) {
                    stopPolling();
                    setUpdateError(t('versionUpdate.errors.authorization'));
                    return;
                }
                if (!response.ok || !data.job || typeof data.job !== 'object') return;
                const active = data.job as Record<string, unknown>;
                const statusUrl = safeStatusPath(active.statusUrl);
                const snapshot = normalizeUpdateJob(active, statusUrl ?? undefined);
                if (!statusUrl || typeof active.jobId !== 'string'
                    || typeof active.targetVersion !== 'string' || isTerminalUpdateState(snapshot.state)) return;
                const attempt: StoredUpdateAttempt = {
                    idempotencyKey: createIdempotencyKey(), jobId: active.jobId, statusUrl,
                    targetVersion: active.targetVersion, createdAt: Date.now(),
                };
                stopPolling();
                storeUpdateAttempt(attempt);
                setJob(snapshot);
                setReused(true);
                pollJob(attempt);
            })
            .catch(() => { /* Older servers may not support discovery; keep the stored snapshot. */ });
        return () => {
            cancelled = true;
            lifecycleRef.current += 1;
            discovery.abort();
            stopPolling();
        };
    }, [installMode, isOpen, pollJob, stopPolling, t]);

    // ADR-156 أ.5 (H4): diagnose once per opening, as soon as the updater is
    // ready and no job is being resumed, so a blocker is on screen — and Start
    // is disabled — before the owner reaches for it.
    const { state: preflight, run: runPreflight, reset: resetPreflight } = useUpdatePreflight();
    const autoPreflightRef = useRef(false);
    useEffect(() => {
        if (!isOpen) {
            autoPreflightRef.current = false;
            resetPreflight();
            return;
        }
        if (hostMode === 'local-main' || installMode !== 'git' || !capability.ready || job || autoPreflightRef.current) return;
        autoPreflightRef.current = true;
        void runPreflight();
    }, [capability.ready, hostMode, installMode, isOpen, job, resetPreflight, runPreflight]);

    // ── Shared: submit a job POST and handle the common response codes ────────

    const submitJobPost = useCallback(async (
        body: Record<string, unknown>,
        attempt: StoredUpdateAttempt,
    ) => {
        const lifecycle = lifecycleRef.current;
        submissionRef.current += 1;
        try {
            const response = await authenticatedFetch('/api/system/update/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.idempotencyKey },
                body: JSON.stringify(body),
            });
            const data = await responseJson(response);
            if (lifecycleRef.current !== lifecycle) return;
            const statusPath = safeStatusPath(data.statusUrl);

            if (response.status === 202 || (response.status === 409
                && ['update_job_active', 'update_in_progress'].includes(String(data.code)) && statusPath)) {
                const acceptedAttempt = {
                    ...attempt,
                    targetVersion: typeof data.targetVersion === 'string' ? data.targetVersion : attempt.targetVersion,
                    jobId: typeof data.jobId === 'string' ? data.jobId : undefined,
                    statusUrl: statusPath || undefined,
                };
                if (!acceptedAttempt.statusUrl) throw new Error('invalid_status_url');
                storeUpdateAttempt(acceptedAttempt);
                setReused(data.reused === true || response.status === 409);
                setJob(normalizeUpdateJob(data, acceptedAttempt.statusUrl));
                stopPolling();
                pollJob(acceptedAttempt, 0);
                return;
            }

            if (response.status === 401 || response.status === 403) {
                setUpdateError(t('versionUpdate.errors.authorization'));
            } else if (response.status === 429) {
                setUpdateError(t('versionUpdate.errors.rateLimited'));
            } else if (response.status === 409 && data.code === 'idempotency_payload_mismatch') {
                clearStoredUpdateAttempt();
                setUpdateError(t('versionUpdate.errors.idempotencyMismatch'));
            } else if (response.status === 409 && data.code === 'update_consent_mismatch') {
                // Phase 1 (T-1730): server rejected because consent.version ≠ expectedVersion.
                setUpdateError(t('versionUpdate.errors.consentMismatch'));
            } else {
                const reason = typeof data.blockedReasonCode === 'string'
                    ? data.blockedReasonCode
                    : typeof data.code === 'string' ? data.code : 'failed';
                setUpdateError(t(`versionUpdate.blockedReasons.${reason}`, {
                    defaultValue: typeof data.error === 'string' ? data.error : t('versionUpdate.errors.failed'),
                }));
            }
            setJob(null);
        } catch (error) {
            if (lifecycleRef.current !== lifecycle) return;
            setUpdateError(error instanceof Error && error.message === 'invalid_status_url'
                ? t('versionUpdate.errors.invalidStatusUrl')
                : t('versionUpdate.errors.connection'));
            setJob(null);
        }
    }, [pollJob, stopPolling, t]);

    // ── Phase 1 (T-1730): "Update Now" → shows consent panel ─────────────────

    const handleUpdateNow = useCallback(async () => {
        if (!latestVersion) {
            setUpdateError(t('versionUpdate.errors.releaseUnavailable'));
            return;
        }
        if (!capability.ready) {
            setUpdateError(t(`versionUpdate.blockedReasons.${capability.reason}`, {
                defaultValue: t('versionUpdate.errors.capabilityBlocked'),
            }));
            return;
        }
        // Pre-flight before showing the consent panel: sessions or dirty tree
        // must be surfaced NOW, not after the owner reads the consent text.
        setUpdateError('');
        const verdict = await runPreflight();
        if (verdict.status !== 'clear') return;

        setShowConsent(true);
    }, [capability, latestVersion, runPreflight, t]);

    /** Start a distinct attempt after a terminal failure instead of reconfirming the dead job. */
    const handleRetryUpdate = useCallback(async () => {
        setJob(null);
        setReused(false);
        setShowConsent(false);
        await handleUpdateNow();
    }, [handleUpdateNow]);

    /**
     * Called when the owner confirms in the consent panel.
     * `activateWhenIdle: true` is ONLY emitted from here (T-1730 Phase 1).
     * `consent.version` matches what was displayed in the consent panel.
     */
    const handleConsentConfirm = useCallback(async () => {
        if (!latestVersion) return;
        setShowConsent(false);
        stopPolling();
        setReused(false);
        setJob({ state: 'accepted', targetVersion: latestVersion });
        const attempt: StoredUpdateAttempt = {
            idempotencyKey: createIdempotencyKey(),
            targetVersion: latestVersion,
            createdAt: Date.now(),
        };
        storeUpdateAttempt(attempt);
        await submitJobPost(
            {
                expectedVersion: latestVersion,
                activateWhenIdle: true,
                deferUntilIdle: true,
                // T-1730 Phase 1: consent must include the exact version shown in the panel.
                consent: { version: latestVersion },
            },
            attempt,
        );
    }, [latestVersion, stopPolling, submitJobPost]);

    // ── Phase 2 (T-1730 §3.3): "Prepare update" → deferUntilIdle ────────────

    /** Preparation during active sessions uses the same explicit activation consent. */
    const handlePrepareUpdate = useCallback(async () => {
        if (!latestVersion || !capability.ready) return;
        setUpdateError('');
        setShowConsent(true);
    }, [capability.ready, latestVersion]);

    /** Renew only the sealed target shown by the job, without creating another update. */
    const confirmPreparedRelease = useCallback(async () => {
        if (!job?.activationTargetDigest || !job.statusUrl || job.state !== 'restart_queued') { setShowConsent(false); return; }
        if (!showConsent) { setShowConsent(true); return; }
        try {
            const response = await authenticatedFetch(`${job.statusUrl}/confirm`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expectedVersion: job.targetVersion, targetDigest: job.activationTargetDigest }),
            });
            if (!response.ok) { setUpdateError(t('versionUpdate.local.failed')); return; }
            setShowConsent(false);
            setUpdateError('');
        } catch { setUpdateError(t('versionUpdate.errors.connection')); }
    }, [job, showConsent, t]);

    // ── Reset consent when the modal is closed ────────────────────────────────

    // Keep showConsent in sync: close the panel if the modal is hidden.
    // (The preflight reset in the existing useEffect already handles modal-close side effects.)
    useEffect(() => {
        if (!isOpen) setShowConsent(false);
    }, [isOpen]);

    if (!isOpen) return null;

    if (hostMode === 'local-main') {
        const update = localStatus?.update;
        const phase = update?.phase ?? 'idle';
        const buildWait = localStatus?.waitReasonCode?.startsWith('local_update_build_') ? localStatus.waitReasonCode : null;
        const canPrepare = !update || ['cancelled', 'failed', 'superseded', 'activated'].includes(phase);
        const canConfirm = update?.authorityKind !== 'policy' && (phase === 'prepared' || (phase === 'awaiting_sessions' && (update?.consentExpiresAt ?? Infinity) <= Date.now()));
        const canCancel = ['preparing', 'prepared', 'awaiting_sessions'].includes(phase);
        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center">
                <button className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-label={t('versionUpdate.ariaLabels.closeModal')} />
                <div role="dialog" aria-modal="true" aria-labelledby="local-update-title" className="relative mx-4 max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-xl">
                    <h2 id="local-update-title" className="text-lg font-semibold text-foreground">{t('versionUpdate.title')}</h2>
                    <p className="text-sm text-muted-foreground">{t('versionUpdate.local.description')}</p>
                    <div className="flex items-center justify-between rounded-lg bg-muted p-3"><span>{t('versionUpdate.currentVersion')}</span><span dir="ltr" className="font-mono">{currentVersion}</span></div>
                    <div className="rounded-lg border border-border p-3 text-sm">{t('versionUpdate.local.target')} <bdi className="font-mono">{(update?.oid ?? localStatus?.oid)?.slice(0, 12) ?? '—'}</bdi></div>
                    {localStatus?.serverLoadedOid && <div className="rounded-lg border border-border p-3 text-sm">{t('versionUpdate.local.loaded')} <bdi className="font-mono">{localStatus.serverLoadedOid.slice(0, 12)}</bdi></div>}
                    {localStatus?.pendingOid && <p className="text-sm text-muted-foreground">{t('versionUpdate.local.pending')} <bdi className="font-mono">{localStatus.pendingOid.slice(0, 12)}</bdi></p>}
                    {localStatus?.policy && <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
                        <p>{t(localStatus.policy.mode === 'dev-full-auto' ? 'versionUpdate.local.policyEnabled' : 'versionUpdate.local.policyDisabled')}</p>
                        <p className="text-muted-foreground">{t('versionUpdate.local.policyDescription')}</p>
                        <button disabled={localBusy || localDisconnected || (localStatus.policy.mode === 'disabled' && !localStatus.policy.available)}
                            onClick={() => void changeDevelopmentPolicy()} className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50">
                            {t(localStatus.policy.mode === 'dev-full-auto' ? 'versionUpdate.local.disablePolicy' : 'versionUpdate.local.enablePolicy')}
                        </button>
                    </div>}
                    <p role="status" aria-live="polite" className="text-sm">{localDisconnected ? t('versionUpdate.local.reconnecting') : buildWait
                        ? t(`versionUpdate.local.waitReasons.${buildWait}`, { defaultValue: t('versionUpdate.local.buildWaiting') })
                        : t(`versionUpdate.local.phases.${phase}`, { defaultValue: t('versionUpdate.local.inProgress') })}</p>
                    {updateError && <p role="alert" className="text-sm text-destructive">{updateError}</p>}
                    {canConfirm && !localStatus?.activationReady && <p role="status" className="text-sm text-muted-foreground">{t('versionUpdate.local.activationUnavailable')}</p>}
                    {showConsent && canConfirm && <p className="rounded-lg border border-border bg-muted p-3 text-sm">{t('versionUpdate.local.consent')}</p>}
                    <div className="flex flex-wrap gap-2">
                        <button onClick={onClose} className="rounded-md bg-muted px-4 py-2 text-sm">{t('versionUpdate.buttons.close')}</button>
                        {canCancel && <button disabled={localBusy || localDisconnected} onClick={() => void submitLocalUpdate('cancel')} className="rounded-md bg-muted px-4 py-2 text-sm disabled:opacity-50">{t('versionUpdate.local.cancel')}</button>}
                        {canPrepare && localStatus?.available && <button disabled={localBusy || localDisconnected} onClick={() => void submitLocalUpdate('prepare')} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{t('versionUpdate.buttons.updateNow')}</button>}
                        {canConfirm && <button disabled={localBusy || localDisconnected || !localStatus?.activationReady} onClick={() => { if (showConsent) void submitLocalUpdate('confirm'); else { localConsentRef.current = JSON.stringify([update!.sequence, update!.revision, update!.targetDigest]); setShowConsent(true); } }} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{t(showConsent ? 'versionUpdate.local.confirm' : 'versionUpdate.local.activate')}</button>}
                        {phase === 'activated' && <button onClick={() => window.location.reload()} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">{t('versionUpdate.buttons.reload')}</button>}
                    </div>
                </div>
            </div>
        );
    }

    const jobActive = Boolean(job && !isTerminalUpdateState(job.state));
    const isFailed = Boolean(job && FAILURE_STATES.has(job.state));
    const termKey = job ? terminalStatusKey(job.state) : null;

    // T-1730: special active state — polling continues, but PhaseStepper is replaced
    // by DeferralWaitingPanel. 'cancelled' is terminal so jobActive would be false.
    const awaitingReleaseConfirmation = job?.state === 'restart_queued' && Boolean(job.activationTargetDigest)
        && (!job.autoActivate || ['expired', 'refused'].includes(job.autoActivation?.state ?? ''));

    const isDeferralWaiting = job?.state === 'awaiting_sessions';

    // Extract job ID from statusUrl for the cancel endpoint.
    const jobIdFromUrl = (url: string | undefined): string | null => {
        if (!url) return null;
        const parts = url.split('/');
        return parts[parts.length - 1]?.split('?')[0] || null;
    };

    // `idle` stays startable: the click itself runs the pre-flight first.
    const preflightChecking = preflight.status === 'checking';
    const startDisabled = capability.loading || !capability.ready
        || (preflight.status !== 'idle' && preflight.status !== 'clear');
    const startLabel = (label: string) => preflightChecking ? t('versionUpdate.preflight.checkingButton') : label;

    // Phase 2: show "Prepare Update" button when preflight is blocked by active_sessions.
    const isBlockedBySessions = preflight.status === 'blocked'
        && preflight.blocker.code === 'active_sessions';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <button className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-label={t('versionUpdate.ariaLabels.closeModal')} />
            <div role="dialog" aria-modal="true" aria-labelledby="version-update-title" className="relative mx-4 max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-xl">

                {/* Header */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
                            <svg className="h-5 w-5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" /></svg>
                        </div>
                        <div><h2 id="version-update-title" className="text-lg font-semibold text-foreground">{t('versionUpdate.title')}</h2><p className="text-sm text-muted-foreground">{releaseInfo?.title || t('versionUpdate.newVersionReady')}</p></div>
                    </div>
                    <button onClick={onClose} aria-label={t('versionUpdate.ariaLabels.closeModal')} className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"><svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
                </div>

                {/* Prepared-but-not-activated banner */}
                {updatePrepared && (
                    <div
                        role="status"
                        className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
                    >
                        {t('versionUpdate.preparedAwaitingActivation')}
                    </div>
                )}

                {/* Version rows */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between rounded-lg bg-muted p-3"><span className="text-sm font-medium text-foreground">{t('versionUpdate.currentVersion')}</span><span dir="ltr" className="font-mono text-sm text-foreground tabular-nums">{currentVersion}</span></div>
                    {sourceVersion && sourceVersion !== currentVersion && (
                        <div className="flex items-center justify-between rounded-lg border border-dashed border-border px-3 py-2">
                            <span className="text-xs text-muted-foreground">{t('versionUpdate.sourceVersionLabel')}</span>
                            <span dir="ltr" className="font-mono text-xs text-muted-foreground tabular-nums">{sourceVersion}</span>
                        </div>
                    )}
                    <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-700 dark:bg-blue-900/20"><span className="text-sm font-medium text-blue-700 dark:text-blue-300">{t('versionUpdate.latestVersion')}</span><span dir="ltr" className="font-mono text-sm text-blue-900 tabular-nums dark:text-blue-100">{latestVersion}</span></div>
                </div>

                {/* Changelog — hidden when consent panel is open to avoid visual noise */}
                {!showConsent && releaseInfo?.body && (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-medium text-foreground">{t('versionUpdate.whatsNew')}</h3>
                        </div>
                        <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-muted p-4">
                            <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm text-foreground dark:prose-invert">{cleanChangelog(releaseInfo.body)}</div>
                        </div>
                    </div>
                )}

                {/* Updater strategy / capability note */}
                {installMode === 'git' && !capability.loading && (
                    <div className={`rounded-md border px-3 py-2 text-xs ${capability.ready ? 'border-border bg-muted text-muted-foreground' : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200'}`}>
                        {capability.ready
                            ? t('versionUpdate.strategy', { strategy: capability.strategy || t('versionUpdate.strategyUnknown') })
                            : t(`versionUpdate.blockedReasons.${capability.reason}`, { defaultValue: t('versionUpdate.errors.capabilityBlocked') })}
                    </div>
                )}

                {/* Pre-flight notice — hide when consent or deferral panel is active */}
                {installMode === 'git' && capability.ready && !jobActive && !showConsent && (
                    <UpdatePreflightNotice state={preflight} onRecheck={() => void runPreflight()} />
                )}

                {/* ── Phase 1 (T-1730): Consent panel ─────────────────────────────── */}
                {showConsent && (job?.targetVersion || latestVersion) && (
                    <UpdateConsentPanel
                        targetVersion={job?.state === 'restart_queued' ? job.targetVersion! : latestVersion!}
                        releaseInfo={releaseInfo}
                        onConfirm={() => void (job ? confirmPreparedRelease() : handleConsentConfirm())}
                        onCancel={() => setShowConsent(false)}
                    />
                )}

                {/* ── Update progress — phase stepper + deferral + terminal summary ─ */}
                {(job || updateError) && (
                    <div className="space-y-2" aria-live="polite" aria-atomic="true">
                        <h3 className="text-sm font-medium text-foreground">{t('versionUpdate.updateProgress')}</h3>
                        {job?.targetVersion && (
                            <p className="text-xs text-muted-foreground">
                                {t('versionUpdate.consent.targetVersionLabel')} <span dir="ltr" className="font-mono">{job.targetVersion}</span>
                            </p>
                        )}

                        {/* Phase 2 (T-1730): Deferral waiting panel */}
                        {isDeferralWaiting && job?.deferral && (
                            <DeferralWaitingPanel
                                deferral={job.deferral}
                                jobId={jobIdFromUrl(job.statusUrl)}
                                onCancelled={() => {
                                    stopPolling();
                                    setJob(prev => prev ? { ...prev, state: 'cancelled' } : null);
                                    clearStoredUpdateAttempt();
                                }}
                            />
                        )}

                        {/* Phase stepper — skip for awaiting_sessions (handled above) */}
                        {job && (jobActive || isFailed) && !isDeferralWaiting && (
                            <div className="rounded-md border border-border bg-card p-3">
                                <PhaseStepper job={job} />
                            </div>
                        )}

                        {/* Error details for failed states */}
                        {job && isFailed && <ErrorPanel job={job} />}

                        {/* Live console of the updater's commands (T-1768) */}
                        {job?.statusUrl && <UpdateTerminalLog statusUrl={job.statusUrl} live={jobActive} />}

                        {/* Terminal summary */}
                        {job && termKey && (
                            <div className={`overflow-hidden rounded-md border ${
                                job.state === 'activated'
                                    ? 'border-green-200 bg-green-50 dark:border-green-800/50 dark:bg-green-950/30'
                                    // T-1730: cancelled is neutral, not red
                                    : job.state === 'cancelled'
                                    ? 'border-border bg-muted dark:border-border dark:bg-muted/50'
                                    : 'border-blue-200 bg-blue-50 dark:border-blue-900/50 dark:bg-blue-950/30'
                            }`}>
                                <div className={`flex items-center gap-2 px-3 py-3 text-sm ${
                                    job.state === 'activated'
                                        ? 'text-green-800 dark:text-green-200'
                                        : job.state === 'cancelled'
                                        ? 'text-muted-foreground'
                                        : 'text-blue-800 dark:text-blue-200'
                                }`}>
                                    {job.state === 'activated' && (
                                        <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                                    )}
                                    {(job.state === 'rolled_back' || job.state === 'rollback_pending' || job.state === 'manual_recovery_required') && (
                                        <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                                    )}
                                    <p className="flex-1">{t(termKey, { version: job.targetVersion || latestVersion })}</p>
                                </div>
                            </div>
                        )}

                        {reused && <p className="text-xs text-muted-foreground">{t('versionUpdate.reusedAttempt')}</p>}
                        {updateError && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200">{updateError}</div>}
                    </div>
                )}

                {/* Manual upgrade instructions (npm mode) */}
                {!jobActive && !job && upgradeCommand && <div className="space-y-3"><h3 className="text-sm font-medium text-foreground">{t('versionUpdate.manualUpgrade')}</h3><div className="rounded-lg border bg-muted p-3"><code className="font-mono text-sm text-foreground">{upgradeCommand}</code></div><p className="text-xs text-muted-foreground">{t('versionUpdate.manualUpgradeHint')}</p></div>}

                {/* Footer action buttons — hidden when the consent panel is open */}
                {!showConsent && (
                    <div className="flex flex-wrap gap-2 pt-2">
                        <button onClick={onClose} className="flex-1 rounded-md bg-muted px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent">
                            {job ? t('versionUpdate.buttons.close') : t('versionUpdate.buttons.later')}
                        </button>

                        {/* Copy npm command */}
                        {!jobActive && upgradeCommand && (
                            <button onClick={() => copyTextToClipboard(upgradeCommand)} className="flex-1 rounded-md bg-muted px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent">
                                {t('versionUpdate.buttons.copyCommand')}
                            </button>
                        )}

                        {awaitingReleaseConfirmation && <button onClick={() => void confirmPreparedRelease()} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">{t('versionUpdate.local.activate')}</button>}

                        {/* Reload after successful activation */}
                        {!jobActive && job?.state === 'activated' && (
                            <button onClick={() => window.location.reload()} className="flex-1 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                                {t('versionUpdate.buttons.reload')}
                            </button>
                        )}

                        {/* Retry after non-activated terminal state (but not cancelled — start fresh) */}
                        {job && !jobActive && job.state !== 'activated' && job.state !== 'manual_recovery_required' && job.state !== 'cancelled' && (
                            <button
                                onClick={() => void handleRetryUpdate()}
                                disabled={startDisabled}
                                aria-busy={preflightChecking || undefined}
                                className="flex flex-1 items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
                            >
                                {startLabel(t('versionUpdate.buttons.retry'))}
                            </button>
                        )}

                        {/* Phase 2 (T-1730): "Prepare update" when sessions block — primary action */}
                        {!job && !upgradeCommand && isBlockedBySessions && capability.ready && (
                            <button
                                onClick={() => void handlePrepareUpdate()}
                                className="flex flex-1 items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                            >
                                {t('versionUpdate.buttons.prepareUpdate')}
                            </button>
                        )}

                        {/* Phase 1 (T-1730): "Update Now" → opens consent panel */}
                        {!job && !upgradeCommand && !isBlockedBySessions && (
                            <button
                                onClick={() => void handleUpdateNow()}
                                disabled={startDisabled}
                                aria-busy={preflightChecking || undefined}
                                className="flex flex-1 items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
                            >
                                {startLabel(t('versionUpdate.buttons.updateNow'))}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

const cleanChangelog = (body: string) => body
    .replace(/\b[0-9a-f]{40}\b/gi, '')
    .replace(/(?:^|\s|-)([0-9a-f]{7,10})\b/gi, '')
    .replace(/\*\*Full Changelog\*\*:.*$/gim, '')
    .replace(/https?:\/\/github\.com\/[^/]+\/[^/]+\/compare\/[^\s)]+/gi, '')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
