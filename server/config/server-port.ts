/**
 * The HTTP listening port, shared by the server entry point and the trusted
 * origin policy (ADR-163 amendment 1, A-2) so the implicit loopback origins
 * always name the port the server actually listens on.
 */

type PortEnv = Readonly<Record<string, string | undefined>>;

const DEFAULT_SERVER_PORT = 3001;

/**
 * Returns `SERVER_PORT` from the environment, or 3001 when unset. Read lazily
 * so callers evaluate it after `load-env` has populated `process.env`.
 */
export function serverPort(env: PortEnv = process.env): string | number {
  return env.SERVER_PORT || DEFAULT_SERVER_PORT;
}
