/**
 * Shared guarded launch path for every server-side `codex` child (T-1872):
 * the measured machine identity, the runtime-compat verdict, the harness-update
 * spawn admission and the final re-stat. Extracted from codex-app-server.js so
 * non-RPC launches (the per-user model-catalog refresh) cannot bypass it.
 */
import { beginHarnessLaunch } from '@/modules/providers/harness-update/spawn-admission.js';
import {
  acquireCodexLaunchIdentity,
  assertCodexIdentityUnchanged,
  codexIdentityFromExecution,
  codexLaunchOptions,
  CODEX_MACHINE_CLI_MISSING_MESSAGE,
  isCodexMachineCliMissing,
} from '@/shared/codex-executable.js';
import { assertCodexRuntimeCompatible } from '@/shared/codex-runtime-compat.js';

/**
 * T-1872: the machine Codex identity for one launch — the admission's own
 * object when a permit exists (never re-acquired), otherwise acquired here once.
 * An unresolvable or incompatible runtime releases the unconsumed permit before rethrowing.
 */
export async function codexLaunchIdentityFor(permissionExecution) {
  try {
    const identity = permissionExecution
      ? codexIdentityFromExecution(permissionExecution) : acquireCodexLaunchIdentity();
    // T-1872 part 2: refuse a machine release outside Nassaj's contract (cached verdict).
    return await assertCodexRuntimeCompatible(identity);
  } catch (error) {
    permissionExecution?.notStarted?.();
    if (isCodexMachineCliMissing(error)) {
      throw Object.assign(new Error(CODEX_MACHINE_CLI_MISSING_MESSAGE), { code: error.code });
    }
    throw error;
  }
}

/** Spawn a `codex` child from the exact measured executable after a final re-stat. */
export function spawnReservedCodex(spawnImpl, identity, env, args, options) {
  const release = beginHarnessLaunch('codex');
  try {
    assertCodexIdentityUnchanged(identity);
    const launch = codexLaunchOptions(env, identity);
    const child = spawnImpl(launch.codexPathOverride, args, { ...options, env: launch.env });
    child.once?.('exit', release);
    child.once?.('error', release);
    return child;
  } catch (error) {
    release();
    throw error;
  }
}
