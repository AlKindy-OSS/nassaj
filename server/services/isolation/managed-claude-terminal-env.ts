/** Environment contract between a managed terminal and its Claude PATH shim. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HarnessBinaryUnresolvedError, resolveHarnessBinary } from '@/shared/harness-binaries.js';

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

/**
 * Resolve the real Claude executable before the shim directory is prepended:
 * the harness registry's claude (T-1873 — the `CLAUDE_CLI_PATH` SERVER override,
 * else the native installer's `~/.local/bin/claude` under the operator home).
 * The isolated PTY env can never redirect it. Throws when claude is not
 * installed, or when the registry would hand back this module's own shim.
 */
export function resolveRealClaudeBinary(): string {
  let executable: string;
  try {
    executable = resolveHarnessBinary('claude');
  } catch (error) {
    if (!(error instanceof HarnessBinaryUnresolvedError)) throw error;
    // Prefix matched by shell-error-frame.ts (the tail is never published).
    throw new Error(
      `Claude executable not found before installing the managed terminal launcher (${error.message})`,
    );
  }
  // The shim must never resolve to itself (infinite launcher recursion).
  if (path.resolve(executable) === path.resolve(MANAGED_CLAUDE_WRAPPER)) {
    throw new Error('Claude executable resolves to the managed terminal launcher itself');
  }
  return path.resolve(executable);
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
  const realBinary = resolveRealClaudeBinary();
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
