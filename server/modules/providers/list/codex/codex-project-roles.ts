/**
 * ADR-206 S1 §4 (C3): pre-launch project role guard.
 *
 * Codex 0.160 accepts project-layer agent roles in two forms: `.codex/agents/*.toml`
 * files, and inline `[agents.<name>]` tables in a project `.codex/config.toml`. Whether a
 * project role really loads cannot be proven offline (F11), so any such role found from
 * the working directory up to `$HOME` (when the cwd is under it) or else `/` turns
 * helpers off for the turn (B = 0). It never refuses the turn.
 *
 * `$CODEX_HOME` (the user layer) is excluded by identity (lexical and real path); the
 * caller also passes the operator `~/.codex`, which is an operator-owned user layer and
 * never repository content. Reads are pinned and no-follow (single link, name bound to
 * the descriptor) with a size cap. Anything that cannot be read safely counts as a hit:
 * fail-closed for delegation, never for the turn.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { openFileNoFollow, PinnedOpenError } from '../../shared/pinned-fd.js';

import { readBoundedUtf8 } from './codex-multi-agent.js';

const CONFIG_MAX_BYTES = 1024 * 1024;
const AGENTS_DIR_MAX_ENTRIES = 4096;

export type CodexProjectRoleKind =
  | 'agents_dir' | 'inline_role' | 'unparsable_config' | 'unreadable_config' | 'symlinked_layer';

/** The first hit; `dir` is the `.codex` directory (for local diagnostics, not for logs). */
export type CodexProjectRoleHit = Readonly<{ kind: CodexProjectRoleKind; dir: string }>;

export type CodexProjectRoleOptions = {
  /** Walk bound when the cwd is under it; defaults to `os.homedir()`. */
  home?: string;
  /** `.codex` directories that are user layers, never project layers. */
  excludedCodexHomes?: readonly string[];
};

/** Lexical and real-path spellings of a directory (real path only when it resolves). */
async function spellings(dir: string): Promise<string[]> {
  const lexical = path.resolve(dir);
  const real = await fsp.realpath(lexical).catch(() => null);
  return real && real !== lexical ? [lexical, real] : [lexical];
}

function isWithin(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Directories from `start` upward to `home` (inclusive) when under it, else to `/`. */
function ancestors(start: string, home: string): string[] {
  const stop = isWithin(start, home) ? home : path.parse(start).root;
  const out: string[] = [];
  for (let dir = start; ; dir = path.dirname(dir)) {
    out.push(dir);
    if (dir === stop || path.dirname(dir) === dir) return out;
  }
}

async function lstatOrNull(target: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * An `[agents]` entry whose value is a table (or an array) is an inline role. The keys
 * Codex 0.160 knows there (`max_threads`, `max_concurrent_threads_per_session`,
 * `max_depth`, `job_max_runtime_seconds`, `interrupt_message`, `default_subagent_model`,
 * `default_subagent_reasoning_effort`) are all scalars, so a table under one of them is
 * malformed and counts too (fail-closed for delegation).
 */
function hasInlineRole(parsed: Record<string, unknown>): boolean {
  const agents = parsed.agents;
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return false;
  return Object.values(agents).some(value => (
    value !== null && typeof value === 'object' && !(value instanceof Date)
  ));
}

async function checkAgentsDir(codexDir: string): Promise<CodexProjectRoleKind | null> {
  const agents = path.join(codexDir, 'agents');
  let stat;
  try {
    stat = await lstatOrNull(agents);
  } catch {
    return 'unreadable_config';
  }
  if (!stat) return null;
  if (stat.isSymbolicLink()) return 'symlinked_layer';
  if (!stat.isDirectory()) return null;
  try {
    // Streamed with an entry cap: an untrusted directory cannot make the launch list it all.
    let seen = 0;
    for await (const entry of await fsp.opendir(agents)) {
      if (entry.name.toLowerCase().endsWith('.toml')) return 'agents_dir';
      if (++seen >= AGENTS_DIR_MAX_ENTRIES) return 'unreadable_config';
    }
    return null;
  } catch {
    return 'unreadable_config';
  }
}

async function checkConfig(codexDir: string): Promise<CodexProjectRoleKind | null> {
  const file = path.join(codexDir, 'config.toml');
  let opened: Awaited<ReturnType<typeof openFileNoFollow>> | null = null;
  try {
    opened = await openFileNoFollow(file);
    if (opened.stat.size > BigInt(CONFIG_MAX_BYTES)) return 'unreadable_config';
    const raw = await readBoundedUtf8(opened.handle, CONFIG_MAX_BYTES);
    if (raw === null) return 'unreadable_config';
    let parsed: Record<string, unknown>;
    try {
      parsed = TOML.parse(raw) as Record<string, unknown>;
    } catch {
      return 'unparsable_config';
    }
    return hasInlineRole(parsed) ? 'inline_role' : null;
  } catch (error) {
    return error instanceof PinnedOpenError && error.reason === 'missing' ? null : 'unreadable_config';
  } finally {
    await opened?.handle.close().catch(() => undefined);
  }
}

/** One `.codex` layer: null when it holds no project role. */
async function checkLayer(codexDir: string, excluded: ReadonlySet<string>): Promise<CodexProjectRoleKind | null> {
  let stat;
  try {
    stat = await lstatOrNull(codexDir);
  } catch {
    return 'unreadable_config';
  }
  if (!stat) return null;
  // By identity: also covers a `.codex` reached through a symlinked ancestor or itself a link.
  const real = await fsp.realpath(codexDir).catch(() => null);
  if (real && excluded.has(real)) return null;
  if (stat.isSymbolicLink()) return 'symlinked_layer';
  if (!stat.isDirectory()) return null;
  return (await checkAgentsDir(codexDir)) ?? checkConfig(codexDir);
}

/**
 * The first project-layer Codex role between `cwd` and `$HOME` (or `/`), or null.
 * Never throws: an unexpected failure is reported as an `unreadable_config` hit.
 */
export async function findCodexProjectRoles(
  cwd: string,
  options: CodexProjectRoleOptions = {},
): Promise<CodexProjectRoleHit | null> {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    const home = path.resolve(options.home ?? os.homedir());
    const excluded = new Set<string>();
    for (const codexHome of options.excludedCodexHomes ?? []) {
      if (typeof codexHome === 'string' && codexHome) for (const spelled of await spellings(codexHome)) excluded.add(spelled);
    }
    const seen = new Set<string>();
    for (const start of await spellings(cwd)) {
      for (const dir of ancestors(start, home)) {
        const codexDir = path.join(dir, '.codex');
        if (seen.has(codexDir) || excluded.has(codexDir)) continue;
        seen.add(codexDir);
        const kind = await checkLayer(codexDir, excluded);
        if (kind) return Object.freeze({ kind, dir: codexDir });
      }
    }
    return null;
  } catch {
    return Object.freeze({ kind: 'unreadable_config', dir: '' });
  }
}
