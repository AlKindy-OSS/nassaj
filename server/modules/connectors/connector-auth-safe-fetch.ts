import { isIP } from 'node:net';

import {
  PROVIDER_AUTH_SPECS,
  validateDcrMetadataForActivation,
  type DcrPkceSpec,
  type ProviderAuthSpec,
} from '../../../shared/connector-auth-registry.js';
import {
  addressKey,
  hostInterfaceAddresses,
  ipv6Words,
  legacyConnectorAddressForbidden,
  type HostAddressSet,
} from '../net/address-policy.js';
import {
  closeResponseBody,
  createDefaultTransport,
  defaultResolver,
  JSON_CONTENT_TYPE,
  readJsonBody,
  runPinnedRequest,
  withTimeout,
  type PinnedErrorKit,
  type PinnedFailure,
  type PinnedMethod,
  type PinnedResolver,
  type PinnedResponse,
  type PinnedTransport,
} from '../net/pinned-transport.js';

/*
 * Thin wrapper over the shared pinned engine (ADR-194 D7): it keeps its spec
 * binding (exact registry endpoints, origins and methods), its redirect count,
 * its error codes and its legacy address table (plus this host's interface
 * addresses). Transport, DNS pinning, body bounds and deadlines are shared.
 */

const ALLOWED_REQUEST_HEADERS = new Set(['accept', 'authorization', 'content-type']);
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

export type SafeFetchMethod = PinnedMethod;
export type SafeFetchResponse = PinnedResponse;
export type SafeFetchTransport = PinnedTransport;
export type SafeFetchResolver = PinnedResolver;

export class ConnectorSafeFetchError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ConnectorSafeFetchError';
  }
}

const CONNECTOR_CODES: Readonly<Record<PinnedFailure, string>> = Object.freeze({
  dns_failed: 'connector_fetch_dns_failed',
  dns_empty: 'connector_fetch_address_forbidden',
  address_blocked: 'connector_fetch_address_forbidden',
  dns_rebinding: 'connector_fetch_dns_rebinding',
  tls_failed: 'connector_fetch_transport_failed',
  transport_failed: 'connector_fetch_transport_failed',
  timeout: 'connector_fetch_timeout',
  redirect_limit: 'connector_fetch_redirect_limit',
  redirect_invalid: 'connector_fetch_redirect_invalid',
  redirect_method: 'connector_fetch_redirect_method_rejected',
  http_status: 'connector_fetch_status_rejected',
  too_large: 'connector_fetch_body_too_large',
  content_type: 'connector_fetch_content_type_invalid',
  json_invalid: 'connector_fetch_json_invalid',
  body_failed: 'connector_fetch_body_failed',
});

const connectorErrors: PinnedErrorKit = Object.freeze({
  fail: (failure: PinnedFailure) => new ConnectorSafeFetchError(CONNECTOR_CODES[failure]),
  owns: (error: unknown) => error instanceof ConnectorSafeFetchError,
});

const defaultTransport = createDefaultTransport(connectorErrors);

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

/** Legacy connector table, plus this host's own interface addresses (D7). */
const connectorAddressClassifier = (own: HostAddressSet) => (address: string): string | null => {
  if (legacyConnectorAddressForbidden(address)) return 'forbidden';
  return own.has(addressKey(address) ?? '') ? 'own_interface' : null;
};

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

export type SafeProviderFetchDependencies = Readonly<{
  resolver?: SafeFetchResolver;
  transport?: SafeFetchTransport;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
}>;

const connectorLimits = (dependencies: SafeProviderFetchDependencies) => {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = dependencies.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = dependencies.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || maxBytes > 1024 * 1024) {
    throw new ConnectorSafeFetchError('connector_fetch_limits_invalid');
  }
  return { timeoutMs, maxRedirects, maxBytes };
};

const connectorRequestBody = (method: SafeFetchMethod, body: Buffer | null): Buffer | null => {
  if (body && method !== 'POST') {
    throw new ConnectorSafeFetchError('connector_fetch_request_body_not_allowed');
  }
  if (body && body.length > MAX_REQUEST_BYTES) {
    throw new ConnectorSafeFetchError('connector_fetch_request_too_large');
  }
  return body;
};

/** Spec-bound hop checks: exact registry endpoint, allowed origin and method on every hop. */
const specHopChecks = (spec: ProviderAuthSpec, policies: Map<string, EndpointPolicy>) => ({
  checkHop: (url: URL, method: SafeFetchMethod) => {
    const policy = policies.get(url.href);
    assertAllowedOrigin(url, spec);
    if (!policy || !policy.methods.has(method)) {
      throw new ConnectorSafeFetchError('connector_fetch_endpoint_not_allowed');
    }
  },
  checkRedirect: (next: URL) => {
    if (!policies.has(next.href)) {
      throw new ConnectorSafeFetchError('connector_fetch_redirect_not_allowed');
    }
    assertAllowedOrigin(next, spec);
  },
});

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
  const url = new URL(endpointUrl(input.spec, input.endpoint));
  const limits = connectorLimits(dependencies);
  const method = input.method ?? 'GET';
  const body = connectorRequestBody(method, input.body ?? null);
  const headers = normalizeHeaders(input.headers, method, input.spec, input.endpoint);
  const result = await runPinnedRequest({
    url, method, headers, body, ...limits,
    responseMode: input.responseMode ?? 'json', readErrorBody: false, acceptJson: JSON_CONTENT_TYPE,
    classifyAddress: connectorAddressClassifier(hostInterfaceAddresses()),
    ...specHopChecks(input.spec, policies),
    resolver: dependencies.resolver ?? defaultResolver,
    transport: dependencies.transport ?? defaultTransport,
    errors: connectorErrors,
  });
  return result.json ?? {};
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
  const answers = await withTimeout(resolver(hostname), DEFAULT_TIMEOUT_MS, connectorErrors);
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
    }), remaining, connectorErrors, () => abort.abort());
    if (response.status < 200 || response.status >= 300) throw new ConnectorSafeFetchError('local_model_status_rejected');
    if (deadline <= Date.now()) throw new ConnectorSafeFetchError('local_model_timeout');
    return await withTimeout(readJsonBody(response, DEFAULT_MAX_RESPONSE_BYTES, connectorErrors), deadline - Date.now(),
      connectorErrors, () => abort.abort());
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
    }), remaining, connectorErrors, () => abort.abort());
    return { status: response.status };
  } finally {
    abort.abort();
    if (response) closeResponseBody(response);
  }
}
