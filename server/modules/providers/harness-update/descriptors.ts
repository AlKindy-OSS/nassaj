/**
 * HARNESS_UPDATE_DESCRIPTORS (T-1749 / ADR-159) — the server-owned, hardcoded
 * table that drives the per-harness version indicator and direct update. The
 * client NEVER sends a command; it sends a harness id only, and the server maps
 * it here to a FIXED resolver + version-read argv + latest probe + exact update
 * argv. Adding/editing an entry is a code change gated on review (never data,
 * never a request field) — that is the injection-free property of ADR-159.
 *
 * ONE resolver per harness, used for spawn, version read AND update target
 * (never `command -v`): a divergence would let the indicator report a different
 * binary than the one that actually runs. The resolvers below reuse each
 * provider's own spawn resolver where one exists (kimi/cursor/qwen), and mirror
 * the documented resolution order otherwise (agy AGY_PATH, opencode OPENCODE_PATH
 * → ~/.opencode, …). All resolvers prefer a user-owned install and degrade to a
 * bare name only when no user copy exists.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line boundaries/no-unknown -- provider launchers own the exact binary resolvers this descriptor must share.
import { resolveCursorBinaryPath } from '@/cursor-cli.js';
// eslint-disable-next-line boundaries/no-unknown -- provider launchers own the exact binary resolvers this descriptor must share.
import { resolveKimiBinaryPath } from '@/kimi-agent-cli.js';
// eslint-disable-next-line boundaries/no-unknown -- provider launchers own the exact binary resolvers this descriptor must share.
import { resolveQwenBinaryPath } from '@/qwen-cli.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { HarnessVersionState } from '../../../../shared/harness-update.contract.js';

export type HarnessInstallMethod =
  | 'native-self-update'
  | 'npm-prefix'
  | 'git-shallow'
  | 'none';

export type HarnessChecksumSource = 'opencode-github' | 'npm-registry' | 'none';

/** Exact, fixed update invocation for a harness (no client input reaches here). */
export interface HarnessUpdateArgv {
  cmd: string;
  args: string[];
  /** Working directory for the update (hermes runs inside its git checkout). */
  cwd?: string;
  /**
   * Extra env merged OVER `cleanSpawnEnv()` for this harness's update AND its
   * recovery run. Two uses today:
   *   - `TMPDIR=/var/tmp` for the npm harnesses (kimi, qwen): npm stages the
   *     tarball in TMPDIR, and the host's /tmp is tmpfs = RAM (the 2026-07 OOM
   *     incident). ADR-159 Addendum 3 makes /var/tmp binding for both.
   *   - `HERMES_HOME` for hermes: the updater rewrites the checkout, so it must
   *     read the operator's own hermes home explicitly, not a derived one.
   * Never secrets: this is a fixed, code-owned table (no request field reaches it).
   */
  env?: Record<string, string>;
}

/** Async latest-version probe spec. Only `npm` is cheap enough to run today. */
export type HarnessLatestProbe =
  | { kind: 'npm'; pkg: string }
  | null;

