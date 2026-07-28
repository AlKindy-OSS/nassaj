import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';
import { TERMINAL_INIT_DELAY_MS } from '../constants/constants';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '../utils/socket';
import {
  MAX_RECONNECT_ATTEMPTS,
  computeBackoffDelay,
  isIntentionalShellClose,
  shouldRetryReconnect,
} from '../utils/reconnect';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

type UseShellConnectionOptions = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  /**
   * Optional explicit provider for the PTY init message. When set (e.g. 'agy'),
   * it overrides the default provider resolution so a command-driven plain
   * shell still declares its provider to the backend, which uses it to apply
   * per-user credential isolation (resolveProviderEnv → isolated HOME). Without
   * this, a plain-shell command would report provider 'plain-shell' and skip
   * agy isolation entirely.
   */
  providerOverrideRef?: MutableRefObject<string | null | undefined>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  setAuthUrl: (nextAuthUrl: string) => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  /** True while an abnormal drop is being auto re-attached (backoff in flight). */
  isReconnecting: boolean;
  closeSocket: () => void;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};

export function useShellConnection({
  wsRef,
  terminalRef,
  fitAddonRef,
  selectedProjectRef,
  selectedSessionRef,
  initialCommandRef,
  isPlainShellRef,
  providerOverrideRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  closeSocket,
  clearTerminalScreen,
  setAuthUrl,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const connectingRef = useRef(false);
  const forceRestartOnInitRef = useRef(false);
  const suppressAutoConnectRef = useRef(false);
  // Backoff bookkeeping for auto re-attach after an abnormal drop.
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  // Set for the one connect that follows a drop, so `onopen` knows to wipe the
  // pane before the server replays its buffer (avoids duplicated output).
  const isReconnectAttemptRef = useRef(false);
  // Holds the latest connect fn so the backoff timer never calls a stale closure.
  const connectWebSocketRef = useRef<((locked?: boolean) => void) | null>(null);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'auth_url' || message.type === 'url_open') {
        const nextAuthUrl = typeof message.url === 'string' ? message.url : '';
        if (nextAuthUrl) {
          setAuthUrl(nextAuthUrl);
        }
      }
    },
    [handleProcessCompletion, onOutputRef, setAuthUrl, terminalRef],
  );

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      return;
    }
    if (!shouldRetryReconnect(reconnectAttemptsRef.current, MAX_RECONNECT_ATTEMPTS)) {
      // Give up: drop to the manual connect overlay and stop retrying. Suppress
      // auto-connect so it does not immediately restart the storm; the user's
      // Connect/Restart action re-arms it.
      reconnectAttemptsRef.current = 0;
      suppressAutoConnectRef.current = true;
      isReconnectAttemptRef.current = false;
      setIsReconnecting(false);
      clearTerminalScreen();
      return;
    }

    const attempt = reconnectAttemptsRef.current;
    reconnectAttemptsRef.current = attempt + 1;
    const delay = computeBackoffDelay(attempt);
    setIsReconnecting(true);

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      // Bail if the view was torn down or a deliberate disconnect landed while
      // we were waiting out the backoff.
      if (suppressAutoConnectRef.current || !terminalRef.current) {
        setIsReconnecting(false);
        return;
      }
      // Re-attach (never forceRestart): we want the live PTY, not a fresh shell.
      isReconnectAttemptRef.current = true;
      forceRestartOnInitRef.current = false;
      connectingRef.current = true;
      setIsConnecting(true);
      connectWebSocketRef.current?.(true);
    }, delay);
  }, [clearTerminalScreen, terminalRef]);

  const connectWebSocket = useCallback(
    (isConnectionLocked = false) => {
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      try {
        const wsUrl = getShellWebSocketUrl();
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          return;
        }

        connectingRef.current = true;

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          setIsConnected(true);
          setIsConnecting(false);
          setIsReconnecting(false);
          connectingRef.current = false;
          // A live socket clears the backoff; the next drop starts fresh.
          reconnectAttemptsRef.current = 0;
          clearReconnectTimer();
          setAuthUrl('');

          window.setTimeout(() => {
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            if (!currentTerminal || !currentFitAddon || !currentProject) {
              return;
            }

            // On a re-attach the server replays the whole session buffer, so wipe
            // the pane first (only now that the socket is up, never before) to
            // keep the replay from stacking under the stale output.
            if (isReconnectAttemptRef.current) {
              isReconnectAttemptRef.current = false;
              clearTerminalScreen();
            }

            currentFitAddon.fit();
            const forceRestart = forceRestartOnInitRef.current;
            forceRestartOnInitRef.current = false;

            sendSocketMessage(socket, {
              type: 'init',
              projectPath: currentProject.fullPath || currentProject.path || '',
              sessionId: isPlainShellRef.current ? null : selectedSessionRef.current?.id || null,
              hasSession: isPlainShellRef.current ? false : Boolean(selectedSessionRef.current),
              // An explicit override (e.g. 'agy') always wins, even for a
              // command-driven plain shell: the backend needs the real provider
              // to apply per-user credential isolation. Otherwise fall back to
              // the legacy resolution (plain-shell, then session/localStorage).
              provider:
                providerOverrideRef?.current ||
                (isPlainShellRef.current
                  ? 'plain-shell'
                  : selectedSessionRef.current?.__provider ||
                    localStorage.getItem('selected-provider') ||
                    'claude'),
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
              forceRestart,
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = (event) => {
          // Stale close from a socket we already replaced or deliberately tore
          // down: closeSocket() nulls wsRef before closing, and a reconnect
          // swaps in a new socket — either way this one is no longer current, so
          // ignore its teardown entirely (prevents a spurious reconnect).
          if (wsRef.current !== socket) {
            return;
          }
          wsRef.current = null;
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;

          const intentional = isIntentionalShellClose(
            event.code,
            suppressAutoConnectRef.current,
          );
          const terminalAlive = Boolean(terminalRef.current);

          if (intentional || !terminalAlive) {
            // User-driven disconnect / clean close / unmounted view: stop and
            // wipe, matching the original behaviour.
            setIsReconnecting(false);
            clearReconnectTimer();
            reconnectAttemptsRef.current = 0;
            clearTerminalScreen();
            return;
          }

          // Abnormal drop (1006 keepalive / sleep / transient network) while the
          // terminal is still open: re-attach to the same project/session PTY,
          // which the server keeps alive and whose buffer it replays on init.
          scheduleReconnect();
        };

        socket.onerror = () => {
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
        };
      } catch {
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
        forceRestartOnInitRef.current = false;
      }
    },
    [
      clearReconnectTimer,
      clearTerminalScreen,
      fitAddonRef,
      handleSocketMessage,
      initialCommandRef,
      isConnected,
      isConnecting,
      isPlainShellRef,
      providerOverrideRef,
      scheduleReconnect,
      selectedProjectRef,
      selectedSessionRef,
      setAuthUrl,
      terminalRef,
      wsRef,
    ],
  );

  // Keep the ref pointing at the latest connect fn so the backoff timer, which
  // is scheduled ahead of time, never fires a stale closure.
  useEffect(() => {
    connectWebSocketRef.current = connectWebSocket;
  }, [connectWebSocket]);

  const connectToShell = useCallback((options?: { forceRestart?: boolean }) => {
    if (!isInitialized || isConnected || isConnecting || connectingRef.current) {
      return;
    }

    // A deliberate connect supersedes any pending auto re-attach.
    clearReconnectTimer();
    reconnectAttemptsRef.current = 0;
    isReconnectAttemptRef.current = false;
    setIsReconnecting(false);
    forceRestartOnInitRef.current = Boolean(options?.forceRestart);
    suppressAutoConnectRef.current = false;
    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true);
  }, [clearReconnectTimer, connectWebSocket, isConnected, isConnecting, isInitialized]);

  const disconnectFromShell = useCallback((options?: { suppressAutoConnect?: boolean }) => {
    if (options?.suppressAutoConnect) {
      suppressAutoConnectRef.current = true;
    }

    // A deliberate disconnect cancels any in-flight auto re-attach.
    clearReconnectTimer();
    reconnectAttemptsRef.current = 0;
    isReconnectAttemptRef.current = false;
    setIsReconnecting(false);
    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    connectingRef.current = false;
    forceRestartOnInitRef.current = false;
    setAuthUrl('');
  }, [clearReconnectTimer, clearTerminalScreen, closeSocket, setAuthUrl]);

  useEffect(() => {
    if (
      !autoConnect ||
      suppressAutoConnectRef.current ||
      !isInitialized ||
      isConnecting ||
      isConnected ||
      // A backoff cycle owns the connection lifecycle; don't race it.
      isReconnecting
    ) {
      return;
    }

    connectToShell();
  }, [autoConnect, connectToShell, isConnected, isConnecting, isInitialized, isReconnecting]);

  // Cancel any pending re-attach when the hook unmounts.
  useEffect(() => clearReconnectTimer, [clearReconnectTimer]);

  return {
    isConnected,
    isConnecting,
    isReconnecting,
    closeSocket,
    connectToShell,
    disconnectFromShell,
  };
}
