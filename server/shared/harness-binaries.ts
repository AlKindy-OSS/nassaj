/**
 * Harness binary registry (T-1873) — the ONE resolver for every harness CLI
 * Nassaj launches, probes, versions and updates.
 *
 * Owner principle: each harness runs the single copy the operator's terminal
 * reaches, installed by the vendor's official user-level method (like Claude in
 * `~/.local/bin`), and the update button updates that same copy. There are no
 * bundled or private vendor copies.
 *
 * Resolution rule (no exceptions, no PATH lookup):
 *   1. the operator override in the SERVER process env (`KIMI_PATH`, …) when set.
 *      It must be absolute and runnable; a bad override fails instead of silently
 *      falling back, because the operator asked for that exact file.
 *   2. the explicit measured install path under the operator home.
 *   3. otherwise a HarnessBinaryUnresolvedError naming what was checked.
 *
 * The override is read from `process.env` ONLY. A member/provider env (the
 * isolated env a spawn runs under) can never redirect the binary: there is no
 * env parameter by design.
 */

import os from 'node:os';
import path from 'node:path';

import {
  isRunnableClaudeExecutable,
  resolveClaudeCodeExecutablePath,
  wellKnownClaudeInstallCandidates,
} from './claude-cli-path.js';
import {
  CODEX_MACHINE_CLI_MISSING,
  codexMachineLauncherPath,
  resolveCodexMachineRuntime,
} from './codex-executable.js';

/** Canonical harness ids with a local CLI (the `no-cli` harnesses have none). */
export type HarnessBinaryId =
  | 'claude'
  | 'codex'
  | 'antigravity'
  | 'cursor'
  | 'opencode'
  | 'qwen'
  | 'kimi'
  | 'hermes';

/** How one harness binary is located. */
export interface HarnessBinarySpec {
  /** The CLI's command name (used in messages and PTY command lines). */
  command: string;
  /** Server-process env var holding an absolute operator override. */
  overrideEnv: string;
  /** The measured official install path, derived from the operator home. */
  measured: (home: string) => string;
  /**
   * Replaces the generic override → measured rule when the harness owns a
   * stricter resolver (codex: T-1872's machine release identity).
   */
  resolve?: (home: string) => string;
}

const localBin = (command: string) => (home: string) => path.join(home, '.local', 'bin', command);

/**
 * The registry. Measured on the reference host (2026-09-27): claude, cursor,
 * agy, qwen and hermes in `~/.local/bin`, opencode and kimi in their official
 * installers' `~/.opencode/bin` and `~/.kimi-code/bin` (kimi: the vendor's
 * native install script, owner decision ADR-189; KIMI_INSTALL_DIR is NOT
 * honoured — only the measured path or the KIMI_PATH server override), codex
 * through T-1872's machine release identity.
 */
export const HARNESS_BINARY_SPECS: Readonly<Record<HarnessBinaryId, HarnessBinarySpec>> = Object.freeze({
  // Delegates the candidate to claude-cli-path.ts: its first well-known
  // candidate is the native installer's `~/.local/bin/claude`.
  claude: {
    command: 'claude',
    overrideEnv: 'CLAUDE_CLI_PATH',
    measured: (home) => wellKnownClaudeInstallCandidates(home, 'claude')[0],
  },
  // codex: the SAME resolver every codex launch uses (codex-executable.js). The
  // launcher is returned only once its machine release validates, so the
  // descriptor, the boot check and every spawn agree on one binary.
  codex: {
    command: 'codex', overrideEnv: 'CODEX_PATH', measured: localBin('codex'),
    resolve: (home) => resolveCodexMachineLauncher(home),
  },
  antigravity: { command: 'agy', overrideEnv: 'AGY_PATH', measured: localBin('agy') },
  cursor: { command: 'cursor-agent', overrideEnv: 'CURSOR_PATH', measured: localBin('cursor-agent') },
  opencode: {
    command: 'opencode',
    overrideEnv: 'OPENCODE_PATH',
    measured: (home) => path.join(home, '.opencode', 'bin', 'opencode'),
  },
  qwen: { command: 'qwen', overrideEnv: 'QWEN_PATH', measured: localBin('qwen') },
  kimi: {
    command: 'kimi',
    overrideEnv: 'KIMI_PATH',
    measured: (home) => path.join(home, '.kimi-code', 'bin', 'kimi'),
  },
  hermes: { command: 'hermes', overrideEnv: 'HERMES_PATH', measured: localBin('hermes') },
});

