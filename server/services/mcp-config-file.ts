/**
 * mcp-config-file — keeps connector secrets off the engine's command line
 * (B-524).
 *
 * THE EXPOSURE. The Agent SDK serialises `options.mcpServers` and pushes it as
 * `--mcp-config <json>` (sdk.mjs: `i.push("--mcp-config", JSON.stringify(...))`).
 * A connector entry carries its credential in `env` — `MAIL_TOKEN`, an API key,
 * an OAuth access token — so that credential lands verbatim in the argv of every
 * `claude` process, i.e. in `/proc/<pid>/cmdline`, which is world-readable. Any
 * account on the host reading `ps aux` sees it, and on this host the members'
 * sessions and the production server share uid `nassaj`, so "any account" is not
 * a hypothetical. Confirmed on four live processes 2026-08-07.
 *
 * THE FIX. `--mcp-config` accepts a FILE PATH as readily as a JSON string
 * ("Load MCP servers from JSON files or strings"), so the payload moves to a
 * file created with mode 0600 and only its path appears in argv. The mode is
 * given to `open()` at CREATE time, never to a `chmod` afterwards: between the
 * two syscalls the file exists world-readable, and a reader that loses that race
 * only has to poll.
 *
 * WHY NOT `/tmp`. `/tmp` is a tmpfs on this host — a file there is resident
 * memory, and a leaked one is leaked RAM (2026-07-29..31: build artefacts in
 * /tmp pinned 2.7GB for 45 hours). These files live on disk inside the MEMBER's
 * own isolated tree instead (see {@link mcpConfigDir}), which the provider cage
 * re-binds for that member and only that member, while
 * `~/.local/share/nassaj-dev`, the one path under a data home the cage blanks,
 * is untouched.
 *
 * LIFECYCLE. One file per run, unlinked in the run's `finally` on every exit
 * path. A `kill -9` leaves it behind, so every write first sweeps the directory
 * of files older than {@link STALE_FILE_MS} — the accumulation is bounded
 * without needing a daemon, and the sweep never touches a file young enough to
 * belong to a live run.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** Directory name under the data home. Deliberately NOT `nassaj-dev`, which the provider cage blanks. */
export const MCP_CONFIG_DIR_NAME = 'nassaj-mcp-config';

/**
 * Root of the per-user isolated trees and the data-home subpath inside one —
 * mirroring provision-user-dirs.js (`usersRoot()` + `userConfigDir(id,
 * '.local/share')`), deliberately NOT imported: that module pulls the whole
 * database layer in, and this one must stay a pure fs/path module. The same
 * trade-off provider-cage-wiring.js documents for `cageUsersRoot`. The drift is
 * pinned by a test that compares the result against the real `userConfigDir`.
 */
const USERS_ROOT_DIR_NAME = '.nassaj-users';
const MEMBER_DATA_HOME_SUBDIR = path.join('.local', 'share');

/** File mode: owner read/write only. Applied at creation, never by a later chmod. */
export const MCP_CONFIG_FILE_MODE = 0o600;

/** Directory mode: owner only, so a stray file inside is unreachable even if its own mode slipped. */
export const MCP_CONFIG_DIR_MODE = 0o700;

/** A leftover older than this cannot belong to a live run and is swept. */
export const STALE_FILE_MS = 6 * 60 * 60 * 1000;

/** An MCP server entry as it reaches the SDK. Only `type` matters here. */
export type McpServerEntry = { type?: string; [key: string]: unknown };

/** The handle a caller must dispose when the run ends. */
export type McpConfigFile = {
  /** Absolute path to hand to `--mcp-config`. */
  readonly path: string;
  /** Unlinks the file. Idempotent, never throws. */
  dispose(): void;
};

/**
 * Where a run's config file belongs. `userId` is a REQUIRED key, not an
 * optional one — see {@link mcpConfigDir}.
 */
