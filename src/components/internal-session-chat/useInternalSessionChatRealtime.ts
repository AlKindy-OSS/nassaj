import { useEffect, useRef } from 'react';

import { IS_PLATFORM } from '../../constants/config';
import { AUTH_TOKEN_STORAGE_KEY } from '../auth/constants';

import type { InternalMessage } from './internalSessionChatApi';

export type InternalChatFrame =
  | { type: 'internal-chat.message.created'; sessionId: string; message: InternalMessage }
  | { type: 'internal-chat.mention-state.changed'; sessionId: string; unreadMentionCount: number }
  | { type: 'internal-chat.membership_revoked'; sessionId: string };

/** Server refusals after which reconnecting cannot succeed (not a member / identity revoked). */
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([4401, 4403, 4404]);

const readStoredToken = (): string | null => {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
};

/**
 * Same rules as the provider socket's buildWebSocketUrl: platform mode and
 * cookie sessions carry no token; otherwise the FRESHEST stored token is used,
 * re-read on every (re)connect so a rotated JWT is never replayed.
 */
export const internalSessionChatSocketUrl = (sessionId: string, token: string | null = readStoredToken()): string => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${protocol}//${window.location.host}/internal-session-chat?sessionId=${encodeURIComponent(sessionId)}`;
  return IS_PLATFORM || !token ? base : `${base}&token=${encodeURIComponent(token)}`;
};

type Options = {
  sessionId: string | null | undefined;
  /** Connect only while the caller holds a room it belongs to. */
  enabled: boolean;
  onFrame: (frame: InternalChatFrame) => void;
  onSnapshot: () => void;
};

/**
 * Dedicated room transport: it never shares the provider's `/ws` socket.
 * Transient drops reconnect with capped backoff; a terminal close (4401/4403/4404)
 * stops reconnecting until the room is opened again.
 */
export function useInternalSessionChatRealtime({ sessionId, enabled, onFrame, onSnapshot }: Options): void {
  const frameRef = useRef(onFrame); frameRef.current = onFrame;
  const snapshotRef = useRef(onSnapshot); snapshotRef.current = onSnapshot;
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let disposed = false;
    let retry: number | null = null;
    let attempts = 0;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(internalSessionChatSocketUrl(sessionId));
      socket.onopen = () => { attempts = 0; void snapshotRef.current(); };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as InternalChatFrame;
          if (frame.sessionId === sessionId) frameRef.current(frame);
        } catch { /* malformed room frame is ignored, never routed to provider */ }
      };
      socket.onclose = (event) => {
        if (disposed || TERMINAL_CLOSE_CODES.has(event.code)) return;
        const delay = Math.min(1_000 * 2 ** attempts, 15_000);
        attempts += 1;
        retry = window.setTimeout(connect, delay);
      };
    };
    connect();
    return () => { disposed = true; if (retry !== null) window.clearTimeout(retry); socket?.close(); };
  }, [enabled, sessionId]);
}
