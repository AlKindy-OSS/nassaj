/**
 * mcp-npx-direct — collapses an `npx -y <package>` MCP launcher into a direct
 * `node <bin>` spawn (T-1297).
 *
 * WHY THIS EXISTS. An MCP server declared as `npx -y @scope/pkg` costs THREE
 * processes per engine spawn, not one: `npm exec` (~130–220MB resident, because
 * it is a full npm), the `sh -c` it uses to run the resolved bin, and only then
 * the server itself (~70–80MB). Measured 2026-08-07 on this host: 12 live
 * processes and ~760MB resident for four `claude` sessions, of which ~690MB was
 * the two supervisors that do nothing after startup. Launching the resolved bin
 * with the SAME node that already runs nassaj drops both supervisors and keeps
 * only the server.
 *
 * WHY NOT THE npx CACHE PATH. `~/.npm/_npx/<hash>/node_modules/.bin/<name>` is
 * real and stable-looking, and is exactly the wrong thing to hardcode: the hash
 * is derived from the requested spec, the tree is garbage-collectable, and
 * `npm cache clean` removes it. This module resolves only from install roots
 * nassaj owns, and when it finds nothing it returns null so the caller keeps the
 * original `npx` form — a connector that is slow to start beats a connector that
 * cannot start.
 *
 * SCOPE. Pure resolution over the filesystem. It never installs, never spawns,
 * and never touches the entry's `env` — the credential in there is not this
 * module's business and it is deliberately not read here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

/** A stdio launcher: the program to run and its arguments. */
export type StdioLaunch = { command: string; args: string[] };

/** The command names that mean "npm's package runner". */
const NPX_COMMANDS = new Set(['npx', 'npx.cmd']);

/**
 * npx flags that take no value and may appear before the package spec.
 * Anything NOT in here (in particular `-p`/`--package`, `-c`, `--call`) makes
 * the invocation something other than "run this one package", so resolution
 * bails rather than guessing which package is meant.
 */
const NPX_VALUELESS_FLAGS = new Set([
  '-y',
  '--yes',
  '--no',
  '--no-install',
  '-q',
  '--quiet',
  '--silent',
  '--prefer-online',
  '--prefer-offline',
  '--offline',
  '--ignore-existing',
]);

/**
 * Strips a version/tag suffix from a package spec, keeping the scope's own `@`.
 * `@infomaniak/mcp-server-mail@1.10.0` → `@infomaniak/mcp-server-mail`.
 */
function packageNameOf(spec: string): string | null {
  if (spec === '' || spec.startsWith('.') || spec.startsWith('/') || spec.includes('://')) {
    // A path or a URL is not an installed package name; nothing to resolve.
    return null;
  }
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  return /^(@[^/@\s]+\/)?[^/@\s]+$/.test(name) ? name : null;
}

/**
 * Splits `['-y', '@scope/pkg', 'serve']` into the package and the arguments the
 * server itself should receive. Returns null when the invocation is not a plain
 * "run one package" (see {@link NPX_VALUELESS_FLAGS}).
 */
export function parseNpxInvocation(
  args: readonly string[],
): { packageName: string; serverArgs: string[] } | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      continue;
    }
    if (arg.startsWith('-')) {
      if (!NPX_VALUELESS_FLAGS.has(arg)) {
        return null;
      }
      continue;
    }
    const packageName = packageNameOf(arg);
    if (packageName === null) {
      return null;
    }
    return { packageName, serverArgs: args.slice(i + 1) };
  }
  return null;
}

/**
 * The roots searched for an installed connector server, in order.
 *
 * The dedicated store comes first and is deliberately NOT under
 * `~/.local/share/nassaj-dev/`: that directory holds the fixture DB.sqlite and is
 * one of the paths the provider cage hides from spawned engines, so a server
 * installed there would become unreachable the day the cage flag is raised.
 *
 * The application's own `node_modules` is searched second so a connector server
 * declared as a real dependency also resolves, with no second install.
 */
