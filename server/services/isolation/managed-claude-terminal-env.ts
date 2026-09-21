/** Environment contract between a managed terminal and its Claude PATH shim. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isRunnableClaudeExecutable,
  wellKnownClaudeInstallCandidates as sharedWellKnownClaudeInstallCandidates,
} from '@/shared/claude-cli-path.js';

export const MANAGED_CLAUDE_MODE_ENV = 'NASSAJ_MANAGED_CLAUDE_MODE';
export const MANAGED_CLAUDE_USER_ENV = 'NASSAJ_MANAGED_CLAUDE_USER_ID';
export const MANAGED_CLAUDE_SESSION_ENV = 'NASSAJ_MANAGED_CLAUDE_SESSION_ID';
export const MANAGED_CLAUDE_REAL_BIN_ENV = 'NASSAJ_MANAGED_CLAUDE_REAL_BIN';
export const MANAGED_CLAUDE_BROKER_SOCKET_ENV = 'NASSAJ_MANAGED_CLAUDE_BROKER_SOCKET';
export const MANAGED_CLAUDE_BROKER_SELECTOR_ENV = 'NASSAJ_MANAGED_CLAUDE_BROKER_SELECTOR';

export type ManagedClaudeTerminalMode = 'general' | 'session-bound';

/** Resolve the source asset from either source or dist-server module layout. */
export function resolveManagedClaudeWrapperPath(
  moduleUrl: string,
  existsSync: typeof fs.existsSync = fs.existsSync,
): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(moduleDir, '../../bin/claude'),
    path.resolve(moduleDir, '../../../../server/bin/claude'),
  ];
  const wrapper = candidates.find((candidate) => existsSync(candidate));
  if (!wrapper) throw new Error('Managed Claude launcher asset is missing');
  return wrapper;
}

export const MANAGED_CLAUDE_WRAPPER = resolveManagedClaudeWrapperPath(import.meta.url);
export const MANAGED_CLAUDE_BIN_DIR = path.dirname(MANAGED_CLAUDE_WRAPPER);

type ResolveDeps = {
  existsSync?: typeof fs.existsSync;
  statSync?: typeof fs.statSync;
  accessSync?: typeof fs.accessSync;
};

/**
 * Well-known Claude install locations probed AFTER the PATH lookup fails
 * (B-1058). A server launched under pm2/systemd inherits a minimal PATH
 * (`/usr/local/bin:/usr/bin:/bin`) that omits the per-user dirs a login shell
 * would add from `.profile`, while the managed terminal deliberately runs
 * `bash --noprofile --norc` so PATH is never repaired there either. The
 * native installer (`curl -fsSL claude.ai/install.sh`) puts the launcher in
 * `~/.local/bin/claude`; the older local/npm layouts are listed after it.
 * Order is priority order. HOME comes from the isolated env handed in.
 *
 * B-1091 parity guard: the candidate LIST now lives in shared/claude-cli-path.ts
 * so CLI detection and this login/terminal path resolve the same dirs. This
 * thin wrapper keeps the env-based signature the terminal env builder uses.
 */
export function wellKnownClaudeInstallCandidates(env: NodeJS.ProcessEnv, command: string): string[] {
  return sharedWellKnownClaudeInstallCandidates((env.HOME ?? '').trim(), command);
}

/** Resolve the real Claude executable before the shim directory is prepended. */
export function resolveRealClaudeBinary(
  env: NodeJS.ProcessEnv,
  configured = env.CLAUDE_CLI_PATH || 'claude',
  deps: ResolveDeps = {},
): string {
  const probe = {
    existsSync: deps.existsSync ?? fs.existsSync,
    statSync: deps.statSync ?? fs.statSync,
    accessSync: deps.accessSync ?? fs.accessSync,
  };
  const candidate = configured.trim();
  const pathEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const paths = candidate.includes(path.sep)
    ? [path.resolve(candidate)]
    : [
      ...pathEntries.map((dir) => path.join(dir, candidate)),
      ...wellKnownClaudeInstallCandidates(env, candidate),
    ];
  for (const executable of paths) {
    // The shim must never resolve to itself (infinite launcher recursion); this
    // is the one criterion the shared predicate cannot own — it is about THIS
    // module's asset, not about being runnable.
    if (path.resolve(executable) === path.resolve(MANAGED_CLAUDE_WRAPPER)) continue;
    if (isRunnableClaudeExecutable(executable, probe)) {
      return path.resolve(executable);
    }
  }
  throw new Error(
    'Claude executable not found before installing the managed terminal launcher '
    + `(looked up "${candidate}" on PATH and in the well-known install dirs under HOME=${env.HOME ?? ''}; `
    + 'set CLAUDE_CLI_PATH to the absolute path of the claude binary)',
  );
}

/** Install the managed launcher as the first PATH entry for this PTY only. */
export function installManagedClaudeTerminalEnv(
  env: NodeJS.ProcessEnv,
  input: { userId: string | number; mode: ManagedClaudeTerminalMode; sessionId?: string | null },
): NodeJS.ProcessEnv {
  if (input.mode === 'session-bound' && !input.sessionId) {
    throw new Error('A session-bound Claude terminal requires a sessionId');
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const realBinary = resolveRealClaudeBinary(env);
  return {
    ...env,
    [pathKey]: [MANAGED_CLAUDE_BIN_DIR, env[pathKey]].filter(Boolean).join(path.delimiter),
    [MANAGED_CLAUDE_MODE_ENV]: input.mode,
    [MANAGED_CLAUDE_USER_ENV]: String(input.userId),
    ...(input.sessionId ? { [MANAGED_CLAUDE_SESSION_ENV]: input.sessionId } : {}),
    [MANAGED_CLAUDE_REAL_BIN_ENV]: realBinary,
  };
}

/** Remove launcher-only metadata before handing env to Claude itself. */
export function stripManagedClaudeTerminalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  const pathKey = Object.keys(clean).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  clean[pathKey] = (clean[pathKey] ?? '')
    .split(path.delimiter)
    .filter((entry) => entry && path.resolve(entry) !== path.resolve(MANAGED_CLAUDE_BIN_DIR))
    .join(path.delimiter);
  delete clean[MANAGED_CLAUDE_MODE_ENV];
  delete clean[MANAGED_CLAUDE_USER_ENV];
  delete clean[MANAGED_CLAUDE_SESSION_ENV];
  delete clean[MANAGED_CLAUDE_REAL_BIN_ENV];
  delete clean[MANAGED_CLAUDE_BROKER_SOCKET_ENV];
  delete clean[MANAGED_CLAUDE_BROKER_SELECTOR_ENV];
  return clean;
}
