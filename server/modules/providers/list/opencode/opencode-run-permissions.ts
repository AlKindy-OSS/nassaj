/**
 * B-1707: the permissions of a non-interactive `opencode run` turn, and the honest
 * reading of what opencode reports about them.
 *
 * OWNER RULING (2026-10-28): "every harness is treated the same way as Claude Code
 * for permissions; the permissions and restrictions are identical to Claude
 * Code's." So an OpenCode turn runs under the mode CLAUDE would run under for the
 * same user, session and request, computed by Claude's own resolver
 * (resolveClaudeEffectivePermissionMode: parity `enforce`, the request mode,
 * skipPermissions, the settings defaultMode for an implicit default, and the
 * settings `disableBypassPermissionsMode` gate). The single SL-4 table
 * (vendor-cli-permissions.js) translates that mode into opencode arguments and an
 * optional nassaj-generated OPENCODE_PERMISSION. Nothing here grants or caps on
 * OpenCode's own account.
 *
 * `run` has no prompt channel: a rule that resolves to "ask" is rejected by opencode
 * itself, which prints `permission requested: <name> (<patterns>); auto-rejecting`.
 * That line becomes one `permission_auto_rejected` error per permission per turn.
 * An argv opencode does not accept makes it print its usage text and exit 1; that
 * becomes one `opencode_cli_args_rejected` error instead of ~40 stderr frames.
 */
import { resolveClaudeEffectivePermissionMode } from '@/services/isolation/claude-permission-mode.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { mapPermissionModeToVendorFlags } from '@/services/isolation/vendor-cli-permissions.js';

/** The opencode env var nassaj writes (plan mode) and always clears when inherited. */
export const OPENCODE_PERMISSION_ENV = 'OPENCODE_PERMISSION';

/** Error code for a permission opencode rejected on its own, with no one asked. */
export const OPENCODE_PERMISSION_AUTO_REJECTED_CODE = 'permission_auto_rejected';

/** Error code for an argv the installed opencode refused (it printed its usage). */
export const OPENCODE_CLI_ARGS_REJECTED_CODE = 'opencode_cli_args_rejected';

type PermissionRequest = Parameters<typeof resolveClaudeEffectivePermissionMode>[0];

export type OpenCodePermissionLaunch = {
  /** The mode Claude would run under for the same request. */
  claudeMode: string;
  /** Arguments to add to `opencode run` (fresh array). */
  args: string[];
  /** nassaj-generated OPENCODE_PERMISSION JSON, or null for none. */
  permission: string | null;
};

type LaunchDeps = {
  claudeEnv?: (userId: string | number | null) => NodeJS.ProcessEnv | null;
  managedSettingsDir?: string;
};

/** Claude's spawn env for this user, or null when Claude cannot run for them. */
function defaultClaudeEnv(userId: string | number | null): NodeJS.ProcessEnv | null {
  try {
    return resolveProviderEnv(userId, 'claude', process.env);
  } catch {
    return null;
  }
}

/**
 * The OpenCode launch permissions for one turn.
 * @param options the turn options (permissionMode, toolsSettings, permissionExecution)
 * @param context the sender and the working directory
 * @param deps test seams
 * @throws {Error} PERMISSION_EFFECTIVE_POLICY_REQUIRED, exactly where Claude refuses
 */
export function resolveOpenCodePermissionLaunch(
  options: PermissionRequest,
  context: { userId: string | number | null; cwd: string | null },
  deps: LaunchDeps = {},
): OpenCodePermissionLaunch {
  const env = (deps.claudeEnv ?? defaultClaudeEnv)(context.userId);
  const claudeMode = resolveClaudeEffectivePermissionMode(options, {
    env,
    cwd: context.cwd,
    managedSettingsDir: deps.managedSettingsDir,
  });
  const mapped = mapPermissionModeToVendorFlags('opencode', claudeMode) as {
    flags: string[];
    permission?: string | null;
  };
  return { claudeMode, args: [...mapped.flags], permission: mapped.permission ?? null };
}

/**
 * The child env with OPENCODE_PERMISSION set to nassaj's value only: an inherited
 * one (operator or user shell) never reaches opencode.
 * @param env the final child env (not mutated)
 * @param permission nassaj-generated JSON, or null
 */
export function withOpenCodePermissionEnv(env: NodeJS.ProcessEnv, permission: string | null): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next[OPENCODE_PERMISSION_ENV];
  if (permission) next[OPENCODE_PERMISSION_ENV] = permission;
  return next;
}

// opencode prints `! permission requested: …` in colour when stderr looks like a TTY.
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;
const AUTO_REJECTED_LINE = /permission requested:\s*([A-Za-z][\w.-]{0,63})\b[^\n]*auto-rejecting/;
const USAGE_HEADER = /^opencode run \[message\.\.\]/;

/**
 * Reads one opencode stderr line. Returns the permission name when the line
 * reports a prompt that opencode rejected by itself, otherwise null.
 * @param line one stderr line
 */
export function readOpenCodeAutoRejectedPermission(line: unknown): string | null {
  if (typeof line !== 'string' || line === '') return null;
  const match = AUTO_REJECTED_LINE.exec(line.replace(ANSI_ESCAPE, ''));
  return match ? match[1] : null;
}

/**
 * The error frame fields for an auto-rejected permission. The text names the
 * permission only; the requested path stays out of the frame.
 * @param permission the permission name opencode reported
 */
export function openCodeAutoRejectedError(permission: string): { code: string; content: string } {
  return {
    code: OPENCODE_PERMISSION_AUTO_REJECTED_CODE,
    content: `OpenCode blocked the "${permission}" permission by itself: this run cannot ask, `
      + 'so no one was asked and nobody refused it.',
  };
}

/** The error frame fields for an argv the installed opencode refused. */
export function openCodeArgsRejectedError(): { code: string; content: string } {
  return {
    code: OPENCODE_CLI_ARGS_REJECTED_CODE,
    content: 'The installed OpenCode refused the arguments nassaj started it with and printed its '
      + 'usage text, so nothing ran. Update OpenCode, then send again.',
  };
}

export type OpenCodeStderrVerdict =
  | { kind: 'plain' }
  | { kind: 'drop' }
  | { kind: 'error'; error: { code: string; content: string } };

/**
 * A per-turn stderr reader: one error per auto-rejected permission name, one error
 * for a usage dump (whose remaining lines are dropped), every other line plain.
 */
export function createOpenCodeStderrReader(): { read(line: string): OpenCodeStderrVerdict } {
  const reported = new Set<string>();
  let inUsage = false;
  return {
    read(line) {
      if (inUsage) return { kind: 'drop' };
      if (USAGE_HEADER.test(line.replace(ANSI_ESCAPE, '').trim())) {
        inUsage = true;
        return { kind: 'error', error: openCodeArgsRejectedError() };
      }
      const permission = readOpenCodeAutoRejectedPermission(line);
      if (!permission) return { kind: 'plain' };
      if (reported.has(permission)) return { kind: 'drop' };
      reported.add(permission);
      return { kind: 'error', error: openCodeAutoRejectedError(permission) };
    },
  };
}
