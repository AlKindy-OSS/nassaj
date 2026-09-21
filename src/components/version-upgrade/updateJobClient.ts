export const UPDATE_ATTEMPT_STORAGE_KEY = 'nassaj:update-attempt:v2';

export type UpdateJobState =
  | 'accepted'
  | 'resolving'
  | 'resolved'
  | 'downloading'
  | 'archive_verified'
  | 'extracting'
  | 'staging'
  | 'candidate_sealed'
  /** T-1730: job is holding until all sessions end; no worker, no fence. */
  | 'awaiting_sessions'
  | 'restart_queued'
  | 'activating'
  | 'runtime_verifying'
  | 'activated'
  | 'rollback_pending'
  | 'rolled_back'
  | 'failed'
  | 'superseded'
  /** T-1730: owner cancelled the deferred job; terminal, no error. */
  | 'cancelled'
  | 'manual_recovery_required';

export interface StoredUpdateAttempt {
  idempotencyKey: string;
  jobId?: string;
  statusUrl?: string;
  targetVersion: string;
  createdAt: number;
}

/**
 * Deferral snapshot embedded in the job snapshot while the job is in
 * `awaiting_sessions`. Built server-side only; the UI never writes it.
 * All timestamps are Unix-epoch milliseconds.
 * (T-1730 §3.3, M15)
 */
export interface DeferralStatus {
  /** When the scheduler will fail the job with `deferral_expired`. */
  deadlineAt: number | null;
  /** Total live session count across both counters (in-process + command-board). */
  sessionCount: number | null;
  /** `reasonCode` from the command-board gate that last observed sessions. */
  gateReason: string | null;
  /** How many times the worker has been rearmed after an `active_sessions` throw. */
  rearmCount: number;
}

/** Where the server's automatic activation stands (T-1751). */
export interface AutoActivationStatus {
  state: 'waiting_row' | 'waiting_sessions' | 'restarting' | 'refused' | 'expired';
  liveSessions: number | null;
  code: string | null;
  deadlineAt: number | null;
}

export interface UpdateJobSnapshot {
  state: UpdateJobState;
  statusUrl?: string;
  targetVersion?: string;
  reason?: string;
  strategy?: string;
  message?: string;
  /** Flat failure fields (T-1750 new server contract). */
  errorCode?: string | null;
  failedPhase?: string | null;
  /** The owner consented to activation when starting the job (T-1751). */
  activationTargetDigest?: string | null;
  autoActivate?: boolean;
  autoActivation?: AutoActivationStatus | null;
  /** Present while the job is in `awaiting_sessions` (T-1730 §3.3). */
  deferral?: DeferralStatus | null;
  /** Which client-asset files drifted, when the failure was a manifest mismatch (T-1804). */
  manifestDrift?: ManifestDrift | null;
}

/** One drift group: how many files, and a bounded sample of dist-relative paths. */
export interface ManifestDriftGroup {
  total: number;
  sample: string[];
}

export interface ManifestDrift {
  unexpected: ManifestDriftGroup;
  missing: ManifestDriftGroup;
  changed: ManifestDriftGroup;
  recoveryCommandAvailable: boolean;
}

/**
 * The server already shape-checks this field, but the client never trusts a
 * response body: a path here is rendered as text, so it is re-filtered to
 * dist-relative names only rather than assumed safe.
 */
function normalizeDriftGroup(value: unknown): ManifestDriftGroup | null {
  if (!value || typeof value !== 'object') return null;
  const group = value as { total?: unknown; sample?: unknown };
  if (!Number.isSafeInteger(group.total) || (group.total as number) < 0) return null;
  const sample = Array.isArray(group.sample)
    ? group.sample.filter((item): item is string =>
      typeof item === 'string' && item.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/.test(item)).slice(0, 20)
    : [];
  return { total: group.total as number, sample };
}

function normalizeManifestDrift(value: unknown): ManifestDrift | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const unexpected = normalizeDriftGroup(source.unexpected);
  const missing = normalizeDriftGroup(source.missing);
  const changed = normalizeDriftGroup(source.changed);
  if (!unexpected || !missing || !changed) return null;
  return { unexpected, missing, changed, recoveryCommandAvailable: source.recoveryCommandAvailable === true };
}

