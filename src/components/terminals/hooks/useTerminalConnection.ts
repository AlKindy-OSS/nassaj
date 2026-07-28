import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

// Reuse the shell's terminal building blocks by import only (T-939): options,
// timing, theme and focus styles stay a single source of truth.
import {
  TERMINAL_INIT_DELAY_MS,
  TERMINAL_OPTIONS,
  TERMINAL_RESIZE_DELAY_MS,
} from '../../shell/constants/constants';
import { useTerminalTheme } from '../../shell/hooks/useTerminalTheme';
import { ensureXtermFocusStyles } from '../../shell/utils/terminalStyles';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { getTerminalWebSocketUrl, parseTerminalMessage, sendTerminalMessage } from '../utils/socket';
import {
  MAX_RECONNECT_ATTEMPTS,
  classifyTerminalClose,
  computeBackoffDelay,
  shouldRetryReconnect,
} from '../utils/reconnect';
import type {
  TerminalConnectionState,
  TerminalExitInfo,
  TerminalSummary,
} from '../types/types';

type UseTerminalConnectionArgs = {
  terminalId: string;
  /** Initial status from the list, so an already-exited terminal opens read-only. */
  initialStatus: TerminalSummary['status'];
  isActive: boolean;
  /** Called on `exited` and on a server-restart close, to refetch the REST list. */
  onRequestListRefresh: () => void;
  /** Optional: reconcile the authoritative terminal record on attach. */
  onAttached?: (terminal: TerminalSummary) => void;
};

type UseTerminalConnectionResult = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  state: TerminalConnectionState;
  truncated: boolean;
  exitInfo: TerminalExitInfo | null;
  errorMessage: string | null;
  /** Re-attach after a superseded / server-restart / error state. */
  reconnect: () => void;
};

/**
 * Attaches a single displayed terminal to its server-side PTY over the
 * `/terminal` WebSocket (T-939) and owns the xterm lifecycle. Mounted once per
 * terminal id (the view keys `<TerminalView>` on the id), so switching between
 * terminals disposes this instance and mounts a fresh one — the server keeps
 * every PTY alive regardless.
 *
 * Flow: open WS → `init{terminalId,cols,rows}` → `attached{terminal,truncated}`
 * → ordered replay `output` → live stream. `exited` disables input and refetches
 * the list. Close codes: 4404 (unknown), 4409 (a newer tab won the attachment),
 * 1001/1006 (server shutdown → refetch).
 */
