/**
 * systemd adapters (ADR-053 §ج-2/ج-4) — the real, execFile-backed implementations
 * of the injected probes/listers the pure modules depend on. Kept separate so the
 * pure logic (concurrency, scope-liveness, ownership-guard) is testable with
 * stubs and never shells out in a unit test.
 *
 * SAFETY
 * ------
 * - Every call uses execFile with a PARAMETERIZED argv (never a shell string) so
 *   a unit name can never inject a command.
 * - This is the plain node server (NOT the Claude client), so the client-side
 *   pm2/systemctl guard does not apply; `systemctl --user` is permitted here.
 * - `systemctlIsActive` / `systemctlShowState` never throw: they map a non-zero
 *   exit to the state text. The enumerations (`listActiveUserScopes`,
 *   `listAllActiveScopes`) re-throw so concurrency gates fail closed;
 *   `probeUserWorkflowUnits` throws only UserUnitProbeError; `systemd-run`
 *   (the launch) surfaces failure so the supervisor can mark the intent failed.
 * - ONE USER MANAGER (B-1474): every `systemctl --user` / `systemd-run --user`
 *   call here forces XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS to
 *   `/run/user/<uid>` (userManagerEnv), so the launcher and the live-unit probe
 *   always address the same manager whatever the inherited env says.
 */

import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveHarnessBinary } from '@/shared/harness-binaries.js';

// eslint-disable-next-line boundaries/dependencies -- systemd admission must stay a synchronous leaf and avoid the providers barrel's service graph.
import { beginHarnessLaunch } from '../providers/harness-update/spawn-admission.js';

import { scopeUnitName } from './config.js';
import type { UnitState } from './result-capture.js';

const execFileAsync = promisify(execFile);

/** The two keys that select which systemd user manager `--user` talks to. */
export interface UserManagerEnv {
  XDG_RUNTIME_DIR: string;
  DBUS_SESSION_BUS_ADDRESS: string;
}

/**
 * Env keys addressing `uid`'s user manager under `runUserRoot` (default
 * `/run/user`). Shared by the probe and every `--user` call in this file so
 * they can never target different managers (see header, B-1474).
 */
