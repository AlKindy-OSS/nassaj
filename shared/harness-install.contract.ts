/**
 * Harness CLI install contract (T-2062) — the ONE source of the install
 * command shown in Settings → Agents → Account and of the owner-only
 * `POST /api/providers/:id/install` wire shape. The server's install-sources
 * table is checked against these display commands by a parity test, so the
 * text the operator reads is the same source the server fetches.
 */

/** Harnesses the server can install for the owner. */
export type InstallableHarnessId = 'codex' | 'opencode';

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
  | 'HARNESS_UPDATE_IN_PROGRESS';

/** Failure codes an install job can end with (`job.error.code`). */
export type HarnessInstallJobErrorCode =
  | 'install_failed'
  | 'install_timeout'
  | 'verify_failed'
  | 'script_rejected';
