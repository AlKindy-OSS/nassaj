import { IS_PLATFORM } from '../../../constants/config';
import type { TerminalIncomingMessage, TerminalOutgoingMessage } from '../types/types';

// Dedicated `/terminal` WebSocket URL builder for the standalone terminals
// feature (T-939). Mirrors shell/utils/socket.ts verbatim in the token-passing
// scheme (query `?token=` off-platform, cookie/session on-platform) but targets
// the `/terminal` endpoint. Kept separate so the shell socket helper is never
// touched.
export function getTerminalWebSocketUrl(): string | null {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  if (IS_PLATFORM) {
    return `${protocol}//${window.location.host}/terminal`;
  }

  const token = localStorage.getItem('auth-token');
  if (!token) {
    console.error('No authentication token found for Terminal WebSocket connection');
    return null;
  }

  return `${protocol}//${window.location.host}/terminal?token=${encodeURIComponent(token)}`;
}

export function parseTerminalMessage(payload: string): TerminalIncomingMessage | null {
  try {
    return JSON.parse(payload) as TerminalIncomingMessage;
  } catch {
    return null;
  }
}

export function sendTerminalMessage(ws: WebSocket | null, message: TerminalOutgoingMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