function normalizeDeferral(value: unknown): DeferralStatus | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  return {
    deadlineAt: typeof raw.deadlineAt === 'number' ? raw.deadlineAt : null,
    sessionCount: typeof raw.sessionCount === 'number' ? raw.sessionCount : null,
    gateReason: typeof raw.gateReason === 'string' ? raw.gateReason : null,
    rearmCount: typeof raw.rearmCount === 'number' ? raw.rearmCount : 0,
  };
}

const AUTO_ACTIVATION_STATES = new Set(['waiting_row', 'waiting_sessions', 'restarting', 'refused', 'expired']);

function normalizeAutoActivation(value: unknown): AutoActivationStatus | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.state !== 'string' || !AUTO_ACTIVATION_STATES.has(raw.state)) return null;
  return {
    state: raw.state as AutoActivationStatus['state'],
    liveSessions: typeof raw.liveSessions === 'number' ? raw.liveSessions : null,
    code: typeof raw.code === 'string' ? raw.code : null,
    deadlineAt: typeof raw.deadlineAt === 'number' ? raw.deadlineAt : null,
  };
}

const UPDATE_STATES: UpdateJobState[] = [
  'accepted', 'resolving', 'resolved', 'downloading', 'archive_verified', 'extracting',
  'staging', 'candidate_sealed', 'awaiting_sessions', 'restart_queued', 'activating',
  'runtime_verifying', 'activated', 'rollback_pending', 'rolled_back', 'failed',
  'superseded', 'cancelled', 'manual_recovery_required',
];

/**
 * Ordered success-path phases for the git-checkout-v2 strategy (9 phases).
 * Matches the approved phase model (architect + devops + qa-critic, T-1748/T-1750).
 */
export const GIT_CHECKOUT_V2_PHASES: ReadonlyArray<UpdateJobState> = [
  'accepted',
  'resolving',
  'resolved',
  'staging',
  'candidate_sealed',
  'restart_queued',
  'activating',
  'runtime_verifying',
  'activated',
] as const;

/**
 * Ordered success-path phases for the release-layout-v2 strategy (11 phases).
 * This strategy is being frozen; kept for backward compatibility.
 */
export const RELEASE_LAYOUT_V2_PHASES: ReadonlyArray<UpdateJobState> = [
  'accepted',
  'resolving',
  'resolved',
  'downloading',
  'archive_verified',
  'extracting',
  'candidate_sealed',
  'restart_queued',
  'activating',
  'runtime_verifying',
  'activated',
] as const;

/**
 * Kept for backward-compat: the legacy flat list that was used before per-strategy
 * phases were introduced. Tests and consumers referencing it still compile.
 * @deprecated Use GIT_CHECKOUT_V2_PHASES or RELEASE_LAYOUT_V2_PHASES.
 */
export const UPDATE_PROGRESS_STATES: ReadonlyArray<UpdateJobState> = GIT_CHECKOUT_V2_PHASES;

/**
 * Select the phase list for a given strategy string.
 * - 'release-layout-v2' → RELEASE_LAYOUT_V2_PHASES
 * - any other / absent  → GIT_CHECKOUT_V2_PHASES (the active strategy)
 * Terminal failure states are not in any phase list and return null.
 */
export function phaseListForStrategy(strategy?: string): ReadonlyArray<UpdateJobState> {
  return strategy === 'release-layout-v2' ? RELEASE_LAYOUT_V2_PHASES : GIT_CHECKOUT_V2_PHASES;
}

/**
 * Infer the strategy from the state when the server does not provide one.
 * - State exclusive to git-checkout-v2 (staging) → 'git-checkout-v2'
 * - State in git-checkout-v2 list → 'git-checkout-v2' (safe default)
 * - Otherwise (release-layout-v2-only states with no declared strategy) → undefined
 */
export function inferStrategy(state: UpdateJobState, declared?: string): string | undefined {
  if (declared) return declared;
  if (GIT_CHECKOUT_V2_PHASES.includes(state)) return 'git-checkout-v2';
  return undefined;
}

/**
 * Returns an integer 0–100 for each success-path phase, or `null` when the
 * state is a failure/rollback terminal or an unknown value.
 *
 * When `strategy` is absent the function infers it from `state`
 * (git-checkout-v2 if the state appears in that list, else null).
 *
 * Guarantees:
 *  - Monotonically increasing along each phase list.
 *  - Only `activated` returns 100.
 *  - Failure states return null.
 *  - Unknown states return null.
 */