export function connectorServerRoots(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = getModuleDir(import.meta.url),
): string[] {
  const roots: string[] = [];
  const configured = env.NASSAJ_CONNECTOR_SERVERS_DIR?.trim();
  if (configured) {
    roots.push(configured);
  }
  const effectiveHome = env.HOME?.trim() || os.homedir();
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(effectiveHome, '.local', 'share');
  roots.push(path.join(dataHome, 'nassaj-connector-servers'));
  // The application's own node_modules, resolved from this module's location so
  // it survives an install being moved. `findAppRoot` — NOT `path.resolve(dir,
  // '..', '..')`, which only reaches the app root under `tsx` (source at
  // `<app>/server/services`). In the compiled build this module lives at
  // `<app>/dist-server/server/services`, so `../..` stopped at
  // `<app>/dist-server`, whose `node_modules` does not exist, and the
  // dependency fallback silently never resolved in production (B-1118).
  // `findAppRoot` understands both layouts and hops past `dist-server`.
  // `getModuleDir` (fileURLToPath under the hood) also decodes a `%20`/space in
  // the install path that `new URL(...).pathname` would have left encoded (B-533).
  roots.push(findAppRoot(moduleDir));
  return roots;
}

/** Reads the `bin` entry a package publishes for the given package name. */
function binPathFor(packageDir: string, packageName: string): string | null {
  let manifest: { bin?: unknown; name?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }

  const { bin } = manifest;
  let relative: string | null = null;
  if (typeof bin === 'string') {
    relative = bin;
  } else if (bin && typeof bin === 'object') {
    const entries = Object.entries(bin as Record<string, unknown>).filter(
      ([, value]) => typeof value === 'string',
    ) as [string, string][];
    // Prefer the bin named after the package (`@scope/foo` → `foo`), which is
    // the name `npx @scope/foo` would itself have run; fall back to a lone bin.
    const preferred = entries.find(([name]) => name === packageName.split('/').pop());
    relative = preferred?.[1] ?? (entries.length === 1 ? entries[0][1] : null);
  }
  if (relative === null) {
    return null;
  }

  const resolved = path.resolve(packageDir, relative);
  return fs.existsSync(resolved) ? resolved : null;
}

/**
 * Resolves `npx -y <pkg>` to `<this node> <pkg's bin>` when the package is
 * installed in a root nassaj owns. Returns null — meaning "leave it alone" —
 * for any launcher this cannot prove it can run.
 */
export function resolveDirectNpxLaunch(
  launch: StdioLaunch,
  env: NodeJS.ProcessEnv = process.env,
): StdioLaunch | null {
  if (!NPX_COMMANDS.has(path.basename(launch.command))) {
    return null;
  }
  const parsed = parseNpxInvocation(launch.args ?? []);
  if (!parsed) {
    return null;
  }

  for (const root of connectorServerRoots(env)) {
    const packageDir = path.join(root, 'node_modules', ...parsed.packageName.split('/'));
    const bin = binPathFor(packageDir, parsed.packageName);
    if (bin) {
      // process.execPath, not the bare word `node`: the engine we hand this to
      // may not share nassaj's PATH (the measured OpenCode case), and a server
      // that cannot spawn is indistinguishable from one with a bad key.
      return { command: process.execPath, args: [bin, ...parsed.serverArgs] };
    }
  }
  return null;
}

/**
 * Applies {@link resolveDirectNpxLaunch} across a whole `{ mcpServers }` map,
 * returning a NEW map. Entries that are not stdio-over-npx, and stdio entries
 * whose package is not installed locally, are passed through untouched.
 */
export function collapseNpxLaunchers<T extends Record<string, unknown>>(
  servers: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const out: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(servers)) {
    const entry = definition as { command?: unknown; args?: unknown } | null;
    if (!entry || typeof entry !== 'object' || typeof entry.command !== 'string') {
      out[name] = definition;
      continue;
    }
    const direct = resolveDirectNpxLaunch(
      { command: entry.command, args: Array.isArray(entry.args) ? (entry.args as string[]) : [] },
      env,
    );
    out[name] = direct ? { ...entry, command: direct.command, args: direct.args } : definition;
  }
  return out as T;
}
