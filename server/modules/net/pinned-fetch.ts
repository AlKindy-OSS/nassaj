/**
 * `pinnedFetchJson` (ADR-194 D7, T-1962 S2): the outbound JSON fetch used by
 * the OIDC verifier, the SSO settings tests and (through a thin wrapper) the
 * connectors.
 *
 * - https only, no userinfo, no fragment; DNS pinned; every A/AAAA answer must
 *   pass the D7 address matrix for the chosen policy; this host's interface
 *   addresses are blocked under both policies; proxy env is ignored.
 * - Ports: under `private_allowed` only 443 or the single `allowedPort`; under
 *   `public` any port except `blockedPorts` (always including nassaj's own).
 * - Redirects: `maxRedirects` (0–3), each hop fully re-validated.
 * - A non-2xx JSON body whose `error` member matches `[A-Za-z0-9_.-]{1,64}` is
 *   returned as `oauthError`; nothing else from an error body is returned.
 *   Callers log `pinnedFetchLogFields(result)`, never the value itself.
 * - Failures are `PinnedFetchError` with a fixed code (see PINNED_FETCH_CODES).
 */
import {
  addressBlockCategory,
  hostInterfaceAddresses,
  type AddressPolicy,
  type HostAddressSet,
} from './address-policy.js';
import {
  createDefaultTransport,
  defaultResolver,
  JSON_CONTENT_TYPE,
  runPinnedRequest,
  type PinnedErrorKit,
  type PinnedFailure,
  type PinnedMethod,
  type PinnedResolver,
  type PinnedTransport,
} from './pinned-transport.js';

export type { AddressPolicy } from './address-policy.js';

const MAX_TIMEOUT_MS = 5_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const HTTPS_PORT = 443;
const OAUTH_ERROR = /^[A-Za-z0-9_.-]{1,64}$/u;
const ALLOWED_HEADERS = new Set(['accept', 'content-type', 'authorization']);
const METADATA_HOSTNAMES = new Set(['metadata.google.internal']);

export class PinnedFetchError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'PinnedFetchError';
    this.code = code;
  }
}

const httpClass = (status: string | undefined): string => {
  const value = Number(status);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? `${Math.floor(value / 100)}xx` : 'other';
};

/** Engine failure → typed D7 code. `fetch_connect_failed` and `fetch_request_invalid` extend D7. */
const PINNED_FETCH_CODES: Readonly<Record<PinnedFailure, (detail?: string) => string>> = Object.freeze({
  dns_failed: () => 'fetch_dns_failed',
  dns_empty: () => 'fetch_dns_failed',
  address_blocked: (detail?: string) => `fetch_address_blocked:${detail ?? 'unknown'}`,
  dns_rebinding: () => 'fetch_address_blocked:dns_rebinding',
  tls_failed: () => 'fetch_tls_failed',
  transport_failed: () => 'fetch_connect_failed',
  body_failed: () => 'fetch_connect_failed',
  timeout: () => 'fetch_timeout',
  redirect_limit: () => 'fetch_redirect_refused',
  redirect_invalid: () => 'fetch_redirect_refused',
  redirect_method: () => 'fetch_redirect_refused',
  http_status: (detail?: string) => `fetch_http_${httpClass(detail)}`,
  too_large: () => 'fetch_too_large',
  content_type: () => 'fetch_not_json',
  json_invalid: () => 'fetch_not_json',
});

const pinnedErrors: PinnedErrorKit = Object.freeze({
  fail: (failure: PinnedFailure, detail?: string) => new PinnedFetchError(PINNED_FETCH_CODES[failure](detail)),
  owns: (error: unknown) => error instanceof PinnedFetchError,
});

export type PinnedFetchInput = Readonly<{
  url: string;
  method: PinnedMethod;
  headers?: Partial<Record<'accept' | 'content-type' | 'authorization', string>>;
  body?: string;
  addressPolicy: AddressPolicy;
  allowedPort?: number;
  maxRedirects?: 0 | 1 | 2 | 3;
  maxBytes: number;
  timeoutMs?: number;
  acceptJsonTypes?: RegExp;
  blockedPorts?: readonly number[];
}>;

export type PinnedFetchResult = Readonly<{ status: number; json: unknown; oauthError?: { error: string } }>;

export type PinnedFetchDependencies = Readonly<{
  resolver?: PinnedResolver;
  transport?: PinnedTransport;
  interfaceAddresses?: () => HostAddressSet;
}>;

const invalid = (): PinnedFetchError => new PinnedFetchError('fetch_request_invalid');

const isPort = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;

/** nassaj's own listening port, always blocked (SSRF back into our API). */
export const nassajListeningPort = (): number => Number(process.env.PORT || 3004);

/** https, no userinfo, no fragment; null otherwise. */
function parseFetchUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url : null;
  } catch {
    return null;
  }
}