export function updateJobPercent(state: UpdateJobState, strategy?: string): number | null {
  const effectiveStrategy = inferStrategy(state, strategy);
  if (!effectiveStrategy) return null;
  const phases = phaseListForStrategy(effectiveStrategy);
  const index = phases.indexOf(state);
  if (index === -1) return null;
  return Math.round((index / (phases.length - 1)) * 100);
}

export const isTerminalUpdateState = (state: UpdateJobState) =>
  state === 'activated' || state === 'rolled_back' || state === 'manual_recovery_required'
  || state === 'failed' || state === 'superseded'
  // T-1730: cancelled is terminal (not an error; owner voluntarily stopped the deferred job)
  || state === 'cancelled';

/**
 * Normalize a raw server payload into a typed UpdateJobSnapshot.
 *
 * Accepts BOTH wire shapes:
 *  - OLD (pre-T-1750): { state, expectedVersion, error: { code, message }, strategy }
 *  - NEW (T-1750+):    { state, targetVersion, errorCode, message, failedPhase, strategy }
 *
 * Both shapes may coexist in the same response for backward compatibility.
 */
export function normalizeUpdateJob(payload: unknown, fallbackStatusUrl?: string): UpdateJobSnapshot {
  const source = payload && typeof payload === 'object'
    ? ((payload as Record<string, unknown>).job as Record<string, unknown> | undefined) ?? payload as Record<string, unknown>
    : {};
  const rawState = String(source.state ?? source.status ?? 'accepted').toLowerCase().replace(/-/g, '_');
  const state = UPDATE_STATES.includes(rawState as UpdateJobState)
    ? rawState as UpdateJobState
    : 'accepted';

  // targetVersion: prefer new flat field, fall back to old `expectedVersion`, then `version`
  const targetVersion =
    typeof source.targetVersion === 'string' ? source.targetVersion
    : typeof source.expectedVersion === 'string' ? source.expectedVersion
    : typeof source.version === 'string' ? source.version
    : undefined;

  // errorCode: prefer new flat field, fall back to nested error.code
  const nestedError = source.error && typeof source.error === 'object'
    ? source.error as Record<string, unknown>
    : null;
  const errorCode =
    typeof source.errorCode === 'string' ? source.errorCode
    : nestedError && typeof nestedError.code === 'string' ? nestedError.code
    : null;

  // message: prefer new flat field, fall back to nested error.message
  const message =
    typeof source.message === 'string' ? source.message
    : nestedError && typeof nestedError.message === 'string' ? nestedError.message
    : undefined;

  const failedPhase = typeof source.failedPhase === 'string' ? source.failedPhase : null;

  return {
    state,
    statusUrl: typeof source.statusUrl === 'string' ? source.statusUrl : fallbackStatusUrl,
    targetVersion,
    reason: typeof source.reason === 'string'
      ? source.reason
      : typeof source.code === 'string' ? source.code : undefined,
    strategy: typeof source.strategy === 'string' ? source.strategy : undefined,
    message,
    errorCode,
    failedPhase,
    activationTargetDigest: typeof source.activationTargetDigest === 'string' && /^[a-f0-9]{64}$/.test(source.activationTargetDigest) ? source.activationTargetDigest : null,
    autoActivate: source.autoActivate === true,
    autoActivation: normalizeAutoActivation(source.autoActivation),
    deferral: normalizeDeferral(source.deferral),
    manifestDrift: normalizeManifestDrift(source.manifestDrift),
  };
}

export function readStoredUpdateAttempt(): StoredUpdateAttempt | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(UPDATE_ATTEMPT_STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.idempotencyKey !== 'string' || typeof parsed.targetVersion !== 'string') return null;
    if (parsed.jobId !== undefined && typeof parsed.jobId !== 'string') return null;
    if (parsed.statusUrl !== undefined && typeof parsed.statusUrl !== 'string') return null;
    if (typeof parsed.createdAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function storeUpdateAttempt(attempt: StoredUpdateAttempt) {
  localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
}

export function clearStoredUpdateAttempt() {
  localStorage.removeItem(UPDATE_ATTEMPT_STORAGE_KEY);
}

export function createIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Old embedded browsers still get an RFC 4122-shaped, per-attempt key.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** Accept only an API path on this origin; never poll a URL supplied by another origin. */
export function safeStatusPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin || !parsed.pathname.startsWith('/api/system/update/jobs/')) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export const pollingDelay = (attempt: number) => Math.min(1_000 * (2 ** attempt), 10_000);