export type McpConfigLocation = {
  /**
   * The member this spawn runs for. `null` ONLY for a genuinely unauthenticated
   * run (system / anonymous / single-user mode), where no isolation exists at
   * all and there is no second member to isolate from.
   */
  readonly userId: string | number | null;
  /** The spawn's environment. Consulted for the anonymous fallback only. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The SERVER's home directory — the process that WRITES the file, which is
   * never one of the HOME-overridden spawns. Injectable for tests only.
   */
  readonly homedir?: () => string;
};

/**
 * The directory the config file is written to, derived from the MEMBER, not
 * from the ambient environment.
 *
 * B-530 — WHY NOT `XDG_DATA_HOME`. This function used to read
 * `env.XDG_DATA_HOME` and fall back to the operator home, with a comment
 * claiming per-user isolation "comes for free". It does not:
 * `resolveProviderEnv` sets `XDG_DATA_HOME` in the `opencode` case ONLY. The
 * `claude` case — the one and only path that reaches this module — sets
 * `CLAUDE_CONFIG_DIR` and nothing else, and the live server process carries no
 * `XDG_DATA_HOME` at all (checked on the running process 2026-08-07). Every
 * member's connector secrets therefore landed in ONE shared directory,
 * `~/.local/share/nassaj-mcp-config`. The 0600 mode did not help: uid `nassaj`
 * is shared between the server and every member's engine, so 0600 is exactly
 * the permission that lets all of them read each other's file.
 *
 * The member's own tree is now derived EXPLICITLY, so the result cannot depend
 * on whether some other provider's case happened to export an env var. It is
 * also the branch the cage re-binds for this member alone (`--tmpfs
 * <usersRoot>` then `--bind <usersRoot>/<userId>`), so member-to-member reads
 * are closed by the cage as well as by the path.
 *
 * `homedir()` — not `env.HOME` — because the writer is the SERVER process,
 * whose HOME is the operator's, exactly like `provision-user-dirs`' own
 * `usersRoot()`. `env.HOME` would be WRONG here: the agy / hermes / cursor
 * cases of `resolveProviderEnv` set HOME to the member's tree, so re-rooting
 * `.nassaj-users` on it would nest a second copy inside the first. The
 * anonymous fallback below is the one place a spawn's own HOME is the right
 * answer, and it uses it.
 *
 * @throws {TypeError} when `userId` is not passed as an explicit key. The old
 *   signature took the env positionally, so an un-migrated caller would
 *   otherwise silently land back in the shared directory — the very bug. A
 *   loud throw at the call site is the only fallback that cannot re-leak.
 */
export function mcpConfigDir(loc: McpConfigLocation): string {
  if (!loc || typeof loc !== 'object' || !('userId' in loc)) {
    throw new TypeError(
      'mcpConfigDir requires an explicit { userId } — omitting it used to fall back to the '
        + 'operator data home, one directory shared by every member (B-530).',
    );
  }
  const { userId, env = process.env, homedir = os.homedir } = loc;
  const id = userId === null || userId === undefined || userId === '' ? null : String(userId);

  if (id !== null) {
    // The id comes from a verified JWT, but a path component is a path
    // component: refuse anything that could climb out of the member's tree
    // rather than compute a directory nobody meant.
    if (id.includes('/') || id.includes(path.sep) || id === '.' || id === '..') {
      throw new TypeError(`mcpConfigDir: refusing a userId that is not a plain path component: ${id}`);
    }
    return path.join(homedir(), USERS_ROOT_DIR_NAME, id, MEMBER_DATA_HOME_SUBDIR, MCP_CONFIG_DIR_NAME);
  }

  // No authenticated member: there is no isolation to honour (resolveProviderEnv
  // returns the operator environment unchanged for a null userId), so the file
  // goes to the spawn's own data home. `env.HOME` is honoured here because THIS
  // branch describes the spawn, and a HOME-overridden provider must not have its
  // file written outside the home it can actually read.
  const dataHome = env.XDG_DATA_HOME?.trim()
    || path.join(env.HOME?.trim() || homedir(), MEMBER_DATA_HOME_SUBDIR);
  return path.join(dataHome, MCP_CONFIG_DIR_NAME);
}

