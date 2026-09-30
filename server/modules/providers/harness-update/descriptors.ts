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
 * binary than the one that actually runs. Every `resolveBinary` delegates to the
 * shared harness registry (server/shared/harness-binaries.ts, T-1873), the same
 * resolver every launch site uses; the parity guard
 * (server/shared/harness-binary-parity.guard.test.ts) fails on any divergence.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PINNED_VENDOR_DIGESTS } from '@/services/isolation/vendor-binary-integrity.js';
import {
  resolveHarnessBinary,
  tryResolveHarnessBinary,
  type HarnessBinaryId,
} from '@/shared/harness-binaries.js';

import type { HarnessVersionState } from '../../../../shared/harness-update.contract.js';

import type { BinaryLayoutSpec } from './snapshot/binary-snapshot.js';
import type { BinaryLayout, LinkMode } from './snapshot/manifest.js';
import { CODEX_STORE, OPENCODE_STORE, type StoreSpec } from './snapshot/store-backup.js';
import {
  claudeLayout,
  codexLayout,
  codexUpdateEnv,
  cursorLayout,
  singleFileLayout,
} from './snapshot-layouts.js';

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
   *   - `TMPDIR=/var/tmp` for the npm harness (qwen): npm stages the
   *     tarball in TMPDIR, and the host's /tmp is tmpfs = RAM (the 2026-07 OOM
   *     incident). ADR-159 Addendum 3 makes /var/tmp binding for both.
   *   - `HERMES_HOME` for hermes: the updater rewrites the checkout, so it must
   *     read the operator's own hermes home explicitly, not a derived one.
   * Never secrets: this is a fixed, code-owned table (no request field reaches it).
   */
  env?: Record<string, string>;
}

/**
 * Async latest-version probe spec. `npm` reads the registry `latest` dist-tag;
 * `github-release` reads a FIXED GitHub `releases/latest` URL (code-owned, never
 * a request field). Both were validated on-host (docs/ops/t1871-measurements.md
 * §b/§c): the published numbering equals the native `--version` output.
 */
export type HarnessLatestProbe =
  | { kind: 'npm'; pkg: string }
  | { kind: 'github-release'; url: string }
  | null;

/** Fixed GitHub latest-release endpoint for opencode (repo moved sst → anomalyco). */
export const OPENCODE_LATEST_RELEASE_URL =
  'https://api.github.com/repos/anomalyco/opencode/releases/latest';

/**
 * How a harness install is snapshotted before an update (T-1871 stage 3,
 * spec §1). `resolveLayout` derives the live paths from the resolved launcher.
 */
export interface HarnessSnapshotSpec {
  layout: BinaryLayout;
  linkMode: LinkMode;
  /** SQLite stores backed up with the binary (none for most harnesses). */
  stores: readonly StoreSpec[];
  resolveLayout: (binaryPath: string) => BinaryLayoutSpec;
}

/** Known-release restore source (opencode only: the digest-verified release asset). */
export interface HarnessRestoreCompatibleSpec {
  /** Version the action installs; always the digest pin, never changed here. */
  version: string;
}

/** Facts the update dialog must state for this harness (qa condition 8). */
export interface HarnessNotices {
  /** The harness's own data is not backed up by the snapshot. */
  dataNotBackedUp: boolean;
  /** The CLI may replace itself outside Nassaj (auto-updater not proven off). */
  selfUpdating: boolean;
}

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
  /**
   * Only the owner's button may update this harness; the auto-update scheduler
   * always skips it (T-1871: every snapshot-backed native harness).
   */
  manualOnly: boolean;
  /** Snapshot/rollback spec; null = the legacy recovery path (npm, git). */
  snapshot: HarnessSnapshotSpec | null;
  /** "Restore compatible version" source, or null when not offered. */
  restoreCompatible: HarnessRestoreCompatibleSpec | null;
  /** Dialog facts; null when there is nothing extra to state. */
  notices: HarnessNotices | null;
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
   * Unverified entries (qwen `NO_UPDATE_NOTIFIER`) stay DATA-only: an
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
  /**
   * Resolves the final spawn/version/update binary through the shared harness
   * registry (no env parameter: a member env can never redirect it). Throws
   * HarnessBinaryUnresolvedError when the CLI is not installed.
   */
  resolveBinary: () => string;
  /** Argv appended to the binary to read the installed version. */
  versionArgs: string[];
  /** Builds the exact fixed update argv, or null when not updatable. */
  updateArgv: (
    env?: NodeJS.ProcessEnv,
    context?: { gitCheckoutDir?: string },
  ) => HarnessUpdateArgv | null;
  latestProbe: HarnessLatestProbe;
  /**
   * The CLI's own updater only STAGES the new exe in `<bin dir>/.staging` and
   * swaps it in on the next run (kimi-code, native-staging.ts): the update
   * forces that swap inside the lease, restores and launches clear any stage.
   */
  stagesNativeUpdate?: boolean;
}

