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
 *   POST /api/providers/:id/restore-compatible  → HarnessUpdateAccepted (opencode only)
 *   POST /api/providers/:id/rollback            → HarnessUpdateAccepted
 *   POST /api/providers/:id/recovery            → HarnessUpdateAccepted | HarnessRecoveryAcknowledged
 *   GET  /api/providers/:id/snapshots           → HarnessSnapshotSummary[]
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
 *   - `unknown`           the version cannot be read safely (mid-update or a
 *                         failed recovery). A failed latest probe is NOT this:
 *                         it stays `updatable` with reason `probe-failed`.
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
  /**
   * Installed version changed since Nassaj last saw it WITHOUT a Nassaj update
   * job recording the change (vendor auto-updater, manual shell update, …).
   * Optional for backward compatibility; absent when the ledger is unavailable.
   */
  drift?: HarnessVersionDrift;
  /** T-1871: only the owner's button updates this harness (scheduler skips it). */
  manualOnly?: boolean;
  /** T-1871: facts the update dialog must state (agy today); absent = none. */
  notices?: HarnessUpdateNotices;
  /** T-1871: restoring a known release is offered (opencode only). */
  restoreCompatible?: HarnessRestoreCompatibleOffer;
}

/** Dialog facts for one harness (qa condition 8). */
export interface HarnessUpdateNotices {
  /** The harness's own data is NOT backed up before an update. */
  dataNotBackedUp: boolean;
  /** The CLI may update itself outside Nassaj (auto-updater not proven off). */
  selfUpdating: boolean;
}

/** The known release the restore action installs. */
export interface HarnessRestoreCompatibleOffer {
  version: string;
  /**
   * false until a real restore run on this host succeeded (qa condition 4);
   * the UI must not present the path as verified before then.
   */
  verified: boolean;
}

/** Out-of-band version change detected by the status read (T-1871 stage 2). */
export type HarnessVersionDrift =
  | { detected: false }
  | {
      detected: true;
      /** Version Nassaj saw last. */
      from: string;
      /** Version installed now. */
      to: string;
      /** ISO timestamp the change was first observed. */
      at: string;
    };

/** 202/200 body of POST /:id/update when a job is accepted. */
export interface HarnessUpdateAccepted {
  jobId: string;
  provider: string;
  status: HarnessUpdateJobStatus;
}

/** 409 body of POST /:id/update when a job is already running for the harness. */
export interface HarnessUpdateConflict {
  /** Always `HARNESS_UPDATE_IN_PROGRESS` (optional only for older servers). */
  code?: 'HARNESS_UPDATE_IN_PROGRESS';
  activeJobId: string;
}

/**
 * Machine codes of a refused harness action. Every 409 carries one; 423/507
 * and 404 carry one too.
 */
export type HarnessActionErrorCode =
  | 'HARNESS_UPDATE_IN_PROGRESS'
  | 'HARNESS_RECOVERY_FAILED'
  | 'LIVE_SESSION_ACTIVE'
  | 'CONFIRMATION_REQUIRED'
  | 'SNAPSHOT_TAMPERED'
  | 'ORIGIN_NAME_CONFLICT'
  | 'SNAPSHOT_LAYOUT_MISMATCH'
  | 'STORE_IN_USE'
  | 'STORE_ACCESS_UNPROVABLE'
  | 'INSUFFICIENT_STORAGE'
  | 'SNAPSHOT_COUNT_CAP'
  | 'NOT_RESTORE_COMPATIBLE'
  | 'SNAPSHOT_NOT_FOUND'
  | 'NO_RECOVERY_PENDING'
  | 'RECOVERY_UNVERIFIED'
  | 'INVALID_ROLLBACK_SCOPE'
  | 'INVALID_RECOVERY_ACTION';

/** Generic refusal body (no path, member id or command ever appears). */
export interface HarnessActionError {
  code: HarnessActionErrorCode | string;
  message: string;
}

/** One acknowledgement the server requires before a risky action. */
export interface HarnessRequiredAck {
  kind: 'pinBreak' | 'dataLoss';
  /** Single-use, 5 minutes, bound to user + harness + action + facts. */
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  textEn: string;
  textAr: string;
  /** Server facts the texts were built from. */
  facts: Record<string, unknown>;
}

/** 409 CONFIRMATION_REQUIRED body; resend the action with `acks`. */
export interface HarnessConfirmationRequired {
  code: 'CONFIRMATION_REQUIRED';
  required: HarnessRequiredAck[];
}

/** `acks` entry of a POST body: echo `kind` + `token` of each required ack. */
export interface HarnessSuppliedAck {
  kind: 'pinBreak' | 'dataLoss';
  token: string;
}

/** POST /:id/update and /:id/restore-compatible body (all optional). */
export interface HarnessUpdateRequest {
  acks?: HarnessSuppliedAck[];
}

/** POST /:id/rollback body. */
export interface HarnessRollbackRequest {
  jobId: string;
  scope: 'binary' | 'binary+data';
  acks?: HarnessSuppliedAck[];
}

/** POST /:id/recovery body (owner exit from `rollback_failed`). */
export interface HarnessRecoveryRequest {
  /** `retry` re-runs the restore; `acknowledge` accepts the current install. */
  action: 'retry' | 'acknowledge';
}

/** 200 body of an acknowledged recovery. */
export interface HarnessRecoveryAcknowledged {
  provider: string;
  status: 'acknowledged';
}

/** GET /:id/snapshots entry (no paths, no member ids). */
export interface HarnessSnapshotSummary {
  jobId: string;
  /** Epoch ms. */
  createdAt: number;
  expiresAt: number;
  fromVersion: string | null;
  toVersion: string | null;
  state: string;
  storeCount: number;
  bytes: number;
  dataRestore: {
    /** From spawn facts only (a lower bound; see storesChanged). */
    requiresAck: boolean;
    firstSpawnAt: number | null;
    spawnCount: number;
    /**
     * Always null in the listing: the GET never hashes stores. The rollback
     * request re-checks them and may still answer CONFIRMATION_REQUIRED.
     */
    storesChanged: boolean | null;
    unknown: boolean;
  };
}

export type HarnessUpdateJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped_live_session'
  | 'refused_pinned'
  /** exit 0 with the same version and bytes; snapshot discarded (T-1871). */
  | 'noop'
  /** the update failed and the previous install was restored and verified. */
  | 'rolled_back'
  /** the restore could not be verified; ONLY this harness stays blocked. */
  | 'rollback_failed';

/** Coarse phase within a running/finished job, for the progress UI. */
export type HarnessUpdateJobPhase =
  | 'queued'
  | 'preflight'
  | 'snapshotting'
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
