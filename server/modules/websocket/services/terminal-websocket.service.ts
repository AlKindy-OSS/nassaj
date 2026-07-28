/**
 * terminal-websocket.service.ts — T-938 (ADR-063): WS `/terminal` attach path
 * for standalone terminals.
 *
 * ATTACH-ONLY by contract: creation, rename, listing and deletion live on REST
 * (`/api/terminals`). This socket only speaks:
 *
 *   client → server: {type:'init', terminalId, cols, rows}
 *                    {type:'input', data}
 *                    {type:'resize', cols, rows}
 *   server → client: {type:'attached', terminal, truncated}
 *                    {type:'output', data}           (replay first, then live)
 *                    {type:'exited', exitCode, signal}
 *                    {type:'error', message, code}
 *
 * Frame order on attach is guaranteed: `attached` → full ordered buffer replay
 * → live stream (single-threaded: the replay snapshot is taken atomically at
 * attach, so no PTY chunk can interleave before it). An exited terminal's
 * replay is sealed with an `exited` frame.
 *
 * Authentication is inherited from verifyWebSocketClient at upgrade time (the
 * shared verifyClient guards EVERY WS path); REQUIRE_TERMINAL_USER below
 * mirrors shell-websocket's REQUIRE_PTY_USER as an explicit, locally auditable
 * fail-closed gate (4401, zero registry access) should that invariant break.
 *
 * Close codes: 4401 unauthenticated, 4404 unknown/foreign terminal (after an
 * `error` frame with code not_found — the same shape as a nonexistent id,
 * never 403), 4409 displaced by a newer attach (newest wins), 1001 going-away
 * (delete/trim — issued by the registry).
 *
 * Dependencies are INJECTED from the composition root (server/index.js), never
 * imported across the module boundary (eslint-plugin-boundaries). The concrete
 * implementation is server/services/standalone-terminals/
 * standalone-terminal-registry.ts, whose exported functions match these
 * signatures structurally.
 */

import { WebSocket, type RawData } from 'ws';

import { readRequestUserId } from '@/modules/websocket/services/chat-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

/**
 * Whether an authenticated userId is mandatory before touching the registry.
 * Same rationale as REQUIRE_PTY_USER in shell-websocket.service.ts: verifyClient
 * already refuses userless upgrades in both platform and OSS modes, so this
 * stays `true` unconditionally — it exists to make the fail-closed gate local
 * and auditable rather than relying on the remote invariant.
 */
const REQUIRE_TERMINAL_USER = true;

/**
 * Terminals are an administrator surface (ADR-063 amend): a shell on the shared
 * host must never be reachable by a regular `user`. These roles mirror the REST
 * `requireRole('owner','admin')` gate on `/api/terminals`; the WS path enforces
 * the SAME gate at init so client-side hiding is never the security boundary.
 */
const TERMINAL_ALLOWED_ROLES: readonly string[] = ['owner', 'admin'];

/** Wire shape of a terminal as serialized by the registry (no userId — ever). */
export type StandaloneTerminalWireObject = {
  id: string;
  title: string;
  cwd: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  signal: number | null;
  createdAt: string;
  lastActivityAt: string;
  attached: boolean;
  hasInitialCommand: boolean;
};

export type TerminalAttachResult = {
  terminal: StandaloneTerminalWireObject;
  truncated: boolean;
  replay: string[];
  displaced: WebSocket | null;
};

export type TerminalInputResult =
  | { outcome: 'written' }
  | { outcome: 'exited'; exitCode: number | null; signal: number | null }
  | { outcome: 'gone' };

type TerminalWebSocketDependencies = {
  /** Binds ws to an OWNED terminal; null for unknown/foreign ids (⇒ 4404). */
  attachSocket: (
    userId: string | number,
    terminalId: string,
    ws: WebSocket
  ) => TerminalAttachResult | null;
  /** Writes input; reports exit state instead of throwing on exited terminals. */
  writeInput: (
    userId: string | number,
    terminalId: string,
    data: string
  ) => TerminalInputResult;
  /** Resizes a running terminal (no-op otherwise). */
  resizeTerminal: (
    userId: string | number,
    terminalId: string,
    cols: unknown,
    rows: unknown
  ) => void;
  /** Releases the binding on disconnect. NEVER kills the PTY (by design). */
  detachSocket: (userId: string | number, terminalId: string, ws: WebSocket) => void;
};

type TerminalIncomingMessage = {
  type?: string;
  terminalId?: string;
  data?: string;
  cols?: number;
  rows?: number;
};

/** Reads a string field from untyped payloads and falls back when absent. */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function sendJson(ws: WebSocket, frame: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}

/**
 * Handles a websocket connection on the `/terminal` path (standalone
 * terminals). One socket may attach to one terminal at a time; a later `init`
 * on the same socket re-targets it (the previous binding is released first so
 * the old terminal's live stream stops flowing here).
 */
