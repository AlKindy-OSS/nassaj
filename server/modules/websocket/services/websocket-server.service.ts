import type { Server as HttpServer } from 'node:http';

import { WebSocket, WebSocketServer, type VerifyClientCallbackSync } from 'ws';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import { handleTerminalConnection } from '@/modules/websocket/services/terminal-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[2];
  // T-938 (ADR-063): standalone-terminal registry bindings, injected from the
  // composition root so this module never imports server/services internals.
  terminal: Parameters<typeof handleTerminalConnection>[2];
  getPluginPort: Parameters<typeof handlePluginWsProxy>[2];
};

/** WebSocket with keepalive liveness flag + consecutive missed-pong counter. */
type AliveWebSocket = WebSocket & { isAlive: boolean; missedPongs?: number };

/** Ping interval in ms — must stay below Cloudflare Tunnel's 90s idle timeout. */
const PING_INTERVAL_MS = 30_000;

/**
 * How many CONSECUTIVE ping cycles a socket may miss before it is terminated.
 *
 * This was effectively 1: a single unanswered ping killed a live socket with no
 * close code, which the browser reports as a 1006 abnormal close — the "the
 * connection drops for a moment whenever I message the coordinator" symptom.
 * One missed cycle is not evidence of a dead peer here:
 *   • the server is single-threaded and does genuinely synchronous work
 *     (better-sqlite3 is sync, transcripts are parsed inline), so a busy turn can
 *     delay READING a pong that did arrive on time;
 *   • the owner works from a phone, where a backgrounded tab or a sleeping radio
 *     routinely skips one beat.
 * Three cycles (~90s of true silence) still reaps a genuinely dead socket, and
 * costs nothing at the tunnel: the ping keeps flowing every 30s regardless of
 * whether pongs come back, so the 90s idle timeout is never approached.
 */
const MAX_MISSED_PONGS = 3;

/**
 * Creates and wires the server-wide websocket gateway used for chat, shell, and
 * plugin proxy routes.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    verifyClient: ((
      info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0]
    ) => verifyWebSocketClient(info, dependencies.verifyClient)),
  });

  // Keepalive: ping every 30s to prevent Cloudflare Tunnel 90s idle timeout.
  const pingInterval = setInterval(() => {
    wss.clients.forEach((client) => {
      const ws = client as AliveWebSocket;
      const diagUserId = (ws as unknown as { userId?: unknown }).userId ?? null;

      if (ws.isAlive === false) {
        ws.missedPongs = (ws.missedPongs ?? 0) + 1;

        if (ws.missedPongs < MAX_MISSED_PONGS) {
          // Tolerated miss: keep pinging. A busy synchronous turn or a phone that
          // skipped a beat is not a dead peer, and terminating here is what made
          // the connection "drop for a moment" mid-conversation.
          console.log(
            `[WS-DIAG] keepalive-miss userId=${JSON.stringify(diagUserId)} `
            + `readyState=${ws.readyState} missed=${ws.missedPongs}/${MAX_MISSED_PONGS}`
          );
          ws.ping();
          return;
        }

        // [WS-DIAG] Keepalive terminate (point #3). Now only after MAX_MISSED_PONGS
        // consecutive silent cycles (~90s). This is the server-initiated path that
        // drops a socket WITHOUT a close code, surfacing on the client as a 1006
        // abnormal close. If this line precedes a freeze, the keepalive (not the
        // browser/reload) killed the active stream's socket. `userId` is the JWT
        // stamp set by the chat handler; readyState shows the state pre-terminate.
        console.log(
          `[WS-DIAG] keepalive-terminate userId=${JSON.stringify(diagUserId)} `
          + `readyState=${ws.readyState} reason=missed-pong-x${ws.missedPongs} `
          + `silentMs=${ws.missedPongs * PING_INTERVAL_MS}`
        );
        ws.terminate();
        return;
      }

      ws.isAlive = false;
      ws.missedPongs = 0;
      ws.ping();
    });
  }, PING_INTERVAL_MS);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  wss.on('connection', (ws, request) => {
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;
    aliveWs.missedPongs = 0;
    aliveWs.on('pong', () => {
      aliveWs.isAlive = true;
      // A late pong clears the streak: the peer is demonstrably alive, so the
      // earlier misses were latency, not death.
      aliveWs.missedPongs = 0;
    });

    const incomingRequest = request as AuthenticatedWebSocketRequest;
    const url = incomingRequest.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;

    if (pathname === '/shell') {
      handleShellConnection(ws, incomingRequest, dependencies.shell);
      return;
    }

    // T-938 (ADR-063): standalone terminals — attach-only stream. Upgrade auth
    // is the same verifyWebSocketClient gate as every other path.
    if (pathname === '/terminal') {
      handleTerminalConnection(ws, incomingRequest, dependencies.terminal);
      return;
    }

    if (pathname === '/ws') {
      handleChatConnection(ws, incomingRequest, dependencies.chat);
      return;
    }

    if (pathname.startsWith('/plugin-ws/')) {
      handlePluginWsProxy(ws, pathname, dependencies.getPluginPort);
      return;
    }

    console.log('[WARN] Unknown WebSocket path:', pathname);
    ws.close();
  });

  return wss;
}
