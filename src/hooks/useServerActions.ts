import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import { useWebSocket } from '../contexts/WebSocketContext';

import { refreshRawExecConfig } from './useRawExecConfig';

/** Shape of a single pending action as returned by GET /api/system/pending */
export type PublicAction = {
  id: string;
  actionType: string;
  label: string;
  commandPreview: string | null;
  reason: string | null;
  sessionId: string | null;
  status: 'pending' | 'executing' | 'failed';
  error: string | null;
  requestedAt: string;
};

export type ExecuteOutcome =
  | { status: 'restarting' }
  | { status: 'success' }
  | { status: 'deferred'; reason: string; detail?: string }
  | { status: 'error'; code: string };

export type DismissOutcome =
  | { status: 'dismissed'; id: string }
  | { status: 'error' };

type PendingActionsResponse = {
  actions?: PublicAction[];
};

/**
 * useServerActions — T-944 F1
 *
 * يجلب قائمة طلبات التنفيذ المعلّقة (GET /api/system/pending) ويبقيها حيّة
 * عبر WS 'pending-actions-updated'. يُعيد الجلب أيضاً عند تغيّر hasPendingActions
 * من /health (انعكاس قيمة جديدة من useVersionCheck).
 *
 * النمط: useProjectBoard (استهلاك useWebSocket().latestMessage ثم refetch).
 * العقد الخادمي: راوتر خلف authenticateToken؛ لا cmd/argv في PublicAction.
 */
export function useServerActions(hasPendingActions: boolean) {
  const [actions, setActions] = useState<PublicAction[]>([]);
  const [loading, setLoading] = useState(false);
  const { latestMessage } = useWebSocket();
  const lastMsgRef = useRef<unknown>(null);

  const refetch = useCallback(async () => {
    try {
      setLoading(true);
      const res = await (authenticatedFetch as (url: string) => Promise<Response>)(
        '/api/system/pending',
      );
      if (!res.ok) return;
      const data = (await res.json()) as PendingActionsResponse;
      setActions(data.actions ?? []);
    } catch {
      // Network error — keep previous state, WS reconnect will re-trigger
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch on mount
  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Re-fetch when hasPendingActions becomes true — new action detected via /health poll
  useEffect(() => {
    if (hasPendingActions) {
      void refetch();
    }
  }, [hasPendingActions, refetch]);

  // WS subscription: 'pending-actions-updated' → refetch; reconnect → catch up
  useEffect(() => {
    if (!latestMessage) return;
    if (lastMsgRef.current === latestMessage) return;
    lastMsgRef.current = latestMessage;
    const msg = latestMessage as { type?: string };
    if (
      msg.type === 'pending-actions-updated' ||
      msg.type === 'websocket-reconnected'
    ) {
      void refetch();
      // The server broadcasts this same message on raw insert/dismiss/execute
      // (broadcastPendingActionsUpdated in server/routes/system.js), so it is the
      // live signal for BOTH queues. This hook mounts once, at Sidebar level and
      // inside the WebSocketProvider, which makes it the one place that can push
      // a fresh raw snapshot to consumers that render outside that provider.
      refreshRawExecConfig();
    }
  }, [latestMessage, refetch]);

  /**
   * POST /api/system/pending/:id/execute
   * Returns the outcome for the panel to handle per-item UI state.
   * Network error immediately after POST → likely server is restarting → 'restarting'.
   */
  const execute = useCallback(
    async (id: string): Promise<ExecuteOutcome> => {
      try {
        const res = await (
          authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
        )(`/api/system/pending/${id}/execute`, { method: 'POST' });

        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

        if (!res.ok) {
          return { status: 'error', code: String(data.code ?? 'internal') };
        }

        const s = String(data.status ?? '');
        if (s === 'restarting') return { status: 'restarting' };
        if (s === 'success') {
          void refetch();
          return { status: 'success' };
        }
        if (s === 'deferred') {
          return {
            status: 'deferred',
            reason: String(data.reason ?? ''),
            detail: data.detail !== undefined ? String(data.detail) : undefined,
          };
        }
        return { status: 'error', code: 'internal' };
      } catch {
        // Network error right after POST → server is likely restarting
        return { status: 'restarting' };
      }
    },
    [refetch],
  );

  /**
   * DELETE /api/system/pending/:id — idempotent dismiss.
   * Triggers refetch; WS will also broadcast pending-actions-updated.
   */
  const dismiss = useCallback(
    async (id: string): Promise<DismissOutcome> => {
      try {
        const res = await (
          authenticatedFetch as (url: string, opts?: RequestInit) => Promise<Response>
        )(`/api/system/pending/${id}`, { method: 'DELETE' });
        if (!res.ok) return { status: 'error' };
        void refetch();
        return { status: 'dismissed', id };
      } catch {
        return { status: 'error' };
      }
    },
    [refetch],
  );

  return { actions, loading, execute, dismiss, refetch };
}
