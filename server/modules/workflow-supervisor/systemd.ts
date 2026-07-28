/**
 * systemd adapters (ADR-053 §ج-2/ج-4) — the real, execFile-backed implementations
 * of the injected probes/listers the pure modules depend on. Kept separate so the
 * pure logic (concurrency, scope-liveness, ownership-guard) is testable with
 * stubs and never shells out in a unit test.
 *
 * SAFETY
 * ------
 * - Every call uses execFile with a PARAMETERIZED argv (never a shell string) so
 *   a unit name can never inject a command — same discipline as
 *   runner-bridge.forceStopRunner.
 * - This is the plain node server (NOT the Claude client), so the client-side
 *   pm2/systemctl guard does not apply; `systemctl --user` is permitted here.
 * - Read paths (`is-active`, `list-units`) never throw into callers: they map a
 *   non-zero exit to the state text or an empty list. `systemd-run` (the launch)
 *   surfaces failure so the supervisor can mark the intent failed.
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

import { scopeUnitName } from './config.js';
import type { UnitState } from './result-capture.js';

const execFileAsync = promisify(execFile);

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
  'GEMINI_CLI_HOME', // gemini
  'CODEX_HOME', // codex
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
    const { stdout } = await execFileAsync('systemctl', ['--user', 'is-active', unit]);
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
    ({ stdout } = await execFileAsync('systemctl', [
      '--user',
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
  const { stdout } = await execFileAsync('systemctl', [
    '--user',
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
      const { stdout: desc } = await execFileAsync('systemctl', [
        '--user',
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
 * List ALL active `wf-*.service` units host-wide (every user), for the global
 * concurrency gate (§ج-5, الشرط 7). Unlike listActiveUserScopes it does NOT
 * filter by owner — the total count is what bounds host memory. Re-throws on a
 * hard enumeration failure so the global gate fails CLOSED (treated as at-cap).
 */
export async function listAllActiveScopes(): Promise<string[]> {
  const { stdout } = await execFileAsync('systemctl', [
    '--user',
    'list-units',
    '--type=service',
    '--state=active',
    '--no-legend',
    '--plain',
    'wf-*.service',
  ]);

  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(
      (u): u is string =>
        typeof u === 'string' && u.startsWith('wf-') && u.endsWith('.service'),
    );
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
  claudeBin: string;
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
}): Promise<string> {
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
    params.claudeBin,
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

  await execFileAsync('systemd-run', args);
  return unit;
}

/** Stop a unit: `systemctl --user stop <unit>`. Idempotent for already-stopped. */
export async function stopScope(unit: string): Promise<boolean> {
  try {
    await execFileAsync('systemctl', ['--user', 'stop', unit]);
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