export function handleTerminalConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: TerminalWebSocketDependencies
): void {
  console.log('[INFO] Standalone terminal websocket connected');

  const userId = readRequestUserId(request);
  const userRole = (request?.user as { role?: string } | undefined)?.role ?? null;
  let attachedTerminalId: string | null = null;

  ws.on('message', (rawMessage: RawData) => {
    try {
      const data = parseIncomingJsonObject(rawMessage) as TerminalIncomingMessage | null;
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      if (data.type === 'init') {
        // Fail-closed: no authenticated user ⇒ refuse before ANY registry
        // access (no lookup, no attach) — never a shared/anonymous fallback.
        if (REQUIRE_TERMINAL_USER && (userId === null || userId === undefined)) {
          console.error(
            '[ERROR] Terminal WebSocket rejected: missing authenticated userId on init'
          );
          sendJson(ws, {
            type: 'error',
            message: 'Authentication required for terminal session',
            code: 'auth_required',
          });
          ws.close(4401, 'Authentication required');
          return;
        }
        if (userId === null || userId === undefined) {
          // Unreachable while REQUIRE_TERMINAL_USER is true (also narrows the
          // type); kept as an independent guard so the path stays fail-closed
          // even if the flag were ever flipped.
          ws.close(4401, 'Authentication required');
          return;
        }

        // Admin-only surface: a valid but non-privileged user (role 'user') is
        // refused BEFORE any registry access — the terminal is a host shell,
        // never exposed to regular members. Mirrors requireRole('owner','admin')
        // on the REST side; client-side hiding is UX only, not a boundary.
        if (!userRole || !TERMINAL_ALLOWED_ROLES.includes(userRole)) {
          console.error(
            `[ERROR] Terminal WebSocket rejected: role '${userRole ?? 'none'}' not permitted`
          );
          sendJson(ws, {
            type: 'error',
            message: 'Terminal access is restricted to administrators',
            code: 'forbidden',
          });
          ws.close(4403, 'Forbidden');
          return;
        }

        const terminalId = readString(data.terminalId);

        // Re-init on the same socket: release the previous binding first so
        // the old terminal's live output stops flowing into this socket.
        if (attachedTerminalId && attachedTerminalId !== terminalId) {
          dependencies.detachSocket(userId, attachedTerminalId, ws);
          attachedTerminalId = null;
        }

        const attach = dependencies.attachSocket(userId, terminalId, ws);
        if (!attach) {
          // Unknown and foreign ids answer identically (no existence oracle).
          sendJson(ws, { type: 'error', message: 'Terminal not found', code: 'not_found' });
          ws.close(4404, 'Terminal not found');
          return;
        }
        attachedTerminalId = attach.terminal.id;

        // Newest attach wins: the displaced socket is closed with the policy
        // code so its client knows it was superseded (not a network failure).
        if (attach.displaced && attach.displaced !== ws) {
          try {
            attach.displaced.close(4409, 'Terminal attached elsewhere');
          } catch {
            // already closing/closed
          }
        }

        // Contract order: attached → full ordered replay → (exited?) → live.
        // All sends below are synchronous within this handler tick, so no PTY
        // chunk can interleave (the registry snapshot was taken at attach).
        sendJson(ws, { type: 'attached', terminal: attach.terminal, truncated: attach.truncated });
        for (const chunk of attach.replay) {
          sendJson(ws, { type: 'output', data: chunk });
        }
        if (attach.terminal.status === 'exited') {
          sendJson(ws, {
            type: 'exited',
            exitCode: attach.terminal.exitCode,
            signal: attach.terminal.signal,
          });
        } else {
          // Fit the PTY to the client's dimensions AFTER the replay is queued,
          // so any redraw the resize provokes arrives as live stream.
          dependencies.resizeTerminal(userId, terminalId, data.cols, data.rows);
        }
        return;
      }

      if (data.type === 'input') {
        if (userId === null || userId === undefined || !attachedTerminalId) {
          return;
        }
        const result = dependencies.writeInput(
          userId,
          attachedTerminalId,
          readString(data.data)
        );
        // Input on an exited terminal is discarded; re-announce the exit so a
        // client that missed the frame converges (contract: never a throw).
        if (result.outcome === 'exited') {
          sendJson(ws, { type: 'exited', exitCode: result.exitCode, signal: result.signal });
        }
        // 'gone' (deleted concurrently) — the registry already closed this
        // socket with 1001; nothing to do.
        return;
      }

      if (data.type === 'resize') {
        if (userId === null || userId === undefined || !attachedTerminalId) {
          return;
        }
        dependencies.resizeTerminal(userId, attachedTerminalId, data.cols, data.rows);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Terminal WebSocket error:', message);
      if (ws.readyState === WebSocket.OPEN) {
        // Generic frame — internal details never reach the client.
        sendJson(ws, { type: 'error', message: 'Invalid terminal message', code: 'invalid_message' });
      }
    }
  });

  ws.on('close', () => {
    // Release the binding only. The PTY keeps running with NO kill timer —
    // deliberately different from the project shell's 30-minute timeout.
    if (attachedTerminalId && userId !== null && userId !== undefined) {
      dependencies.detachSocket(userId, attachedTerminalId, ws);
      attachedTerminalId = null;
    }
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Terminal WebSocket error:', error);
  });
}
