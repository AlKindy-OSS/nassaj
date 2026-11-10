/**
 * npm-lock harness pins and layout (T-2086 S4, ADR-224).
 *
 * A reviewed pin is a directory committed under `server/harness-locks/<id>/<v>/`:
 * `package.json` + `package-lock.json` (the exact tree `npm ci` installs) and
 * `tree-manifest.json` (the full-tree sha256 root of trust, tree-manifest.js).
 * The install layout under the operator home (one terminal copy):
 *
 *   ~/.local/share/dsh/versions/<v>/{package.json,package-lock.json,node_modules}
 *   ~/.local/bin/dsh  →  (absolute symlink) versions/<v>/node_modules/@deepseek-ai/dsh/lib/bin.js
 *
 * The launcher link is the single source of "which version is current";
 * the version kept beside it is the rollback target.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { findAppRoot, getModuleDir } from '@/utils/runtime-paths.js';

/** The S2 node floor of dsh (package engines `>=24.9.0`). */
export const DSH_MIN_NODE = '24.9.0';

/** An install source of kind `npm-lock` (one reviewed lockfile per pin). */
export interface NpmLockInstallSource {
  kind: 'npm-lock';
  harness: 'dsh';
  /** npm package the lock pins. */
  pkg: string;
  /** Launch entry relative to the version dir (the npm `bin` target). */
  binRel: string;
  /** Reviewed pins, oldest first; the LAST is the install/update target. */
  reviewedPins: readonly string[];
  /** Directory holding one `<version>/` dir per reviewed pin. */
  lockRoot: () => string;
  /** Install root under the operator home. */
  installRoot: (home: string) => string;
  /** The terminal launcher the harness registry resolves. */
  launcher: (home: string) => string;
  minNodeVersion: string;
  /** Free bytes HOME and the npm cache filesystem must each have. */
  minFreeBytes: number;
  /** Versions kept on disk (current + previous). */
  keepVersions: number;
  timeoutMs: number;
}

/** The committed manifest document of one pin. */
export interface PinManifest {
  schema: number;
  harness: string;
  package: string;
  version: string;
  platform: string;
  lockfileSha256: string;
  entry: { path: string; sha256: string };
  fileCount: number;
  totalBytes: number;
  treeSha256: string;
  packages: Record<string, string>;
}

/** The reviewed files of one pin. */
export interface LoadedPin {
  version: string;
  packageJson: Buffer;
  lock: Buffer;
  manifest: PinManifest;
}

/** Typed refusal of the npm-lock flows, mapped onto job error codes. */
export class NpmLockError extends Error {
  constructor(readonly jobCode: string, readonly causeCode: string) {
    super(causeCode);
    this.name = 'NpmLockError';
  }
}

const VERSION_NAME = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u;

/** The DeepSeek Harness pin table (the one npm-lock harness). */
export const DSH_NPM_LOCK_SOURCE: NpmLockInstallSource = Object.freeze({
  kind: 'npm-lock',
  harness: 'dsh',
  pkg: '@deepseek-ai/dsh',
  binRel: 'node_modules/@deepseek-ai/dsh/lib/bin.js',
  // Reviewed 2026-11-07 (T-2086 S0/S4): 725 lock entries, 69 454 files.
  reviewedPins: Object.freeze(['0.2.2-rc.1']),
  lockRoot: () => path.join(findAppRoot(getModuleDir(import.meta.url)), 'server', 'harness-locks', 'dsh'),
  installRoot: (home: string) => path.join(home, '.local', 'share', 'dsh'),
  launcher: (home: string) => path.join(home, '.local', 'bin', 'dsh'),
  minNodeVersion: DSH_MIN_NODE,
  minFreeBytes: 3 * 1024 ** 3,
  keepVersions: 2,
  timeoutMs: 10 * 60 * 1000,
}) as NpmLockInstallSource;

/** The install/update target (last reviewed pin). */
export function targetPin(source: NpmLockInstallSource): string {
  const pin = source.reviewedPins.at(-1);
  if (!pin) throw new NpmLockError('pin_invalid', 'no_reviewed_pin');
  return pin;
}

export const versionsDir = (source: NpmLockInstallSource, home: string) => path.join(source.installRoot(home), 'versions');
export const versionDir = (source: NpmLockInstallSource, home: string, v: string) => path.join(versionsDir(source, home), v);
export const entryPath = (source: NpmLockInstallSource, home: string, v: string) =>
  path.join(versionDir(source, home, v), source.binRel);

