/**
 * live-claude-sessions — "does any process still run with this Claude config
 * dir?" (ADR-203 condition 1, T-2003 C2).
 *
 * A repoint of `<CLAUDE_CONFIG_DIR>/skills` is seen instantly by a running Claude
 * session, so it is deferred while one is live. The three launch kinds the ADR
 * names do not share one in-process registry (SDK chat runs, the managed Claude
 * terminal, and `claude -p` started from any shell), but all three run with the
 * user's `CLAUDE_CONFIG_DIR` in their environment. The process table is therefore
 * the one source that covers them all: every process of this uid whose environ
 * names the same config dir counts as a live session (the SDK's CLI child, the
 * terminal shell and anything it started, a scripted `claude -p`).
 *
 * Only environ is read, in memory, and only the one variable is compared; no
 * command line or other variable is logged or returned. Processes of other uids
 * are unreadable (EACCES) and skipped — they cannot run this user's tree anyway.
 *
 * FAIL-CLOSED: if the process table cannot be read at all (no /proc), the answer
 * is "live", so the repoint waits rather than racing a session it cannot see.
 */

import fs from 'node:fs';
import path from 'node:path';

const CONFIG_KEY = 'CLAUDE_CONFIG_DIR=';
/**
 * Process names that can be a Claude session: the native CLI and the Node
 * runtime (SDK child, npm-installed CLI). An idle shell or tmux server that merely
 * inherited the variable is not one, so it does not block a repoint.
 */
const SESSION_COMMS = new Set(['claude', 'node']);

type LiveProbe = (configDir: string) => boolean;

let probeOverride: LiveProbe | null = null;

/** Test seam: replace the probe (null restores the /proc scan). */
export function setLiveClaudeSessionProbeForTest(probe: LiveProbe | null): void {
  probeOverride = probe;
}

function canonical(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * True when /proc/<pid>/exe points at a Claude-capable binary: basename
 * `claude` or `node`, or a native install exec-ed by its versioned path
 * (`…/claude/versions/<ver>`, whose comm is the version string). A ` (deleted)`
 * suffix (binary replaced by an update while running) is ignored.
 */
function isSessionExe(procRoot: string, pid: string): boolean {
  let exe: string;
  try {
    exe = fs.readlinkSync(path.join(procRoot, pid, 'exe')).replace(/ \(deleted\)$/, '');
  } catch {
    return false;
  }
  return SESSION_COMMS.has(path.basename(exe)) || exe.includes('/claude/versions/');
}

/** True when /proc/<pid>/comm is `claude` or `node` (the fallback when exe is unreadable). */
function isSessionComm(procRoot: string, pid: string): boolean {
  try {
    return SESSION_COMMS.has(fs.readFileSync(path.join(procRoot, pid, 'comm'), 'utf8').trim());
  } catch {
    return false;
  }
}

/** A process that can be a Claude session: by its exe, else by its comm. Shells never are. */
function isSessionProcess(procRoot: string, pid: string): boolean {
  return isSessionExe(procRoot, pid) || isSessionComm(procRoot, pid);
}

/** Reads one process's CLAUDE_CONFIG_DIR, or null when absent/unreadable. */
function readConfigDir(procRoot: string, pid: string): string | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(path.join(procRoot, pid, 'environ'));
  } catch {
    return null;
  }
  for (const entry of raw.toString('utf8').split('\0')) {
    if (entry.startsWith(CONFIG_KEY)) return entry.slice(CONFIG_KEY.length);
  }
  return null;
}

/**
 * Scans `procRoot` for Claude-capable processes (exe or comm `claude`/`node`, or a
 * native `…/claude/versions/<ver>` binary; never this server) whose
 * environment carries `CLAUDE_CONFIG_DIR` equal to `configDir`. An unreadable
 * process table answers true (fail-closed).
 *
 * @param configDir the user's Claude config dir
 * @param procRoot process table root (injectable for tests)
 */
export function scanLiveClaudeSessions(configDir: string, procRoot = '/proc'): boolean {
  let pids: string[];
  try {
    pids = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return true;
  }
  const wanted = new Set([path.resolve(configDir), canonical(configDir)]);
  const self = String(process.pid);
  for (const pid of pids) {
    if (pid === self || !isSessionProcess(procRoot, pid)) continue;
    const value = readConfigDir(procRoot, pid);
    if (value && (wanted.has(path.resolve(value)) || wanted.has(canonical(value)))) return true;
  }
  return false;
}

/** True when another live Claude process uses `configDir` (or it cannot be told). */
export function hasLiveClaudeSession(configDir: string): boolean {
  return probeOverride ? probeOverride(configDir) : scanLiveClaudeSessions(configDir);
}
