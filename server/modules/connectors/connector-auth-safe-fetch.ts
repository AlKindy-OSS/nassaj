import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';

import {
  PROVIDER_AUTH_SPECS,
  validateDcrMetadataForActivation,
  type DcrPkceSpec,
  type ProviderAuthSpec,
} from '../../../shared/connector-auth-registry.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_REQUEST_HEADERS = new Set(['accept', 'authorization', 'content-type']);
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;.*)?$/iu;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;

export type ProviderEndpointKey =
  | 'protectedResourceMetadata'
  | 'authorizationServerMetadata'
  | 'authorization'
  | 'token'
  | 'registration'
  | 'revocation'
  | 'apiKeyProbe';

export type SafeFetchMethod = 'GET' | 'POST';

export type SafeFetchResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: AsyncIterable<Uint8Array>;
  /** Immediately aborts the underlying response stream without draining it. */
  cancel?: () => void;
}>;

export type SafeFetchTransport = (input: Readonly<{
  url: URL;
  address: string;
  family: 4 | 6;
  method: SafeFetchMethod;
  headers: Readonly<Record<string, string>>;
  body: Buffer | null;
  timeoutMs: number;
  signal: AbortSignal;
}>) => Promise<SafeFetchResponse>;

export type SafeFetchResolver = (hostname: string) => Promise<readonly Readonly<{
  address: string;
  family: 4 | 6;
}>[]>;

export class ConnectorSafeFetchError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ConnectorSafeFetchError';
  }
}

type EndpointPolicy = Readonly<{ url: string; methods: ReadonlySet<SafeFetchMethod> }>;

const assertTrustedSpec = (spec: ProviderAuthSpec): void => {
  if (!PROVIDER_AUTH_SPECS.includes(spec)) {
    throw new ConnectorSafeFetchError('connector_fetch_untrusted_provider_spec');
  }
};

const addPolicy = (
  policies: Map<string, EndpointPolicy>,
  rawUrl: string | undefined,
  methods: readonly SafeFetchMethod[],
): void => {
  if (!rawUrl) return;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConnectorSafeFetchError('connector_fetch_catalog_url_invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ConnectorSafeFetchError('connector_fetch_catalog_url_invalid');
  }
  policies.set(url.href, { url: url.href, methods: new Set(methods) });
};

const endpointPolicies = (spec: ProviderAuthSpec): Map<string, EndpointPolicy> => {
  assertTrustedSpec(spec);
  const policies = new Map<string, EndpointPolicy>();
  if (spec.method === 'dcr_pkce') {
    addPolicy(policies, spec.endpoints.protectedResourceMetadata, ['GET']);
    addPolicy(policies, spec.endpoints.authorizationServerMetadata, ['GET']);
    addPolicy(policies, spec.metadataExpectations.authorizationEndpoint, ['GET']);
    addPolicy(policies, spec.metadataExpectations.tokenEndpoint, ['POST']);
    addPolicy(policies, spec.metadataExpectations.registrationEndpoint, ['POST']);
    addPolicy(policies, spec.metadataExpectations.revocationEndpoint, ['POST']);
  } else if (spec.method === 'byo_app') {
    addPolicy(policies, spec.endpoints.authorization, ['GET']);
    addPolicy(policies, spec.endpoints.token, ['POST']);
    addPolicy(policies, spec.endpoints.revocation, ['POST']);
    addPolicy(policies, spec.endpoints.appRegistration, ['GET']);
  } else if (spec.serviceProbe.status === 'certified'
    && spec.serviceProbe.endpoint && spec.serviceProbe.method) {
    addPolicy(policies, spec.serviceProbe.endpoint, [spec.serviceProbe.method]);
  }
  return policies;
};

