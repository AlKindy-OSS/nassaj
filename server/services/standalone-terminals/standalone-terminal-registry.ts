/**
 * standalone-terminal-registry.ts — T-938 (ADR-063): in-memory registry backing
 * the "standalone terminals" feature.
 *
 * Standalone terminals are PTY sessions that belong to a USER, not to a project
 * or chat session:
 *
 *   - Created over REST (POST /api/terminals). The PTY spawns IMMEDIATELY —
 *     before any websocket attaches — and its output accumulates in a bounded
 *     replay buffer so a later attach renders the full history.
 *   - Attached over WS /terminal (terminal-websocket.service.ts). At most ONE
 *     attached socket per terminal; the newest attach wins and the WS layer
 *     closes the displaced socket with 4409.
 *   - A websocket disconnect NEVER kills the PTY and starts NO kill timer —
 *     deliberately different from the project shell terminal's 30-minute
 *     PTY_SESSION_TIMEOUT (shell-websocket.service.ts). The process runs until
 *     it exits on its own or the owner deletes the terminal.
 *   - Exited terminals stay listed (with their buffer) until deleted, capped at
 *     MAX_EXITED_PER_USER with oldest-first trimming.
 *   - A server restart loses every terminal (by design; no persistence).
 *
 * SECURITY (mirrors shell-websocket.service.ts):
 *   - Per-user ownership from the JWT. Every lookup takes the caller's userId
 *     and misses for a foreign terminal, so REST/WS callers answer 404 — the
 *     same shape as "does not exist", never 403 (no existence oracle).
 *   - `userId` is NEVER serialized to the client (see toWire).
 *   - Spawn env passes through the SAME three seams as the project shell PTY:
 *     resolveProviderEnv(userId, 'claude', process.env) →
 *     prioritizeUserNpmGlobalBin(isolatedEnv, cwd) → resolveCagedLaunch
 *     (B-MU-PTY-ENV / B-90 / T-897).
 *   - cwd validation is fail-indistinguishable: a nonexistent path and a KNOWN
 *     private project the user cannot see return the SAME frozen `invalid_cwd`
 *     failure object (no membership probe via terminal creation).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import pty, { type IPty } from 'node-pty';
import type { WebSocket } from 'ws';

// Namespace import (not `import { projectsDb }`): unit tests module-mock this
// barrel with only the subset they exercise; a namespace binding tolerates a
// member a mock omits (same rationale as chat-websocket.service.ts).
import * as databaseModule from '@/modules/database/index.js';
import { prioritizeUserNpmGlobalBin } from '@/modules/websocket/services/shell-websocket.service.js';
import { resolveCagedLaunch } from '@/services/isolation/provider-cage-wiring.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';

// ── Constants (ADR-063) ──────────────────────────────────────────────────────

export const MAX_RUNNING_PER_USER = 5;
export const MAX_EXITED_PER_USER = 10;
export const BUFFER_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB replay buffer per terminal
export const TITLE_MAX = 64;
export const CMD_MAX = 4096;

/** ws.readyState OPEN — literal to avoid a runtime dependency on the ws pkg. */
const WS_OPEN = 1;

// ── Types ────────────────────────────────────────────────────────────────────

export type StandaloneTerminalStatus = 'running' | 'exited';

type StandaloneTerminalEntry = {
  id: string; // "term_" + uuid v4
  userId: number; // ownership key — NEVER serialized to the client
  title: string; // 1..64 after trim
  cwd: string; // absolute, exists as a directory, visibility-checked
  initialCommand: string | null; // ≤ CMD_MAX
  pty: IPty | null; // null once exited
  status: StandaloneTerminalStatus;
  exitCode: number | null;
  signal: number | null;
  ws: WebSocket | null; // at most one attached socket
  buffer: string[];
  bufferBytes: number; // capped at BUFFER_MAX_BYTES, head-dropped
  truncated: boolean; // true once any head chunk was dropped
  createdAt: string; // ISO
  lastActivityAt: string; // ISO
  seq: number; // monotonic creation order (stable same-ms sort key)
};

/** Wire object — the ONLY terminal shape the client ever sees. No userId. */
export type StandaloneTerminalWire = {
  id: string;
  title: string;
  cwd: string;
  status: StandaloneTerminalStatus;
  exitCode: number | null;
  signal: number | null;
  createdAt: string;
  lastActivityAt: string;
  attached: boolean;
  hasInitialCommand: boolean;
};

