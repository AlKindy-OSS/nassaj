import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { announceScheduledMessagesChanged } from '../../scheduled-messages/scheduledMessagesEvents';

export type ScheduledMessageStatus = 'pending' | 'running' | 'sent' | 'failed' | 'cancelled';

export interface ScheduledMessage {
  id: string;
  sessionId: string;
  content: string;
  options: Record<string, unknown>;
  scheduledFor: string;
  status: ScheduledMessageStatus;
  attempts: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduledMessagesResponse {
  messages?: ScheduledMessage[];
  message?: ScheduledMessage;
  error?: string;
  messageText?: string;
}

async function readResponse(response: Response): Promise<ScheduledMessagesResponse> {
  return response.json().catch(() => ({})) as Promise<ScheduledMessagesResponse>;
}

function resolveError(response: Response, payload: ScheduledMessagesResponse): string {
  return payload.error || payload.messageText || `HTTP ${response.status}`;
}

/** Session-scoped client for the durable scheduled-message queue. */
export function useScheduledMessages(sessionId: string | null | undefined) {
  const [messages, setMessages] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'load' | 'action' | null>(null);
  const refreshSequence = useRef(0);
  const activeSessionId = useRef(sessionId);
  activeSessionId.current = sessionId;

  const refresh = useCallback(async () => {
    const requestedSessionId = sessionId;
    // A mutation started in the previous conversation can finish after the
    // composer has navigated. Never let its closure repopulate this panel with
    // another session's message contents.
    if (requestedSessionId !== activeSessionId.current) return;
    const sequence = ++refreshSequence.current;
    if (!requestedSessionId) {
      setMessages([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setErrorKind(null);
    try {
      const query = encodeURIComponent(requestedSessionId);
      const responses = await Promise.all([
        authenticatedFetch(`/api/scheduled-messages?sessionId=${query}&status=pending`),
        authenticatedFetch(`/api/scheduled-messages?sessionId=${query}&status=failed`),
      ]);
      const payloads = await Promise.all(responses.map(readResponse));
      const failedIndex = responses.findIndex((response) => !response.ok);
      if (failedIndex >= 0) throw new Error(resolveError(responses[failedIndex], payloads[failedIndex]));
      if (sequence !== refreshSequence.current || requestedSessionId !== activeSessionId.current) return;
      setMessages(
        payloads.flatMap((payload) => payload.messages ?? [])
          .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor)),
      );
    } catch (cause) {
      if (sequence === refreshSequence.current && requestedSessionId === activeSessionId.current) {
        setError(cause instanceof Error ? cause.message : 'request_failed');
        setErrorKind('load');
      }
    } finally {
      if (sequence === refreshSequence.current && requestedSessionId === activeSessionId.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    // Do not display the previous conversation's prompts while the new request
    // is in flight.
    setMessages([]);
    setError(null);
    setErrorKind(null);
    void refresh();
  }, [refresh]);

  const mutate = useCallback(async (
    path: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    body?: Record<string, unknown>,
    id?: string,
  ) => {
    setBusyId(id ?? 'create');
    setError(null);
    setErrorKind(null);
    try {
      const response = await authenticatedFetch(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = response.status === 204 ? {} : await readResponse(response);
      if (!response.ok) throw new Error(resolveError(response, payload));
      announceScheduledMessagesChanged();
      await refresh();
      return payload.message ?? null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'request_failed');
      setErrorKind('action');
      throw cause;
    } finally {
      setBusyId(null);
    }
  }, [refresh]);

  const create = useCallback((content: string, scheduledFor: string, options: Record<string, unknown>) => {
    if (!sessionId) return Promise.reject(new Error('session_required'));
    return mutate('/api/scheduled-messages', 'POST', { sessionId, content, scheduledFor, options });
  }, [mutate, sessionId]);

  const update = useCallback((id: string, content: string, scheduledFor: string) =>
    mutate(`/api/scheduled-messages/${encodeURIComponent(id)}`, 'PATCH', { content, scheduledFor }, id), [mutate]);
  const retry = useCallback((id: string) =>
    mutate(`/api/scheduled-messages/${encodeURIComponent(id)}`, 'PATCH', {}, id), [mutate]);
  const cancel = useCallback((id: string) =>
    mutate(`/api/scheduled-messages/${encodeURIComponent(id)}`, 'DELETE', undefined, id), [mutate]);

  return { messages, loading, busyId, error, errorKind, refresh, create, update, retry, cancel };
}