export function useTerminalConnection({
  terminalId,
  initialStatus,
  isActive,
  onRequestListRefresh,
  onAttached,
}: UseTerminalConnectionArgs): UseTerminalConnectionResult {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeTimeoutRef = useRef<number | null>(null);
  // Exponential-backoff re-attach bookkeeping. `reconnectAttemptsRef` counts
  // consecutive failures (reset to 0 on a successful `attached`), and the timer
  // holds the pending retry so unmount / manual reconnect can cancel it.
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  // True while the process is running AND we hold the attachment: gates stdin.
  const canInputRef = useRef(initialStatus === 'running');
  // Bridge stable callbacks into the mount-once effect without re-running it.
  const onRequestListRefreshRef = useRef(onRequestListRefresh);
  const onAttachedRef = useRef(onAttached);
  const reconnectRef = useRef<(() => void) | null>(null);

  const [state, setState] = useState<TerminalConnectionState>('idle');
  const [truncated, setTruncated] = useState(false);
  const [exitInfo, setExitInfo] = useState<TerminalExitInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useTerminalTheme(terminalRef);

  useEffect(() => {
    onRequestListRefreshRef.current = onRequestListRefresh;
    onAttachedRef.current = onAttached;
  }, [onRequestListRefresh, onAttached]);

  const setInputEnabled = useCallback((enabled: boolean) => {
    canInputRef.current = enabled;
    const term = terminalRef.current;
    if (term) {
      term.options.disableStdin = !enabled;
    }
  }, []);

  useEffect(() => {
    ensureXtermFocusStyles();
  }, []);

  // Mount once per terminal id (component is keyed on it).
  useEffect(() => {
    if (!terminalContainerRef.current || terminalRef.current) {
      return;
    }

    const term = new Terminal({ ...TERMINAL_OPTIONS });
    terminalRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    // Intentionally NOT loading WebglAddon — same reason as the shell terminal
    // (see useShellTerminal.ts). The WebGL renderer draws each cell in isolation,
    // so Arabic letters render in their disconnected/reversed isolated forms with
    // no shaping or bidi. xterm's default DOM renderer delegates each same-style
    // run to the browser, which joins the Arabic correctly, while xterm still
    // forces an LTR cell grid so TUI output stays aligned. A deliberate GPU-speed
    // trade-off for an Arabic-first tool. Verified in a real browser on real Arabic.
    term.open(terminalContainerRef.current);
    term.options.disableStdin = initialStatus !== 'running';

    // Copy on Ctrl/Cmd+C when a selection exists; intercept Ctrl/Cmd+V so pasted
    // text is injected via the socket only after the async clipboard read.
    const copySelection = async (): Promise<boolean> => {
      const selection = term.getSelection();
      if (!selection) {
        return false;
      }
      return copyTextToClipboard(selection);
    };

    const handleTerminalCopy = (event: ClipboardEvent) => {
      if (!term.hasSelection()) {
        return;
      }
      const selection = term.getSelection();
      if (!selection) {
        return;
      }
      event.preventDefault();
      if (event.clipboardData) {
        event.clipboardData.setData('text/plain', selection);
        return;
      }
      void copyTextToClipboard(selection);
    };

    terminalContainerRef.current.addEventListener('copy', handleTerminalCopy);

    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key?.toLowerCase() === 'c' &&
        term.hasSelection()
      ) {
        event.preventDefault();
        event.stopPropagation();
        void copySelection();
        return false;
      }

      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key?.toLowerCase() === 'v'
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (canInputRef.current && typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          navigator.clipboard
            .readText()
            .then((text) => {
              sendTerminalMessage(wsRef.current, { type: 'input', data: text });
            })
            .catch(() => {});
        }
        return false;
      }

      return true;
    });

    const dataSubscription = term.onData((data) => {
      if (canInputRef.current) {
        sendTerminalMessage(wsRef.current, { type: 'input', data });
      }
    });

    const sendResize = () => {
      const currentFit = fitAddonRef.current;
      const currentTerm = terminalRef.current;
      if (!currentFit || !currentTerm) {
        return;
      }
      currentFit.fit();
      sendTerminalMessage(wsRef.current, {
        type: 'resize',
        cols: currentTerm.cols,
        rows: currentTerm.rows,
      });
    };

    const closeSocket = () => {
      const socket = wsRef.current;
      // Null the ref BEFORE closing so the socket's async `onclose` sees itself
      // superseded (wsRef.current !== socket) and ignores our own teardown.
      wsRef.current = null;
      if (socket) {
        try {
          socket.close();
        } catch {
          // ignore
        }
      }
    };

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    // Re-attach to the still-alive PTY after an abnormal drop, backing off
    // exponentially. Guarded by a hard attempt cap so a dead endpoint degrades
    // to a manual-retry error state instead of looping forever.
    const scheduleReconnect = () => {
      if (reconnectTimerRef.current !== null) {
        return;
      }
      if (!shouldRetryReconnect(reconnectAttemptsRef.current, MAX_RECONNECT_ATTEMPTS)) {
        reconnectAttemptsRef.current = 0;
        setErrorMessage(null);
        setState('error');
        return;
      }
      const attempt = reconnectAttemptsRef.current;
      reconnectAttemptsRef.current = attempt + 1;
      const delay = computeBackoffDelay(attempt);
      setState('reconnecting');
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        openSocket(true);
      }, delay);
    };

    const openSocket = (isReconnect = false) => {
      const url = getTerminalWebSocketUrl();
      if (!url) {
        setState('error');
        setErrorMessage(null);
        return;
      }

      // Keep the "reconnecting…" affordance (and the existing on-screen output)
      // visible while a re-attach is in flight; a fresh open shows "connecting".
      setState(isReconnect ? 'reconnecting' : 'connecting');

      const socket = new WebSocket(url);
      wsRef.current = socket;

      socket.onopen = () => {
        window.setTimeout(() => {
          const currentFit = fitAddonRef.current;
          const currentTerm = terminalRef.current;
          if (!currentFit || !currentTerm || wsRef.current !== socket) {
            return;
          }
          currentFit.fit();
          sendTerminalMessage(socket, {
            type: 'init',
            terminalId,
            cols: currentTerm.cols,
            rows: currentTerm.rows,
          });
        }, TERMINAL_INIT_DELAY_MS);
      };

      socket.onmessage = (event) => {
        const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '');
        const message = parseTerminalMessage(raw);
        if (!message) {
          return;
        }

        if (message.type === 'attached') {
          // A successful attach clears the backoff. The server always replays
          // its full buffer next, so wipe the pane first: on a re-attach this
          // prevents the replay from being appended below stale output.
          reconnectAttemptsRef.current = 0;
          clearReconnectTimer();
          terminalRef.current?.clear();
          terminalRef.current?.write('\x1b[2J\x1b[H');
          const attachedTerminal = (message as { terminal?: TerminalSummary }).terminal;
          const isTruncated = Boolean((message as { truncated?: boolean }).truncated);
          setTruncated(isTruncated);
          if (attachedTerminal) {
            onAttachedRef.current?.(attachedTerminal);
            if (attachedTerminal.status === 'exited') {
              setInputEnabled(false);
              setExitInfo({ exitCode: attachedTerminal.exitCode, signal: attachedTerminal.signal });
              setState('exited');
              return;
            }
          }
          setInputEnabled(true);
          setState('attached');
          return;
        }

        if (message.type === 'output') {
          const data = typeof (message as { data?: unknown }).data === 'string'
            ? (message as { data: string }).data
            : '';
          terminalRef.current?.write(data);
          return;
        }

        if (message.type === 'exited') {
          const exited = message as { exitCode?: number | null; signal?: number | null };
          setInputEnabled(false);
          setExitInfo({ exitCode: exited.exitCode ?? null, signal: exited.signal ?? null });
          setState('exited');
          onRequestListRefreshRef.current();
          return;
        }

        if (message.type === 'error') {
          const errored = message as { message?: string };
          setErrorMessage(typeof errored.message === 'string' ? errored.message : null);
          setState('error');
        }
      };

      socket.onclose = (event) => {
        // Stale close from a socket we already replaced (unmount / reconnect):
        // a newer socket owns wsRef, so ignore this teardown entirely.
        if (wsRef.current !== socket) {
          return;
        }
        wsRef.current = null;
        setInputEnabled(false);

        // Route by close code. 4409/4404/4403/1001 are final (no auto-loop);
        // any abnormal drop (1006 / keepalive timeout / transient network) is
        // re-attached with backoff — the PTY survives server-side, no kill timer.
        switch (classifyTerminalClose(event.code)) {
          case 'superseded':
            setState('superseded');
            return;
          case 'notFound':
            setState('notFound');
            return;
          case 'forbidden':
            setErrorMessage(null);
            setState('error');
            return;
          case 'serverRestart':
            setState('serverRestart');
            onRequestListRefreshRef.current();
            return;
          case 'reconnect':
          default:
            scheduleReconnect();
        }
      };

      socket.onerror = () => {
        // `onclose` fires next with the real code; avoid double state churn here.
      };
    };

    const reconnect = () => {
      clearReconnectTimer();
      reconnectAttemptsRef.current = 0;
      closeSocket();
      setErrorMessage(null);
      setExitInfo(null);
      setTruncated(false);
      terminalRef.current?.clear();
      terminalRef.current?.write('\x1b[2J\x1b[H');
      openSocket();
    };
    reconnectRef.current = reconnect;

    // A tab that slept (laptop lid / backgrounded) misses pongs and gets culled
    // by the server keepalive; when it returns, re-attach immediately instead of
    // waiting out the backoff timer.
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || reconnectTimerRef.current === null) {
        return;
      }
      clearReconnectTimer();
      openSocket(true);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const initTimer = window.setTimeout(sendResize, TERMINAL_INIT_DELAY_MS);

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = window.setTimeout(sendResize, TERMINAL_RESIZE_DELAY_MS);
    });
    resizeObserver.observe(terminalContainerRef.current);

    openSocket();

    const container = terminalContainerRef.current;
    return () => {
      container?.removeEventListener('copy', handleTerminalCopy);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      clearReconnectTimer();
      reconnectAttemptsRef.current = 0;
      window.clearTimeout(initTimer);
      dataSubscription.dispose();
      closeSocket();
      reconnectRef.current = null;
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // Mount-once per terminal id — the view remounts this hook when the id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // Keep the terminal focused while it is the active view and accepting input.
  useEffect(() => {
    if (!isActive || state !== 'attached') {
      return;
    }
    const focus = () => terminalRef.current?.focus();
    const frame = window.requestAnimationFrame(focus);
    const timer = window.setTimeout(focus, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [isActive, state]);

  const reconnect = useCallback(() => {
    reconnectRef.current?.();
  }, []);

  return {
    terminalContainerRef,
    state,
    truncated,
    exitInfo,
    errorMessage,
    reconnect,
  };
}