const home = () => os.homedir();

/** The registry resolver for `id`, as a descriptor `resolveBinary`. */
function fromRegistry(id: HarnessBinaryId): () => string {
  return () => resolveHarnessBinary(id);
}

/**
 * `<resolved binary> <args>` for a native self-updating CLI; null (→ no update)
 * when the registry cannot resolve the CLI.
 */
function nativeUpdateArgv(id: HarnessBinaryId, args: string[]): HarnessUpdateArgv | null {
  const cmd = tryResolveHarnessBinary(id);
  return cmd ? { cmd, args } : null;
}

/**
 * `codex update` with the install targets derived from the launcher link; null
 * (→ no update) when the launcher is not the measured standalone layout.
 */
function codexUpdateArgv(): HarnessUpdateArgv | null {
  const cmd = tryResolveHarnessBinary('codex');
  if (!cmd) return null;
  try {
    return { cmd, args: ['update'], env: codexUpdateEnv(cmd) };
  } catch {
    return null;
  }
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
 *   - qwen:         npm-managed; NO_UPDATE_NOTIFIER is carried in the descriptor
 *                   but UNVERIFIED on-host, so it is not wired into the spawn env.
 * KNOB VERIFIED and WIRED (claude, opencode, kimi):
 *   - claude:   DISABLE_AUTOUPDATER=1 — documented Anthropic knob, WIRED into the
 *               governed spawn env (resolve-provider-env.js) and asserted on the
 *               spawned env by claude-sdk.disable-autoupdater.test.ts.
 *   - opencode: OPENCODE_DISABLE_AUTOUPDATE=1 — measured on-host (2026-09-11) in
 *               the pinned binary: the var is read into opencode's env map and
 *               the auto-update check returns early on it. WIRED in
 *               resolve-provider-env.js, asserted by
 *               resolve-provider-env.opencode-autoupdate.test.js.
 *   - kimi:     KIMI_CODE_NO_AUTO_UPDATE=1 — read by the native binary
 *               (isAutoUpdateDisabledByEnv), WIRED in resolve-provider-env.js
 *               for every kimi child incl. the terminal PTY (T-1873).
 * A harness with `autoUpdaterDisableVerified !== true` is SKIPPED by the
 * auto-update scheduler (its built-in updater could still race the server).
 */
export const AUTOUPDATER_DISABLE_NONE = Object.freeze([
  'codex', 'antigravity', 'cursor', 'hermes', 'qwen',
]);

/**
 * qwen's npm install prefix (T-1873): a USER-LEVEL GLOBAL install into
 * `~/.local` — `lib/node_modules/<pkg>` + `bin/qwen` — so the launcher the
 * registry resolves (`~/.local/bin/qwen`) is exactly what the update and the
 * recovery rewrite. (The update used to run WITHOUT `-g` and so wrote
 * `~/.local/node_modules`, a tree `~/.local/bin/qwen` never ran.)
 */
const QWEN_NPM_PREFIX = path.join(home(), '.local');

/**
 * The one npm argv for an npm-prefix harness install (update AND recovery):
 * a global install into `prefix`, so npm links `prefix/bin/<bin>`.
 */
export function npmPrefixInstallArgs(prefix: string, spec: string): string[] {
  return ['install', '--global', '--prefix', prefix, spec];
}

/** The canonical descriptor table, keyed by canonical harness id. */
export const HARNESS_UPDATE_DESCRIPTORS: Readonly<Record<string, HarnessDescriptor>> = Object.freeze({
  claude: {
    id: 'claude',
    aliases: [],
    installMethod: 'native-self-update',
    state: 'updatable',
    updatable: true,
    manualOnly: true,
    reason: null,
    runProviders: ['claude'],
    pinKey: null,
    checksumSource: 'none',
    // DISABLE_AUTOUPDATER is the documented Claude Code knob and the ONLY one
    // actually wired into the governed spawn env (resolve-provider-env.js);
    // claude-sdk.disable-autoupdater.test.ts asserts it on the spawned env.
    disableAutoUpdaterEnv: { DISABLE_AUTOUPDATER: '1' },
    autoUpdaterDisableVerified: true,
    resolveBinary: fromRegistry('claude'),
    versionArgs: ['--version'],
    updateArgv: () => nativeUpdateArgv('claude', ['update']),
    // npm numbering equals the native version (measured). npm `latest` tracks the
    // `next` channel, so a newer latest is "published", not "the updater will move".
    latestProbe: { kind: 'npm', pkg: '@anthropic-ai/claude-code' },
    snapshot: { layout: 'versioned-file', linkMode: 'hardlink', stores: [], resolveLayout: claudeLayout },
    restoreCompatible: null,
    notices: null,
  },
  codex: {
    id: 'codex',
    aliases: [],
    installMethod: 'native-self-update',
    state: 'updatable',
    updatable: true,
    manualOnly: true,
    reason: null,
    runProviders: ['codex'],
    pinKey: null,
    checksumSource: 'none',
    disableAutoUpdaterEnv: null,
    autoUpdaterDisableVerified: false,
    resolveBinary: fromRegistry('codex'),
    versionArgs: ['--version'],
    // CODEX_HOME / CODEX_INSTALL_DIR are derived from the launcher link so the
    // installer rewrites exactly the install Nassaj runs (measurements §a).
    updateArgv: () => codexUpdateArgv(),
    // npm `latest` carries the plain native number (platform builds are suffixed).
    latestProbe: { kind: 'npm', pkg: '@openai/codex' },
    snapshot: { layout: 'versioned-dir', linkMode: 'hardlink', stores: [CODEX_STORE], resolveLayout: codexLayout },
    restoreCompatible: null,
    notices: null,
  },
  antigravity: {
    id: 'antigravity',
    aliases: ['agy'],
    installMethod: 'native-self-update',
    state: 'updatable',
    updatable: true,
    manualOnly: true,
    reason: null,
    // agy runs register under the `antigravity` run-registry provider id.
    runProviders: ['antigravity', 'agy'],
    pinKey: null,
    checksumSource: 'none',
    disableAutoUpdaterEnv: null,
    autoUpdaterDisableVerified: false,
    resolveBinary: fromRegistry('antigravity'),
    versionArgs: ['--version'],
    updateArgv: () => nativeUpdateArgv('antigravity', ['update']),
    latestProbe: null,
    // agy data (~/.gemini/antigravity-cli) is out of scope, and its built-in
    // updater is not proven off until the stage 7 off-switch run.
    snapshot: { layout: 'single-file', linkMode: 'copy', stores: [], resolveLayout: singleFileLayout },
    restoreCompatible: null,
    notices: { dataNotBackedUp: true, selfUpdating: true },
  },
  cursor: {
    id: 'cursor',
    aliases: ['cursor-agent'],
    installMethod: 'native-self-update',
    state: 'updatable',
    updatable: true,
    manualOnly: true,
    reason: null,
    runProviders: ['cursor'],
    pinKey: null,
    checksumSource: 'none',
    disableAutoUpdaterEnv: null,
    autoUpdaterDisableVerified: false,
    resolveBinary: fromRegistry('cursor'),
    versionArgs: ['--version'],
    updateArgv: () => nativeUpdateArgv('cursor', ['update']),
    latestProbe: null,
    snapshot: { layout: 'versioned-dir', linkMode: 'hardlink', stores: [], resolveLayout: cursorLayout },
    restoreCompatible: null,
    notices: null,
  },
  opencode: {
    id: 'opencode',
    aliases: [],
    installMethod: 'native-self-update',
    state: 'updatable',
    updatable: true,
    manualOnly: true,
    reason: null,
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
    resolveBinary: fromRegistry('opencode'),
    versionArgs: ['--version'],
    updateArgv: () => nativeUpdateArgv('opencode', ['upgrade']),
    latestProbe: { kind: 'github-release', url: OPENCODE_LATEST_RELEASE_URL },
    snapshot: { layout: 'single-file', linkMode: 'copy', stores: [OPENCODE_STORE], resolveLayout: singleFileLayout },
    restoreCompatible: { version: PINNED_VENDOR_DIGESTS.opencode.version },
    notices: null,
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
    resolveBinary: fromRegistry('qwen'),
    versionArgs: ['--version'],
    // Deterministic npm reinstall into the MEASURED user prefix. `qwen update`
    // exists ("check and install") but re-derives its own prefix; the fixed
    // reinstall is prefix-correct, non-interactive and recoverable (D3/item 3).
    updateArgv: () => ({
      cmd: 'npm',
      args: npmPrefixInstallArgs(QWEN_NPM_PREFIX, '@qwen-code/qwen-code@latest'),
      // /tmp is tmpfs (RAM) on this host; npm stages tarballs in TMPDIR.
      env: { TMPDIR: NPM_UPDATE_TMPDIR },
    }),
    latestProbe: { kind: 'npm', pkg: '@qwen-code/qwen-code' },
    // Legacy exact-version recovery (npm reinstall / git reset); no snapshot yet.
    manualOnly: false,
    snapshot: null,
    restoreCompatible: null,
    notices: null,
  },
  kimi: {
    id: 'kimi',
    aliases: [],
    // Owner decision (ADR-189): the vendor's official native install script,
    // one self-contained binary at ~/.kimi-code/bin/kimi (measured 2.1.1).
    installMethod: 'native-self-update',
    state: 'updatable',
    updatable: true,
    reason: null,
    runProviders: ['kimi'],
    pinKey: 'kimi',
    checksumSource: 'none',
    // KIMI_CODE_NO_AUTO_UPDATE — verified in the native binary's bundled source
    // (isAutoUpdateDisabledByEnv: no check, no background install, no staged
    // swap) and WIRED for every kimi child in resolve-provider-env.js.
    disableAutoUpdaterEnv: { KIMI_CODE_NO_AUTO_UPDATE: '1' },
    autoUpdaterDisableVerified: true,
    resolveBinary: fromRegistry('kimi'),
    versionArgs: ['--version'],
    // `kimi update --yes` (measured `kimi upgrade|update [-y]`): a manual,
    // non-interactive native self-update of this same binary (staged, below).
    updateArgv: () => nativeUpdateArgv('kimi', ['update', '--yes']),
    // Measured: `kimi update` downloads into ~/.kimi-code/bin/.staging and the
    // swap runs on the NEXT kimi start (even with KIMI_CODE_NO_AUTO_UPDATE=1).
    stagesNativeUpdate: true,
    // npm `latest` carries the same numbering as the native release.
    latestProbe: { kind: 'npm', pkg: '@moonshot-ai/kimi-code' },
    // Button-only: the one installed copy moves only when the owner updates it.
    manualOnly: true,
    // One native file replaced in place, copied like agy/opencode.
    snapshot: { layout: 'single-file', linkMode: 'copy', stores: [], resolveLayout: singleFileLayout },
    restoreCompatible: null,
    // kimi data (~/.kimi-code, per-user KIMI_CODE_HOME) is not snapshotted, and a
    // kimi run outside Nassaj (a login shell) can still update itself.
    notices: { dataNotBackedUp: true, selfUpdating: true },
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
    resolveBinary: fromRegistry('hermes'),
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
    // Legacy exact-version recovery (npm reinstall / git reset); no snapshot yet.
    manualOnly: false,
    snapshot: null,
    restoreCompatible: null,
    notices: null,
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
    resolveBinary: () => '',
    versionArgs: ['--version'],
    updateArgv: () => null,
    latestProbe: null,
    manualOnly: false,
    snapshot: null,
    restoreCompatible: null,
    notices: null,
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
    manualOnly: false,
    snapshot: null,
    restoreCompatible: null,
    notices: null,
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

/**
 * True when `toVersion` is strictly newer than `fromVersion` (numeric dotted
 * compare of the first version token). Unparseable → false (never "advanced").
 */
export function isVersionAdvance(fromVersion: string, toVersion: string): boolean {
  const parse = (value: string): number[] | null => {
    const match = value.match(/\d+(?:\.\d+)+/u);
    return match ? match[0].split('.').map((part) => Number.parseInt(part, 10)) : null;
  };
  const from = parse(fromVersion);
  const to = parse(toVersion);
  if (!from || !to) return false;
  for (let i = 0; i < Math.max(from.length, to.length); i += 1) {
    const left = from[i] ?? 0;
    const right = to[i] ?? 0;
    if (right > left) return true;
    if (right < left) return false;
  }
  return false;
}