const endpointUrl = (spec: ProviderAuthSpec, endpoint: ProviderEndpointKey): string => {
  if (spec.method === 'dcr_pkce') {
    const values: Partial<Record<ProviderEndpointKey, string>> = {
      protectedResourceMetadata: spec.endpoints.protectedResourceMetadata,
      authorizationServerMetadata: spec.endpoints.authorizationServerMetadata,
      authorization: spec.metadataExpectations.authorizationEndpoint,
      token: spec.metadataExpectations.tokenEndpoint,
      registration: spec.metadataExpectations.registrationEndpoint,
      revocation: spec.metadataExpectations.revocationEndpoint,
    };
    if (values[endpoint]) return values[endpoint]!;
  }
  if (spec.method === 'byo_app') {
    const values: Partial<Record<ProviderEndpointKey, string>> = {
      authorization: spec.endpoints.authorization,
      token: spec.endpoints.token,
      revocation: spec.endpoints.revocation,
    };
    if (values[endpoint]) return values[endpoint]!;
  }
  if (spec.method === 'api_key' && endpoint === 'apiKeyProbe'
    && spec.serviceProbe.status === 'certified' && spec.serviceProbe.endpoint) {
    return spec.serviceProbe.endpoint;
  }
  throw new ConnectorSafeFetchError('connector_fetch_endpoint_not_supported');
};

const assertAllowedOrigin = (url: URL, spec: ProviderAuthSpec): void => {
  if (!spec.allowedOrigins.includes(url.origin)) {
    throw new ConnectorSafeFetchError('connector_fetch_origin_not_allowed');
  }
};

const ipv4IsForbidden = (address: string): boolean => {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2)))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
};

const ipv6Words = (address: string): number[] | null => {
  let normalized = address.toLowerCase();
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (dotted) {
    const octets = dotted.split('.').map(Number);
    if (octets.length !== 4 || octets.some(value => value < 0 || value > 255)) return null;
    normalized = `${normalized.slice(0, -dotted.length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  if ((normalized.match(/::/gu) ?? []).length > 1) return null;
  const [leftRaw, rightRaw = ''] = normalized.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!normalized.includes('::') && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right].map(word => Number.parseInt(word, 16));
  return words.length === 8 && words.every(word => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
};

const addressIsForbidden = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return ipv4IsForbidden(address);
  if (family !== 6) return true;
  const words = ipv6Words(address);
  if (!words) return true;
  const [first] = words;
  const embeddedIpv4 = (high: number, low: number): string =>
    `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  // IPv4-compatible and IPv4-mapped destinations inherit the IPv4 policy.
  if (words.slice(0, 6).every(word => word === 0)) {
    return ipv4IsForbidden(embeddedIpv4(words[6], words[7]));
  }
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return ipv4IsForbidden(embeddedIpv4(words[6], words[7]));
  }
  // RFC 6052 well-known NAT64 prefix: enforce the embedded IPv4 decision.
  if (words[0] === 0x64 && words[1] === 0xff9b
    && words.slice(2, 6).every(word => word === 0)) {
    return ipv4IsForbidden(embeddedIpv4(words[6], words[7]));
  }
  // 64:ff9b:1::/48 is explicitly local-use (RFC 8215), never global.
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) return true;
  // Fail closed: ordinary IPv6 must be in global unicast 2000::/3.
  if ((first & 0xe000) !== 0x2000) return true;
  // Transition, benchmarking, documentation, ORCHID, and special-purpose
  // allocations are not acceptable provider transport destinations.
  if (first === 0x2002 // 6to4
    || (first === 0x2001 && words[1] < 0x0200) // IETF transition/special space
    || (first === 0x2001 && words[1] === 0x0db8) // documentation
    || (first === 0x3fff && (words[1] & 0xf000) === 0)) return true; // documentation /20
  return false;
};

