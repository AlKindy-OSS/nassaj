// Standalone Terminals feature (T-939). These types mirror the server contract
// verbatim so the client can be built against it before the server ships.

export type TerminalStatus = 'running' | 'exited';

/**
 * A standalone terminal record as returned by the REST list / mutation
 * endpoints and the WS `attached` payload. Named `TerminalSummary` (not
 * `Terminal`) to avoid colliding with xterm's `Terminal` class in view code.
 */
export type TerminalSummary = {
  id: string;
  title: string;
  cwd: string;
  status: TerminalStatus;
  exitCode: number | null;
  // node-pty reports the terminating signal as a number (e.g. 15 = SIGTERM).
  signal: number | null;
  createdAt: string;
  lastActivityAt: string;
  attached: boolean;
  hasInitialCommand: boolean;
};

// ── REST envelopes ────────────────────────────────────────────────────────
export type TerminalListResponse = { terminals: TerminalSummary[] };
export type TerminalMutationResponse = { terminal: TerminalSummary };
export type TerminalErrorResponse = { error: string; code?: string };

export type TerminalCreateInput = {
  title?: string;
  cwd?: string;
  initialCommand?: string;
};

/** A resolved, user-facing create/CRUD error (localized message + server code). */
export type TerminalActionError = {
  code: string;
  message: string;
};

// ── WebSocket (client → server) ───────────────────────────────────────────
export type TerminalInitMessage = {
  type: 'init';
  terminalId: string;
  cols: number;
  rows: number;
};

export type TerminalInputMessage = {
  type: 'input';
  data: string;
};

export type TerminalResizeMessage = {
  type: 'resize';
  cols: number;
  rows: number;
};

export type TerminalOutgoingMessage =
  | TerminalInitMessage
  | TerminalInputMessage
  | TerminalResizeMessage;

// ── WebSocket (server → client) ───────────────────────────────────────────
export type TerminalAttachedMessage = {
  type: 'attached';
  terminal: TerminalSummary;
  truncated?: boolean;
};

export type TerminalOutputMessage = {
  type: 'output';
  data: string;
};

export type TerminalExitedMessage = {
  type: 'exited';
  exitCode: number | null;
  signal: number | null;
};

export type TerminalErrorMessage = {
  type: 'error';
  message?: string;
  code?: string;
};

export type TerminalIncomingMessage =
  | TerminalAttachedMessage
  | TerminalOutputMessage
  | TerminalExitedMessage
  | TerminalErrorMessage
  | { type: string; [key: string]: unknown };

/**
 * Client-side connection state for a single displayed terminal. Drives the
 * overlays/badges in the terminal view:
 * - `superseded` (WS 4409): a newer tab took the attachment.
 * - `serverRestart` (WS 1001): the server cleanly went away.
 * - `notFound` (WS 4404): the terminal id is unknown.
 * - `reconnecting`: an abnormal drop (WS 1006 / keepalive timeout / network)
 *   while attached; the PTY survives server-side, so the client re-attaches
 *   automatically with exponential backoff and replays the buffer on success.
 */
export type TerminalConnectionState =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'attached'
  | 'exited'
  | 'notFound'
  | 'superseded'
  | 'serverRestart'
  | 'error';

export type TerminalExitInfo = {
  exitCode: number | null;
  signal: number | null;
};
