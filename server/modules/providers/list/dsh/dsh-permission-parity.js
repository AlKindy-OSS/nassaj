/**
 * dsh-permission-parity — a dsh turn runs under exactly Claude's restrictions
 * (owner decision 2026-11-07; B-1707 ruling "every harness is treated the same way
 * as Claude Code for permissions"). T-2086, ADR-224.
 *
 * The turn's mode is the mode CLAUDE would run under for the same member, cwd and
 * request (resolveClaudeEffectivePermissionMode: parity enforce, the request mode,
 * skipPermissions, the settings defaultMode, disableBypassPermissionsMode).
 *
 * Since T-2089 (ADR-225) every mode runs: the per-turn parity engine
 * (services/permission-parity) decides each tool call — Claude's hooks, allow/ask/deny
 * rules and mode — through the Nassaj policy plugin inside dsh. Refused before spawn:
 *   - unreadable Claude settings, a deny/ask rule the engine cannot enforce, a non-command
 *     hook, an enabled plugin whose hooks cannot be read (Claude would load them);
 *   - Claude's sandbox enabled (no dsh layer variant mirrors it yet: never run unsandboxed);
 *   - a Task/Agent deny or ask rule is decided per call by the engine (dsh subagent → Task);
 *     under parity enforce, where Claude blocks Task/Agent, Task is a disallowed tool (T-2091:
 *     no separate no-subagent layer).
 * Nothing is dropped silently; every refusal names its code.
 *
 * ADR-226 (owner-visible, §8.1): C1 a turn is refused (PERMISSION_EFFECTIVE_POLICY_REQUIRED)
 * when no Claude env can be built (was: managed-only rules); C2 Claude's `dontAsk` and `auto`
 * modes run under the engine's rules (dontAsk: every ask is denied; auto: decided as default);
 * C3 Claude's env comes from claudeSpawnEnvFor, grants honoured, built ONCE per turn (it seeds
 * the operator policy) and shared by the validation and the turn's engine.
 */

import os from 'node:os';

import { claudeSpawnEnvFor } from '../../../../services/isolation/claude-spawn-env.js';
import { resolveClaudeEffectivePermissionMode, resolveClaudeRequestedPermissionMode }
  from '../../../../services/isolation/claude-permission-mode.js';
import { readClaudeSpawnSettings } from '../../../../services/isolation/claude-spawn-settings.js';
import { BLOCKING_HOOK_EVENTS, hookState } from '../../../../services/permission-parity/claude-hooks.js';
import { createClaudeParityEngine, PARITY_MODES }
  from '../../../../services/permission-parity/claude-parity-engine.js';

export const DSH_PARITY_CODES = Object.freeze({
  modeUnsupported: 'dsh_permission_mode_unsupported',
  ruleUnsupported: 'dsh_permission_rule_unsupported',
  hooksUnsupported: 'dsh_claude_hooks_unsupported',
  /** Claude's sandbox is enabled; no dsh layer variant mirrors it yet (T-2089). */
  sandboxUnsupported: 'dsh_claude_sandbox_unsupported',
  policy: 'PERMISSION_EFFECTIVE_POLICY_REQUIRED',
});

/** Claude hook events that can stop a tool call or a prompt before it runs (shared, T-2089). */
export const DSH_BLOCKING_HOOK_EVENTS = BLOCKING_HOOK_EVENTS;
export { hookState };

/** A pre-spawn refusal carrying the code the client shows. */
export class DshParityRefusal extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'DshParityRefusal';
    this.code = code;
  }
}

/** Claude's spawn env for the member (claudeSpawnEnvFor: grants honoured, ADR-226 C3). */
export const defaultClaudeEnv = (userId) => claudeSpawnEnvFor(userId, process.env);

/** Claude's env for this turn, built once; a refusal when it cannot be built (ADR-226 C1). */
function turnClaudeEnv(claudeEnv, userId) {
  let env = null;
  try { env = claudeEnv(userId) ?? null; } catch { env = null; }
  if (!env) throw new DshParityRefusal(DSH_PARITY_CODES.policy, 'The Claude permission policy for this member cannot be built.');
  return env;
}

