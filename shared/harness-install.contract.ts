/**
 * Harness CLI install contract (T-2062) — the ONE source of the install
 * command shown in Settings → Agents → Account and of the owner-only
 * `POST /api/providers/:id/install` wire shape. The server's install-sources
 * table is checked against these display commands by a parity test, so the
 * text the operator reads is the same source the server fetches.
 */

/** Harnesses the server can install for the owner. */
export type InstallableHarnessId = 'codex' | 'opencode' | 'antigravity' | 'claude';

/** Display copy of one installable harness. */
export interface HarnessInstallInfo {
  /** Banner title when the CLI is missing. */
  label: string;
  /** The vendor's official command, shown verbatim for manual install. */
  command: string;
  /** Where the official installer puts the CLI. */
  note: string;
}

/** Frozen display table (UI and server share it). */
export const HARNESS_INSTALL_INFO: Readonly<Record<InstallableHarnessId, HarnessInstallInfo>> = Object.freeze({
  codex: Object.freeze({
    label: 'Codex CLI is not installed',
    command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    note: 'Official standalone installer → ~/.local/bin/codex. An npm -g copy is not detected.',
  }),
  opencode: Object.freeze({
    label: 'OpenCode CLI is not installed',
    command: 'curl -fsSL https://opencode.ai/install | bash',
    note: 'Official installer → ~/.opencode/bin/opencode. An npm -g copy is not detected.',
  }),
  // ADR-215 stage A. Measured 2026-10-20: the vendor's `agy install` appends a
  // PATH line to an existing ~/.bashrc and ~/.profile (official footprint).
  antigravity: Object.freeze({
    label: 'Antigravity CLI (agy) is not installed',
    command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    note: 'Official installer → ~/.local/bin/agy; it downloads from a Cloud Run manifest host and '
      + 'storage.googleapis.com, and adds a PATH line to ~/.bashrc and ~/.profile.',
  }),
  // ADR-215 stage B. Nassaj takes the same release path as this command
  // (latest → manifest → binary → `claude install <v>`) and also checks the
  // vendor's GPG signature on the manifest.
  claude: Object.freeze({
    label: 'Claude Code CLI is not installed',
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
    note: 'Official native installer → ~/.local/bin/claude → ~/.local/share/claude/versions/<v>; '
      + 'Nassaj verifies the vendor-signed manifest first.',
  }),
});

/** True when `id` is a harness the install endpoint accepts. */
export function isInstallableHarness(id: string): id is InstallableHarnessId {
  return Object.prototype.hasOwnProperty.call(HARNESS_INSTALL_INFO, id);
}

/** POST /:id/install 202 body (the job is then polled at /update-jobs/:jobId). */
export interface HarnessInstallStarted {
  jobId: string;
  provider: InstallableHarnessId;
  status: 'running';
}

/** Refusal codes of POST /:id/install (body `{ code, message, activeJobId? }`). */
export type HarnessInstallRefusalCode =
  | 'UNKNOWN_HARNESS'
  | 'HARNESS_NOT_INSTALLABLE'
  | 'PLATFORM_MODE_UNSUPPORTED'
  | 'HARNESS_ALREADY_INSTALLED'
  | 'HARNESS_INSTALL_INVALID'
  | 'HARNESS_OVERRIDE_SET'
  | 'HARNESS_UPDATE_IN_PROGRESS'
  /** ADR-215 §3.6: one install at a time across all harnesses. */
  | 'HARNESS_INSTALL_SLOT_BUSY';

/** Failure codes an install job can end with (`job.error.code`). */
export type HarnessInstallJobErrorCode =
  | 'install_failed'
  | 'install_timeout'
  | 'verify_failed'
  | 'script_rejected'
  /** ADR-215 ش4: free space in HOME is below the descriptor's minimum. */
  | 'insufficient_space'
  /** ADR-215 ش3: gpgv is missing, so the claude manifest cannot be verified. */
  | 'verifier_unavailable';
