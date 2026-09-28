/**
 * Tainted-turn gate (T-1903, qa H1-H3 + C1, owner-approved DEFAULT-DENY).
 *
 * Once another member's text entered a run, every tool except a short
 * read-only allowlist needs the STARTER's approval, and the sub-agent launchers
 * (Agent, Task, Workflow) are refused outright — a sub-agent would carry the
 * injected instruction beyond this gate. The gate is an allowlist on purpose:
 * a tool the SDK adds tomorrow is gated by default.
 *
 * It is a PreToolUse hook matched on EVERY tool: `canUseTool` is skipped in
 * bypassPermissions, a PreToolUse hook is not, and a hook `deny` wins over an
 * `allow` from any other hook (proved on the real CLI by
 * scripts/smoke/steer-taint-precedence.smoke.mjs).
 */

/**
 * Side-effect-free tools a tainted turn may still use without asking:
 * Read/Grep/Glob read files; TodoWrite only edits the run's own task list
 * (no file, process or network effect). Every other tool, including any the
 * SDK adds later, asks the starter (deny-by-default).
 */
export const STEER_TAINT_FREE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'TodoWrite']);

/** Launch sub-agents: refused outright in a tainted turn, never offered to the starter. */
export const STEER_TAINT_REFUSED_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'Workflow']);

/** Every tool reaches the callback; the allowlist lives in code, not in the matcher. */
export const STEER_TAINT_MATCHER = '.*';

/**
 * CLI hook timeout (seconds) for an approval ceiling in ms. Always larger than
 * the approval wait, so the hook answers (deny on timeout) before the CLI
 * could give up on it — a CLI-side hook timeout can never turn into an allow.
 */
export function steerHookTimeoutSeconds(approvalTimeoutMs: number): number {
  return Math.ceil(approvalTimeoutMs / 1000) + 60;
}

export type StarterVerdict = 'allow' | 'deny' | 'timeout' | 'offline';

export type SteerTaintDeps = {
  isTainted: () => boolean;
  /** Asks ONLY the starter; must resolve 'offline' when the starter has no live socket. */
  askStarter: (toolName: string, input: unknown, signal?: AbortSignal) => Promise<StarterVerdict>;
  log?: (line: string) => void;
};

/** True for every tool the gate governs (everything outside the free allowlist). */
export function isSteerGatedTool(toolName: unknown): boolean {
  return typeof toolName !== 'string' || !STEER_TAINT_FREE_TOOLS.has(toolName);
}

function deny(reason: string) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/** Builds the SDK PreToolUse callback. Any internal failure denies. */
export function createSteerTaintHook(deps: SteerTaintDeps) {
  return async (hookInput: Record<string, any>, _toolUseId?: unknown, context?: { signal?: AbortSignal }) => {
    const toolName = hookInput?.tool_name;
    try {
      if (!deps.isTainted() || !isSteerGatedTool(toolName)) return {};
      if (typeof toolName !== 'string' || STEER_TAINT_REFUSED_TOOLS.has(toolName)) {
        deps.log?.(`[STEER-TAINT] deny tool=${String(toolName)} reason=subagent-in-tainted-turn`);
        return deny('Another member steered this turn; launching sub-agents is blocked until the turn ends.');
      }
      const verdict = await deps.askStarter(toolName, hookInput?.tool_input, context?.signal);
      deps.log?.(`[STEER-TAINT] tool=${toolName} verdict=${verdict}`);
      if (verdict === 'allow') return {};
      return deny(verdict === 'deny'
        ? 'The turn owner declined this action after another member steered the turn.'
        : `This turn was steered by another member; ${toolName} needs the turn owner's approval (${verdict}).`);
    } catch {
      return deny('Steer safety check failed; the action was blocked.');
    }
  };
}