/**
 * Splits the servers by who runs them.
 *
 * `type: 'sdk'` entries are in-process objects the SDK connects over its own
 * control channel; they never reach argv and MUST stay on `options.mcpServers`
 * (they are not serialisable — that is the point of them). Everything else is
 * an external launcher the SDK would serialise, and is what moves to the file.
 */
export function splitSdkMcpServers(
  mcpServers: Record<string, McpServerEntry> | null | undefined,
): { inProcess: Record<string, McpServerEntry>; external: Record<string, McpServerEntry> } {
  const inProcess: Record<string, McpServerEntry> = {};
  const external: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(mcpServers ?? {})) {
    if (entry && typeof entry === 'object' && (entry as McpServerEntry).type === 'sdk') {
      inProcess[name] = entry;
    } else {
      external[name] = entry;
    }
  }
  return { inProcess, external };
}

/**
 * Deletes config files older than {@link STALE_FILE_MS}.
 *
 * Best-effort by construction: a missing directory, an unreadable entry or a
 * file another run unlinked between readdir and stat are all normal and silent.
 * Never throws — a sweep failure must not block a chat turn.
 */
export function sweepStaleMcpConfigFiles(dir: string, now: number = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith('mcp-') || !name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs <= STALE_FILE_MS) continue;
      fs.unlinkSync(full);
      removed += 1;
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  return removed;
}

/**
 * Writes the external MCP servers to a fresh 0600 file and returns its path.
 *
 * Returns null when there is nothing to externalise, so the caller's code path
 * for "no connectors" stays exactly what it was.
 *
 * @param external - servers to serialise (the `external` half of {@link splitSdkMcpServers})
 * @param loc - who this run belongs to; see {@link mcpConfigDir}. `userId` is a
 *   required key and its omission throws rather than defaulting to a directory
 *   shared by every member (B-530).
 */
export function writeMcpConfigFile(
  external: Record<string, McpServerEntry>,
  loc: McpConfigLocation,
): McpConfigFile | null {
  // The location is validated BEFORE the empty-set shortcut: a caller that has
  // not been migrated must fail on every run, not only on the runs that happen
  // to carry a connector.
  const dir = mcpConfigDir(loc);
  if (!external || Object.keys(external).length === 0) return null;

  fs.mkdirSync(dir, { recursive: true, mode: MCP_CONFIG_DIR_MODE });
  sweepStaleMcpConfigFiles(dir);

  const filePath = path.join(dir, `mcp-${crypto.randomUUID()}.json`);
  // `wx` + mode: create-exclusive with the final permissions already set. No
  // window in which the payload is readable by anyone but the owner, and no
  // chance of clobbering another run's file.
  const fd = fs.openSync(filePath, 'wx', MCP_CONFIG_FILE_MODE);
  let written = false;
  try {
    fs.writeFileSync(fd, JSON.stringify({ mcpServers: external }));
    written = true;
  } finally {
    // A throwing closeSync must not jump over the unlink below, nor mask the
    // more informative write error that is already propagating. Capture it and
    // re-raise only when the write itself succeeded.
    let closeError: unknown;
    try {
      fs.closeSync(fd);
    } catch (error) {
      closeError = error;
    }
    // B-532: `openSync('wx')` already created the file. If the write (or the
    // JSON.stringify feeding it) throws, the `finally` at the call site never
    // sees a handle to dispose, so the 0600 file — possibly a half-written one
    // still carrying the secret — would linger on disk until some LATER run's
    // sweep happened past STALE_FILE_MS, i.e. maybe never. Unlink it on the
    // failing path so a write error can never leak a persistent secret file.
    if (!written) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Nothing to clean up (never created, or already gone).
      }
    } else if (closeError) {
      // The write succeeded, so there is no in-flight error to preserve and the
      // file is kept; a failed close is then the real failure to surface.
      throw closeError;
    }
  }

  let disposed = false;
  return {
    path: filePath,
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Already gone (swept, or the run ended twice) — nothing to do.
      }
    },
  };
}