export interface HarnessDescriptor {
  /** Canonical harness id (provider-registry id where one exists). */
  id: string;
  /** Accepted request aliases normalised to `id`. */
  aliases: string[];
  installMethod: HarnessInstallMethod;
  /** Baseline UI state; the probe may downgrade `updatable` → `unknown`. */
  state: HarnessVersionState;
  /** Whether the update button is actionable at all. */
  updatable: boolean;
  /** Baseline machine reason (null when a plain updatable harness). */
  reason: string | null;
  /**
   * Run-registry provider ids that count as a LIVE session of this harness, for
   * the cross-user no-live-session gate. `agy` registers runs as `antigravity`.
   */
  runProviders: string[];
  /** Key in PINNED_VENDOR_DIGESTS, or null when this harness is not pinned. */
  pinKey: string | null;
  /** Where the vendor publishes a verifiable checksum for a signed re-pin. */
  checksumSource: HarnessChecksumSource;
  /**
   * Env that DISABLES the CLI's own built-in auto-updater (D2). An entry is
   * WIRED into the governed spawn env (`services/isolation/resolve-provider-env.js`)
   * ONLY when `autoUpdaterDisableVerified` is true; two are today:
   *   - claude   `DISABLE_AUTOUPDATER=1` — documented Anthropic knob, asserted on
   *              the spawned env by `claude-sdk.disable-autoupdater.test.ts`.
   *   - opencode `OPENCODE_DISABLE_AUTOUPDATE=1` — measured on-host in the pinned
   *              binary: it reads the var into its env map and its update check
   *              short-circuits on `config.autoupdate===false || env.OPENCODE_
   *              DISABLE_AUTOUPDATE`. Asserted on the resolved env by
   *              `resolve-provider-env.opencode-autoupdate.test.js`.
   * Unverified entries (qwen/kimi `NO_UPDATE_NOTIFIER`) stay DATA-only: an
   * unverified knob silently wired is a no-op that reads like a guarantee, and
   * the scheduler skips any harness whose knob is unverified.
   * `null` = no known knob (listed in AUTOUPDATER_DISABLE_NONE).
   */
  disableAutoUpdaterEnv: Record<string, string> | null;
  autoUpdaterDisableVerified: boolean;
  /** For npm-prefix harnesses: the install prefix + package (update + recovery). */
  npm?: { prefix: string; pkg: string };
  /** For git-shallow (hermes): the shallow git checkout the updater rewrites. */
  gitCheckoutDir?: string;
  /** Resolves the final spawn/version/update binary. Never `command -v`. */
  resolveBinary: (env?: NodeJS.ProcessEnv) => string;
  /** Argv appended to the binary to read the installed version. */
  versionArgs: string[];
  /** Builds the exact fixed update argv, or null when not updatable. */
  updateArgv: (
    env?: NodeJS.ProcessEnv,
    context?: { gitCheckoutDir?: string },
  ) => HarnessUpdateArgv | null;
  latestProbe: HarnessLatestProbe;
}

const home = () => os.homedir();

/** agy resolver — mirrors agy-cli.js:42 (AGY_PATH || ~/.local/bin/agy). */
function resolveAgyBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGY_PATH?.trim();
  return override || path.join(home(), '.local', 'bin', 'agy');
}

/** opencode resolver — mirrors resolveOpenCodeBinaryPathRaw (no pin throw here). */
function resolveOpenCodeBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCODE_PATH?.trim();
  if (override) return override;
  const installed = path.join(home(), '.opencode', 'bin', 'opencode');
  try {
    if (fs.existsSync(installed)) return installed;
  } catch {
    /* fall through */
  }
  return 'opencode';
}

/** Claude resolver shared with every SDK launch (`CLAUDE_CLI_PATH`, PATH, then known installs). */
function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env): string {
  return resolveClaudeCodeExecutablePath(env.CLAUDE_CLI_PATH, { env });
}

/** codex resolver — CODEX_PATH override, else the user launcher, else bare. */
function resolveCodexBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_PATH?.trim();
  if (override) return override;
  try {
    const launcher = path.join(home(), '.local', 'bin', 'codex');
    if (fs.existsSync(launcher)) return launcher;
  } catch {
    /* fall through */
  }
  return 'codex';
}

/**
 * hermes resolver — HERMES_PATH override, else the MEASURED launcher
 * `~/.local/bin/hermes` (a bash shim that execs `<checkout>/venv/bin/hermes`),
 * else bare. `~/.hermes/bin` holds uv/uvx/tirith only — never the CLI.
 */
function resolveHermesBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HERMES_PATH?.trim();
  if (override) return override;
  for (const candidate of [
    path.join(home(), '.local', 'bin', 'hermes'),
    path.join(home(), '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes'),
  ]) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* fall through */
    }
  }
  return 'hermes';
}

/** hermes git checkout (measured: shallow clone at ~/.hermes/hermes-agent). */
export function resolveHermesCheckoutDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HERMES_CHECKOUT_DIR?.trim();
  return override || path.join(home(), '.hermes', 'hermes-agent');
}

/** hermes per-user state root, passed explicitly to the updater (isolation). */
function resolveHermesHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HERMES_HOME?.trim();
  return override || path.join(home(), '.hermes');
}

/** `uv` used to reinstall the hermes venv on rollback (measured ~/.local/bin/uv). */
export function resolveUvBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HERMES_UV_PATH?.trim();
  if (override) return override;
  const measured = path.join(home(), '.local', 'bin', 'uv');
  try {
    if (fs.existsSync(measured)) return measured;
  } catch {
    /* fall through */
  }
  return 'uv';
}

/** Python interpreter of the hermes venv, for `uv pip install -e .` on rollback. */
export function resolveHermesVenvPython(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveHermesCheckoutDir(env), 'venv', 'bin', 'python');
}

