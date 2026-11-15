export type MechanicalCliHarnessProvider = 'codex' | 'opencode';
export type MechanicalCliCapabilityProbe = (
  provider: MechanicalCliHarnessProvider, env: NodeJS.ProcessEnv,
) => boolean;

/**
 * Installed-binary proof. Browser and environment claims cannot replace it.
 * codex and opencode prove their binaries in their own adapter probes, so the
 * server-side capability check admits both without a separate spawn.
 */
export const installedMechanicalCliProbe: MechanicalCliCapabilityProbe = (provider) =>
  provider === 'codex' || provider === 'opencode';

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
    opencode: env.NASSAJ_TURN_SUPERVISOR_OPENCODE_CHAT,
  } as const)[provider as MechanicalCliHarnessProvider];
  return ['codex', 'opencode'].includes(provider) && enabled(flag);
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