export type StandaloneTerminalFailure = {
  ok: false;
  status: 400 | 404 | 409;
  code:
    | 'invalid_title'
    | 'invalid_cwd'
    | 'invalid_initial_command'
    | 'terminal_limit_reached'
    | 'not_found';
  error: string;
};

export type StandaloneTerminalSuccess = { ok: true; terminal: StandaloneTerminalWire };

export type CreateStandaloneTerminalInput = {
  userId: number;
  title?: unknown;
  cwd?: unknown;
  initialCommand?: unknown;
};

/** Result of binding a websocket to a terminal (WS init). */
export type StandaloneTerminalAttachResult = {
  terminal: StandaloneTerminalWire;
  truncated: boolean;
  replay: string[]; // full ordered buffer snapshot taken atomically at attach
  displaced: WebSocket | null; // previously attached socket (caller closes 4409)
};

export type StandaloneTerminalInputResult =
  | { outcome: 'written' }
  | { outcome: 'exited'; exitCode: number | null; signal: number | null }
  | { outcome: 'gone' };

// ── State ────────────────────────────────────────────────────────────────────

const terminals = new Map<string, StandaloneTerminalEntry>();
let nextSeq = 0;

// ── Shared failure objects ───────────────────────────────────────────────────

// SINGLE frozen object for EVERY cwd rejection (nonexistent path, relative
// path, non-string, or a known private project invisible to the caller) so the
// two security-relevant cases are structurally indistinguishable — same status,
// same code, same message, same identity.
const INVALID_CWD: StandaloneTerminalFailure = Object.freeze({
  ok: false,
  status: 400,
  code: 'invalid_cwd',
  error: 'Invalid working directory',
});

const INVALID_TITLE: StandaloneTerminalFailure = Object.freeze({
  ok: false,
  status: 400,
  code: 'invalid_title',
  error: `Title must be a string of 1-${TITLE_MAX} characters`,
});

const INVALID_INITIAL_COMMAND: StandaloneTerminalFailure = Object.freeze({
  ok: false,
  status: 400,
  code: 'invalid_initial_command',
  error: `Initial command must be a string of at most ${CMD_MAX} characters`,
});

const LIMIT_REACHED: StandaloneTerminalFailure = Object.freeze({
  ok: false,
  status: 409,
  code: 'terminal_limit_reached',
  error: `Terminal limit reached (${MAX_RUNNING_PER_USER} running)`,
});

const NOT_FOUND: StandaloneTerminalFailure = Object.freeze({
  ok: false,
  status: 404,
  code: 'not_found',
  error: 'Terminal not found',
});

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Ownership predicate. Fail-closed: a nullish caller id never matches anything
 * (upstream guards — authenticateToken on REST, the 4401 gate on WS — should
 * make that unreachable, but the registry never trusts them). String-normalized
 * compare because the JWT layer may surface the id as number or string.
 */
function isOwnedBy(entry: StandaloneTerminalEntry, userId: string | number): boolean {
  if (userId === null || userId === undefined || userId === '') {
    return false;
  }
  return String(entry.userId) === String(userId);
}

/** Looks up a terminal the caller owns; foreign and unknown ids both miss. */
function findOwned(
  userId: string | number,
  terminalId: string
): StandaloneTerminalEntry | null {
  const entry = terminals.get(terminalId);
  if (!entry || !isOwnedBy(entry, userId)) {
    return null;
  }
  return entry;
}

function entriesForUser(userId: string | number): StandaloneTerminalEntry[] {
  return [...terminals.values()]
    .filter((entry) => isOwnedBy(entry, userId))
    .sort((a, b) => a.seq - b.seq);
}

function runningCountForUser(userId: string | number): number {
  return entriesForUser(userId).filter((entry) => entry.status === 'running').length;
}

/** Serializes an entry for the client. `userId` is deliberately absent. */
function toWire(entry: StandaloneTerminalEntry): StandaloneTerminalWire {
  return {
    id: entry.id,
    title: entry.title,
    cwd: entry.cwd,
    status: entry.status,
    exitCode: entry.exitCode,
    signal: entry.signal,
    createdAt: entry.createdAt,
    lastActivityAt: entry.lastActivityAt,
    attached: entry.ws !== null,
    hasInitialCommand: entry.initialCommand !== null,
  };
}

