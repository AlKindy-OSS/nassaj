/**
 * ADR-219 ح-1 — the pure constants of a relay-mode Claude spawn (no imports),
 * so a process with no database (the workflow task-runner unit) can apply them.
 */

/** Tools that reach other sessions; removed where no relay hook can route them. */
export const RELAY_SESSION_TOOLS = ['SendMessage', 'ListAgents', 'ListPeers'] as const;

/** The `--settings` value of a relay-mode CLI spawn. */
export const REFUSE_SETTINGS_JSON = '{"crossSessionInbound":"refuse"}';

/** CLI args of a hookless relay-mode spawn: `--settings` refuse, then the variadic disallow list. */
export function relayCliArgsForRelayMode(): { settingsArgs: string[]; disallowedTools: string[] } {
  return { settingsArgs: ['--settings', REFUSE_SETTINGS_JSON], disallowedTools: [...RELAY_SESSION_TOOLS] };
}
