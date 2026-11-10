/**
 * B-1707 / ADR-226: the permissions of a non-interactive `opencode run` turn, and the honest
 * reading of what opencode reports about them.
 *
 * OWNER RULING (2026-10-28): "every harness is treated the same way as Claude Code
 * for permissions; the permissions and restrictions are identical to Claude
 * Code's." So an OpenCode turn runs under the mode CLAUDE would run under for the
 * same user, session and request, computed by Claude's own resolver
 * (resolveClaudeEffectivePermissionMode), fed by Claude's spawn env (claudeSpawnEnvFor,
 * grants honoured). Since ADR-226 every tool call is decided by the shared Claude-parity
 * engine (Claude's hooks, rules and mode, asks as member cards) through the channel-client
 * plugin; OpenCode itself gets L1 (`{"*":"allow"}` + Claude's deny rules + the plan block)
 * and `--agent plan` in plan mode, never its skip flag.
 *
 * An argv opencode does not accept makes it print its usage text and exit 1; that becomes
 * one `opencode_cli_args_rejected` error instead of ~40 stderr frames. With `"*":"allow"`
 * opencode no longer auto-rejects on its own; a line that still says so (an agent-level
 * rule) becomes one `permission_auto_rejected` error per permission per turn.
 */
import { resolveClaudeEffectivePermissionMode, resolveClaudeRequestedPermissionMode }
  from '@/services/isolation/claude-permission-mode.js';
import { claudeSpawnEnvFor } from '@/services/isolation/claude-spawn-env.js';
import { mapPermissionModeToVendorFlags } from '@/services/isolation/vendor-cli-permissions.js';
import { createClaudeParityEngine } from '@/services/permission-parity/claude-parity-engine.js';
import { opencodeParityAdapter } from '@/services/permission-parity/opencode-claude-tools.js';

import { OpenCodeParityRefusal, PARITY_CODES, prepareOpenCodeL1 } from './opencode-parity-launch.js';

/** Error code for a permission opencode rejected on its own, with no one asked. */
export const OPENCODE_PERMISSION_AUTO_REJECTED_CODE = 'permission_auto_rejected';

/** Error code for an argv the installed opencode refused (it printed its usage). */
export const OPENCODE_CLI_ARGS_REJECTED_CODE = 'opencode_cli_args_rejected';

type PermissionRequest = Parameters<typeof resolveClaudeEffectivePermissionMode>[0]
  & { toolsSettings?: { skipPermissions?: unknown; disallowedTools?: unknown } | null };

/** What one turn's engine needs beyond the launch decision. */
export type OpenCodeEngineTurn = {
  /** The OpenCode child's HOME (relative `~` paths are not expanded by opencode). */
  home: string;
  sessionId: string;
  transcriptPath: string;
  /** MCP server names configured for this spawn (the `<server>_<tool>` split). */
  mcpServers: string[];
  /** The OpenCode child env (XDG_CONFIG_HOME for the harness-config sensitive set). */
  harnessEnv: NodeJS.ProcessEnv;
};

export type OpenCodePermissionParity = {
  /** The mode Claude would run under for the same request. */
  claudeMode: string;
  /** Arguments to add to `opencode run` (fresh array): `--agent plan` or nothing. */
  args: string[];
  /** nassaj-generated OPENCODE_PERMISSION JSON (L1). */
  permission: string;
  /** The per-turn parity engine (throws OpenCodeParityRefusal on an engine refusal). */
  createEngine: (turn: OpenCodeEngineTurn) => ReturnType<typeof createClaudeParityEngine>;
};

type EngineInput = Parameters<typeof createClaudeParityEngine>[0];
/** The engine's JSDoc names the dsh adapter's type; the OpenCode adapter has the same shape. */
const OPENCODE_ADAPTER = opencodeParityAdapter as unknown as EngineInput['adapter'];

type LaunchDeps = {
  claudeEnv?: (userId: string | number | null) => NodeJS.ProcessEnv | null;
  managedSettingsDir?: string;
};

/**
 * Claude's spawn env for the member, exactly as Claude's spawn builds it. A throw is a
 * refusal: Claude itself would not run for this member, so neither does OpenCode.
 */
function claudeEnvOrRefuse(read: (userId: string | number | null) => NodeJS.ProcessEnv | null,
  userId: string | number | null): NodeJS.ProcessEnv {
  let env: NodeJS.ProcessEnv | null = null;
  try {
    env = read(userId);
  } catch {
    env = null;
  }
  if (!env) throw new OpenCodeParityRefusal(PARITY_CODES.policy, 'The Claude permission policy for this turn cannot be built.');
  return env;
}

/**
 * The OpenCode permissions for one turn: Claude's mode, the argv, L1, and the engine factory.
 * Validates the engine now, before any spawn (an unreadable setting, an unsupported rule or a
 * non-command hook refuses here, with no process started).
 * @param options the turn options (permissionMode, toolsSettings, permissionExecution)
 * @param context the sender and the working directory
 * @param deps test seams
 * @throws {OpenCodeParityRefusal|Error} PERMISSION_EFFECTIVE_POLICY_REQUIRED where Claude refuses
 */
export function resolveOpenCodePermissionParity(
  options: PermissionRequest,
  context: { userId: string | number | null; cwd: string },
  deps: LaunchDeps = {},
): OpenCodePermissionParity {
  const readEnv = deps.claudeEnv ?? ((userId) => claudeSpawnEnvFor(userId, process.env));
  const env = claudeEnvOrRefuse(readEnv, context.userId);
  const claudeMode = resolveClaudeEffectivePermissionMode(options, {
    env, cwd: context.cwd, managedSettingsDir: deps.managedSettingsDir,
  });
  const mapped = mapPermissionModeToVendorFlags('opencode', claudeMode) as { flags: string[] };
  const { parityEnforced } = resolveClaudeRequestedPermissionMode(options);
  const requested = options.toolsSettings?.disallowedTools;
  // Under parity enforce Claude blocks Task/Agent (mapCliOptionsToSDK); so does OpenCode.
  const disallowedTools = [...(Array.isArray(requested) ? requested : []), ...(parityEnforced ? ['Task', 'Agent'] : [])];
  const permission = prepareOpenCodeL1({
    claudeMode, claudeEnv: env, cwd: context.cwd, userId: context.userId, disallowedTools,
    managedSettingsDir: deps.managedSettingsDir,
  });
  const createEngine = (turn: OpenCodeEngineTurn) => {
    try {
      return createClaudeParityEngine({
        userId: context.userId, cwd: context.cwd, permissionMode: claudeMode, managedSettingsDir: deps.managedSettingsDir,
        claudeEnv: () => env, requireClaudeEnv: true, disallowedTools, adapter: OPENCODE_ADAPTER, ...turn,
      });
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      throw new OpenCodeParityRefusal(typeof code === 'string' ? code : PARITY_CODES.policy,
        error instanceof Error ? error.message : String(error));
    }
  };
  createEngine({ home: context.cwd, sessionId: 'validation', transcriptPath: '/dev/null', mcpServers: [], harnessEnv: {} });
  return { claudeMode, args: [...mapped.flags], permission, createEngine };
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