function sendFrame(ws: WebSocket | null, frame: Record<string, unknown>): void {
  if (ws && ws.readyState === WS_OPEN) {
    try {
      ws.send(JSON.stringify(frame));
    } catch (error) {
      console.error(
        '[ERROR] Standalone terminal frame send failed:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

/** Closes a socket defensively (used for delete/trim going-away closes). */
function closeSocket(ws: WebSocket | null, code: number, reason: string): void {
  if (!ws) {
    return;
  }
  try {
    ws.close(code, reason);
  } catch {
    // already closing/closed — nothing to do
  }
}

/**
 * Appends a PTY chunk to the replay buffer, enforcing the 2 MiB byte cap by
 * dropping whole chunks from the HEAD (oldest output first) and latching the
 * `truncated` flag. The newest chunk is always retained.
 */
function appendToBuffer(entry: StandaloneTerminalEntry, chunk: string): void {
  entry.buffer.push(chunk);
  entry.bufferBytes += Buffer.byteLength(chunk, 'utf8');
  while (entry.bufferBytes > BUFFER_MAX_BYTES && entry.buffer.length > 1) {
    const dropped = entry.buffer.shift() as string;
    entry.bufferBytes -= Buffer.byteLength(dropped, 'utf8');
    entry.truncated = true;
  }
}

/**
 * Caps stored exited terminals per user at MAX_EXITED_PER_USER by removing the
 * OLDEST exited entries. A trimmed terminal that still has a viewer attached
 * gets a going-away close (1001) — the terminal ceased to exist.
 */
function trimExitedForUser(userId: number): void {
  const exited = entriesForUser(userId).filter((entry) => entry.status === 'exited');
  while (exited.length > MAX_EXITED_PER_USER) {
    const oldest = exited.shift() as StandaloneTerminalEntry;
    closeSocket(oldest.ws, 1001, 'Terminal removed');
    oldest.ws = null;
    terminals.delete(oldest.id);
  }
}

/**
 * cwd visibility gate — same semantics as isProjectPathVisibleToUser in
 * chat-websocket.service.ts (re-implemented on the database barrel to keep this
 * service outside the websocket module graph): an UNREGISTERED directory is
 * allowed (matches the project shell's creation/first-run rule); a REGISTERED
 * project must be visible to the caller. The caller maps a refusal onto the
 * same INVALID_CWD failure as a nonexistent path (indistinguishable).
 */
function isCwdVisibleToUser(cwd: string, userId: string | number): boolean {
  const projectRow = databaseModule.projectsDb.getProjectPath(cwd);
  if (!projectRow) {
    return true;
  }

  const numericUserId =
    typeof userId === 'number'
      ? userId
      : typeof userId === 'string' && userId.trim() !== ''
        ? Number.parseInt(userId, 10)
        : null;

  return databaseModule.projectsDb.isProjectVisibleToUser(
    projectRow.project_id,
    Number.isInteger(numericUserId) ? (numericUserId as number) : null
  );
}

/** Clamps a resize dimension to a sane integer range, with a fallback. */
function clampDimension(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.min(1024, Math.floor(numeric)));
}

// ── REST-facing API ──────────────────────────────────────────────────────────

/**
 * Creates a standalone terminal and spawns its PTY immediately (before any
 * websocket attaches). Output produced from this instant accumulates in the
 * replay buffer.
 *
 * Validation (contract T-938): title 1..64 after trim (server fallback
 * "Terminal <n>" when absent), cwd absolute + existing directory + visible
 * (default $HOME), initialCommand ≤ 4096 chars. Limit: MAX_RUNNING_PER_USER
 * running terminals per user (409).
 */
export function createStandaloneTerminal(
  input: CreateStandaloneTerminalInput
): StandaloneTerminalSuccess | StandaloneTerminalFailure {
  const { userId } = input;

  // title — absent ⇒ English server fallback (the client sends localized ones).
  let title: string;
  if (input.title === undefined || input.title === null) {
    title = `Terminal ${entriesForUser(userId).length + 1}`;
  } else if (typeof input.title !== 'string') {
    return INVALID_TITLE;
  } else {
    const trimmed = input.title.trim();
    if (trimmed.length < 1 || trimmed.length > TITLE_MAX) {
      return INVALID_TITLE;
    }
    title = trimmed;
  }

  // cwd — every rejection path returns the SAME frozen INVALID_CWD object.
  let cwd: string;
  if (input.cwd === undefined || input.cwd === null) {
    cwd = os.homedir();
  } else if (typeof input.cwd !== 'string' || input.cwd.trim() === '') {
    return INVALID_CWD;
  } else {
    const trimmed = input.cwd.trim();
    if (!path.isAbsolute(trimmed)) {
      return INVALID_CWD;
    }
    cwd = path.resolve(trimmed);
  }
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      return INVALID_CWD;
    }
  } catch {
    return INVALID_CWD;
  }
  if (!isCwdVisibleToUser(cwd, userId)) {
    return INVALID_CWD;
  }

  // initialCommand — empty/whitespace-only collapses to null (plain shell).
  let initialCommand: string | null;
  if (input.initialCommand === undefined || input.initialCommand === null) {
    initialCommand = null;
  } else if (typeof input.initialCommand !== 'string') {
    return INVALID_INITIAL_COMMAND;
  } else if (input.initialCommand.length > CMD_MAX) {
    return INVALID_INITIAL_COMMAND;
  } else {
    initialCommand = input.initialCommand.trim() === '' ? null : input.initialCommand;
  }

  if (runningCountForUser(userId) >= MAX_RUNNING_PER_USER) {
    return LIMIT_REACHED;
  }

  // B-MU-PTY-ENV: per-user isolated credential env via the central seam — the
  // same resolver and provider key ('claude') as the project shell PTY.
  const isolatedEnv = resolveProviderEnv(userId, 'claude', process.env);

  // B-90: hoist the user's npm-global binaries to the front of PATH, deriving
  // every candidate from the ISOLATED env so per-user isolation is preserved.
  const prioritizedPath = prioritizeUserNpmGlobalBin(isolatedEnv, cwd);

  // Interactive login shell by default; `bash -c <cmd>` when a command was
  // given (argv array — the command string is never shell-interpolated here).
  const shellArgs = initialCommand === null ? ['-l'] : ['-c', initialCommand];

  // T-897: route the launch through the provider cage (default OFF ⇒ returned
  // unchanged), exactly like the project shell PTY.
  const ptyLaunch = resolveCagedLaunch({
    userId,
    provider: 'claude',
    cmd: 'bash',
    args: shellArgs,
    cwd,
  });

  const nowIso = new Date().toISOString();
  const entry: StandaloneTerminalEntry = {
    id: `term_${randomUUID()}`,
    userId,
    title,
    cwd,
    initialCommand,
    pty: null,
    status: 'running',
    exitCode: null,
    signal: null,
    ws: null,
    buffer: [],
    bufferBytes: 0,
    truncated: false,
    createdAt: nowIso,
    lastActivityAt: nowIso,
    seq: nextSeq++,
  };

  const child = pty.spawn(ptyLaunch.cmd, ptyLaunch.args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: {
      ...isolatedEnv,
      [prioritizedPath.key]: prioritizedPath.value,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '3',
    },
  });
  entry.pty = child;
  terminals.set(entry.id, entry);

  child.onData((chunk) => {
    appendToBuffer(entry, chunk);
    entry.lastActivityAt = new Date().toISOString();
    sendFrame(entry.ws, { type: 'output', data: chunk });
  });

  child.onExit(({ exitCode, signal }) => {
    entry.status = 'exited';
    entry.exitCode = typeof exitCode === 'number' ? exitCode : null;
    entry.signal = typeof signal === 'number' ? signal : null;
    entry.pty = null;
    entry.lastActivityAt = new Date().toISOString();
    // The record (and its buffer) stays until deleted or trimmed; an attached
    // viewer is told immediately.
    sendFrame(entry.ws, { type: 'exited', exitCode: entry.exitCode, signal: entry.signal });
    trimExitedForUser(entry.userId);
  });

  return { ok: true, terminal: toWire(entry) };
}

