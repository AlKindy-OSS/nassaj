/**
 * Frozen install sources of the owner CLI install (T-2062, qa C1/C7). The
 * display commands live in `shared/harness-install.contract.ts`; a parity test
 * pins that every script URL here is the URL the operator sees there.
 *
 *   - opencode: NO shell script. The pinned, sha-verified release asset of
 *     `installCompatAsset` is installed at the registry's measured path.
 *   - codex: the vendor's install.sh is downloaded to a private file (https,
 *     host allowlist re-checked on every redirect, size cap), its sha256 is
 *     logged and audited, then it runs as `sh <file>`. Measured redirect chain
 *     (2026-10-20): chatgpt.com/codex/install.sh → 302 →
 *     releases.openai.com/codex/install.sh (~34 KB).
 */

import type { InstallableHarnessId } from '../../../../shared/harness-install.contract.js';

/** A downloaded-then-run installer script. */
export interface ScriptInstallSource {
  kind: 'script';
  url: string;
  allowedHosts: readonly string[];
  maxRedirects: number;
  /** Hard cap on the script body. */
  capBytes: number;
  /** Absolute interpreter the script file is passed to. */
  interpreter: string;
  timeoutMs: number;
}

/** The pinned release asset path (opencode). */
export interface AssetInstallSource {
  kind: 'asset';
}

export type HarnessInstallSource = ScriptInstallSource | AssetInstallSource;

/** Installer process timeout (qa C1: 5 min). */
export const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** The install source of every installable harness. */
export const HARNESS_INSTALL_SOURCES: Readonly<Record<InstallableHarnessId, HarnessInstallSource>> = Object.freeze({
  codex: Object.freeze({
    kind: 'script',
    url: 'https://chatgpt.com/codex/install.sh',
    allowedHosts: Object.freeze(['chatgpt.com', 'releases.openai.com']),
    maxRedirects: 2,
    capBytes: 256 * 1024,
    interpreter: '/bin/sh',
    timeoutMs: INSTALL_TIMEOUT_MS,
  }),
  opencode: Object.freeze({ kind: 'asset' }),
});