/** TMPDIR every npm-backed harness update/recovery runs under (never tmpfs). */
export const NPM_UPDATE_TMPDIR = '/var/tmp';

/**
 * Harnesses with NO verified built-in auto-updater disable env (D2). For these
 * the server scheduler is the single controlled update path; the built-in
 * updater is not disabled because no knob was confirmed on-host.
 *   - codex:        `codex update` is manual; --help exposes only a generic
 *                   `--disable <FEATURE>`, not an auto-updater switch.
 *   - antigravity:  no auto-update env in --help or bundled strings.
 *   - cursor:       no auto-update env in --help.
 *   - hermes:       git-shallow (Addendum 3); no built-in updater knob, so the
 *                   scheduler skips it and the manual button owns its updates.
 *   - qwen/kimi:    npm-managed; NO_UPDATE_NOTIFIER is carried in the descriptor
 *                   but UNVERIFIED on-host, so it is not wired into the spawn env.
 * KNOB VERIFIED and WIRED (claude, opencode):
 *   - claude:   DISABLE_AUTOUPDATER=1 — documented Anthropic knob, WIRED into the
 *               governed spawn env (resolve-provider-env.js) and asserted on the
 *               spawned env by claude-sdk.disable-autoupdater.test.ts.
 *   - opencode: OPENCODE_DISABLE_AUTOUPDATE=1 — measured on-host (2026-09-11) in
 *               the pinned binary: the var is read into opencode's env map and
 *               the auto-update check returns early on it. WIRED in
 *               resolve-provider-env.js, asserted by
 *               resolve-provider-env.opencode-autoupdate.test.js.
 * A harness with `autoUpdaterDisableVerified !== true` is SKIPPED by the
 * auto-update scheduler (its built-in updater could still race the server).
 */
export const AUTOUPDATER_DISABLE_NONE = Object.freeze([
  'codex', 'antigravity', 'cursor', 'hermes', 'qwen', 'kimi',
]);

/**
 * npm install prefixes measured on-host (T-1749 D3):
 *   kimi  → ~/.local/share/kimi-code-vendor  (bin/kimi + node_modules/)
 *   qwen  → ~/.local                         (lib/node_modules + bin/qwen)
 */
const KIMI_NPM_PREFIX = path.join(home(), '.local', 'share', 'kimi-code-vendor');
const QWEN_NPM_PREFIX = path.join(home(), '.local');

