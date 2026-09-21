import { useCallback, useEffect, useRef, useState } from 'react';

const MESSAGE_FORK_TIMEOUT_MS = 30_000;

type SendResult = { ok: boolean; reason?: string } | void;

type MessageForkFrame = {
  type?: string;
  requestId?: string;
  forkedSessionId?: string;
  code?: string;
  message?: string;
};

type ForkRequest = {
  requestId: string;
  sessionId: string;
  upToMessageId: string;
  retryRegistrationOnly?: true;
  expectedForkedSessionId?: string;
};

type UseMessageForkArgs = {
  sessionId: string | null;
  latestMessage: MessageForkFrame | null;
  sendMessage: (message: unknown) => SendResult;
  onForked: (sessionId: string) => void;
  onError: (code: string, message?: string) => void;
};

function createRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through for older/insecure browser contexts.
  }
  return `message-fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Correlates a reply-level transcript fork with its WS terminal frame.
 *
 * The server owns transcript selection; the client only passes the explicit
 * transcript UUID it received with the rendered assistant message.
 */
export function useMessageFork({
  sessionId,
  latestMessage,
  sendMessage,
  onForked,
  onError,
}: UseMessageForkArgs) {
  const [isForking, setIsForking] = useState(false);
  const pendingRequestRef = useRef<ForkRequest | null>(null);
  const registrationRetriesRef = useRef(new Map<string, ForkRequest>());
  const currentSessionRef = useRef(sessionId);
  currentSessionRef.current = sessionId;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFrameRef = useRef<MessageForkFrame | null>(null);
  const onForkedRef = useRef(onForked);
  const onErrorRef = useRef(onError);
  onForkedRef.current = onForked;
  onErrorRef.current = onError;

  const clearPending = useCallback(() => {
    pendingRequestRef.current = null;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsForking(false);
  }, []);

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  // A completion from the conversation we left must never navigate the new
  // conversation. No pending request is automatically resent on navigation.
  useEffect(() => { clearPending(); }, [sessionId, clearPending]);

  const forkFromMessage = useCallback((upToMessageId: string) => {
    const normalizedMessageId = upToMessageId.trim();
    if (!sessionId || !normalizedMessageId || pendingRequestRef.current) {
      if (!pendingRequestRef.current) onErrorRef.current('invalid_request');
      return;
    }

    const key = JSON.stringify([sessionId, normalizedMessageId]);
    const request = registrationRetriesRef.current.get(key)
      ?? { requestId: createRequestId(), sessionId, upToMessageId: normalizedMessageId };
    const { requestId } = request;
    pendingRequestRef.current = request;
    setIsForking(true);
    let result: SendResult;
    try { result = sendMessage({ type: 'message-fork', ...request }); }
    catch {
      clearPending();
      onErrorRef.current('outcome_unknown');
      return;
    }
    if (result && result.ok === false) {
      clearPending();
      onErrorRef.current(result.reason === 'disconnected' ? 'disconnected' : 'fork_failed');
      return;
    }
    timeoutRef.current = setTimeout(() => {
      if (pendingRequestRef.current?.requestId !== requestId) return;
      clearPending();
      onErrorRef.current('timeout');
    }, MESSAGE_FORK_TIMEOUT_MS);
  }, [clearPending, sendMessage, sessionId]);

  useEffect(() => {
    if (!latestMessage || latestMessage === lastFrameRef.current) return;
    lastFrameRef.current = latestMessage;
    if (latestMessage.type !== 'message-forked' && latestMessage.type !== 'message-fork-error') return;
    const request = pendingRequestRef.current;
    if (!request || request.sessionId !== currentSessionRef.current
      || !latestMessage.requestId || latestMessage.requestId !== request.requestId) return;

    const forkedSessionId = latestMessage.forkedSessionId;
    const errorCode = typeof latestMessage.code === 'string' && latestMessage.code
      ? latestMessage.code
      : 'fork_failed';
    const errorMessage = typeof latestMessage.message === 'string' ? latestMessage.message : undefined;
    const key = JSON.stringify([request.sessionId, request.upToMessageId]);
    if (latestMessage.type === 'message-fork-error' && errorCode === 'registration_failed'
      && typeof forkedSessionId === 'string' && forkedSessionId.trim()) {
      // An explicit retry may register only the known target. The server must
      // reject missing/expired evidence instead of creating another branch.
      registrationRetriesRef.current.set(key, {
        ...request, retryRegistrationOnly: true, expectedForkedSessionId: forkedSessionId,
      });
    }
    clearPending();
    if (latestMessage.type === 'message-forked' && typeof forkedSessionId === 'string' && forkedSessionId) {
      registrationRetriesRef.current.delete(key);
      onForkedRef.current(forkedSessionId);
      return;
    }
    const missingResult = latestMessage.type === 'message-forked'
      || (errorCode === 'registration_failed' && !(typeof forkedSessionId === 'string' && forkedSessionId.trim()));
    onErrorRef.current(missingResult ? 'outcome_unknown' : errorCode, errorMessage);
  }, [clearPending, latestMessage]);

  return { forkFromMessage, isForking };
}