const resolvePublicAddress = async (
  hostname: string,
  resolver: SafeFetchResolver,
  priorAnswers: Map<string, string>,
) => {
  let answers: Awaited<ReturnType<SafeFetchResolver>>;
  try {
    answers = await resolver(hostname);
  } catch {
    throw new ConnectorSafeFetchError('connector_fetch_dns_failed');
  }
  if (answers.length === 0 || answers.some(answer => addressIsForbidden(answer.address))) {
    throw new ConnectorSafeFetchError('connector_fetch_address_forbidden');
  }
  if (answers.some(answer => isIP(answer.address) !== answer.family)) {
    throw new ConnectorSafeFetchError('connector_fetch_address_forbidden');
  }
  const fingerprint = [...new Set(answers.map(answer => `${answer.family}:${answer.address.toLowerCase()}`))]
    .sort().join(',');
  const prior = priorAnswers.get(hostname);
  if (prior !== undefined && prior !== fingerprint) {
    throw new ConnectorSafeFetchError('connector_fetch_dns_rebinding');
  }
  priorAnswers.set(hostname, fingerprint);
  return answers[0];
};

const defaultResolver: SafeFetchResolver = async hostname =>
  (await lookup(hostname, { all: true, verbatim: true })).map(answer => {
    if (answer.family !== 4 && answer.family !== 6) {
      throw new ConnectorSafeFetchError('connector_fetch_dns_failed');
    }
    return { address: answer.address, family: answer.family };
  });

const defaultTransport: SafeFetchTransport = input => new Promise((resolve, reject) => {
  const request = (input.url.protocol === 'http:' ? httpRequest : httpsRequest)(input.url, {
    method: input.method,
    headers: input.headers,
    servername: input.url.hostname,
    signal: input.signal,
    lookup: (_hostname, _options, callback) => callback(null, input.address, input.family),
  }, response => {
    const headers: Record<string, string | readonly string[] | undefined> = {};
    for (const [name, value] of Object.entries(response.headers)) headers[name.toLowerCase()] = value;
    resolve({
      status: response.statusCode ?? 0,
      headers,
      body: response,
      cancel: () => response.destroy(),
    });
  });
  request.setTimeout(input.timeoutMs, () => {
    request.destroy(new ConnectorSafeFetchError('connector_fetch_timeout'));
  });
  request.once('error', error => reject(
    error instanceof ConnectorSafeFetchError
      ? error
      : new ConnectorSafeFetchError('connector_fetch_transport_failed'),
  ));
  if (input.body) request.write(input.body);
  request.end();
});

const normalizeHeaders = (
  headers: Readonly<Record<string, string>> | undefined,
  method: SafeFetchMethod,
  spec: ProviderAuthSpec,
  endpoint: ProviderEndpointKey,
): Record<string, string> => {
  const normalized: Record<string, string> = { accept: 'application/json' };
  const probeHeader = spec.method === 'api_key' && endpoint === 'apiKeyProbe'
    ? spec.serviceProbe.credentialHeader
    : undefined;
  const staticHeaders = spec.method === 'api_key' && endpoint === 'apiKeyProbe'
    ? spec.serviceProbe.staticHeaders ?? {}
    : {};
  for (const [rawName, value] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    const staticValue = staticHeaders[name];
    if ((!ALLOWED_REQUEST_HEADERS.has(name) && name !== probeHeader && staticValue === undefined)
      || (staticValue !== undefined && value !== staticValue) || /[\r\n]/u.test(value)) {
      throw new ConnectorSafeFetchError('connector_fetch_header_not_allowed');
    }
    if (name === 'authorization' && method !== 'POST' && probeHeader !== 'authorization') {
      throw new ConnectorSafeFetchError('connector_fetch_header_not_allowed');
    }
    if ((name === 'x-figma-token' || name === 'api-key') && name !== probeHeader) {
      throw new ConnectorSafeFetchError('connector_fetch_header_not_allowed');
    }
    normalized[name] = value;
  }
  return normalized;
};

const firstHeader = (
  headers: SafeFetchResponse['headers'],
  name: string,
): string | undefined => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' ? value : value?.[0];
};

