/**
 * Per-harness install layouts for snapshots (T-1871 stage 3, spec §1).
 *
 * Every layout is DERIVED from the resolved launcher (the same binary Nassaj
 * spawns), never from hardcoded version paths, so a snapshot always covers the
 * bytes that actually run. A launcher whose shape does not match the measured
 * layout is SNAPSHOT_LAYOUT_MISMATCH: the update is refused before any change.
 *
 * Measured shapes (docs/ops/t1871-measurements.md):
 *   claude   ~/.local/bin/claude → ~/.local/share/claude/versions/<v>        (file)
 *   cursor   ~/.local/bin/cursor-agent → …/versions/<v>/cursor-agent         (dir)
 *   codex    ~/.local/bin/codex → <CODEX_HOME>/packages/standalone/current/bin/codex,
 *            current → releases/<v>                                         (dir)
 *   agy      ~/.local/bin/agy                                    (single file)
 *   opencode ~/.opencode/bin/opencode                            (single file)
 *   kimi     ~/.kimi-code/bin/kimi (official native install, ADR-189) (single file)
 */

import fs from 'node:fs';
import path from 'node:path';

import type { BinaryLayoutSpec } from './snapshot/binary-snapshot.js';
import { snapshotError } from './snapshot/errors.js';

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Absolute target of the symlink `link`, or null when `link` is not a symlink. */
function linkTarget(link: string): string | null {
  if (!lstatOrNull(link)?.isSymbolicLink()) return null;
  return path.resolve(path.dirname(link), fs.readlinkSync(link));
}

function realpathOrMismatch(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
  }
}

function assertAbsolute(binaryPath: string): void {
  if (!path.isAbsolute(binaryPath)) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
}

/** claude: the launcher symlink points at one version FILE in `versions/`. */
export function claudeLayout(binaryPath: string): BinaryLayoutSpec {
  assertAbsolute(binaryPath);
  if (!linkTarget(binaryPath)) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
  const versionsDir = path.dirname(realpathOrMismatch(binaryPath));
  return { layout: 'versioned-file', linkMode: 'hardlink', binaryPath, versionsDir, symlinks: [binaryPath] };
}

/** cursor: the launcher symlink points INTO one version DIR of `versions/`. */
export function cursorLayout(binaryPath: string): BinaryLayoutSpec {
  assertAbsolute(binaryPath);
  if (!linkTarget(binaryPath)) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
  const versionsDir = path.dirname(path.dirname(realpathOrMismatch(binaryPath)));
  return { layout: 'versioned-dir', linkMode: 'hardlink', binaryPath, versionsDir, symlinks: [binaryPath] };
}

/** The codex standalone layout derived from the launcher link. */
export interface CodexStandalone {
  codexHome: string;
  standaloneDir: string;
  currentLink: string;
  installDir: string;
}

/**
 * Derives the codex standalone install from `~/.local/bin/codex`:
 * launcher → `<CODEX_HOME>/packages/standalone/current/bin/codex`.
 */
export function codexStandaloneOf(binaryPath: string): CodexStandalone {
  assertAbsolute(binaryPath);
  const target = linkTarget(binaryPath);
  if (!target || path.basename(target) !== 'codex' || path.basename(path.dirname(target)) !== 'bin') {
    throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
  }
  const currentLink = path.dirname(path.dirname(target));
  const standaloneDir = path.dirname(currentLink);
  const packagesDir = path.dirname(standaloneDir);
  const shapeOk = path.basename(currentLink) === 'current' && path.basename(standaloneDir) === 'standalone'
    && path.basename(packagesDir) === 'packages' && Boolean(linkTarget(currentLink));
  if (!shapeOk) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
  return { codexHome: path.dirname(packagesDir), standaloneDir, currentLink, installDir: path.dirname(binaryPath) };
}

/** codex: `current` is swapped first, then the launcher link is re-verified. */
export function codexLayout(binaryPath: string): BinaryLayoutSpec {
  const s = codexStandaloneOf(binaryPath);
  return {
    layout: 'versioned-dir',
    linkMode: 'hardlink',
    binaryPath,
    versionsDir: path.join(s.standaloneDir, 'releases'),
    symlinks: [s.currentLink, binaryPath],
  };
}

/**
 * Env of `codex update` (measurements §a): the installer must target the
 * install the launcher points at, whichever home the binary would derive.
 */
export function codexUpdateEnv(binaryPath: string): Record<string, string> {
  const s = codexStandaloneOf(binaryPath);
  return { CODEX_HOME: s.codexHome, CODEX_INSTALL_DIR: s.installDir };
}

/** agy / opencode / kimi: one regular file replaced in place (copied, never linked). */
export function singleFileLayout(binaryPath: string): BinaryLayoutSpec {
  assertAbsolute(binaryPath);
  if (!lstatOrNull(binaryPath)?.isFile()) throw snapshotError('SNAPSHOT_LAYOUT_MISMATCH');
  return { layout: 'single-file', linkMode: 'copy', binaryPath, symlinks: [] };
}
