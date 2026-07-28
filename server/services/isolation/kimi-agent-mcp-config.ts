import fsDefault from 'node:fs';
import path from 'node:path';

import { resolveKimiHomeForUser } from './kimi-agent-home.js';

/**
 * kimi-agent-mcp-config — KM-4 (mcp) (ADR-062 §4.2, wave W4-C): the seam that
 * materializes the native Kimi AGENT's MCP config at
 * <KIMI_CODE_HOME>/.kimi-code/mcp.json (KG-1 §1.1), per user.
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
 * ever land in ~/.nassaj-users/A/.kimi/.kimi-code/mcp.json — never B's. The file
 * may reference server env (tokens), so it is written 0600 and atomically
 * (tmp + rename) to avoid a torn read.
 *
 * FIELD-CONFIRMED AT G-KIMI-LIVE (§4.5): kimi is not installed on this node, so
 * the exact mcp.json schema is taken from the common MCP convention
 * (`{ "mcpServers": { "<name>": {...} } }`, the Claude/codex shape). The builder
 * is the single place to refine the shape once the live CLI is captured; the
 * path resolution and isolation contract do not change.
 */

/**
 * The config subdir INSIDE the Kimi home that holds mcp.json (KG-1 §1.1). This
 * MIRRORS `KIMI_CONFIG_SUBDIR` in provision-user-dirs.js (which is a non-exported
 * const there, and provision-user-dirs.js is owned by the config-seam agent —
 * W2-D — so it is not modified here to export it). Both must agree; the layout is
 * field-CONFIRMED at G-KIMI-LIVE, at which point this is a single-point edit. The
 * ROOT home (.kimi) is the shared KIMI_HOME_SUBDIR constant, reused via
 * resolveKimiHomeForUser — so the env var and on-disk root can never drift; only
 * this leaf subdir name is restated locally.
 */
export const KIMI_CONFIG_SUBDIR = '.kimi-code';

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
 * Resolves the mcp.json path INSIDE an already-resolved Kimi home:
 * <home>/.kimi-code/mcp.json.
 */
export function resolveKimiAgentMcpConfigPath(home: string): string {
  return path.join(home, KIMI_CONFIG_SUBDIR, KIMI_MCP_FILENAME);
}

/**
 * Resolves a user's mcp.json path through the SL-5 per-user home resolver — the
 * isolated ~/.nassaj-users/<userId>/.kimi/.kimi-code/mcp.json when kimi is
 * isolated, else the operator ~/.kimi/.kimi-code/mcp.json.
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