/** Lists the caller's terminals, createdAt ascending (stable via seq). */
export function listStandaloneTerminals(userId: string | number): StandaloneTerminalWire[] {
  return entriesForUser(userId).map(toWire);
}

/** Renames an owned terminal. Foreign/unknown ids both answer not_found. */
export function renameStandaloneTerminal(
  userId: string | number,
  terminalId: string,
  titleInput: unknown
): StandaloneTerminalSuccess | StandaloneTerminalFailure {
  const entry = findOwned(userId, terminalId);
  if (!entry) {
    return NOT_FOUND;
  }
  if (typeof titleInput !== 'string') {
    return INVALID_TITLE;
  }
  const trimmed = titleInput.trim();
  if (trimmed.length < 1 || trimmed.length > TITLE_MAX) {
    return INVALID_TITLE;
  }
  entry.title = trimmed;
  return { ok: true, terminal: toWire(entry) };
}

/**
 * Deletes an owned terminal: kills a live PTY, closes any attached socket with
 * a going-away code, and drops the record (buffer included). Returns false for
 * foreign/unknown ids (caller answers 404).
 */
export function deleteStandaloneTerminal(userId: string | number, terminalId: string): boolean {
  const entry = findOwned(userId, terminalId);
  if (!entry) {
    return false;
  }
  if (entry.pty) {
    try {
      entry.pty.kill();
    } catch {
      // already dead — deletion proceeds regardless
    }
    entry.pty = null;
  }
  closeSocket(entry.ws, 1001, 'Terminal deleted');
  entry.ws = null;
  terminals.delete(entry.id);
  return true;
}

