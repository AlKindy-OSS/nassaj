/**
 * Single trusted-origin source (ADR-163 amendment 1, D1 / A1).
 *
 * Every Origin check for cookie-authenticated requests (wallet login and
 * mutations, the forced password-change cookie, device websockets) and every
 * read of the MULTI_ACCOUNT_SWITCHING flag goes through this module. Trust is
 * derived from the environment only — never from `Host`, `req.protocol` or
 * `X-Forwarded-Proto` — and `trust proxy` stays off (ADR-040).
 *
 * allowedOrigins = APP_ORIGINS ∪ APP_ORIGIN ∪ NASSAJ_PUBLIC_ORIGIN, each parsed
 * strictly (bare canonical https origin, ADR-193 validator; invalid values are
 * dropped with a warning and nothing is derived in their place), plus the two
 * implicit loopback origins on the port the server listens on.
 *
 * The policy is computed once per distinct environment and frozen; in
 * production the environment never changes, so it is computed once at boot.
 */

import type { IncomingMessage } from 'node:http';

import { corsAllowedOrigins } from '../config/cors-origins.js';
import { serverPort } from '../config/server-port.js';
import { IS_PLATFORM } from '../constants/config.js';
import { canonicalInstallationOrigin } from '../modules/connectors/connector-installation-origin-resolver.js';

type OriginEnv = Readonly<Record<string, string | undefined>>;

export type TrustedOriginPolicy = Readonly<{
  /** Every origin a cookie-authenticated request may come from. */
  origins: ReadonlySet<string>;
  /** At least one explicit https origin is configured (loopback alone never enables the wallet). */
  walletOriginConfigured: boolean;
  /** The single predicate for MULTI_ACCOUNT_SWITCHING (fail-closed). */
  multiAccountSwitching: boolean;
  /** Stable warning codes, safe to log (no origin values). */
  warnings: readonly Readonly<{ code: string; source?: string }>[];
}>;

const POLICY_ENV_KEYS = [
  'APP_ORIGINS', 'APP_ORIGIN', 'NASSAJ_PUBLIC_ORIGIN', 'SERVER_PORT', 'ALLOWED_ORIGINS',
  'MULTI_ACCOUNT_SWITCHING',
] as const;

type Warning = { code: string; source?: string };

/** Parses one explicit value with the strict ADR-193 validator; null when unusable. */
function strictOrigin(raw: string): string | null {
  try { return canonicalInstallationOrigin(raw, false); } catch { return null; }
}

/** Lists explicit candidates with their source key; APP_ORIGINS is comma-separated. */
function explicitCandidates(env: OriginEnv): Array<{ source: string; raw: string }> {
  const list = String(env.APP_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
    .map((raw) => ({ source: 'APP_ORIGINS', raw }));
  const singles = (['APP_ORIGIN', 'NASSAJ_PUBLIC_ORIGIN'] as const)
    .filter((key) => typeof env[key] === 'string' && env[key] !== '')
    .map((key) => ({ source: key, raw: env[key] as string }));
  return [...list, ...singles];
}

/** The http loopback origins on the listening port only. */
function implicitOrigins(env: OriginEnv): string[] {
  const port = serverPort(env);
  return ['localhost', '127.0.0.1'].flatMap((host) => {
    try { return [new URL(`http://${host}:${port}`).origin]; } catch { return []; }
  });
}

/** Canonical CORS origins; entries that are not URLs cannot match anything. */
function canonicalCorsOrigins(env: OriginEnv): Set<string> {
  return new Set(corsAllowedOrigins(env).flatMap((origin) => {
    try { return [new URL(origin).origin]; } catch { return []; }
  }));
}

/** Resolves the explicit origin set, recording a warning for each dropped value. */
function explicitOrigins(env: OriginEnv, warnings: Warning[]): Set<string> {
  const explicit = new Set<string>();
  for (const { source, raw } of explicitCandidates(env)) {
    const origin = strictOrigin(raw);
    if (origin) explicit.add(origin);
    else warnings.push({ code: 'trusted_origin_invalid', source });
  }
  if (explicit.size === 0) warnings.push({ code: 'trusted_origins_unconfigured' });
  return explicit;
}

/**
 * Builds the policy for one environment. Pure: no logging, no caching.
 * @param platform platform mode never enables device sessions.
 */
export function buildTrustedOriginPolicy(env: OriginEnv, platform: boolean = IS_PLATFORM): TrustedOriginPolicy {
  const warnings: Warning[] = [];
  const explicit = explicitOrigins(env, warnings);
  const cors = canonicalCorsOrigins(env);
  const corsAligned = [...explicit].every((origin) => cors.has(origin));
  if (!corsAligned) warnings.push({ code: 'trusted_origin_not_in_cors' });
  const flagOn = env.MULTI_ACCOUNT_SWITCHING === 'true';
  const multiAccountSwitching = flagOn && !platform && explicit.size > 0 && corsAligned;
  if (flagOn && !multiAccountSwitching) warnings.push({ code: 'multi_account_switching_disabled' });
  return Object.freeze({
    origins: Object.freeze(new Set([...explicit, ...implicitOrigins(env)])),
    walletOriginConfigured: explicit.size > 0,
    multiAccountSwitching,
    warnings: Object.freeze(warnings.map((warning) => Object.freeze(warning))),
  });
}

let cached: Readonly<{ key: string; policy: TrustedOriginPolicy }> | null = null;

/** Returns the frozen policy for the current process environment, logging warnings once. */
export function trustedOriginPolicy(env: OriginEnv = process.env): TrustedOriginPolicy {
  const key = POLICY_ENV_KEYS.map((name) => env[name] ?? '\u0000').join('\u0001');
  if (cached?.key === key) return cached.policy;
  const policy = buildTrustedOriginPolicy(env);
  for (const warning of policy.warnings) console.warn('[trusted-origin]', warning);
  cached = Object.freeze({ key, policy });
  return policy;
}

/** The configured origin allowlist. */
export function allowedOrigins(): ReadonlySet<string> {
  return trustedOriginPolicy().origins;
}

/** Whether an explicit https origin is configured. */
export function walletOriginConfigured(): boolean {
  return trustedOriginPolicy().walletOriginConfigured;
}

/**
 * The single MULTI_ACCOUNT_SWITCHING predicate: the flag is on, not platform
 * mode, an explicit https origin exists and every explicit origin is a CORS
 * origin. Otherwise legacy JWT login continues.
 */
export function multiAccountSwitchingEnabled(): boolean {
  return trustedOriginPolicy().multiAccountSwitching;
}

/** Normalizes an Origin header to `scheme://host[:port]`, or null when absent/opaque/invalid. */
function normalizedOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value === 'null') return null;
  try {
    const parsed = new URL(value);
    return parsed.username || parsed.password ? null : parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Whether the request's `Origin` header names an allowed origin. Accepts an
 * Express request or a raw websocket upgrade request; a missing or `null`
 * Origin is never trusted.
 */
export function isTrustedOrigin(req: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = normalizedOrigin(req.headers?.origin);
  return origin !== null && allowedOrigins().has(origin);
}