/** The canonical descriptor table, keyed by canonical harness id. */
export const HARNESS_UPDATE_DESCRIPTORS: Readonly<Record<string, HarnessDescriptor>> = Object.freeze({
  claude: {
    id: 'claude',
    aliases: [],
    installMethod: 'native-self-update',
    state: 'managed-external',
    updatable: false,
    reason: 'rollback-unavailable',
    runProviders: ['claude'],
    pinKey: null,
    checksumSource: 'none',
    // DISABLE_AUTOUPDATER is the documented Claude Code knob and the ONLY one
    // actually wired into the governed spawn env (resolve-provider-env.js);
    // claude-sdk.disable-autoupdater.test.ts asserts it on the spawned env.
    disableAutoUpdaterEnv: { DISABLE_AUTOUPDATER: '1' },
    autoUpdaterDisableVerified: true,
    resolveBinary: resolveClaudeBinary,
    versionArgs: ['--version'],
    updateArgv: (env = process.env) => ({ cmd: resolveClaudeBinary(env), args: ['update'] }),
    latestProbe: null,
  },
  codex: {
    id: 'codex',
    aliases: [],
    installMethod: 'native-self-update',
    state: 'managed-external',
    updatable: false,
    reason: 'rollback-unavailable',
    runProviders: ['codex'],
    pinKey: null,
    checksumSource: 'none',
    disableAutoUpdaterEnv: null,
    autoUpdaterDisableVerified: false,
    resolveBinary: resolveCodexBinary,
    versionArgs: ['--version'],
    updateArgv: (env = process.env) => ({ cmd: resolveCodexBinary(env), args: ['update'] }),
    latestProbe: null,
  },
  antigravity: {
    id: 'antigravity',
    aliases: ['agy'],
    installMethod: 'native-self-update',
    state: 'managed-external',
    updatable: false,
    reason: 'rollback-unavailable',
    // agy runs register under the `antigravity` run-registry provider id.
    runProviders: ['antigravity', 'agy'],
    pinKey: null,
    checksumSource: 'none',
    disableAutoUpdaterEnv: null,
    autoUpdaterDisableVerified: false,
    resolveBinary: resolveAgyBinary,
    versionArgs: ['--version'],
    updateArgv: (env = process.env) => ({ cmd: resolveAgyBinary(env), args: ['update'] }),
    latestProbe: null,
  },
  cursor: {
    id: 'cursor',
    aliases: ['cursor-agent'],
    installMethod: 'native-self-update',
    state: 'managed-external',
    updatable: false,
    reason: 'rollback-unavailable',
    runProviders: ['cursor'],
    pinKey: null,
    checksumSource: 'none',
    disableAutoUpdaterEnv: null,
    autoUpdaterDisableVerified: false,
    resolveBinary: (env) => resolveCursorBinaryPath(env),
    versionArgs: ['--version'],
    updateArgv: (env) => ({ cmd: resolveCursorBinaryPath(env), args: ['update'] }),
    latestProbe: null,
  },
  opencode: {
    id: 'opencode',
    aliases: [],
    installMethod: 'native-self-update',
    state: 'managed-external',
    updatable: false,
    reason: 'rollback-unavailable',
    // opencode carries the GLM row: one opencode update moves both UI rows.
    runProviders: ['opencode', 'glm'],
    pinKey: 'opencode',
    checksumSource: 'opencode-github',
    // OPENCODE_DISABLE_AUTOUPDATE — measured on-host in the pinned binary (the
    // env is read and the auto-update check short-circuits on it), so it IS
    // wired into the governed spawn env (resolve-provider-env.js, case
    // 'opencode') and asserted there by a test on the resolved env.
    disableAutoUpdaterEnv: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
    autoUpdaterDisableVerified: true,
    resolveBinary: resolveOpenCodeBinary,
    versionArgs: ['--version'],
    updateArgv: (env = process.env) => ({ cmd: resolveOpenCodeBinary(env), args: ['upgrade'] }),
    latestProbe: null,
  },
  qwen: {
    id: 'qwen',
    aliases: [],
    installMethod: 'npm-prefix',
    state: 'updatable',
    updatable: true,
    reason: null,
    runProviders: ['qwen'],
    pinKey: null,
    checksumSource: 'npm-registry',
    // update-notifier honours NO_UPDATE_NOTIFIER; not yet host-verified for qwen.
    disableAutoUpdaterEnv: { NO_UPDATE_NOTIFIER: '1' },
    autoUpdaterDisableVerified: false,
    npm: { prefix: QWEN_NPM_PREFIX, pkg: '@qwen-code/qwen-code' },
    resolveBinary: (env) => resolveQwenBinaryPath(env),
    versionArgs: ['--version'],
    // Deterministic npm reinstall into the MEASURED user prefix. `qwen update`
    // exists ("check and install") but re-derives its own prefix; the fixed
    // reinstall is prefix-correct, non-interactive and recoverable (D3/item 3).
    updateArgv: () => ({
      cmd: 'npm',
      args: ['install', '--prefix', QWEN_NPM_PREFIX, '@qwen-code/qwen-code@latest'],
      // /tmp is tmpfs (RAM) on this host; npm stages tarballs in TMPDIR.
      env: { TMPDIR: NPM_UPDATE_TMPDIR },
    }),
    latestProbe: { kind: 'npm', pkg: '@qwen-code/qwen-code' },
  },
  kimi: {
    id: 'kimi',
    aliases: [],
    installMethod: 'npm-prefix',
    state: 'updatable',
    updatable: true,
    reason: null,
    runProviders: ['kimi'],
    pinKey: 'kimi',
    checksumSource: 'npm-registry',
    disableAutoUpdaterEnv: { NO_UPDATE_NOTIFIER: '1' },
    autoUpdaterDisableVerified: false,
    npm: { prefix: KIMI_NPM_PREFIX, pkg: '@moonshot-ai/kimi-code' },
    resolveBinary: (env) => resolveKimiBinaryPath(env),
    versionArgs: ['--version'],
    updateArgv: () => ({
      cmd: 'npm',
      args: ['install', '--prefix', KIMI_NPM_PREFIX, '@moonshot-ai/kimi-code@latest'],
      // /tmp is tmpfs (RAM) on this host; npm stages tarballs in TMPDIR.
      env: { TMPDIR: NPM_UPDATE_TMPDIR },
    }),
    latestProbe: { kind: 'npm', pkg: '@moonshot-ai/kimi-code' },
  },
  hermes: {
    id: 'hermes',
    aliases: [],
    installMethod: 'git-shallow',
    // ADR-159 Addendum 3 (supersedes D4): the checkout is a SHALLOW CLONE and
    // the carried 5ecf3bf0 is upstream, not a local-only commit, so nothing is
    // destroyed. `hermes update` = git fetch + reset --hard + uv pip install -e.
    // `--yes` is required for a headless run (it only answers the CLI's
    // interactive migrate/stash prompts; it does not change what is installed).
    state: 'updatable',
    updatable: true,
    reason: null,
    runProviders: ['hermes'],
    pinKey: null,
    checksumSource: 'none',
    disableAutoUpdaterEnv: null,
    autoUpdaterDisableVerified: false,
    gitCheckoutDir: resolveHermesCheckoutDir(),
    resolveBinary: resolveHermesBinary,
    versionArgs: ['--version'],
    updateArgv: (env = process.env, context = {}) => ({
      cmd: path.join(
        context.gitCheckoutDir ?? resolveHermesCheckoutDir(env), 'venv', 'bin', 'hermes',
      ),
      args: ['update', '--yes'],
      // The updater rewrites the checkout, so it runs INSIDE it.
      cwd: context.gitCheckoutDir ?? resolveHermesCheckoutDir(env),
      // HERMES_HOME isolation: name the state root explicitly instead of letting
      // the CLI derive ~/.hermes from whatever HOME cleanSpawnEnv() carries.
      env: { HERMES_HOME: resolveHermesHome(env) },
    }),
    latestProbe: null,
  },
  glm: {
    id: 'glm',
    aliases: [],
    installMethod: 'none',
    // GLM has no local CLI — it rides the opencode carrier.
    state: 'no-cli',
    updatable: false,
    reason: 'updates with opencode',
    runProviders: ['glm'],
    pinKey: null,
    checksumSource: 'none',
    disableAutoUpdaterEnv: null,
    autoUpdaterDisableVerified: false,
    resolveBinary: () => 'opencode',
    versionArgs: ['--version'],
    updateArgv: () => null,
    latestProbe: null,
  },
  deepseek: {
    id: 'deepseek',
    aliases: [],
    installMethod: 'none',
    state: 'no-cli',
    updatable: false,
    reason: 'no-cli',
    runProviders: ['deepseek'],
    pinKey: null,
    checksumSource: 'none',
    disableAutoUpdaterEnv: null,
    autoUpdaterDisableVerified: false,
    resolveBinary: () => '',
    versionArgs: ['--version'],
    updateArgv: () => null,
    latestProbe: null,
  },
});

