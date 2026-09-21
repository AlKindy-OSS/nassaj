import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CLAUDE_COMMAND = 'claude';
const CLAUDE_SCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const CLAUDE_WRAPPER_SEGMENTS = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'] as const;

export type ResolveClaudeCodeExecutablePathDependencies = {
  execFileSync?: typeof execFileSync;
  existsSync?: typeof fs.existsSync;
  statSync?: typeof fs.statSync;
  accessSync?: typeof fs.accessSync;
  platform?: NodeJS.Platform;
  readFileSync?: typeof fs.readFileSync;
  /**
   * Operator home used to derive the well-known install dirs (B-1091). Defaults
   * to os.homedir(): the claude binary belongs to the OPERATOR who installed it,
   * never the isolated per-user tree, so detection must not read the caller's
   * isolated HOME.
   */
  homedir?: typeof os.homedir;
  /** Environment whose PATH is scanned for a bare command. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
};

/** Filesystem seam for the shared executable-acceptance predicate. */
export type ExecutableProbeDependencies = {
  existsSync?: typeof fs.existsSync;
  statSync?: typeof fs.statSync;
  accessSync?: typeof fs.accessSync;
};

/**
 * The SINGLE acceptance test shared by CLI *detection* (this module) and the
 * managed-terminal *link* path (B-1091 parity guard). A candidate qualifies only
 * when it exists, is a regular file (never a directory — a dir is X_OK by virtue
 * of being searchable), and is executable (X_OK). Sharing the predicate — not
 * just the candidate list — prevents a split verdict such as a chmod-000
 * `~/.local/bin/claude` that detection rejects while the launcher accepts a valid
 * `/usr/local/bin/claude` further down the list.
 */
export function isRunnableClaudeExecutable(
  candidate: string,
  deps: ExecutableProbeDependencies = {},
): boolean {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const statSync = deps.statSync ?? fs.statSync;
  const accessSync = deps.accessSync ?? fs.accessSync;
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      return false;
    }
    accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Well-known Claude install locations probed AFTER a PATH lookup fails (B-1091),
 * the single source of truth for both CLI *detection* (this module) and the
 * managed-terminal *link* path (server/services/isolation/managed-claude-terminal-env.ts
 * delegates here — a parity guard so detection, spawn, and login all resolve the
 * same binary). A server launched under pm2/systemd inherits a minimal PATH
 * (`/usr/local/bin:/usr/bin:/bin:/usr/games`) that omits the per-user dirs a
 * login shell adds from `.profile`, so a bare `claude` fails ENOENT even though
 * the native installer (`curl -fsSL claude.ai/install.sh`) put it in
 * `~/.local/bin/claude`. Order is priority order: native installer, the older
 * local installer layouts, npm-global, then the system prefix.
 */
export function wellKnownClaudeInstallCandidates(home: string, command: string): string[] {
  const trimmedHome = (home ?? '').trim();
  const homeCandidates = trimmedHome
    ? [
      path.join(trimmedHome, '.local', 'bin', command),
      path.join(trimmedHome, '.claude', 'local', command),
      path.join(trimmedHome, '.claude', 'local', 'bin', command),
      path.join(trimmedHome, '.npm-global', 'bin', command),
    ]
    : [];
  return [...homeCandidates, path.join('/usr/local/bin', command)];
}

function getPathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isPathLike(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function resolveClaudeWrapperBinary(
  wrapperPath: string,
  deps: Required<ResolveClaudeCodeExecutablePathDependencies>,
): string | null {
  const pathApi = getPathApi(deps.platform);
  const directCandidate = pathApi.resolve(pathApi.dirname(wrapperPath), ...CLAUDE_WRAPPER_SEGMENTS);

  if (deps.existsSync(directCandidate)) {
    return directCandidate;
  }

  let content: string;
  try {
    content = deps.readFileSync(wrapperPath, 'utf8');
  } catch {
    return null;
  }

  const matches = content.matchAll(/["']([^"'\\\r\n]*claude\.exe)["']/gi);
  for (const match of matches) {
    const rawTarget = match[1]
      .replace(/^\$basedir[\\/]/i, '')
      .replace(/^%dp0%[\\/]/i, '')
      .replace(/^%~dp0[\\/]/i, '');
    const normalizedTarget = rawTarget.replace(/[\\/]/g, pathApi.sep);
    const candidate = pathApi.isAbsolute(normalizedTarget)
      ? normalizedTarget
      : pathApi.resolve(pathApi.dirname(wrapperPath), normalizedTarget);

    if (deps.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveWindowsClaudeExecutablePath(
  configuredPath: string,
  deps: Required<ResolveClaudeCodeExecutablePathDependencies>,
): string {
  const pathApi = getPathApi(deps.platform);
  const extension = pathApi.extname(configuredPath).toLowerCase();
  const explicitPath = isPathLike(configuredPath) || pathApi.isAbsolute(configuredPath);

  if (CLAUDE_SCRIPT_EXTENSIONS.has(extension)) {
    return configuredPath;
  }

  if (explicitPath && extension === '.exe') {
    return configuredPath;
  }

  if (explicitPath) {
    return resolveClaudeWrapperBinary(configuredPath, deps) ?? configuredPath;
  }

  try {
    const stdout = deps.execFileSync('where.exe', [configuredPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const candidates = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (pathApi.extname(candidate).toLowerCase() === '.exe') {
        return candidate;
      }
    }

    for (const candidate of candidates) {
      const resolved = resolveClaudeWrapperBinary(candidate, deps);
      if (resolved) {
        return resolved;
      }
    }
  } catch {
    return configuredPath;
  }

  return configuredPath;
}

/**
 * Resolves a bare command on non-win32 by scanning the env PATH, then the
 * well-known install dirs the pm2/systemd PATH omits. Returns the absolute path
 * of the first existing candidate, or `null` when nothing is found.
 */
function resolvePosixInstalledPath(
  command: string,
  deps: Required<ResolveClaudeCodeExecutablePathDependencies>,
): string | null {
  const pathApi = getPathApi(deps.platform);
  const probe = { existsSync: deps.existsSync, statSync: deps.statSync, accessSync: deps.accessSync };
  const rawPath = deps.env.PATH ?? deps.env.Path ?? '';

  for (const dir of rawPath.split(pathApi.delimiter).filter(Boolean)) {
    const candidate = pathApi.join(dir, command);
    if (isRunnableClaudeExecutable(candidate, probe)) {
      return candidate;
    }
  }

  // Only when PATH resolves nothing is HOME consulted (kept lazy so the common
  // PATH-hit case never touches the filesystem for the well-known dirs).
  for (const candidate of wellKnownClaudeInstallCandidates(deps.homedir(), command)) {
    if (isRunnableClaudeExecutable(candidate, probe)) {
      return candidate;
    }
  }

  return null;
}

export function resolveClaudeCodeExecutablePath(
  configuredPath: string | undefined = process.env.CLAUDE_CLI_PATH,
  dependencies: ResolveClaudeCodeExecutablePathDependencies = {},
): string {
  const deps: Required<ResolveClaudeCodeExecutablePathDependencies> = {
    execFileSync: dependencies.execFileSync ?? execFileSync,
    existsSync: dependencies.existsSync ?? fs.existsSync,
    statSync: dependencies.statSync ?? fs.statSync,
    accessSync: dependencies.accessSync ?? fs.accessSync,
    platform: dependencies.platform ?? process.platform,
    readFileSync: dependencies.readFileSync ?? fs.readFileSync,
    homedir: dependencies.homedir ?? os.homedir,
    env: dependencies.env ?? process.env,
  };

  const normalizedPath = stripWrappingQuotes(configuredPath || DEFAULT_CLAUDE_COMMAND);
  if (deps.platform === 'win32') {
    return resolveWindowsClaudeExecutablePath(normalizedPath, deps);
  }

  // An explicit path (from CLAUDE_CLI_PATH or a path-like config) is the first
  // priority and is honored verbatim, exactly as before. Only a bare command
  // that cannot be found on PATH falls back to the well-known install dirs;
  // when nothing is found the bare command is returned unchanged (preserving
  // the prior behavior for hosts where PATH already resolves it via spawn).
  if (isPathLike(normalizedPath)) {
    return normalizedPath;
  }

  return resolvePosixInstalledPath(normalizedPath, deps) ?? normalizedPath;
}
