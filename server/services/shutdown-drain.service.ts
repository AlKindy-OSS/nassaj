/**
 * Graceful shutdown drain — B-N-DRAIN (ADR-021 / ADR-022), reworked for B-23.
 *
 * A stop signal (SIGINT/SIGTERM — PM2 sends SIGINT in fork mode) triggers a
 * TIMED DRAIN instead of an immediate process.exit(0). In-flight provider runs
 * (claude/agy/codex/...) are child processes that die with this process, so we
 * wait — bounded by drainTimeoutMs — for active sessions to finish before
 * exiting.
 *
 * B-319 rework (2026-07-30, supersedes the B-23 immediate release — ADR-084):
 * the listener is now released AT EXIT TIME, not on the first signal. B-23
 * (2026-06-11) released the port the moment the first stop signal arrived, on
 * the assumption that a PM2 replacement was always about to bind it. That
 * assumption is false in every path:
 *
 *   - PM2 fork-mode `restart` starts the successor only AFTER the old process
 *     exits (God.restartProcessId → stopProcessId → startProcessId, PM2 7.0.1
 *     source), so during a drain with live sessions the released port had NO
 *     listener at all — measured as the B-129 ~18-minute 502 window and the
 *     2026-07-29 fleet-node `pkill` incident (28 minutes dead with a healthy
 *     process attached).
 *   - A stray signal (pkill / manual kill) has no successor, ever.
 *
 * The EADDRINUSE crash-loop B-23 was built for is solved more correctly by the
 * listen guard (B-41, listen-with-guard.service.ts): a starting instance
 * tolerates a held port instead of crash-looping. So the drain now keeps
 * SERVING for its whole duration — sockets stay open, pending tool approvals
 * can still be answered — and releases the port + closes websockets (1001) +
 * cancels whatever approvals remain only in the instant before exit.
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
 * ADR-028/B-24). The loop is broken by the listen guard
 * (listen-with-guard.service.ts), which makes a starting instance tolerate a
 * held port instead of crash-looping — so no time cap on the drain is needed.
 * The escape hatches for a genuinely wedged drain remain: a second stop signal
 * (immediate exit) and PM2's kill_timeout.
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
  /** Final cleanup before exit (background lifecycle). */
  finalCleanup: () => Promise<unknown>;
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
    finalCleanup,
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

  /**
   * B-337: the session count reaches into every provider's registry, and a
   * throw here runs inside a SIGNAL HANDLER whose promise nobody awaits — so an
   * unguarded exception meant no exit, no port release, and no log line, until
   * PM2's SIGKILL 24 hours later. `/health` already wraps the same counters
   * (safeCount); the drain, where a failure is far more expensive, did not.
   *
   * Fails toward EXITING, deliberately: an unreadable registry cannot prove
   * work is in flight, and hanging forever is the worse outcome of the two.
   */
  const safeCounts = (): SessionCounts => {
    try {
      return countActiveSessionsByProvider();
    } catch (error) {
      logger.warn(
        '[DRAIN] session count failed; treating as zero and shutting down:',
        (error as Error)?.message ?? error,
      );
      return {};
    }
  };

  // B-319 (ADR-084): release the TCP listener only at EXIT TIME. Releasing it
  // on the first signal (the old B-23 behaviour) opened a listener-less window
  // for the entire drain, because no PM2 successor exists until this process
  // exits — and a stray signal has no successor at all.
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

  /**
   * True once teardown has begun. In production `exit` is process.exit, which
   * never returns, so nothing after it can run; this flag makes that guarantee
   * explicit instead of load-bearing. Without it the escape hatch tears down,
   * and the still-running poll loop then tears down a SECOND time as soon as it
   * observes the count drop — harmless today, a latent double-close the moment
   * `exit` becomes anything but process.exit.
   */
  let exiting = false;

  const shutdownNow = async (signal: string): Promise<void> => {
    if (exiting) return;
    exiting = true;
    // Release the port / close sockets as the FIRST act of actually exiting,
    // so the gap between "no listener" and "process gone" is milliseconds —
    // PM2 (restart successor or autorestart after a stray kill) takes over
    // immediately instead of facing a dead port for the whole drain.
    releaseListener(signal);
    try {
      await finalCleanup();
    } finally {
      exit(0);
    }
  };

  let drainStarted = false;

  return async function drainThenShutdown(signal: string): Promise<void> {
    if (drainStarted) {
      logger.warn(`[DRAIN] second ${signal} received — exiting immediately`);
      // B-337: still release properly on the way out. Under the pre-B-319 order
      // this had already happened on the FIRST signal, so a bare exit here was
      // harmless; now that the first signal keeps serving, exiting bare would
      // leave every pending tool approval to die on a socket that just vanished
      // — which reaches the user as "the user doesn't want to proceed", a
      // refusal they never made. The escape hatch stays immediate: every step
      // is synchronous and individually try/caught.
      if (!exiting) {
        exiting = true;
        releaseListener(signal);
        exit(0);
      }
      return;
    }
    drainStarted = true;

    let counts = safeCounts();
    let total = totalActiveSessions(counts);
    if (total === 0) {
      await shutdownNow(signal);
      return;
    }

    const deadline = drainTimeoutMs > 0 ? now() + drainTimeoutMs : Infinity;
    logger.log(
      `[DRAIN] ${signal} received with ${total} active session(s); ` +
      'still SERVING while draining (B-319: the port is released only at exit); ' +
      (drainTimeoutMs > 0
        ? `waiting up to ${Math.round(drainTimeoutMs / 1000)}s`
        : 'waiting with no deadline (send a second signal to force exit)'),
      counts,
    );

    let lastLoggedTotal = total;
    while (total > 0 && now() < deadline && !exiting) {
      await sleep(pollMs);
      counts = safeCounts();
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
    await shutdownNow(signal);
  };
}