function validatedHeaders(input: PinnedFetchInput): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  for (const [rawName, value] of Object.entries(input.headers ?? {})) {
    const name = rawName.toLowerCase();
    if (!ALLOWED_HEADERS.has(name) || typeof value !== 'string' || /[\r\n]/u.test(value)) throw invalid();
    headers[name] = value;
  }
  return headers;
}

function validatedBody(input: PinnedFetchInput): Buffer | null {
  if (input.body === undefined) return null;
  if (input.method !== 'POST' || typeof input.body !== 'string') throw invalid();
  const body = Buffer.from(input.body, 'utf8');
  if (body.length > MAX_REQUEST_BYTES) throw invalid();
  return body;
}

function validatedLimits(input: PinnedFetchInput) {
  const timeoutMs = input.timeoutMs ?? MAX_TIMEOUT_MS;
  const maxRedirects = input.maxRedirects ?? 0;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw invalid();
  if (![0, 1, 2, 3].includes(maxRedirects)) throw invalid();
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_RESPONSE_BYTES) {
    throw invalid();
  }
  if (input.method !== 'GET' && input.method !== 'POST') throw invalid();
  if (input.addressPolicy !== 'public' && input.addressPolicy !== 'private_allowed') throw invalid();
  return { timeoutMs, maxRedirects };
}

/** The port rule for every hop: one fixed port under private_allowed, blocked list always. */
function portRule(input: PinnedFetchInput): (port: number) => boolean {
  if (input.allowedPort !== undefined && (input.addressPolicy !== 'private_allowed' || !isPort(input.allowedPort))) {
    throw invalid();
  }
  const blocked = new Set([nassajListeningPort(), ...(input.blockedPorts ?? [])]);
  if ([...blocked].some((port) => !isPort(port))) throw invalid();
  const fixed = input.addressPolicy === 'private_allowed' ? input.allowedPort ?? HTTPS_PORT : null;
  return (port) => !blocked.has(port) && (fixed === null || port === fixed);
}

function hopChecks(portAllowed: (port: number) => boolean) {
  const checkHop = (url: URL) => {
    if (parseFetchUrl(url.href) === null) throw new PinnedFetchError('fetch_redirect_refused');
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (METADATA_HOSTNAMES.has(hostname)) throw new PinnedFetchError('fetch_address_blocked:metadata');
    if (!portAllowed(Number(url.port || HTTPS_PORT))) throw new PinnedFetchError('fetch_port_blocked');
  };
  const checkRedirect = (next: URL) => {
    if (parseFetchUrl(next.href) === null) throw new PinnedFetchError('fetch_redirect_refused');
  };
  return { checkHop, checkRedirect };
}

/** The `error` member of an OAuth error body, only when it is a safe token. */
export function safeOauthError(json: unknown): string | null {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
  const error = Object.hasOwn(json, 'error') ? (json as { error?: unknown }).error : undefined;
  return typeof error === 'string' && OAUTH_ERROR.test(error) ? error : null;
}

/** Structured log fields for a result: presence of an OAuth error only, never its value. */
export function pinnedFetchLogFields(result: PinnedFetchResult): Readonly<Record<string, unknown>> {
  return { status: result.status, oauth_error_present: result.oauthError !== undefined };
}

function interpretResult(result: { status: number; json: Record<string, unknown> | null }): PinnedFetchResult {
  if (result.status >= 200 && result.status < 300) return { status: result.status, json: result.json };
  const error = safeOauthError(result.json);
  if (error === null) throw new PinnedFetchError(`fetch_http_${httpClass(String(result.status))}`);
  return { status: result.status, json: null, oauthError: { error } };
}

/** D7 pinned JSON fetch. Throws PinnedFetchError; never echoes a body or transport detail. */
export async function pinnedFetchJson(
  input: PinnedFetchInput,
  dependencies: PinnedFetchDependencies = {},
): Promise<PinnedFetchResult> {
  const url = parseFetchUrl(input?.url);
  if (url === null) throw invalid();
  const { timeoutMs, maxRedirects } = validatedLimits(input);
  const headers = validatedHeaders(input);
  const body = validatedBody(input);
  const own = (dependencies.interfaceAddresses ?? hostInterfaceAddresses)();
  const result = await runPinnedRequest({
    url, method: input.method, headers, body, maxRedirects, maxBytes: input.maxBytes, timeoutMs,
    responseMode: 'json', readErrorBody: true, acceptJson: input.acceptJsonTypes ?? JSON_CONTENT_TYPE,
    classifyAddress: (address) => addressBlockCategory(address, input.addressPolicy, own),
    ...hopChecks(portRule(input)),
    resolver: dependencies.resolver ?? defaultResolver,
    transport: dependencies.transport ?? createDefaultTransport(pinnedErrors),
    errors: pinnedErrors,
  });
  return interpretResult(result);
}