export function userManagerEnv(uid: number, runUserRoot = '/run/user'): UserManagerEnv {
  const dir = path.join(runUserRoot, String(uid));
  return { XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/bus` };
}

/**
 * Inherited env (PATH etc.) with the user-manager keys forced to this uid's
 * manager. Without getuid (non-POSIX) the inherited env is returned unchanged.
 */
function userCallEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  return typeof uid === 'number' ? { ...base, ...userManagerEnv(uid) } : base;
}

/** `systemctl --user …` against this uid's user manager (see userCallEnv). */
function userSystemctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('systemctl', ['--user', ...args], { env: userCallEnv() });
}

/** execFile-shaped runner for `systemd-run` (injectable for tests). */
export type LaunchExec = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => Promise<unknown>;

/** Bound to the literal `systemd-run` (`file` is informational for the test seam). */
const defaultLaunchExec: LaunchExec = (_file, args, opts) => execFileAsync('systemd-run', args, opts);

/** Absolute path to the compiled in-unit result-capture wrapper (sibling file). */
function taskRunnerPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'task-runner.js');
}

/**
 * The env keys the per-user isolation seam (resolveProviderEnv) sets to redirect
 * a provider to a user's OWN credential tree. These are the ToS-critical keys
 * that MUST reach the unit — and a transient user service inherits NOTHING from
 * the launcher (verified), so if one of these is not forwarded via --setenv the
 * run would fall back to the default location = wrong isolation. We forward them
 * unconditionally when present, never by a fragile diff.
 */
export const ISOLATION_ENV_KEYS = [
  'CLAUDE_CONFIG_DIR', // claude (the ToS-critical one)
  'CODEX_HOME', // codex
  // B-548: HOME is the actual credential-bearing knob for agy AND hermes AND
  // cursor (several providers, one mechanism), so it belongs in the
  // unconditional list rather than behind the weaker rule-2 diff below. When
  // the provider is not isolated, resolvedEnv.HOME simply equals the operator's
  // and forwarding it is a no-op with an upside: a transient user unit inherits
  // NOTHING, so naming HOME explicitly removes a silent dependency on systemd
  // filling it from the user record.
  'HOME',
] as const;

/**
 * Compute the exact `--setenv` map to forward to a workflow unit, from the
 * resolver's output `resolvedEnv` relative to the supervisor's `baseEnv`. Pure &
 * unit-testable. Rules:
 *   1. EVERY isolation key present in resolvedEnv is forwarded (never dropped by
 *      a diff — a transient unit inherits nothing, so a missing ToS key = wrong
 *      credentials, not a harmless no-op).
 *   2. Any OTHER key whose value DIFFERS from baseEnv is forwarded too (covers a
 *      future isolation key we forgot to enumerate), while the bulk of the
 *      inherited env is NOT copied (no leak of the launcher's full environment).
 */
export function computeIsolationSetenv(
  resolvedEnv: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const setenv: Record<string, string> = {};
  for (const key of ISOLATION_ENV_KEYS) {
    const v = resolvedEnv[key];
    if (typeof v === 'string' && v.length > 0) {
      setenv[key] = v;
    }
  }
  for (const [k, v] of Object.entries(resolvedEnv)) {
    if (typeof v === 'string' && baseEnv[k] !== v) {
      setenv[k] = v;
    }
  }
  return setenv;
}

/**
 * `systemctl --user is-active <unit>` → the state text ('active'/'inactive'/
 * 'failed'/…). systemctl exits non-zero for inactive/failed but STILL prints the
 * state on stdout, so we read stdout regardless of exit code. Returns 'unknown'
 * only when there is genuinely no output.
 */
export async function systemctlIsActive(unit: string): Promise<string> {
  try {
    const { stdout } = await userSystemctl(['is-active', unit]);
    return stdout.trim() || 'unknown';
  } catch (error) {
    const stdout =
      typeof (error as { stdout?: unknown })?.stdout === 'string'
        ? ((error as { stdout: string }).stdout as string)
        : '';
    return stdout.trim() || 'inactive';
  }
}

/**
 * Probe a transient unit's terminal ActiveState for the classifier (§أ-3). Maps
 * `systemctl --user show <unit>` to one of active|activating|inactive|failed|gone
 * ('gone' = the manager GC'd a clean transient service, LoadState=not-found). A
 * show failure ⇒ 'gone' (decisive terminal, never a hang). Never throws.
 */
export async function systemctlShowState(unit: string): Promise<UnitState> {
  if (!unit) {
    return 'gone';
  }
  let stdout: string;
  try {
    ({ stdout } = await userSystemctl([
      'show',
      unit,
      '--property=ActiveState',
      '--property=Result',
      '--property=LoadState',
    ]));
  } catch {
    return 'gone';
  }
  const kv: Record<string, string> = {};
  for (const line of stdout.trim().split('\n')) {
    const j = line.indexOf('=');
    if (j > 0) {
      kv[line.slice(0, j)] = line.slice(j + 1);
    }
  }
  if (kv.LoadState === 'not-found') {
    return 'gone';
  }
  const s = kv.ActiveState || 'unknown';
  if (
    s === 'active' ||
    s === 'activating' ||
    s === 'inactive' ||
    s === 'failed'
  ) {
    return s;
  }
  return 'unknown';
}

/**
 * List active `wf-*.service` units owned by `userId`. The owning user is encoded
 * in a unit property we set at launch (Description carries `wf-owner=<userId>`),
 * so we enumerate all `wf-*.service` units and filter by that marker. On a hard
 * enumeration failure this adapter RE-THROWS (does not mask as empty): the
 * CONCURRENCY gate treats a throw as saturated (fail-closed), so a monitoring
 * blip denies a launch rather than opening the floodgate.
 */
export async function listActiveUserScopes(userId: number): Promise<string[]> {
  // --plain/--no-legend for stable parsing; only running/active units. Transient
  // workflow units are SERVICES (not --scope; see config.scopeUnitName rationale).
  const { stdout } = await userSystemctl([
    'list-units',
    '--type=service',
    '--state=active',
    '--no-legend',
    '--plain',
    'wf-*.service',
  ]);

  const units = stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((u): u is string => typeof u === 'string' && u.startsWith('wf-') && u.endsWith('.service'));

  if (units.length === 0) {
    return [];
  }

  // Filter by owner marker in each unit's Description.
  const owned: string[] = [];
  for (const unit of units) {
    try {
      const { stdout: desc } = await userSystemctl([
        'show',
        '-p',
        'Description',
        '--value',
        unit,
      ]);
      if (desc.includes(`wf-owner=${userId} `) || desc.trim().endsWith(`wf-owner=${userId}`)) {
        owned.push(unit);
      }
    } catch {
      // A unit that vanished between list and show is simply no longer active.
    }
  }
  return owned;
}

/**
 * List ALL active `wf-*.service` units of THIS uid's user manager — i.e. every
 * Nassaj member, since all members share the server's uid — for the global
 * concurrency gate (§ج-5, الشرط 7). Unlike listActiveUserScopes it does NOT
 * filter by owner — the total count is what bounds host memory. Re-throws on a
 * hard enumeration failure so the global gate fails CLOSED (treated as at-cap).
 */
export async function listAllActiveScopes(): Promise<string[]> {
  const { stdout } = await userSystemctl([
    'list-units',
    '--type=service',
    '--state=active',
    '--no-legend',
    '--plain',
    'wf-*.service',
  ]);

  return parseWfUnits(stdout);
}

/** Unit names of `wf-*.service` rows in `systemctl list-units --plain --no-legend` output. */
function parseWfUnits(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(
      (u): u is string =>
        typeof u === 'string' && u.startsWith('wf-') && u.endsWith('.service'),
    );
}

/**
 * Result of probing this uid's systemd user manager for live workflow units.
 * Only `present` carries units; the other states mean no user manager can be
 * running workflow units for this uid on this host.
 */
export type UserUnitProbe =
  | { state: 'unsupported' | 'no_systemd' | 'manager_absent' }
  | { state: 'present'; units: string[] };

/** Why the user-unit probe could not reach a verdict (callers fail closed). */
export type UserUnitProbeReason =
  | 'systemctl_missing'
  | 'systemctl_failed'
  | 'timeout'
  | 'bad_runtime_dir'
  | 'stat_failed'
  | 'probe_failed';

/**
 * The probe could not decide. `message` is a fixed, client-safe sentence;
 * `detail` (bounded raw stderr / errno) is for server logs only.
 */
export class UserUnitProbeError extends Error {
  readonly reason: UserUnitProbeReason;
  readonly detail: string;

  constructor(reason: UserUnitProbeReason, detail = '') {
    super(`user unit probe failed: ${reason}`);
    this.name = 'UserUnitProbeError';
    this.reason = reason;
    this.detail = detail.slice(0, 200);
  }
}

/** execFile-shaped runner the probe uses (injectable for tests). */
export type ProbeExec = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Seams of {@link probeUserWorkflowUnits}; every field defaults to the real host. */
export interface UserUnitProbeOptions {
  platform?: NodeJS.Platform;
  getuid?: (() => number) | undefined;
  runUserRoot?: string;
  systemdRoot?: string;
  exec?: ProbeExec;
  /** PATH handed to systemctl (defaults to process.env.PATH). */
  basePath?: string;
  /** systemctl time limit in ms (defaults to PROBE_TIMEOUT_MS). */
  timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BUFFER = 256 * 1024;

/** Bound to the literal `systemctl` (`file` is informational for the test seam). */
const defaultProbeExec: ProbeExec = async (_file, args, opts) => {
  const { stdout, stderr } = await execFileAsync('systemctl', args, opts);
  return { stdout: String(stdout), stderr: String(stderr) };
};

/** lstat that maps ENOENT to null and any other failure to `stat_failed`. */
async function lstatOrAbsent(p: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(p);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    throw new UserUnitProbeError('stat_failed', String(code ?? error));
  }
}

function probeFailure(error: unknown): UserUnitProbeError {
  const e = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown };
  const detail = typeof e?.stderr === 'string' ? e.stderr : String(e?.code ?? '');
  if (e?.code === 'ENOENT') return new UserUnitProbeError('systemctl_missing', detail);
  // maxBuffer overflow also sets killed=true; it is an output failure, not a timeout.
  if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new UserUnitProbeError('systemctl_failed', String(e.code));
  if (e?.killed === true || e?.code === 'ETIMEDOUT') return new UserUnitProbeError('timeout', detail);
  return new UserUnitProbeError('systemctl_failed', detail);
}

/**
 * Probes THIS uid's systemd user manager for active `wf-*.service` units
 * (B-1474). Absence is judged ONLY on root-owned paths (`/run/systemd/system`,
 * `/run/user/<uid>` created by logind) — never on sockets inside the runtime
 * dir, which a same-uid member process could delete to spoof "no manager".
 * When the runtime dir exists, systemctl is asked with an explicit env
 * (nothing inherited but PATH) and any failure throws UserUnitProbeError.
 *
 * @returns the probe verdict; throws ONLY UserUnitProbeError when undecidable
 *   (an unclassified failure becomes `probe_failed`), so callers can attribute
 *   the failing leg exactly.
 */
export async function probeUserWorkflowUnits(opts: UserUnitProbeOptions = {}): Promise<UserUnitProbe> {
  try {
    return await probeUserUnits(opts);
  } catch (error) {
    if (error instanceof UserUnitProbeError) throw error;
    throw new UserUnitProbeError('probe_failed', error instanceof Error ? error.message : String(error));
  }
}

async function probeUserUnits(opts: UserUnitProbeOptions): Promise<UserUnitProbe> {
  const platform = opts.platform ?? process.platform;
  const getuid = 'getuid' in opts ? opts.getuid : process.getuid?.bind(process);
  if (platform !== 'linux' || typeof getuid !== 'function') return { state: 'unsupported' };
  if ((await lstatOrAbsent(opts.systemdRoot ?? '/run/systemd/system')) === null) return { state: 'no_systemd' };
  const uid = getuid();
  const dir = path.join(opts.runUserRoot ?? '/run/user', String(uid));
  const st = await lstatOrAbsent(dir);
  if (st === null) return { state: 'manager_absent' };
  if (!st.isDirectory() || st.uid !== uid) throw new UserUnitProbeError('bad_runtime_dir');
  const env: NodeJS.ProcessEnv = {
    PATH: opts.basePath ?? process.env.PATH ?? '/usr/bin:/bin',
    ...userManagerEnv(uid, opts.runUserRoot),
    LC_ALL: 'C',
  };
  const args = ['--user', 'list-units', '--type=service', '--state=active', '--no-legend', '--plain', 'wf-*.service'];
  let stdout: string;
  try {
    ({ stdout } = await (opts.exec ?? defaultProbeExec)('systemctl', args, {
      env, timeout: opts.timeoutMs ?? PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER,
    }));
  } catch (error) {
    throw probeFailure(error);
  }
  // Parsed outside the exec catch: a parse fault is probe_failed, not systemctl_failed.
  return { state: 'present', units: parseWfUnits(stdout) };
}

/**
 * Launch a workflow as a TRANSIENT systemd user SERVICE (not --scope). Returns
 * the unit name immediately after `systemd-run` forks the unit — it does NOT
 * block until the workflow finishes (a --scope launch would block, breaking the
 * poll loop, the concurrency cap, and the "supervisor.json at launch" invariant;
 * see config.scopeUnitName). The unit is owned by the user systemd manager and
 * OUTLIVES this launcher — the B-103 survival guarantee.
 *
 * Parameterized argv only (no shell) so a unit name / path / prompt can never
 * inject. The owner id is embedded in the unit Description so
 * listActiveUserScopes can attribute it. CLAUDE_CONFIG_DIR (and any other
 * isolated env keys) are passed via --setenv (GATE1 proved --setenv is
 * respected), NEVER inherited.
 *
 * @returns the unit name on success; throws on launch failure so the supervisor
 *   can mark the intent failed and surface an orphan.
 */
export async function launchScope(params: {
  wfLaunchId: string;
  userId: number;
  cwd: string;
  scriptOrPrompt: string;
  setenv: Record<string, string>;
  /** Task artifact dir (result.json[.partial] + DONE land here — §أ-2/§أ-4). */
  resultDir: string;
  model?: string | null;
  memoryMax?: string;
  timeoutSeconds?: number;
  /** Absolute node binary for the in-unit wrapper (defaults to this process's). */
  nodeBin?: string;
  /** Env to read PATH / optional unit HOME from (defaults to process.env). */
  baseEnv?: NodeJS.ProcessEnv;
  /** systemd-run runner (tests only; defaults to execFile). */
  exec?: LaunchExec;
}): Promise<string> {
  // T-1749/ADR-159: the unit runs `task-runner` → `claude -p`, i.e. a real claude
  // harness spawn out-of-process. Refuse to launch it while claude is updating;
  // the in-unit wrapper cannot consult the in-process lease itself.
  const unit = scopeUnitName(params.wfLaunchId);
  const memMax = params.memoryMax ?? '2G';
  const timeoutS = params.timeoutSeconds ?? 7200;
  const nodeBin = params.nodeBin ?? process.execPath;
  const baseEnv = params.baseEnv ?? process.env;

  // Transient service: --unit=wf-*.service (NO --scope). systemd-run returns as
  // soon as the manager accepts the unit; the run continues detached.
  const args: string[] = [
    '--user',
    '--quiet',
    `--unit=${unit}`,
    `--description=nassaj workflow wf-owner=${params.userId}`,
    '-p',
    `MemoryMax=${memMax}`,
    '-p',
    'MemorySwapMax=0',
    // Hard bound at the unit level. The in-unit wrapper bounds `claude` itself
    // with an internal SIGTERM timer (so it survives to seal a DONE); this is
    // the ultimate belt if the wrapper itself hangs.
    '-p',
    `RuntimeMaxSec=${timeoutS + 180}`,
  ];

  // Isolated env via --setenv (never inheritance). CLAUDE_CONFIG_DIR is the
  // ToS-critical one; any other key resolveProviderEnv added is forwarded too.
  for (const [key, value] of Object.entries(params.setenv)) {
    args.push(`--setenv=${key}=${value}`);
  }

  // Forward PATH so `claude`'s own grandchildren resolve inside the unit (a
  // transient user unit otherwise inherits only the manager's minimal PATH).
  // The wrapper itself is invoked by ABSOLUTE nodeBin, so it never needs PATH.
  if (typeof baseEnv.PATH === 'string' && baseEnv.PATH.length > 0) {
    args.push(`--setenv=PATH=${baseEnv.PATH}`);
  }
  // Optional explicit unit HOME (WORKFLOW_SUPERVISOR_UNIT_HOME): unset in prod
  // (the unit inherits the operator HOME — correct for claude, whose isolation
  // is CLAUDE_CONFIG_DIR only). Set only by the isolated shadow harness so no
  // claude write can escape to the real home.
  const unitHome = baseEnv.WORKFLOW_SUPERVISOR_UNIT_HOME;
  if (typeof unitHome === 'string' && unitHome.length > 0) {
    args.push(`--setenv=HOME=${unitHome}`);
  }

  // Working directory for the unit (the project cwd for `claude -p`).
  args.push(`--working-directory=${params.cwd}`);

  // The command: the in-unit result-capture wrapper (NOT `claude` directly). The
  // wrapper runs `claude -p ... --output-format json`, streams stdout to
  // result.json.partial, then seals atomically (rename → DONE). It must survive
  // claude's death to seal, so it is NOT wrapped in an outer `timeout`.
  args.push(
    '--',
    nodeBin,
    taskRunnerPath(),
    '--task-dir',
    params.resultDir,
    '--claude-bin',
    // The one claude the terminal runs, from the harness registry (T-1873).
    resolveHarnessBinary('claude'),
    '--output-format',
    'json',
    '--claude-timeout-sec',
    String(timeoutS),
  );
  if (params.model) {
    args.push('--model', params.model);
  }
  // Prompt LAST and as a single argv element (parameterized — no shell, no
  // injection possible regardless of prompt content).
  args.push('--prompt', params.scriptOrPrompt);

  const releaseLaunch = beginHarnessLaunch('claude');
  try {
    await (params.exec ?? defaultLaunchExec)('systemd-run', args, { env: userCallEnv() });
  } catch (error) {
    releaseLaunch();
    throw error;
  }
  // The transient unit outlives systemd-run. Retain admission until its actual
  // terminal state so an update cannot begin in the manager-start/on-exit gap.
  const watch = setInterval(() => {
    void systemctlShowState(unit).then((state) => {
      if (state === 'inactive' || state === 'failed' || state === 'gone') {
        clearInterval(watch);
        releaseLaunch();
      }
    });
  }, 1_000);
  watch.unref?.();
  return unit;
}

/** Stop a unit: `systemctl --user stop <unit>`. Idempotent for already-stopped. */
export async function stopScope(unit: string): Promise<boolean> {
  try {
    await userSystemctl(['stop', unit]);
    return true;
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown })?.stderr === 'string'
        ? ((error as { stderr: string }).stderr as string)
        : '';
    if (/not loaded|not[- ]?active|no such unit|not running/i.test(stderr)) {
      return true;
    }
    return false;
  }
}