const readJsonBody = async (response: SafeFetchResponse, maxBytes: number): Promise<Record<string, unknown>> => {
  const contentType = firstHeader(response.headers, 'content-type');
  if (!contentType || !JSON_CONTENT_TYPE.test(contentType)) {
    throw new ConnectorSafeFetchError('connector_fetch_content_type_invalid');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let joined: Buffer | null = null;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) throw new ConnectorSafeFetchError('connector_fetch_body_too_large');
      chunks.push(buffer);
    }
    joined = Buffer.concat(chunks, total);
    try {
      const parsed = JSON.parse(joined.toString('utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      return parsed as Record<string, unknown>;
    } catch {
      throw new ConnectorSafeFetchError('connector_fetch_json_invalid');
    }
  } catch (error) {
    if (error instanceof ConnectorSafeFetchError) throw error;
    throw new ConnectorSafeFetchError('connector_fetch_body_failed');
  } finally {
    joined?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
};

const discardBoundedBody = async (response: SafeFetchResponse, maxBytes: number): Promise<Record<string, unknown>> => {
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new ConnectorSafeFetchError('connector_fetch_body_too_large');
  }
  return {};
};

const cancelResponse = (response: SafeFetchResponse): void => {
  try {
    response.cancel?.();
  } catch {
    // Transport cleanup must never leak provider/socket details to callers.
  }
};

