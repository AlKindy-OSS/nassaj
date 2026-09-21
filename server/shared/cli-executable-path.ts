import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isRunnableClaudeExecutable } from '@/shared/claude-cli-path.js';

/**
 * Generic provider-CLI resolver (B-1138) — the B-1091 fix generalized beyond
 * claude. A server launched under pm2/systemd inherits a minimal PATH
 * (`/usr/local/bin:/usr/bin:/bin:/usr/games`) that omits the per-user dirs a
 * login shell adds from `.profile`, so a bare `codex`/`hermes`/`agy`/`kimi`
 * fails ENOENT even though its native installer put it in `~/.local/bin`.
 * The result: a card that reads "Connected" next to "CLI is not installed",
 * and a spawn that dies ENOENT. Detection (isCliInstalled) and every spawn
 * site resolve through THIS function so "detected" == "runnable".
 */
export type ResolveCliExecutableOptions = {
  /** Operator override (e.g. process.env.AGY_PATH). Path-like → honored verbatim. */
  override?: string | undefined;
  /** Vendor-specific install dirs relative to HOME (e.g. ['.opencode/bin']). */
  extraHomeDirs?: readonly string[];
  homedir?: typeof os.homedir;
  env?: NodeJS.ProcessEnv;
  existsSync?: typeof fs.existsSync;
  statSync?: typeof fs.statSync;
  accessSync?: typeof fs.accessSync;
  platform?: NodeJS.Platform;
};

const isPathLike = (value: string): boolean => value.includes('/') || value.includes('\\');

/**
 * Install locations probed AFTER a PATH lookup fails, in priority order: the
 * native-installer dir, vendor-specific dirs, npm-global, then the system prefix.
 */
export function wellKnownCliInstallCandidates(
  home: string,
  command: string,
  extraHomeDirs: readonly string[] = [],
): string[] {
  const trimmedHome = (home ?? '').trim();
  const homeCandidates = trimmedHome
    ? [
      path.join(trimmedHome, '.local', 'bin', command),
      ...extraHomeDirs.map((dir) => path.join(trimmedHome, dir, command)),
      path.join(trimmedHome, '.npm-global', 'bin', command),
    ]
    : [];
  return [...homeCandidates, path.join('/usr/local/bin', command)];
}

/**
 * Resolves a provider CLI to an absolute runnable path: override (path-like
 * verbatim) → env PATH → well-known install dirs. Returns the bare command
 * unchanged when nothing is found (and always on win32, where cross-spawn's own
 * PATHEXT lookup is already correct), so the caller's ENOENT handling is intact.
 */
export function resolveCliExecutablePath(
  command: string,
  options: ResolveCliExecutableOptions = {},
): string {
  const requested = (options.override ?? '').trim() || command;
  const platform = options.platform ?? process.platform;
  if (isPathLike(requested) || platform === 'win32') {
    return requested;
  }

  const probe = {
    existsSync: options.existsSync ?? fs.existsSync,
    statSync: options.statSync ?? fs.statSync,
    accessSync: options.accessSync ?? fs.accessSync,
  };
  const env = options.env ?? process.env;
  const pathDirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, requested);
    if (isRunnableClaudeExecutable(candidate, probe)) {
      return candidate;
    }
  }

  const home = (options.homedir ?? os.homedir)();
  for (const candidate of wellKnownCliInstallCandidates(home, requested, options.extraHomeDirs)) {
    if (isRunnableClaudeExecutable(candidate, probe)) {
      return candidate;
    }
  }
  return requested;
}

/** agy: `AGY_PATH` override, then PATH and the well-known dirs (was `~/.local/bin/agy` only). */
export const resolveAgyExecutablePath = (): string =>
  resolveCliExecutablePath('agy', { override: process.env.AGY_PATH });
