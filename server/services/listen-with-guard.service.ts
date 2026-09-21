/**
 * Single-listener bind guard — B-41 ("self-hosting trap").
 *
 * Problem proven in T-95 diagnosis (2026-06-13): nassaj-dev runs as a PM2
 * fork-mode app whose claude/agy sessions are DIRECT CHILD processes of the
 * server. On `pm2 restart` while a session is active, the old process enters
 * the graceful drain (shutdown-drain.service.ts) and — because PM2 7.0.1
 * fork-mode loses track of the live pid under `treekill:false` (ADR-028 / B-24)
 * — PM2 spawns a REPLACEMENT instance while the old one is still alive and (for
 * the duration of the drain) still effectively holding port 3004. The naked
 * `server.listen()` in the replacement then throws EADDRINUSE, the process
 * exits with code 1, PM2 respawns it, and the cycle repeats every
 * exp_backoff interval.
 *
 * Evidence (T-95): a single uninterrupted crash-loop from 2026-06-12 17:14:38
 * to 2026-06-13 03:13:28. The running build ALREADY shipped B-23 — the loop
 * ended at 03:13:39 with "[DRAIN] SIGTERM: listener closed — port released",
 * followed instantly by a clean bind at 03:13:43. That proves the predecessor
 * held the port only because it had never been SIGNALLED to stop (PM2 lost its
 * pid and spawned a replacement beside the still-live original), not because the
 * drain deliberately kept the listener bound. So capping the drain would not
 * have helped; breaking the bind crash-loop is what matters.
 *
 * Fix: never let a bind failure crash-loop. The replacement instance:
 *   1. Retries `listen()` with bounded backoff for a finite window. This
 *      absorbs the brief, EXPECTED overlap while a draining predecessor frees
 *      the listener socket (the B-23 drain releases it within milliseconds of
 *      the stop signal, so a healthy handoff binds on the first or second try).
 *   2. If the port is STILL held after the window, it PROBES the holder's
 *      /health endpoint to tell our own predecessor apart from a foreign holder:
 *        - Holder is one of OURS (reports service:'nassaj-server') OR the probe
 *          is inconclusive (connection refused / parse error): the predecessor
 *          is a draining/ghost instance, so exit cleanly (0). PM2 reschedules a
 *          single bounded retry instead of crash-looping on EADDRINUSE.
 *        - Holder is FOREIGN (answers but is not us, or answers nothing usable
 *          on a held port): exit 1 so PM2 marks the process `errored` and the
 *          operator is paged — no silent death behind a stranger on our port.
 *   3. A non-EADDRINUSE bind error (EACCES, …) is always fatal (exit 1).
 *
 * This is transport-layer hardening only: it changes nothing about how sessions
 * run, and it preserves the owner-mandated unbounded drain (B-N-DRAIN).
 */

/**
 * Parses LISTEN_BIND_WINDOW_MS from the environment. A non-negative finite
 * integer is honoured; anything else falls back to the default (8000ms). This
 * lets operators widen the overlap tolerance if a slow drain handoff is
 * expected, without touching code.
 */
export function resolveBindWindowMs(raw: string | undefined, fallback = 8000): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Stable fingerprint emitted by our own /health endpoint (see server/index.js). */
export const HEALTH_SERVICE_MARKER = 'nassaj-server';

/** Verdict from probing whatever currently holds the contested port. */
export type HealthProbeResult =
  | 'ours' // the holder answered /health with our marker → a draining/ghost predecessor
  | 'foreign' // the holder answered but is NOT us → a stranger squatting on our port
  | 'inconclusive'; // could not decide (refused/timeout/parse error)

/**
 * Probes http://host:port/health to classify whoever holds the port. Default
 * implementation; injectable for tests. Treats only a clear non-matching JSON
 * body as 'foreign'; refusals/timeouts/parse failures are 'inconclusive' so the
 * benefit of the doubt goes to "our own predecessor" (exit cleanly, let PM2
 * reschedule) rather than to crashing the box on a flaky probe.
 */
