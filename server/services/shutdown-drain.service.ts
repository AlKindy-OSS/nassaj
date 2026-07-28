/**
 * Graceful shutdown drain — B-N-DRAIN (ADR-021 / ADR-022), reworked for B-23.
 *
 * A stop signal (SIGINT/SIGTERM — PM2 sends SIGINT in fork mode) triggers a
 * TIMED DRAIN instead of an immediate process.exit(0). In-flight provider runs
 * (claude/agy/codex/...) are child processes that die with this process, so we
 * wait — bounded by drainTimeoutMs — for active sessions to finish before
 * exiting.
 *
 * B-23 fix (2026-06-11): the original drain kept the HTTP/WS listener bound
 * for the whole drain, so the PM2 replacement instance crash-looped on
 * EADDRINUSE (10x in ~5s -> "errored") and the service collapsed once the old
 * instance finally exited. The drain now RELEASES THE PORT IMMEDIATELY on the
 * first stop signal:
 *
 *   1. `server.close()` — closes the listening socket synchronously (the port
 *      is free for the replacement instance) while established sockets keep
 *      working.
 *   2. Every WebSocket client is closed with 1001 (going away) so UIs
 *      reconnect to the replacement instance and resume from the
 *      registry/transcript (PHASE-SR-0) instead of feeding new work to the
 *      draining process.
 *   3. `server.closeIdleConnections()` — drops idle keep-alive sockets so
 *      lingering HTTP clients cannot route new requests to the old code.
 *
 * Child provider processes are NOT touched: they keep running until their
 * sessions finish (the whole point of the drain), and PM2 must keep
 * `treekill: false` so its eventual SIGKILL never propagates to them.
 *
 * drainTimeoutMs = 0 (the default) waits WITHOUT a deadline — owner decision
 * B-N-DRAIN (2026-06-09): "drain with no ceiling, roles may run for hours". The
 * EADDRINUSE crash-loop that motivated B-41 was NOT caused by the unbounded
 * drain: the T-95 diagnosis proved the predecessor held the port because it had
 * never received a stop signal (PM2 fork-mode lost its pid under treekill:false,
 * ADR-028/B-24), not because the drain deliberately kept the listener open
 * (B-23 already releases it on the first stop signal). The loop is broken by the
 * listen guard (listen-with-guard.service.ts), which makes a starting instance
 * tolerate a held port instead of crash-looping — so no time cap on the drain is
 * needed. The escape hatches for a genuinely wedged drain remain: a second stop
 * signal (immediate exit) and PM2's kill_timeout.
 */

/** WebSocket close code sent to clients when the server is going away. */
export const WS_CLOSE_GOING_AWAY = 1001;

/** Default poll interval while waiting for sessions to finish. */
export const DEFAULT_DRAIN_POLL_MS = 2000;

type SessionCounts = Record<string, number>;

type DrainLogger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

/** Minimal structural view of node:http Server used by the drain. */
type DrainHttpServer = {
  close: (callback?: (err?: Error) => void) => unknown;
  /** Available since Node 18.2 — optional so tests can omit it. */
  closeIdleConnections?: () => void;
};

/** Minimal structural view of ws.WebSocketServer used by the drain. */
type DrainWebSocketServer = {
  clients: Iterable<{ close: (code?: number, reason?: string) => void }>;
};

