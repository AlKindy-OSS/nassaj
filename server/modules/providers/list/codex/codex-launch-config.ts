/**
 * The `config` of every Codex SDK launch (`new Codex({ config })`), composed in
 * one place so the real-CLI proofs (T-2107 qa high 4) run the exact object the
 * spawn chokepoint (server/openai-codex.js) builds.
 */

export type CodexLaunchConfigInput = {
  /** codexMultiAgentConfig(...) for this turn (ADR-206 S1, B-1616). */
  multiAgentConfig: Readonly<Record<string, unknown>>;
  /** The T-1315 per-turn slot (codexTurnDeveloperInstructions). */
  developerInstructions: string;
  sandboxMode: string;
  /** ADR-174 docs roots, writable only under workspace-write. */
  docsWritableRoots: readonly string[];
  /** ADR-227 / T-2107: the local-engine overrides, or null for a cloud chat. */
  localConfig: Readonly<Record<string, unknown>> | null;
};

/**
 * ADR-134 v1 denies MCP and external delegation as surfaces: these parent-controlled
 * overrides replace any entries in the user's config before the CLI starts. ADR-174:
 * no product-derived path may widen the sandbox into governance. The local overrides
 * (generated provider, context window, vendor features off) come last.
 */
export function composeCodexLaunchConfig(input: CodexLaunchConfigInput): Record<string, unknown> {
  const { multiAgentConfig, developerInstructions, sandboxMode, docsWritableRoots, localConfig } = input;
  return {
    ...multiAgentConfig,
    mcp_servers: {},
    developer_instructions: developerInstructions,
    ...(sandboxMode === 'workspace-write' && docsWritableRoots.length > 0
      ? { 'sandbox_workspace_write.writable_roots': docsWritableRoots }
      : {}),
    ...(localConfig ?? {}),
  };
}
