/**
 * ADR-219 "CLI version check" — the version of the claude CLI a resume turn
 * would run, read with `--version` (argv only, no shell) and cached briefly so
 * a harness update is noticed without a probe per delivery.
 */

import { execFile } from 'node:child_process';

// eslint-disable-next-line boundaries/no-unknown -- the root command service owns the canonical secret-stripping environment.
import { cleanSpawnEnv } from '@/services/command-board-custom.js';

const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5000;

type Exec = (binary: string, args: string[]) => Promise<string>;

/**
 * Runs the binary without a shell under cleanSpawnEnv (B-1713): PATH and HOME
 * stay (the CLI shebang is `#!/usr/bin/env node`), server secrets never reach it.
 */
export const defaultExec: Exec = (binary, args) => new Promise((resolve, reject) => {
  const env = cleanSpawnEnv() as NodeJS.ProcessEnv;
  execFile(binary, args, { timeout: TIMEOUT_MS, env }, (error, stdout) => {
    if (error) reject(error);
    else resolve(String(stdout));
  });
});

/** `x.y.z` at the start of a line of `claude --version` output, or null. */
export function parseCliVersion(output: string): string | null {
  const match = /^(\d+\.\d+\.\d+)\b/mu.exec(output);
  return match ? match[1]! : null;
}

/**
 * A cached reader. `resolveBinary` is called on every miss (the harness registry
 * may move the binary); a failed read is not cached.
 */
export function createCliVersionReader(resolveBinary: () => string, exec: Exec = defaultExec, now = Date.now) {
  let cached: { version: string; at: number } | null = null;
  return async (): Promise<string | null> => {
    if (cached && now() - cached.at < TTL_MS) return cached.version;
    try {
      const version = parseCliVersion(await exec(resolveBinary(), ['--version']));
      if (version) cached = { version, at: now() };
      return version;
    } catch {
      return null;
    }
  };
}
