/**
 * harness-update.contract — the WIRE CONTRACT for the per-harness version
 * indicator and direct update feature (T-1749 / ADR-159).
 *
 * It lives in the CROSS-SIDE `shared/` tree (not `server/shared/`) precisely so
 * BOTH sides compile against the same declaration: the first cut of the client
 * hook invented its own `{ status, version, progressPercent }` shape and silently
 * never matched the server's `{ state, installedVersion, upToDate, … }`.
 * `src/hooks/useHarnessVersion.ts` imports these types and derives its UI state
 * from them; `useHarnessVersion.contract.test.ts` feeds the mapper a fixture
 * typed as `HarnessVersionStatus`, so a server-side rename breaks the build.
 *
 * Endpoints (all under /api/providers, behind authenticateToken; the two
 * mutating/owner surfaces additionally behind requireRole('owner')):
 *
 *   GET  /api/providers/:id/version-status      → HarnessVersionStatus
 *   GET  /api/providers/version-status          → HarnessVersionStatus[]
 *   POST /api/providers/:id/update              → HarnessUpdateAccepted (409 on running, 403 non-owner)
 *   GET  /api/providers/update-jobs/:jobId      → HarnessUpdateJob
 *   GET  /api/providers/autoupdate-settings     → HarnessAutoUpdateSettings
 *   PUT  /api/providers/autoupdate-settings     → HarnessAutoUpdateSettings
 *
 * `:id` is a harness id — the provider registry id where one exists
 * (`claude`, `codex`, `antigravity`, `cursor`, `opencode`, `qwen`, `kimi`,
 * `hermes`, `glm`, `deepseek`). The route also accepts the aliases `agy`
 * (→ antigravity) and `cursor-agent` (→ cursor) and normalises them.
 */

/**
 * Coarse state the UI renders as a badge:
 *   - `updatable`         a user-owned install with a working updater and probe
 *   - `managed-external`  installed but nassaj cannot update it in place
 *   - `no-cli`            no local CLI (hosted API: deepseek; glm rides opencode)
 *   - `unknown`           installed but the latest-version probe could not run
 *                         (network failure with no fresh cache) — never a crash
 */
export type HarnessVersionState =
  | 'updatable'
  | 'managed-external'
  | 'no-cli'
  | 'unknown';

/** One harness row for the settings "agents" tab. */
export interface HarnessVersionStatus {
  /** Harness id (see module header). */
  provider: string;
  state: HarnessVersionState;
  /** Installed version string, or null when no CLI / unreadable. */
  installedVersion: string | null;
  /** Latest published version, or null when unknown / no-cli. */
  latestVersion: string | null;
  /**
   * true when installed === latest; false when an update is available; null
   * when it cannot be decided (unknown/no-cli).
   */
  upToDate: boolean | null;
  /** true only when the update button should be actionable for this harness. */
  updatable: boolean;
  /** Machine reason when not updatable / not up to date (e.g. `pinned`,
   * `managed-external`, `no-cli`, `probe-failed`); null otherwise. */
  reason: string | null;
  /** ISO timestamp the status (esp. the latest probe) was computed. */
  checkedAt: string;
  /** true when an update job for this harness is currently running. */
  updating: boolean;
  /** The running job id, or null. */
  activeJobId: string | null;
}

/** 202/200 body of POST /:id/update when a job is accepted. */
export interface HarnessUpdateAccepted {
  jobId: string;
  provider: string;
  status: HarnessUpdateJobStatus;
}

/** 409 body of POST /:id/update when a job is already running for the harness. */
export interface HarnessUpdateConflict {
  activeJobId: string;
}

export type HarnessUpdateJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped_live_session'
  | 'refused_pinned';

/** Coarse phase within a running/finished job, for the progress UI. */
export type HarnessUpdateJobPhase =
  | 'queued'
  | 'preflight'
  | 'updating'
  | 'verifying'
  | 'recovering'
  | 'done';

/**
 * Machine error codes a job can carry (ADR-159 Addendum 3 "contract deltas"):
 *   - `pinned_refused`      the digest pin is armed over a pinned harness
 *   - `live_session_active` the atomic no-live-session gate rejected the run
 *   - `installation_unrecognized` no exact installed version or supported path
 *   - `dirty_installation` a git-backed install has local changes
 *   - `update_failed` / `update_timeout` / `verify_failed` / `no_update_argv`
 *     / `update_exception` the update itself did not complete
 */
export interface HarnessUpdateJobError {
  code: string;
  /** English operator-facing message (never a raw command or env). */
  message: string;
  /** Arabic rendering of the same message (UI is ar-first). */
  messageAr?: string;
}

/** GET /update-jobs/:jobId body. */
export interface HarnessUpdateJob {
  jobId: string;
  provider: string;
  status: HarnessUpdateJobStatus;
  phase: HarnessUpdateJobPhase;
  /** 0–100 integer. */
  percent: number;
  /** Sanitized, append-only log lines (no secrets, no env). */
  log: string[];
  fromVersion: string | null;
  toVersion: string | null;
  error: HarnessUpdateJobError | null;
}

/** GET/PUT /autoupdate-settings body. */
export interface HarnessAutoUpdateSettings {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
}