/** Claude's sandbox is on for this spawn (any loaded source). */
function claudeSandboxEnabled(sources) {
  return sources.some((source) => source.status === 'ok' && source.settings?.sandbox?.enabled === true);
}

/** Engine refusal code → the client-facing dsh code (existing copy where one fits). */
const ENGINE_CODE = Object.freeze({
  parity_rule_unsupported: DSH_PARITY_CODES.ruleUnsupported,
  parity_hook_type_unsupported: DSH_PARITY_CODES.hooksUnsupported,
  parity_hook_source_unreadable: DSH_PARITY_CODES.hooksUnsupported,
  parity_hook_malformed: DSH_PARITY_CODES.hooksUnsupported,
  parity_hook_tmpfs: DSH_PARITY_CODES.hooksUnsupported,
  parity_settings_unreadable: DSH_PARITY_CODES.policy,
  parity_mode_unsupported: DSH_PARITY_CODES.modeUnsupported,
  PERMISSION_EFFECTIVE_POLICY_REQUIRED: DSH_PARITY_CODES.policy,
});

/**
 * The dsh launch decision for one turn (T-2089 S5): Claude's effective mode, whether the
 * a factory for the per-turn parity engine (rules, hooks,
 * mode) the policy plugin consults. Refuses (DshParityRefusal) only what parity cannot run:
 * unreadable settings, an unsupported deny/ask rule, a non-command hook or an unreadable
 * enabled plugin, and Claude's sandbox (no matching dsh layer variant yet).
 * @param {object} options turn options (permissionMode, toolsSettings, permissionExecution)
 * @param {{ userId: unknown, cwd: string|null }} context
 * @param {{ claudeEnv?: (userId: unknown) => NodeJS.ProcessEnv|null, managedSettingsDir?: string }} [deps]
 * @returns {{ claudeMode: string,
 *   createEngine: (turn: { home: string, sessionId: string, transcriptPath: string }) => object }}
 */
export function resolveDshPermissionParity(options, context, deps = {}) {
  const env = turnClaudeEnv(deps.claudeEnv ?? defaultClaudeEnv, context.userId);
  const claudeEnv = () => env;
  const ctx = { userId: context.userId, managedSettingsDir: deps.managedSettingsDir };
  let claudeMode;
  let parityEnforced;
  try {
    claudeMode = resolveClaudeEffectivePermissionMode(options, { env, cwd: context.cwd, ...ctx });
    ({ parityEnforced } = resolveClaudeRequestedPermissionMode(options));
  } catch {
    throw new DshParityRefusal(DSH_PARITY_CODES.policy, 'The permission profile for this turn is unavailable.');
  }
  if (!PARITY_MODES.includes(claudeMode)) {
    throw new DshParityRefusal(DSH_PARITY_CODES.modeUnsupported, `DeepSeek Harness does not mirror Claude's "${claudeMode}" mode yet.`);
  }
  const sources = readClaudeSpawnSettings(env, context.cwd, ctx);
  if (claudeSandboxEnabled(sources)) {
    throw new DshParityRefusal(DSH_PARITY_CODES.sandboxUnsupported,
      'Claude runs sandboxed for you; DeepSeek Harness has no matching sandbox layer yet.');
  }
  const requested = options?.toolsSettings?.disallowedTools;
  const disallowedTools = [...(Array.isArray(requested) ? requested : []), ...(parityEnforced ? ['Task'] : [])];
  const createEngine = (turn) => {
    try {
      return createClaudeParityEngine({ userId: context.userId, cwd: context.cwd, permissionMode: claudeMode,
        managedSettingsDir: deps.managedSettingsDir, claudeEnv, disallowedTools, ...turn });
    } catch (error) {
      const code = ENGINE_CODE[error?.code];
      if (code) throw new DshParityRefusal(code, error.message);
      throw error;
    }
  };
  // Validate now (before any spawn); the turn builds its own engine with dsh's HOME.
  createEngine({ home: context.cwd ?? os.homedir(), sessionId: 'validation', transcriptPath: '/dev/null' });
  return { claudeMode, createEngine };
}