export type ShutdownDrainDeps = {
  server: DrainHttpServer;
  wss: DrainWebSocketServer;
  /** Active session counts per provider (claude, cursor, codex, ...). */
  countActiveSessionsByProvider: () => SessionCounts;
  /** Final cleanup before exit (plugin child servers). */
  stopAllPlugins: () => Promise<unknown>;
  /** process.exit in production; injectable for tests. */
  exit: (code: number) => void;
  /**
   * Cancels every tool approval still waiting on a user answer, and returns how
   * many were cancelled. Runs BEFORE the websocket clients are closed, so a
   * pending permission request is resolved as an honest, retryable runtime
   * cancellation instead of dying on a socket that is about to be shut — the
   * latter surfaces to the user as "The user doesn't want to proceed with this
   * tool use", a rejection they never made. Optional: omitting it preserves the
   * previous behaviour exactly.
   */
  cancelPendingApprovals?: () => number;
  /** 0 = wait with no deadline (the owner-mandated default, B-N-DRAIN). */
  drainTimeoutMs?: number;
  pollMs?: number;
  logger?: DrainLogger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Parses DRAIN_TIMEOUT_MS from the environment. Anything that is not a
 * positive finite integer means "no deadline" (0) — the owner-mandated default
 * (B-N-DRAIN, 2026-06-09: drain with no ceiling). An explicit positive integer
 * opts a single operator into a bounded drain for that run.
 */
export function resolveDrainTimeoutMs(raw: string | undefined): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Builds the stop-signal handler. The returned function is idempotent-ish:
 * the first call starts the drain, a second call (operator escape hatch)
 * forces an immediate exit.
 */
export function createShutdownDrain(deps: ShutdownDrainDeps): (signal: string) => Promise<void> {
  const {
    server,
    wss,
    countActiveSessionsByProvider,
    stopAllPlugins,
    exit,
    cancelPendingApprovals,
    drainTimeoutMs = 0,
    pollMs = DEFAULT_DRAIN_POLL_MS,
    logger = console,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = deps;

  const totalActiveSessions = (counts: SessionCounts): number =>
    Object.values(counts).reduce((sum, n) => sum + n, 0);

  // B-23: free the TCP listener the moment the first stop signal arrives so
  // the PM2 replacement instance can bind the port while we drain.
  const releaseListener = (signal: string): void => {
    // FIRST, before any socket is closed: hand every waiting approval an honest
    // cancellation. A request left on a socket we are about to shut reaches the
    // user as a rejection they never made.
    if (cancelPendingApprovals) {
      try {
        const cancelled = cancelPendingApprovals();
        if (cancelled > 0) {
          logger.log(
            `[DRAIN] ${signal}: cancelled ${cancelled} pending tool approval(s) before closing sockets ` +
            '— they are reported as retryable runtime cancellations, not user refusals',
          );
        }
      } catch (error) {
        logger.warn('[DRAIN] failed to cancel pending approvals:', (error as Error)?.message ?? error);
      }
    }

    try {
      server.close();
    } catch (error) {
      logger.warn('[DRAIN] failed to close listener:', (error as Error)?.message ?? error);
    }

    let closedClients = 0;
    try {
      for (const client of wss.clients) {
        client.close(WS_CLOSE_GOING_AWAY, 'server restarting');
        closedClients += 1;
      }
    } catch (error) {
      logger.warn('[DRAIN] failed to close websocket clients:', (error as Error)?.message ?? error);
    }

    try {
      server.closeIdleConnections?.();
    } catch (error) {
      logger.warn('[DRAIN] failed to close idle connections:', (error as Error)?.message ?? error);
    }

    logger.log(
      `[DRAIN] ${signal}: listener closed — port released for the replacement instance; ` +
      `${closedClients} websocket client(s) asked to reconnect`,
    );
  };

  const shutdownNow = async (): Promise<void> => {
    try {
      await stopAllPlugins();
    } finally {
      exit(0);
    }
  };

  let drainStarted = false;

  return async function drainThenShutdown(signal: string): Promise<void> {
    if (drainStarted) {
      logger.warn(`[DRAIN] second ${signal} received — exiting immediately`);
      exit(0);
      return;
    }
    drainStarted = true;

    releaseListener(signal);

    let counts = countActiveSessionsByProvider();
    let total = totalActiveSessions(counts);
    if (total === 0) {
      await shutdownNow();
      return;
    }

    const deadline = drainTimeoutMs > 0 ? now() + drainTimeoutMs : Infinity;
    logger.log(
      `[DRAIN] ${signal} received with ${total} active session(s); ` +
      (drainTimeoutMs > 0
        ? `waiting up to ${Math.round(drainTimeoutMs / 1000)}s`
        : 'waiting with no deadline (send a second signal to force exit)'),
      counts,
    );

    let lastLoggedTotal = total;
    while (total > 0 && now() < deadline) {
      await sleep(pollMs);
      counts = countActiveSessionsByProvider();
      total = totalActiveSessions(counts);
      if (total !== lastLoggedTotal) {
        lastLoggedTotal = total;
        logger.log(`[DRAIN] ${total} active session(s) remaining`, counts);
      }
    }

    if (total > 0) {
      logger.warn(
        `[DRAIN] timeout elapsed with ${total} session(s) still active; exiting anyway`,
        counts,
      );
    } else {
      logger.log('[DRAIN] all sessions finished; shutting down');
    }
    await shutdownNow();
  };
}
