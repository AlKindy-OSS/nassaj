import type { MutableRefObject, RefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';

export type AuthCopyStatus = 'idle' | 'copied' | 'failed';

export type ShellInitMessage = {
  type: 'init';
  projectPath: string;
  sessionId: string | null;
  hasSession: boolean;
  provider: string;
  cols: number;
  rows: number;
  initialCommand: string | null | undefined;
  isPlainShell: boolean;
  forceRestart?: boolean;
  /**
   * T-2037: binds the init to ONE composer-submitted one-shot run. The server
   * launches a runId at most once; every later init with the same id only
   * re-attaches (or reports the run finished). A one-shot init never carries
   * forceRestart.
   */
  runId?: string;
  /** T-2037: marks a composer one-shot for the server's audit and gate. */
  origin?: 'composer_shell';
  /**
   * T-2037: re-attach only — never launch. Set on every one-shot init except
   * the single launching one, which alone carries initialCommand.
   */
  attachOnly?: true;
};

/** T-2037: asks the server for the captured output of a one-shot run. */
export type ShellOneShotCaptureRequest = {
  type: 'oneshot_capture';
  runId: string;
};

export type ShellResizeMessage = {
  type: 'resize';
  cols: number;
  rows: number;
};

export type ShellInputMessage = {
  type: 'input';
  data: string;
};

export type ShellOutgoingMessage =
  | ShellInitMessage
  | ShellResizeMessage
  | ShellInputMessage
  | ShellOneShotCaptureRequest;

/** T-2037: server frames that belong to a one-shot run (never to a session shell). */
export type OneShotFrame =
  | {
      type: 'oneshot_finished';
      runId: string;
      /** Only a number is a real exit; null never means success. */
      exitCode: number | null;
      /** Cut short (e.g. a server restart): completion is unknown. */
      interrupted?: true;
      /** The server has no record of running it in this session. */
      unknown?: true;
      /** Refused and never executed. */
      refused?: true;
    }
  | {
      type: 'oneshot_capture';
      runId: string;
      text: string;
      truncated: boolean;
      exitCode: number | null;
    }
  /** The capture could not be served; the run and socket are unaffected. */
  | { type: 'oneshot_capture_unavailable'; runId: string };

export type ShellIncomingMessage =
  | { type: 'output'; data: string }
  | { type: 'auth_url'; url?: string }
  | { type: 'url_open'; url?: string }
  // The server refuses a shell for six distinct reasons and says so in this
  // frame; `code` is the machine-readable reason (e.g. 'update_maintenance_active')
  // and is optional so an older server that only sends `message` still works.
  | { type: 'error'; message?: string; code?: string }
  | { type: string; [key: string]: unknown };

/** A server-side refusal surfaced to the consumer, not a process exit. */
export type ShellErrorInfo = {
  message: string;
  code: string | null;
};

export type UseShellRuntimeOptions = {
  selectedProject: Project | null | undefined;
  selectedSession: ProjectSession | null | undefined;
  initialCommand: string | null | undefined;
  isPlainShell: boolean;
  /**
   * Explicit provider for the PTY init message (e.g. 'agy'). Overrides default
   * provider resolution so a command-driven plain shell still declares its
   * provider, enabling backend per-user credential isolation.
   */
  provider?: string | null;
  minimal: boolean;
  autoConnect: boolean;
  isRestarting: boolean;
  onProcessComplete?: ((exitCode: number) => void) | null;
  /**
   * Called with the server refusal for every `error` frame, and with `null`
   * when that refusal is superseded (socket reopened, or PTY output resumed).
   * Never implies the process exited.
   */
  onShellError?: ((error: ShellErrorInfo | null) => void) | null;
  onOutputRef?: MutableRefObject<(() => void) | null>;
  /**
   * T-2037: the one-shot run this shell is bound to. When set, every init
   * re-sends this same id (reconnect, remount, Connect) and never forceRestart,
   * so nothing but a fresh composer submit can start a command.
   */
  oneShotRunId?: string | null;
  /** T-2037: `oneshot_finished` / `oneshot_capture` frames for that run. */
  onOneShotFrame?: ((frame: OneShotFrame) => void) | null;
  /** T-2037: true once per run — only that init may carry the command. */
  claimOneShotLaunch?: ((runId: string) => boolean) | null;
};

export type ShellSharedRefs = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  authUrlRef: MutableRefObject<string>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
};

export type UseShellRuntimeResult = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  isConnected: boolean;
  isInitialized: boolean;
  isConnecting: boolean;
  isReconnecting: boolean;
  /** True after the owner closed this shell to install an update (B-1448). */
  closedForUpdate: boolean;
  authUrl: string;
  authUrlVersion: number;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
  openAuthUrlInBrowser: (url?: string) => boolean;
  copyAuthUrlToClipboard: (url?: string) => Promise<boolean>;
};
