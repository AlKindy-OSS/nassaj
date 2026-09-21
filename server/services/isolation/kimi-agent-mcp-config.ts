import fsDefault from 'node:fs';
import path from 'node:path';

import { resolveKimiHomeForUser } from './kimi-agent-home.js';

/**
 * UNWIRED (B-383, 2026-08-01). This module has ZERO callers in `server/` and `src/` —
 * `kimi-agent-cli.js` never mentions mcp — so NO file is written at any spawn and no
 * MCP server reaches a kimi turn today. Read the paragraphs below as a description of
 * a seam that is BUILT but NOT CONNECTED; connecting it is tracked on B-383, not done.
 * (The previous header claimed it "carries the operator's MCP servers into the CLI at
 * each turn" — it never has. Same failure mode as the cleanSpawnEnv comment that
 * described protection which never reached a spawn.)
 *
 * kimi-agent-mcp-config — KM-4 (mcp) (ADR-062 §4.2, wave W4-C): the seam that
 * materializes the native Kimi AGENT's MCP config at <KIMI_CODE_HOME>/mcp.json,
 * per user.
 *
 * PATH, FIELD-CONFIRMED 2026-08-01 (B-383). This wrote <KIMI_CODE_HOME>/.kimi-code/
 * mcp.json, which kimi NEVER reads. kimi v0.28.1's own bundled `/mcp-config` skill
 * (dist/main.mjs) states the three files it loads, in precedence order:
 *   • user-global:   <KIMI_CODE_HOME>/mcp.json      ← flat in the home, no nesting
 *   • project-root:  <project root>/.mcp.json       ← the Claude-compatible file
 *   • project-local: <cwd>/.kimi-code/mcp.json      ← relative to CWD, not to the home
 * The `.kimi-code/` nesting only ever applied to the CWD-relative file, so composing it
 * with the home produced a path nothing opens. The live tree confirms the flat layout:
 * ~/.nassaj-users/1/.kimi/ holds config.toml, credentials/, device_id and logs/ at its
 * root, and its .kimi-code/ is empty. The `{ mcpServers: {...} }` SHAPE was correct.
 *
 * DELIBERATELY SEPARATE from `kimi-mcp.provider.ts` (the six-facet CHAT facet,
 * which exposes an EMPTY server set for the toolless hosted-HTTP chat path). This
 * seam does NOT read/expose servers for the UI; it WRITES the agent CLI's own
 * mcp.json under the isolated config-home, so a per-user agent turn (KM-1) can
 * carry the operator's MCP servers into the sandboxed CLI without leaking one
 * user's config into another's tree.
 *
 * PER-USER ISOLATION is the load-bearing property: every write resolves the home
 * through resolveKimiHomeForUser (SL-5, agent mode), so user A's mcp.json can only
 * ever land in ~/.nassaj-users/A/.kimi/mcp.json — never B's. The file may reference
 * server env (tokens), so it is written 0600 and atomically (tmp + rename) to avoid a
 * torn read.
 */

/**
 * The CWD-relative config subdir kimi reads a project-local mcp.json from
 * (`<cwd>/.kimi-code/mcp.json`). Kept exported because provision-user-dirs.js
 * pre-creates the matching directory, but it is deliberately NOT part of the
 * user-global path any more — composing it with the home was B-383.
 */
export const KIMI_CWD_CONFIG_SUBDIR = '.kimi-code';

/** The MCP config filename kimi reads from its config-home. */
export const KIMI_MCP_FILENAME = 'mcp.json';

/** Minimal fs surface this seam needs, injectable for tests. */
export type KimiMcpFs = {
  mkdirSync: typeof fsDefault.mkdirSync;
  writeFileSync: typeof fsDefault.writeFileSync;
  renameSync: typeof fsDefault.renameSync;
  chmodSync: typeof fsDefault.chmodSync;
  readFileSync: typeof fsDefault.readFileSync;
};

/** The canonical `{ mcpServers }` config shape this seam serializes. */
export type KimiAgentMcpConfig = {
  mcpServers: Record<string, unknown>;
};

/**
 * Resolves the user-global mcp.json path INSIDE an already-resolved Kimi home:
 * <home>/mcp.json — flat, no nesting (B-383).
 */
export function resolveKimiAgentMcpConfigPath(home: string): string {
  return path.join(home, KIMI_MCP_FILENAME);
}

/**
 * Resolves a user's mcp.json path through the SL-5 per-user home resolver — the
 * isolated ~/.nassaj-users/<userId>/.kimi/mcp.json when kimi is isolated, else the
 * operator ~/.kimi-code/mcp.json.
 */
export function resolveKimiAgentMcpConfigPathForUser(userId: string | number | null): string {
  return resolveKimiAgentMcpConfigPath(resolveKimiHomeForUser(userId));
}

/**
 * PURE builder: normalizes a servers map into the canonical `{ mcpServers }`
 * config. Non-object / empty-name entries are dropped so a malformed input never
 * produces an invalid config. Order-preserving over the input entries.
 */
export function buildKimiAgentMcpConfig(
  servers: Record<string, unknown> = {},
): KimiAgentMcpConfig {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(servers)) {
    if (name && definition && typeof definition === 'object') {
      mcpServers[name] = definition;
    }
  }
  return { mcpServers };
}

/**
 * Writes the agent mcp.json into an already-resolved Kimi home, atomically and
 * 0600. Ensures the .kimi-code/ dir exists (0700). Returns the written path.
 *
 * @param home an already-resolved KIMI_CODE_HOME (use the *ForUser variant to
 *   resolve per-user isolation — this low-level form is home-explicit so tests
 *   can prove isolation with two distinct homes and no DB).
 */
export function writeKimiAgentMcpConfig(
  home: string,
  servers: Record<string, unknown> = {},
  deps: { fs?: KimiMcpFs } = {},
): string {
  const fs = deps.fs ?? fsDefault;
  const target = resolveKimiAgentMcpConfigPath(home);
  const dir = path.dirname(target);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const serialized = `${JSON.stringify(buildKimiAgentMcpConfig(servers), null, 2)}\n`;
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, serialized, { mode: 0o600 });
  fs.renameSync(tmp, target);
  // rename preserves the tmp file's mode; re-assert 0600 defensively (best-effort).
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // A filesystem that rejects chmod (rare) still leaves the 0600 tmp mode intact.
  }

  return target;
}

/**
 * Writes a user's agent mcp.json through the SL-5 per-user home resolver, so the
 * file lands in that user's isolated tree only.
 */
export function writeKimiAgentMcpConfigForUser(
  userId: string | number | null,
  servers: Record<string, unknown> = {},
  deps: { fs?: KimiMcpFs } = {},
): string {
  return writeKimiAgentMcpConfig(resolveKimiHomeForUser(userId), servers, deps);
}

/**
 * Reads and normalizes an existing agent mcp.json from a home, or null when it is
 * absent/unreadable/malformed (never throws — callers treat absence as "no
 * servers configured yet").
 */
export function readKimiAgentMcpConfig(
  home: string,
  deps: { fs?: KimiMcpFs } = {},
): KimiAgentMcpConfig | null {
  const fs = deps.fs ?? fsDefault;
  try {
    // readFileSync with an explicit 'utf8' encoding always yields a string (never
    // a Buffer), so it is parsed directly — no Buffer→string narrowing needed.
    const raw = fs.readFileSync(resolveKimiAgentMcpConfigPath(home), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const servers = (parsed as Record<string, unknown>).mcpServers;
    return buildKimiAgentMcpConfig(
      servers && typeof servers === 'object' ? (servers as Record<string, unknown>) : {},
    );
  } catch {
    return null;
  }
}
