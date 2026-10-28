/**
 * ADR-219 D1 (qa ح-1) — the relay policy EVERY Claude spawn applies, as a leaf
 * the SDK paths, the headless `claude -p` paths and the parity guard share.
 *
 * In `relay` mode a spawn gets `crossSessionInbound: refuse`. A spawn with no
 * relay hook (the headless CLI paths) also loses the session tools, since
 * nothing would route them.
 */

// eslint-disable-next-line boundaries/dependencies -- ADR-219: the member count as a leaf, so the supervisor process and a mocked database barrel need nothing else.
import { userDb } from '@/modules/database/repositories/users.js';

import { relayCliArgsForRelayMode } from './peer-spawn-constants.js';

export type RelayMode = 'native' | 'relay';

export { RELAY_SESSION_TOOLS, REFUSE_SETTINGS_JSON } from './peer-spawn-constants.js';

/** Test-only override (`relay` | `native`); unset in production. */
export const RELAY_MODE_OVERRIDE_ENV = 'NASSAJ_PEER_RELAY_FORCE_MODE';

/** `native` on a one-member node, `relay` with more (D1). */
export function computeRelayMode(activeMemberCount: number): RelayMode {
  return Number.isFinite(activeMemberCount) && activeMemberCount > 1 ? 'relay' : 'native';
}

/** Active members now; a read failure counts as many (fail closed to relay). */
export function readActiveMembers(read: () => number = () => userDb.getActiveUserCount()): number {
  try {
    return read();
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The relay mode a spawn starting now gets (the env override wins; tests only). */
export function relayModeNow(count: number = readActiveMembers(), env: NodeJS.ProcessEnv = process.env): RelayMode {
  const forced = env[RELAY_MODE_OVERRIDE_ENV];
  if (forced === 'relay' || forced === 'native') return forced;
  return computeRelayMode(count);
}

/** The SDK `settings` a run gets: `refuse` in relay mode, nothing in native. */
export function relaySdkSettings(mode: RelayMode): { crossSessionInbound: 'refuse' } | null {
  return mode === 'relay' ? { crossSessionInbound: 'refuse' } : null;
}

/** Spread into SDK options of a spawn that is not a chat run (probe, catalog, side query, supervisor). */
export function relaySdkSpawnOptions(mode: RelayMode = relayModeNow()): { settings?: { crossSessionInbound: 'refuse' } } {
  const settings = relaySdkSettings(mode);
  return settings ? { settings: { ...settings } } : {};
}

/** CLI equivalent for a hookless `claude -p` spawn: `--settings` plus the session tools to disallow. */
export function relayCliPolicy(mode: RelayMode = relayModeNow()): { settingsArgs: string[]; disallowedTools: string[] } {
  return mode === 'relay' ? relayCliArgsForRelayMode() : { settingsArgs: [], disallowedTools: [] };
}
