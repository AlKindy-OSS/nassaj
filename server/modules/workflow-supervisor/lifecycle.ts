/**
 * Scope lifecycle (ADR-053 §ج-4) — stop + cleanup for supervisor-launched
 * workflows. Mirrors runner-bridge.forceStopRunner: a durable pause file FIRST
 * (so a re-poll cannot relaunch) THEN the scope stop.
 *
 * The bridge is the only writer of these control files; the supervisor reads the
 * pause file before (re)launching an intent. Reboot is intentionally NOT handled
 * here: transient scopes die on reboot and are surfaced as visible orphans by the
 * liveness source — never auto-resumed (the decided reboot semantics).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { scopeStateDir, scopeUnitName } from './config.js';
import { stopScope } from './systemd.js';

/** Path to a scope's durable pause control file. */
function pausePath(wfLaunchId: string): string {
  return path.join(scopeStateDir(wfLaunchId), 'pause');
}

/** True when a launch id has been paused (stops re-launch / marks intent stopped). */
export async function isScopePaused(wfLaunchId: string): Promise<boolean> {
  try {
    await fsp.access(pausePath(wfLaunchId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a running scope workflow: write the pause file, then `systemctl --user
 * stop`. Returns the scope-stop result; the pause is written regardless so a
 * racing relaunch is always blocked.
 */
export async function stopScopeWorkflow(wfLaunchId: string, by = 'owner'): Promise<boolean> {
  const p = pausePath(wfLaunchId);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(
    p,
    `${JSON.stringify({ reason: 'stop', by, at: new Date().toISOString() })}\n`,
    'utf8',
  );
  return stopScope(scopeUnitName(wfLaunchId));
}

/**
 * Remove a completed scope's state dir. Called by a cleanup timer for scopes
 * whose unit is long inactive. Best-effort; never throws.
 */
export async function cleanupScopeState(wfLaunchId: string): Promise<void> {
  try {
    await fsp.rm(scopeStateDir(wfLaunchId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
