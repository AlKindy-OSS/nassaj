/**
 * Test helper: configures the trusted-origin policy for an in-process server on
 * an ephemeral loopback port. The listening port becomes SERVER_PORT, so
 * `http://127.0.0.1:<port>` is an implicit trusted origin, and an explicit https
 * origin (also a CORS origin) lets MULTI_ACCOUNT_SWITCHING take effect.
 */

const KEYS = ['SERVER_PORT', 'NASSAJ_PUBLIC_ORIGIN', 'ALLOWED_ORIGINS', 'APP_ORIGIN', 'APP_ORIGINS'] as const;

export const TEST_PUBLIC_ORIGIN = 'https://nassaj.test';

/** Applies the environment and returns the loopback origin plus a restore function. */
export function useWalletOriginEnv(port: number): { origin: string; restore: () => void } {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  delete process.env.APP_ORIGIN;
  delete process.env.APP_ORIGINS;
  process.env.SERVER_PORT = String(port);
  process.env.NASSAJ_PUBLIC_ORIGIN = TEST_PUBLIC_ORIGIN;
  process.env.ALLOWED_ORIGINS = TEST_PUBLIC_ORIGIN;
  const restore = () => {
    for (const key of KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
  return { origin: `http://127.0.0.1:${port}`, restore };
}