/** Every harness id the registry resolves, in a stable order. */
export const HARNESS_BINARY_IDS: readonly HarnessBinaryId[] = Object.freeze(
  Object.keys(HARNESS_BINARY_SPECS) as HarnessBinaryId[],
);

/** Accepted aliases (run-provider / command names) → canonical id. */
const HARNESS_BINARY_ALIASES: Readonly<Record<string, HarnessBinaryId>> = Object.freeze({
  agy: 'antigravity',
  'cursor-agent': 'cursor',
});

export type HarnessBinaryFailure =
  | 'override-not-absolute'
  | 'override-not-runnable'
  | 'not-installed'
  | 'invalid-install';

/** Typed refusal: the harness CLI cannot be located by the registry rule. */
export class HarnessBinaryUnresolvedError extends Error {
  readonly code = 'HARNESS_BINARY_UNRESOLVED';
  readonly harness: string;
  readonly reason: HarnessBinaryFailure;

  constructor(harness: string, reason: HarnessBinaryFailure, message: string) {
    super(message);
    this.name = 'HarnessBinaryUnresolvedError';
    this.harness = harness;
    this.reason = reason;
  }
}

/** Normalises an id or alias to a canonical registry id, or null. */
export function toHarnessBinaryId(idOrAlias: string): HarnessBinaryId | null {
  const key = idOrAlias.trim().toLowerCase();
  if (Object.hasOwn(HARNESS_BINARY_SPECS, key)) return key as HarnessBinaryId;
  return HARNESS_BINARY_ALIASES[key] ?? null;
}

/** Shows a path relative to the operator home (`~/…`) in messages. */
function displayPath(filePath: string, home: string): string {
  return home && filePath.startsWith(`${home}${path.sep}`) ? `~${filePath.slice(home.length)}` : filePath;
}

function specFor(idOrAlias: string): { id: HarnessBinaryId; spec: HarnessBinarySpec } {
  const id = toHarnessBinaryId(idOrAlias);
  if (!id) throw new Error(`Unknown harness binary id: ${idOrAlias}`);
  return { id, spec: HARNESS_BINARY_SPECS[id] };
}

function resolveOverride(id: HarnessBinaryId, spec: HarnessBinarySpec, override: string, home: string): string {
  if (!path.isAbsolute(override)) {
    throw new HarnessBinaryUnresolvedError(
      id,
      'override-not-absolute',
      `${spec.command} CLI override ${spec.overrideEnv} must be an absolute path.`,
    );
  }
  if (!isRunnableClaudeExecutable(override)) {
    // The override path itself is never echoed: these messages reach members.
    throw new HarnessBinaryUnresolvedError(
      id,
      'override-not-runnable',
      `${spec.command} CLI override ${spec.overrideEnv} does not point at a runnable file.`,
    );
  }
  return override;
}

/** Not-installed refusal naming the measured path (home-relative) and the override. */
function notInstalled(id: HarnessBinaryId, spec: HarnessBinarySpec, home: string): HarnessBinaryUnresolvedError {
  return new HarnessBinaryUnresolvedError(
    id,
    'not-installed',
    `${spec.command} CLI not found at ${displayPath(spec.measured(home), home)}. Install it with the vendor's `
      + `official method, or set ${spec.overrideEnv} to its absolute path.`,
  );
}

/**
 * codex: validate the machine release T-1872 launches (layout, native entry,
 * manifest) and return its launcher. The identity module owns CODEX_PATH.
 */
function resolveCodexMachineLauncher(home: string): string {
  const spec = HARNESS_BINARY_SPECS.codex;
  try {
    resolveCodexMachineRuntime();
    return codexMachineLauncherPath();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'PERMISSION_CODEX_PATH_NOT_ABSOLUTE') {
      throw new HarnessBinaryUnresolvedError('codex', 'override-not-absolute',
        `codex CLI override ${spec.overrideEnv} must be an absolute path.`);
    }
    if (code === CODEX_MACHINE_CLI_MISSING) throw notInstalled('codex', spec, home);
    throw new HarnessBinaryUnresolvedError('codex', 'invalid-install',
      `codex CLI is not a usable machine release (${typeof code === 'string' ? code : 'unreadable'}).`);
  }
}

/**
 * Resolves a harness CLI to the absolute path every launch site must use.
 * Returns the launcher path itself (never its realpath) so the snapshot layouts
 * see the same symlink the operator's terminal runs. Throws
 * HarnessBinaryUnresolvedError when the CLI is not where the rule expects it.
 */