const closeResponseBody = (response: SafeFetchResponse): void => {
  cancelResponse(response);
  try {
    const pendingReturn = response.body[Symbol.asyncIterator]().return?.();
    if (pendingReturn) void pendingReturn.catch(() => undefined);
  } catch {
    // A broken iterator cannot delay or replace the redacted fetch error.
  }
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try { onTimeout?.(); } catch { /* cleanup is best-effort */ }
          reject(new ConnectorSafeFetchError('connector_fetch_timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export type SafeProviderFetchDependencies = Readonly<{
  resolver?: SafeFetchResolver;
  transport?: SafeFetchTransport;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
}>;

/** Fetches JSON only from an exact endpoint owned by one trusted registry spec. */
export const safeFetchProviderJson = async (input: Readonly<{
  spec: ProviderAuthSpec;
  endpoint: ProviderEndpointKey;
  method?: SafeFetchMethod;
  headers?: Readonly<Record<string, string>>;
  body?: Buffer | null;
  /** Certified endpoints such as RFC 7009 revocation may return an empty body. */
  responseMode?: 'json' | 'discard';
}>, dependencies: SafeProviderFetchDependencies = {}): Promise<Record<string, unknown>> => {
  const policies = endpointPolicies(input.spec);
  const startUrl = new URL(endpointUrl(input.spec, input.endpoint));
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = dependencies.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxResponseBytes = dependencies.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1
    || maxResponseBytes > 1024 * 1024) {
    throw new ConnectorSafeFetchError('connector_fetch_limits_invalid');
  }
  let method = input.method ?? 'GET';
  let body = input.body ?? null;
  if (body && method !== 'POST') {
    throw new ConnectorSafeFetchError('connector_fetch_request_body_not_allowed');
  }
  if (body && body.length > MAX_REQUEST_BYTES) {
    throw new ConnectorSafeFetchError('connector_fetch_request_too_large');
  }
  let headers = normalizeHeaders(input.headers, method, input.spec, input.endpoint);
  let currentUrl = startUrl;
  const resolver = dependencies.resolver ?? defaultResolver;
  const transport = dependencies.transport ?? defaultTransport;
  const priorAnswers = new Map<string, string>();
  const deadline = Date.now() + timeoutMs;

  for (let redirects = 0; ; redirects += 1) {
    const policy = policies.get(currentUrl.href);
    assertAllowedOrigin(currentUrl, input.spec);
    if (!policy || !policy.methods.has(method)) {
      throw new ConnectorSafeFetchError('connector_fetch_endpoint_not_allowed');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ConnectorSafeFetchError('connector_fetch_timeout');
    const address = await withTimeout(resolvePublicAddress(currentUrl.hostname, resolver, priorAnswers), remaining);
    let response: SafeFetchResponse;
    const transportAbort = new AbortController();
    try {
      response = await withTimeout(transport({
        url: currentUrl,
        address: address.address,
        family: address.family,
        method,
        headers,
        body,
        timeoutMs: remaining,
        signal: transportAbort.signal,
      }), remaining, () => transportAbort.abort());
    } catch (error) {
      if (error instanceof ConnectorSafeFetchError) throw error;
      throw new ConnectorSafeFetchError('connector_fetch_transport_failed');
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      if (response.status < 200 || response.status >= 300) {
        closeResponseBody(response);
        throw new ConnectorSafeFetchError('connector_fetch_status_rejected');
      }
      const bodyRemaining = deadline - Date.now();
      if (bodyRemaining <= 0) {
        closeResponseBody(response);
        throw new ConnectorSafeFetchError('connector_fetch_timeout');
      }
      try {
        return await withTimeout(
          input.responseMode === 'discard'
            ? discardBoundedBody(response, maxResponseBytes)
            : readJsonBody(response, maxResponseBytes),
          bodyRemaining,
          () => {
            transportAbort.abort();
            cancelResponse(response);
          },
        );
      } catch (error) {
        cancelResponse(response);
        throw error;
      }
    }
    closeResponseBody(response);
    if (redirects >= maxRedirects) throw new ConnectorSafeFetchError('connector_fetch_redirect_limit');
    const location = firstHeader(response.headers, 'location');
    if (!location) throw new ConnectorSafeFetchError('connector_fetch_redirect_invalid');
    if (method === 'POST' && response.status !== 307 && response.status !== 308) {
      throw new ConnectorSafeFetchError('connector_fetch_redirect_method_rejected');
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new ConnectorSafeFetchError('connector_fetch_redirect_invalid');
    }
    if (!policies.has(nextUrl.href)) {
      throw new ConnectorSafeFetchError('connector_fetch_redirect_not_allowed');
    }
    assertAllowedOrigin(nextUrl, input.spec);
    if (nextUrl.origin !== currentUrl.origin) {
      const { authorization: _authorization, ...withoutAuthorization } = headers;
      headers = withoutAuthorization;
    }
    currentUrl = nextUrl;
  }
};

export type CertifiedProviderMetadata = Readonly<{
  protectedResourceMetadata: Readonly<Record<string, unknown>>;
  authorizationServerMetadata: Readonly<Record<string, unknown>>;
}>;

/** Fetches and verifies the exact issuer/auth/token/register contract before activation. */
export const fetchCertifiedProviderMetadata = async (
  spec: DcrPkceSpec,
  dependencies: SafeProviderFetchDependencies = {},
): Promise<CertifiedProviderMetadata> => {
  assertTrustedSpec(spec);
  const [protectedResourceMetadata, authorizationServerMetadata] = await Promise.all([
    safeFetchProviderJson({ spec, endpoint: 'protectedResourceMetadata' }, dependencies),
    safeFetchProviderJson({ spec, endpoint: 'authorizationServerMetadata' }, dependencies),
  ]);
  if (!validateDcrMetadataForActivation(spec, protectedResourceMetadata, authorizationServerMetadata)) {
    throw new ConnectorSafeFetchError('connector_fetch_metadata_expectations_failed');
  }
  return { protectedResourceMetadata, authorizationServerMetadata };
};

/**
 * Ports below 1024 belong to the host's own privileged services (ssh, smtp, the
 * reverse proxy …), never to a user-run inference server. B-1268 refuses them on
 * loopback so "test connection" cannot be aimed at this machine's own daemons.
 */
const PRIVILEGED_PORT_CEILING = 1024;

/** The nassaj listener itself, refused on every host (SSRF back into our own API). */
const nassajPort = (): number => Number(process.env.PORT || 3004);

const localModelPort = (url: URL): number => Number(url.port || (url.protocol === 'https:' ? 443 : 80));

const isLoopbackAddress = (address: string): boolean => {
  if (isIP(address) === 4) return address.startsWith('127.');
  const words = isIP(address) === 6 ? ipv6Words(address) : null;
  if (!words) return false;
  if (words.slice(0, 7).every(word => word === 0) && words[7] === 1) return true;
  if (words.slice(0, 5).every(word => word === 0) && (words[5] === 0 || words[5] === 0xffff)) {
    return isLoopbackAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  return false;
};

/**
 * Networks where plaintext http is acceptable for local inference: loopback, RFC1918,
 * CGNAT/tailnet 100.64.0.0/10 and IPv6 ULA. Everything else is the public internet,
 * where a key (and the prompt) may not travel in the clear — owner decision: the
 * responsibility for a remote endpoint is the person who connects it, but only over TLS.
 */
const isPrivateInferenceAddress = (address: string): boolean => {
  if (isLoopbackAddress(address)) return true;
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  const words = isIP(address) === 6 ? ipv6Words(address) : null;
  if (!words) return false;
  if (words.slice(0, 5).every(word => word === 0) && (words[5] === 0 || words[5] === 0xffff)) {
    return isPrivateInferenceAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  return (words[0] & 0xfe00) === 0xfc00;
};

/**
 * ADR-163 / B-1268: local inference permits private networks but rejects metadata
 * hosts, the nassaj port, privileged loopback ports, and plaintext http toward a
 * literal public address. A DNS name that resolves to a public address is caught after
 * resolution in safeFetchLocalModelJson. Connector URLs never reach this function.
 */
export function validateLocalModelUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ConnectorSafeFetchError('local_model_url_invalid'); }
  const port = localModelPort(url);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  const literalPublic = isIP(host) !== 0 && !isPrivateInferenceAddress(host);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search
    || port === nassajPort() || port === 3004 || host.includes('metadata')
    || (port < PRIVILEGED_PORT_CEILING && (host === 'localhost' || isLoopbackAddress(host)))
    || (url.protocol === 'http:' && literalPublic)
    || /[{}$]/u.test(raw)) throw new ConnectorSafeFetchError('local_model_url_forbidden');
  return url;
}

const localAddressForbidden = (address: string): boolean => {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a >= 224 || (a === 169 && b === 254) || address === '100.100.100.200'
      || address === '168.63.129.16';
  }
  if (isIP(address) !== 6) return true;
  if (address.toLowerCase() === 'fd00:ec2::254') return true;
  const words = ipv6Words(address);
  if (!words) return true;
  if (words[0] === 0xfd00 && words[1] === 0xec2 && words.slice(2, 7).every(word => word === 0) && words[7] === 0x254) return true;
  if (words.slice(0, 7).every(word => word === 0) && words[7] === 1) return false;
  if (words.slice(0, 5).every(word => word === 0) && (words[5] === 0 || words[5] === 0xffff)) {
    return localAddressForbidden(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  // Only ordinary global IPv6 and ULA (including tailnet); block transition encodings.
  return !((words[0] & 0xfe00) === 0xfc00 || ((words[0] & 0xe000) === 0x2000
    && words[0] !== 0x2002 && !(words[0] === 0x2001 && words[1] < 0x0200)));
};

/**
 * Pins DNS and re-applies the ADR-163/B-1268 address rules to the RESOLVED address,
 * so a DNS name pointing at loopback (or at the public internet over http) is refused
 * too. Shared by the local-model GET fetch and the POST auth probe.
 */
const resolveLocalModelAddress = async (
  url: URL,
  resolver: SafeFetchResolver,
): Promise<Readonly<{ address: string; family: 4 | 6 }>> => {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const answers = await withTimeout(resolver(hostname), DEFAULT_TIMEOUT_MS);
  const port = localModelPort(url);
  const forbidden = (address: string): boolean => localAddressForbidden(address)
    || (port < PRIVILEGED_PORT_CEILING && isLoopbackAddress(address))
    || (url.protocol === 'http:' && !isPrivateInferenceAddress(address));
  if (!answers.length || answers.some(answer => forbidden(answer.address) || isIP(answer.address) !== answer.family)) {
    throw new ConnectorSafeFetchError('local_model_address_forbidden');
  }
  return answers[0];
};

/** Pinned DNS + shared bounded transport/parser; redirects are never followed. */
export async function safeFetchLocalModelJson(rawUrl: string, apiKey?: string | null,
  dependencies: Pick<SafeProviderFetchDependencies, 'resolver' | 'transport'> = {}): Promise<Record<string, unknown>> {
  const url = validateLocalModelUrl(rawUrl);
  if (apiKey && /[\r\n]/u.test(apiKey)) throw new ConnectorSafeFetchError('local_model_key_invalid');
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  const target = await resolveLocalModelAddress(url, dependencies.resolver ?? defaultResolver);
  const abort = new AbortController();
  let response: SafeFetchResponse | undefined;
  try {
    const remaining = Math.max(1, deadline - Date.now());
    response = await withTimeout((dependencies.transport ?? defaultTransport)({
      url, ...target, method: 'GET', headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: null, timeoutMs: remaining, signal: abort.signal,
    }), remaining, () => abort.abort());
    if (response.status < 200 || response.status >= 300) throw new ConnectorSafeFetchError('local_model_status_rejected');
    if (deadline <= Date.now()) throw new ConnectorSafeFetchError('local_model_timeout');
    return await withTimeout(readJsonBody(response, DEFAULT_MAX_RESPONSE_BYTES), deadline - Date.now(), () => abort.abort());
  } finally {
    abort.abort();
    if (response) closeResponseBody(response);
  }
}

/**
 * B-1298(a): authenticated auth probe. POSTs a minimal body to a local-model endpoint
 * (e.g. `/chat/completions`) with the configured key and returns ONLY the HTTP status,
 * without loading a model or reading the body. A wrong/missing key yields 401 on servers
 * that gate auth before model load (llama.cpp / llama-swap); a valid key yields a 4xx
 * validation error instead — never a 401. The GET `/models` endpoint is served
 * unauthenticated by llama.cpp, so a wrong key would otherwise pass silently.
 *
 * The body is `{}` deliberately: with no `model` field there is nothing to resolve or
 * load, and with no `messages` field every runtime fails validation before generating.
 * Naming a sentinel model instead would add a model-resolution step for no extra safety.
 *
 * Reuses the same pinned DNS, address validation and bounded transport as the GET fetch,
 * so SSRF protections are not bypassed. The caller decides which statuses mean "bad key"
 * and never surfaces the provider's raw response.
 */
export async function safeProbeLocalModelAuth(rawUrl: string, apiKey?: string | null,
  dependencies: Pick<SafeProviderFetchDependencies, 'resolver' | 'transport'> = {}): Promise<{ status: number }> {
  const url = validateLocalModelUrl(rawUrl);
  if (apiKey && /[\r\n]/u.test(apiKey)) throw new ConnectorSafeFetchError('local_model_key_invalid');
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  const target = await resolveLocalModelAddress(url, dependencies.resolver ?? defaultResolver);
  const abort = new AbortController();
  let response: SafeFetchResponse | undefined;
  try {
    const remaining = Math.max(1, deadline - Date.now());
    response = await withTimeout((dependencies.transport ?? defaultTransport)({
      url, ...target, method: 'POST',
      headers: {
        accept: 'application/json', 'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: Buffer.from('{}'), timeoutMs: remaining, signal: abort.signal,
    }), remaining, () => abort.abort());
    return { status: response.status };
  } finally {
    abort.abort();
    if (response) closeResponseBody(response);
  }
}