/** Every canonical harness id, in a stable display order. */
export const HARNESS_IDS: readonly string[] = Object.freeze(
  Object.keys(HARNESS_UPDATE_DESCRIPTORS),
);

const ALIAS_TO_ID: Readonly<Record<string, string>> = Object.freeze(
  Object.values(HARNESS_UPDATE_DESCRIPTORS).reduce<Record<string, string>>((acc, d) => {
    acc[d.id] = d.id;
    for (const alias of d.aliases) acc[alias] = d.id;
    return acc;
  }, {}),
);

/**
 * Normalises a request harness id/alias to its canonical id, or null when it is
 * not a known harness (the route answers a clean 4xx, never a crash).
 */
export function resolveHarnessId(idOrAlias: unknown): string | null {
  if (typeof idOrAlias !== 'string') return null;
  const key = idOrAlias.trim().toLowerCase();
  return ALIAS_TO_ID[key] ?? null;
}

/** Looks up a descriptor by id/alias, or null. */
export function getHarnessDescriptor(idOrAlias: unknown): HarnessDescriptor | null {
  const id = resolveHarnessId(idOrAlias);
  return id ? HARNESS_UPDATE_DESCRIPTORS[id] : null;
}

/**
 * Parses a CLI `--version` output into a comparable version string. Handles the
 * plain `1.2.3` / `2026.07.23-e383d2b` / `0.42.0` forms and hermes' banner
 * (`Hermes Agent v0.17.0 (…)`). Returns null when no version token is found.
 */
export function parseVersionOutput(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;
  // hermes banner: prefer the `vX.Y.Z` token.
  const vTagged = text.match(/\bv(\d+\.\d+\.\d+[\w.-]*)/i);
  if (vTagged) return vTagged[1];
  // Otherwise the first version-looking token (date-versions included).
  const token = text.match(/\d+\.\d+(?:\.\d+)?[\w.-]*/);
  return token ? token[0] : null;
}