// ── WS-facing API (injected into terminal-websocket.service.ts) ─────────────

/**
 * Binds `ws` as the terminal's (single) attached socket and returns everything
 * the WS layer needs to honor the frame order `attached → replay → live`:
 * the wire object, the truncated flag, an atomic buffer snapshot, and the
 * previously attached socket (newest-wins; the caller closes it with 4409).
 *
 * Returns null for unknown/foreign ids — caller answers not_found + 4404.
 */
export function attachStandaloneTerminalSocket(
  userId: string | number,
  terminalId: string,
  ws: WebSocket
): StandaloneTerminalAttachResult | null {
  const entry = findOwned(userId, terminalId);
  if (!entry) {
    return null;
  }
  const displaced = entry.ws !== null && entry.ws !== ws ? entry.ws : null;
  entry.ws = ws;
  return {
    terminal: toWire(entry),
    truncated: entry.truncated,
    replay: [...entry.buffer],
    displaced,
  };
}

/**
 * Writes user keystrokes to an owned running terminal. On an exited terminal
 * the input is DISCARDED and the exit state is reported back so the WS layer
 * can re-send the `exited` frame (never a throw).
 */
export function writeStandaloneTerminalInput(
  userId: string | number,
  terminalId: string,
  data: string
): StandaloneTerminalInputResult {
  const entry = findOwned(userId, terminalId);
  if (!entry) {
    return { outcome: 'gone' };
  }
  if (entry.status === 'exited' || !entry.pty) {
    return { outcome: 'exited', exitCode: entry.exitCode, signal: entry.signal };
  }
  entry.pty.write(typeof data === 'string' ? data : '');
  entry.lastActivityAt = new Date().toISOString();
  return { outcome: 'written' };
}

/** Resizes an owned running terminal (no-op for exited/unknown/foreign). */
export function resizeStandaloneTerminal(
  userId: string | number,
  terminalId: string,
  cols: unknown,
  rows: unknown
): void {
  const entry = findOwned(userId, terminalId);
  if (!entry || !entry.pty || entry.status !== 'running') {
    return;
  }
  entry.pty.resize(clampDimension(cols, 80), clampDimension(rows, 24));
}

/**
 * Releases the socket binding when a client disconnects. The PTY keeps running
 * with NO kill timer — output keeps accumulating in the buffer for the next
 * attach. Only the socket that is actually bound is released (a displaced
 * socket's late close must not detach its successor).
 */
export function detachStandaloneTerminalSocket(
  userId: string | number,
  terminalId: string,
  ws: WebSocket
): void {
  const entry = findOwned(userId, terminalId);
  if (entry && entry.ws === ws) {
    entry.ws = null;
  }
}

// ── Test seam ────────────────────────────────────────────────────────────────

/** Kills and clears every terminal. TEST-ONLY (suite isolation). */
export function resetStandaloneTerminalsForTest(): void {
  for (const entry of terminals.values()) {
    if (entry.pty) {
      try {
        entry.pty.kill();
      } catch {
        // ignore — teardown
      }
    }
    closeSocket(entry.ws, 1001, 'Server shutting down');
    entry.ws = null;
  }
  terminals.clear();
  nextSeq = 0;
}
