import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// eslint-disable-next-line boundaries/dependencies -- capability probes execute provider binaries and share the updater's atomic admission seam.
import { beginHarnessLaunch } from '../providers/harness-update/spawn-admission.js';

export type MechanicalCliHarnessProvider = 'codex' | 'qwen' | 'opencode' | 'hermes';
export type MechanicalCliCapabilityProbe = (
  provider: MechanicalCliHarnessProvider, env: NodeJS.ProcessEnv,
) => boolean;

const probeCache = new Map<string, boolean>();

function output(
  provider: MechanicalCliHarnessProvider,
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string | null {
  const releaseHarnessLaunch = beginHarnessLaunch(provider);
  try {
    const result = spawnSync(binary, args, {
      env, shell: false, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    if (result.error || result.status !== 0) return null;
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  } finally {
    releaseHarnessLaunch();
  }
}

function exactVersion(
  provider: MechanicalCliHarnessProvider,
  binary: string,
  expected: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const value = output(provider, binary, ['--version'], env);
  return value?.match(/\bv?(\d+\.\d+\.\d+)\b/u)?.[1] === expected;
}

function qwenProbe(env: NodeJS.ProcessEnv): boolean {
  const releaseHarnessLaunch = beginHarnessLaunch('qwen');
  try {
    const binary = env.QWEN_PATH?.trim() || 'qwen';
    const help = output('qwen', binary, ['--help'], env);
    if (!help || !exactVersion('qwen', binary, '0.21.12', env)) return false;
    return [
      '--system-prompt', '--safe-mode', '--sandbox', '--approval-mode',
      '--max-tool-calls', '--exclude-tools', '--disabled-slash-commands',
    ].every((option) => help.includes(option));
  } finally {
    releaseHarnessLaunch();
  }
}

function hermesProbe(env: NodeJS.ProcessEnv): boolean {
  const releaseHarnessLaunch = beginHarnessLaunch('hermes');
  try {
    const binary = env.HERMES_PATH?.trim() || 'hermes';
    if (!exactVersion('hermes', binary, '0.17.0', env)) return false;
    const directory = mkdtempSync('/var/tmp/nassaj-hermes-capability-probe-');
    const isolated = {
      ...env, HOME: `${directory}/home`, HERMES_HOME: `${directory}/hermes`,
      XDG_CONFIG_HOME: `${directory}/config`, XDG_DATA_HOME: `${directory}/data`,
      XDG_STATE_HOME: `${directory}/state`, XDG_CACHE_HOME: `${directory}/cache`,
    };
    Object.values(isolated).filter((value) => typeof value === 'string' && value.startsWith(directory))
      .forEach((entry) => mkdirSync(entry!, { recursive: true, mode: 0o700 }));
    try {
      const raw = output('hermes', binary, [
        '--safe-mode', '--ignore-user-config', '--ignore-rules', '--toolsets', '',
        'prompt-size', '--json',
      ], isolated);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { tools?: { count?: unknown } };
      return parsed.tools?.count === 0;
    } catch { return false; }
    finally { rmSync(directory, { recursive: true, force: true }); }
  } finally {
    releaseHarnessLaunch();
  }
}

/** Installed-binary proof. Browser and environment claims cannot replace it. */
export const installedMechanicalCliProbe: MechanicalCliCapabilityProbe = (provider, env) => {
  if (provider === 'codex' || provider === 'opencode') return true;
  const binary = provider === 'qwen'
    ? (env.QWEN_PATH?.trim() || 'qwen') : (env.HERMES_PATH?.trim() || 'hermes');
  const key = `${provider}:${binary}`;
  if (probeCache.has(key)) return probeCache.get(key)!;
  const result = provider === 'qwen' ? qwenProbe(env) : hermesProbe(env);
  probeCache.set(key, result);
  return result;
};

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

/** Exact server-owned provider × mode deployment request. */
export function isCliTurnSupervisorArmed(
  provider: string,
  mode: string,
  env: NodeJS.ProcessEnv = process.env,
): provider is MechanicalCliHarnessProvider {
  if (mode !== 'chat') return false;
  const flag = ({
    codex: env.NASSAJ_TURN_SUPERVISOR_CODEX_CHAT,
    qwen: env.NASSAJ_TURN_SUPERVISOR_QWEN_CHAT,
    opencode: env.NASSAJ_TURN_SUPERVISOR_OPENCODE_CHAT,
    hermes: env.NASSAJ_TURN_SUPERVISOR_HERMES_CHAT,
  } as const)[provider as MechanicalCliHarnessProvider];
  return ['codex', 'qwen', 'opencode', 'hermes'].includes(provider) && enabled(flag);
}

/** Armed plus installed-binary proof; false must never cue legacy fallback. */
export function isCliTurnSupervisorEnabled(
  provider: string,
  mode: string,
  env: NodeJS.ProcessEnv = process.env,
  probe: MechanicalCliCapabilityProbe = installedMechanicalCliProbe,
): provider is MechanicalCliHarnessProvider {
  return isCliTurnSupervisorArmed(provider, mode, env)
    && probe(provider as MechanicalCliHarnessProvider, env);
}

export const cliCapabilityInternals = Object.freeze({
  qwenProbe,
  hermesProbe,
  exactVersion,
  hasCachedProbe: (key: string) => probeCache.has(key),
  clearProbeCache: () => probeCache.clear(),
});
