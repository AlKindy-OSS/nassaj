/**
 * The permission mode a Claude spawn runs under, as ONE resolver that other
 * harnesses reuse (owner ruling 2026-10-28, B-1707: "every harness is treated the
 * same way as Claude Code for permissions; the permissions and restrictions are
 * identical to Claude Code's").
 *
 * Claude's mode comes from three layers, in this order:
 *  1. the request (mapCliOptionsToSDK uses resolveClaudeRequestedPermissionMode):
 *     permission parity `enforce` → bypassPermissions (any profile other than
 *     full_delegation refuses the spawn); else the client/route mode, where
 *     `toolsSettings.skipPermissions` lifts any non-plan mode to bypassPermissions;
 *  2. an implicit `default` (no explicit choice) becomes the settings'
 *     `permissions.defaultMode` (applySettingsPermissionMode → resolveSettingsDefaultMode);
 *  3. the Claude CLI itself turns a bypass request into `default` when any loaded
 *     settings file sets `permissions.disableBypassPermissionsMode: "disable"`
 *     (measured in the 2.1.306 binary). nassaj adds no other bypass gate.
 *
 * Claude applies layers 1–2 here and layer 3 inside its own CLI; a harness that
 * mirrors Claude calls resolveClaudeEffectivePermissionMode, which applies all three.
 */
import { claudeSpawnSettingsFiles, readJsonObject } from './engine-anthropic-credential-guard.js';
import { resolveSettingsDefaultMode } from './claude-settings-default-mode.js';

/**
 * Layer 1: the mode Claude is launched with for this request.
 * @param {{ permissionMode?: unknown, toolsSettings?: { skipPermissions?: unknown } | null,
 *   permissionExecution?: { mode?: unknown, effectivePolicy?: { profileId?: unknown } | null } | null }} [options]
 * @returns {{ parityEnforced: boolean, requested: unknown, mode: string, implicit: boolean }}
 *   `requested` is the mode before skipPermissions (plan tools key off it); `implicit`
 *   marks a `default` that was not an explicit choice.
 * @throws {Error} PERMISSION_EFFECTIVE_POLICY_REQUIRED under enforce without full_delegation
 */
export function resolveClaudeRequestedPermissionMode(options = {}) {
  const parityEnforced = options.permissionExecution?.mode === 'enforce';
  if (parityEnforced && options.permissionExecution?.effectivePolicy?.profileId !== 'full_delegation') {
    throw new Error('PERMISSION_EFFECTIVE_POLICY_REQUIRED');
  }
  const requested = parityEnforced ? 'bypassPermissions' : options.permissionMode;
  let mode = requested || 'default';
  if (options.toolsSettings?.skipPermissions && requested !== 'plan') mode = 'bypassPermissions';
  if (parityEnforced) mode = 'bypassPermissions';
  return { parityEnforced, requested, mode, implicit: !parityEnforced && mode === 'default' };
}

/**
 * Layer 3: whether any settings file the Claude spawn loads disables bypass. The
 * setting only restricts, so every source counts (as in the CLI). An unreadable
 * or malformed source counts as disabling: Claude's spawn is refused over it.
 * @param {NodeJS.ProcessEnv} env Claude's spawn env for this user
 * @param {string|null|undefined} cwd the working directory
 * @param {{ managedSettingsDir?: string }} [ctx] test seam
 * @returns {boolean}
 */
export function isClaudeBypassDisabledBySettings(env, cwd, ctx = {}) {
  let files;
  try {
    files = claudeSpawnSettingsFiles(env, cwd, ctx.managedSettingsDir);
  } catch {
    return true;
  }
  for (const { file, label } of files) {
    let settings;
    try {
      settings = readJsonObject(file, label);
    } catch {
      return true;
    }
    if (settings?.permissions?.disableBypassPermissionsMode === 'disable') return true;
  }
  return false;
}

/**
 * The mode Claude would really run under for this request: layers 1–3.
 * @param {Parameters<typeof resolveClaudeRequestedPermissionMode>[0]} options the request options
 * @param {{ env: NodeJS.ProcessEnv | null, cwd?: string | null, managedSettingsDir?: string }} spawn
 *   Claude's spawn env for the same user (null when Claude cannot run for them: the
 *   settings cannot be read, so the result fails closed to `default`) and the cwd.
 * @returns {string} the effective Claude permission mode
 * @throws {Error} PERMISSION_EFFECTIVE_POLICY_REQUIRED (layer 1)
 */
export function resolveClaudeEffectivePermissionMode(options, spawn) {
  const { mode, implicit } = resolveClaudeRequestedPermissionMode(options);
  const { env, cwd = null } = spawn;
  if (!env) return mode === 'plan' ? 'plan' : 'default';
  const ctx = { managedSettingsDir: spawn.managedSettingsDir };
  const effective = implicit ? (resolveSettingsDefaultMode(env, cwd, ctx) ?? 'default') : mode;
  if (effective === 'bypassPermissions' && isClaudeBypassDisabledBySettings(env, cwd, ctx)) return 'default';
  return effective;
}
