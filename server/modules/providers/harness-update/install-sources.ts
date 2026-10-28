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
 *   - antigravity (ADR-215 stage A): the same script path. Measured
 *     2026-10-20 (docs/ADR-215-measurements.md): antigravity.google serves
 *     the script with no redirect (7 643 B); the script itself fetches a Cloud
 *     Run manifest and a storage.googleapis.com tarball (~64 MB → ~222 MB
 *     binary), so its payload hosts are the script's choice. Its last step is
 *     `"$BINARY_PATH" install || true`, so a zero exit proves nothing: success
 *     is the launch resolver plus `agy --version` only.
 */

import path from 'node:path';

import type { InstallableHarnessId } from '../../../../shared/harness-install.contract.js';

import { CLAUDE_KEY, type SignedManifestSource } from './signed-manifest.js';

/** A file the vendor installer may create (ADR-215 ش4/ش5 cleanup scope). */
export interface OwnedPath {
  /** Absolute path; must pass the hard deny-list (install-cleanup.ts). */
  path: string;
  /** Vendor staging leftover: also removed after a successful install. */
  staging: boolean;
  /**
   * When set, the entry is a launcher symlink: it is removed only when it is
   * a symlink whose literal readlink equals this absolute path (claude:
   * `~/.local/bin/claude` → `~/.local/share/claude/versions/<v>`).
   */
  symlinkTo?: string;
}

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
  /**
   * Digests reviewed for this Nassaj release (owner decision ADR-215 Q1 =
   * option A): an unknown digest is logged in full with an "unreviewed"
   * warning and audited, never blocked.
   */
  knownSha256: readonly string[];
  /** Free bytes HOME must have before the download (0 = no check). */
  minFreeBytes: number;
  /** Regular files only; removed on failure when they appeared during the job. */
  ownedPaths: (home: string) => readonly OwnedPath[];
}

/** The pinned release asset path (opencode). */
export interface AssetInstallSource {
  kind: 'asset';
}

export type HarnessInstallSource = ScriptInstallSource | AssetInstallSource | SignedManifestSource;

/** Installer process timeout (qa C1: 5 min). */
export const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Timeout of an installer that downloads its own payload (agy ~64 MB, claude install; ADR-215). */
export const VENDOR_DOWNLOAD_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** ش4: the placed binary plus the vendor staging files (dirs are never removed). */
function agyOwnedPaths(home: string): readonly OwnedPath[] {
  const staging = path.join(home, '.cache', 'antigravity', 'staging');
  return Object.freeze([
    { path: path.join(home, '.local', 'bin', 'agy'), staging: false },
    { path: path.join(staging, 'agy'), staging: true },
    { path: path.join(staging, 'agy.tar.gz'), staging: true },
    { path: path.join(staging, 'antigravity'), staging: true },
  ]);
}

/**
 * claude (ADR-215 stage B): the launcher link and the one version file
 * `<staged> install <v>` creates. `~/.claude*` and `~/.claude.json` stay
 * (deny-list); the link is removable only while it points literally at the
 * version file of this job.
 */
function claudeOwnedPaths(home: string, version: string): readonly OwnedPath[] {
  const versionFile = path.join(home, '.local', 'share', 'claude', 'versions', version);
  return Object.freeze([
    { path: path.join(home, '.local', 'bin', 'claude'), staging: false, symlinkTo: versionFile },
    { path: versionFile, staging: false },
  ]);
}

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
    // Measured 2026-10-20 (docs/ADR-215-measurements.md).
    knownSha256: Object.freeze(['150e3cf675682efeaac115aa3747add3f27887896d04ce6d0b56478d8b428bf6']),
    minFreeBytes: 0,
    // codex leaves a machine release (ADR-188) whose layout is validated, not
    // swept: unchanged T-2062 behaviour.
    ownedPaths: () => Object.freeze([]),
  }),
  opencode: Object.freeze({ kind: 'asset' }),
  antigravity: Object.freeze({
    kind: 'script',
    url: 'https://antigravity.google/cli/install.sh',
    allowedHosts: Object.freeze(['antigravity.google']),
    maxRedirects: 0,
    capBytes: 64 * 1024,
    interpreter: '/bin/bash',
    timeoutMs: VENDOR_DOWNLOAD_INSTALL_TIMEOUT_MS,
    knownSha256: Object.freeze(['62966c07365423bd4dc209355060744058fb30d60f5323e2d360e39de64e5042']),
    // Measured peak: tarball 64 MB + extracted 222 MB + placed copy 222 MB.
    minFreeBytes: 1024 * 1024 * 1024,
    ownedPaths: agyOwnedPaths,
  }),
  claude: Object.freeze({
    kind: 'signed-manifest',
    baseUrl: 'https://downloads.claude.ai/claude-code-releases',
    allowedHosts: Object.freeze(['downloads.claude.ai']),
    maxRedirects: 0,
    keyFingerprint: CLAUDE_KEY.fingerprint,
    keyringBase64: CLAUDE_KEY.keyringBase64,
    minSignedVersion: '2.1.89',
    smallCapBytes: 64 * 1024,
    binaryCapBytes: 400 * 1024 * 1024,
    // qa I5: `claude install` contacts the vendor too; same 10 min as agy.
    timeoutMs: VENDOR_DOWNLOAD_INSTALL_TIMEOUT_MS,
    // Measured: ~289 MB staged binary + the same size placed under versions/.
    minFreeBytes: 1536 * 1024 * 1024,
    ownedPaths: claudeOwnedPaths,
  }),
});