/** Reads and cross-checks one reviewed pin (throws NpmLockError pin_invalid). */
export function loadPin(source: NpmLockInstallSource, version: string): LoadedPin {
  if (!source.reviewedPins.includes(version) || !VERSION_NAME.test(version)) {
    throw new NpmLockError('pin_invalid', 'unreviewed_version');
  }
  const dir = path.join(source.lockRoot(), version);
  let packageJson: Buffer;
  let lock: Buffer;
  let manifest: PinManifest;
  try {
    packageJson = fs.readFileSync(path.join(dir, 'package.json'));
    lock = fs.readFileSync(path.join(dir, 'package-lock.json'));
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'tree-manifest.json'), 'utf8')) as PinManifest;
  } catch {
    throw new NpmLockError('pin_invalid', 'pin_files_unreadable');
  }
  const lockSha = createHash('sha256').update(lock).digest('hex');
  const consistent = manifest.version === version && manifest.harness === source.harness
    && manifest.package === source.pkg && manifest.entry?.path === source.binRel
    && manifest.lockfileSha256 === lockSha && typeof manifest.treeSha256 === 'string';
  if (!consistent) throw new NpmLockError('pin_invalid', 'manifest_inconsistent');
  if (manifest.platform !== `${process.platform}-${process.arch}`) {
    throw new NpmLockError('pin_invalid', 'platform_unsupported');
  }
  return { version, packageJson, lock, manifest };
}

/**
 * T-2091: a version the update pipeline verified on this host (contract suite green) keeps its
 * reviewed result in <installRoot>/reviewed/<v>/ (lockfile, full-tree manifest, report).
 */
export const localReviewedDir = (source: NpmLockInstallSource, home: string, v: string) =>
  path.join(source.installRoot(home), 'reviewed', v);

/** True for a repo-reviewed pin or a version the pipeline verified on this host. */
export function isReviewedVersion(source: NpmLockInstallSource, home: string, version: string): boolean {
  if (source.reviewedPins.includes(version)) return true;
  return VERSION_NAME.test(version) && fs.existsSync(path.join(localReviewedDir(source, home, version), 'tree-manifest.json'));
}

/** loadPin for a repo pin, else the pipeline's local reviewed record (same cross-checks). */
export function loadReviewedPin(source: NpmLockInstallSource, home: string, version: string): LoadedPin {
  if (source.reviewedPins.includes(version)) return loadPin(source, version);
  if (!VERSION_NAME.test(version)) throw new NpmLockError('pin_invalid', 'unreviewed_version');
  const dir = localReviewedDir(source, home, version);
  let lock: Buffer;
  let packageJson: Buffer;
  let manifest: PinManifest;
  try {
    lock = fs.readFileSync(path.join(dir, 'package-lock.json'));
    packageJson = fs.readFileSync(path.join(dir, 'package.json'));
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'tree-manifest.json'), 'utf8')) as PinManifest;
  } catch {
    throw new NpmLockError('pin_invalid', 'unreviewed_version');
  }
  const lockSha = createHash('sha256').update(lock).digest('hex');
  const consistent = manifest.version === version && manifest.harness === source.harness && manifest.package === source.pkg
    && manifest.entry?.path === source.binRel && manifest.lockfileSha256 === lockSha && typeof manifest.treeSha256 === 'string'
    && manifest.platform === `${process.platform}-${process.arch}`;
  if (!consistent) throw new NpmLockError('pin_invalid', 'manifest_inconsistent');
  return { version, packageJson, lock, manifest };
}

/**
 * The version the launcher points at, read from the literal link (never
 * followed further): `versions/<v>/<binRel>` with `<v>` a version name, else null.
 */
export function currentVersion(source: NpmLockInstallSource, home: string): string | null {
  let target: string;
  try {
    target = fs.readlinkSync(source.launcher(home));
  } catch {
    return null;
  }
  return versionOfEntry(source, versionsDir(source, home), target);
}

/** `<v>` when `entry` is exactly `<root>/<v>/<binRel>`, else null. */
export function versionOfEntry(source: NpmLockInstallSource, root: string, entry: string): string | null {
  const rel = path.relative(root, path.resolve(entry));
  const [v, ...rest] = rel.split(path.sep);
  if (!v || !VERSION_NAME.test(v) || rest.join('/') !== source.binRel) return null;
  return v;
}

/** Installed version dirs (dot-prefixed staging dirs excluded), newest mtime first. */
export function keptVersions(source: NpmLockInstallSource, home: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(versionsDir(source, home));
  } catch {
    return [];
  }
  return names
    .filter((n) => VERSION_NAME.test(n))
    .map((n) => ({ n, t: fs.lstatSync(versionDir(source, home, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .map((e) => e.n);
}

/** The npm CLI shipped beside `node` (`<prefix>/bin/node` → `<prefix>/lib/node_modules/npm`). */
export function npmCliBesideNode(node: string): string {
  return path.join(path.dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/** Staging dir of `version` inside the versions dir (same filesystem: atomic rename). */
export const stagingDir = (source: NpmLockInstallSource, home: string, v: string) =>
  path.join(versionsDir(source, home), `.staging-${v}`);

/**
 * The ONE install argv of an npm-lock pin: `<node> <npm-cli> ci` of the reviewed
 * lock already written into `cwd` — never `install`, never a spec, never latest;
 * lifecycle scripts off; a private cache dir under /var/tmp.
 */
export function npmLockCiArgv(node: string, cacheDir: string): { cmd: string; args: string[] } {
  return {
    cmd: node,
    args: [npmCliBesideNode(node), 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier',
      '--cache', cacheDir],
  };
}