export function resolveHarnessBinary(idOrAlias: string): string {
  const { id, spec } = specFor(idOrAlias);
  const override = process.env[spec.overrideEnv]?.trim() ?? '';
  // win32 keeps the claude-cli-path resolver (where.exe + .exe wrapper
  // unwrapping); the measured paths below are POSIX installer layouts.
  if (id === 'claude' && process.platform === 'win32') {
    return resolveClaudeCodeExecutablePath(override || undefined);
  }
  const home = os.homedir();
  if (spec.resolve) return spec.resolve(home);
  if (override) return resolveOverride(id, spec, override, home);

  const measured = spec.measured(home);
  if (isRunnableClaudeExecutable(measured)) return measured;
  throw notInstalled(id, spec, home);
}

/**
 * `resolveHarnessBinary` with one more SERVER-env override that wins over the
 * harness's own (e.g. the workflow supervisor's WORKFLOW_SUPERVISOR_CLAUDE_BIN).
 * The same rules apply: absolute and runnable, or a clear refusal — never a
 * PATH lookup and never a silent fallback.
 */
export function resolveHarnessBinaryWithOverride(idOrAlias: string, overrideEnv: string): string {
  const { id, spec } = specFor(idOrAlias);
  const override = process.env[overrideEnv]?.trim() ?? '';
  if (!override) return resolveHarnessBinary(id);
  return resolveOverride(id, { ...spec, overrideEnv }, override, os.homedir());
}

/** Non-throwing form: the resolved path, or null when the CLI is unresolved. */
export function tryResolveHarnessBinary(idOrAlias: string): string | null {
  try {
    return resolveHarnessBinary(idOrAlias);
  } catch (error) {
    if (error instanceof HarnessBinaryUnresolvedError) return null;
    throw error;
  }
}

/** POSIX single-quote for a PTY command line (`'…'`, embedded `'` escaped). */
export function shellQuoteBinary(filePath: string): string {
  return `'${filePath.replace(/'/g, `'\\''`)}'`;
}

/** The shell-quoted resolved path, for PTY command lines. Throws when unresolved. */
export function quotedHarnessBinary(idOrAlias: string): string {
  return shellQuoteBinary(resolveHarnessBinary(idOrAlias));
}

/** One boot-check row. */
export interface HarnessBinaryStatus {
  id: HarnessBinaryId;
  resolved: boolean;
  path: string | null;
  error: string | null;
  /** The server env var an operator sets to point at a non-standard install. */
  overrideEnv: string;
}

/** Resolves every registry harness without throwing (boot check / diagnostics). */
export function inspectHarnessBinaries(): HarnessBinaryStatus[] {
  return HARNESS_BINARY_IDS.map((id) => {
    const { overrideEnv } = HARNESS_BINARY_SPECS[id];
    try {
      return { id, resolved: true, path: resolveHarnessBinary(id), error: null, overrideEnv };
    } catch (error) {
      if (!(error instanceof HarnessBinaryUnresolvedError)) throw error;
      return { id, resolved: false, path: null, error: error.message, overrideEnv };
    }
  });
}

/**
 * Boot check: logs every harness the registry cannot resolve, each with the
 * exact fix (e.g. a fleet node whose claude came from a system `npm i -g` sets
 * CLAUDE_CLI_PATH=/usr/bin/claude). Never throws — a missing harness only
 * disables that harness; the service keeps running. codex is checked through
 * the same machine-release resolver its launches use.
 */
export function logUnresolvedHarnessBinaries(
  warn: (message: string, details: Record<string, unknown>) => void = console.warn,
): HarnessBinaryStatus[] {
  let statuses: HarnessBinaryStatus[];
  try {
    statuses = inspectHarnessBinaries();
  } catch (error) {
    warn('[harness-binaries] boot check failed', { error: String(error) });
    return [];
  }
  const unresolved = statuses.filter((status) => !status.resolved);
  if (unresolved.length > 0) {
    warn('[harness-binaries] harness CLIs not resolved; those harnesses cannot launch', {
      unresolved: unresolved.map(({ id, error, overrideEnv }) => ({
        id,
        error,
        fix: `install ${HARNESS_BINARY_SPECS[id].command} with the vendor's official user-level method, `
          + `or set ${overrideEnv}=<absolute path of the installed CLI> in the server environment and restart`,
      })),
    });
  }
  return statuses;
}