async function defaultProbeHealth(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<HealthProbeResult> {
  // localhost is the only reachable target for a same-host predecessor; binding
  // host may be 0.0.0.0 which is not connectable.
  const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${target}:${port}/health`, {
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as { service?: unknown } | null;
    if (body && typeof body === 'object' && 'service' in body) {
      return body.service === HEALTH_SERVICE_MARKER ? 'ours' : 'foreign';
    }
    // Answered HTTP but without our marker shape → something else is listening.
    return 'foreign';
  } catch {
    // Connection refused, reset, timeout, non-HTTP responder, etc.
    return 'inconclusive';
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal structural view of node:http Server used by the guard. */
type GuardHttpServer = {
  listen: (port: number, host: string, callback: () => void) => unknown;
  once: (event: 'error', listener: (err: NodeJS.ErrnoException) => void) => unknown;
  removeListener?: (event: 'error', listener: (...args: unknown[]) => void) => unknown;
};

type GuardLogger = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type ListenWithGuardDeps = {
  server: GuardHttpServer;
  port: number;
  host: string;
  /** Called once the socket is successfully bound and listening. */
  onListening: () => void;
  /**
   * Total wall-clock budget (ms) spent retrying EADDRINUSE before giving up.
   * A healthy drain handoff frees the port within ~1 poll, so a few seconds is
   * generous. Default 8000.
   */
  bindWindowMs?: number;
  /** Delay between bind attempts (ms). Default 500. */
  retryDelayMs?: number;
  /** Clean exit when the port stays held past the window. process.exit in prod. */
  exit: (code: number) => void;
  /**
   * Classifies whoever holds the port once the bind window expires, so a held
   * port held by a STRANGER surfaces as `errored` (exit 1) instead of dying
   * silently. Injectable for tests; defaults to a real /health probe.
   */
  probeHealth?: (host: string, port: number, timeoutMs: number) => Promise<HealthProbeResult>;
  /** Timeout for a single health probe (ms). Default 1500. */
  probeTimeoutMs?: number;
  logger?: GuardLogger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** Reasons a single bind attempt can resolve. */
type AttemptResult = 'listening' | 'addr-in-use' | 'fatal';

/**
 * Binds the HTTP server to the port, tolerating a brief EADDRINUSE overlap
 * from a draining predecessor. Resolves once listening; on a wedged port it
 * exits cleanly (0) so PM2 reschedules instead of accumulating crash state.
 */
export async function listenWithGuard(deps: ListenWithGuardDeps): Promise<void> {
  const {
    server,
    port,
    host,
    onListening,
    bindWindowMs = 8000,
    retryDelayMs = 500,
    exit,
    probeHealth = defaultProbeHealth,
    probeTimeoutMs = 1500,
    logger = console,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = deps;

  const attempt = (): Promise<AttemptResult> =>
    new Promise<AttemptResult>((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if (err && err.code === 'EADDRINUSE') {
          resolve('addr-in-use');
          return;
        }
        logger.error('[LISTEN] fatal bind error:', err?.message ?? err);
        resolve('fatal');
      };

      server.once('error', onError);
      server.listen(port, host, () => {
        // Bound successfully — drop the transient error listener so a later
        // runtime socket error is not swallowed by this handler.
        server.removeListener?.('error', onError as (...args: unknown[]) => void);
        onListening();
        resolve('listening');
      });
    });

  const deadline = now() + Math.max(0, bindWindowMs);
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const result = await attempt();

    if (result === 'listening') {
      if (attempts > 1) {
        logger.log(`[LISTEN] bound to ${host}:${port} after ${attempts} attempt(s)`);
      }
      return;
    }

    if (result === 'fatal') {
      // A non-EADDRINUSE failure is a real error — surface it as a crash.
      exit(1);
      return;
    }

    // EADDRINUSE: a predecessor still holds the port.
    if (now() >= deadline) {
      // The window is spent. Before giving up, find out WHO holds the port so a
      // foreign squatter does not leave us dead-but-green (always exit 0).
      const holder = await probeHealth(host, port, probeTimeoutMs);

      if (holder === 'foreign') {
        logger.error(
          `[LISTEN] port ${port} held after ${attempts} attempt(s) over ${bindWindowMs}ms by a ` +
          'FOREIGN listener (its /health did not report service="' + HEALTH_SERVICE_MARKER + '"). ' +
          'This is NOT a nassaj predecessor — exiting with code 1 so the supervisor marks the ' +
          'process errored and an operator investigates instead of dying silently.',
        );
        exit(1);
        return;
      }

      logger.warn(
        `[LISTEN] port ${port} still held after ${attempts} attempt(s) over ${bindWindowMs}ms ` +
        `(holder probe: ${holder}) — a draining or ghost nassaj predecessor owns the socket ` +
        '(B-41). Exiting cleanly (0) so the supervisor reschedules a single bounded retry ' +
        'instead of crash-looping on EADDRINUSE.',
      );
      exit(0);
      return;
    }

    logger.log(
      `[LISTEN] port ${port} in use (attempt ${attempts}); predecessor draining — retrying in ${retryDelayMs}ms`,
    );
    await sleep(retryDelayMs);
  }
}
