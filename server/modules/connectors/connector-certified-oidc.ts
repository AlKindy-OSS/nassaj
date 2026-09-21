import type { ByoAppSpec } from '../../../shared/connector-auth-registry.js';
// eslint-disable-next-line boundaries/no-unknown -- shared verifier owns JOSE validation and replay-safe claims checks.
import { createOidcVerifier } from '../../services/oidc-verifier.service.js';

const DISCOVERY_MAX_BYTES = 64 * 1024;

const verifierFactory = createOidcVerifier as unknown as (input: Readonly<{
  issuer: string;
  clientId: string;
  fetchImpl: typeof fetch;
}>) => Readonly<{
  verifyIdToken(token: string, nonce: string): Promise<Readonly<Record<string, unknown>>>;
}>;

export class ConnectorCertifiedOidcError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ConnectorCertifiedOidcError';
  }
}

const exactHttps = (value: string): string => {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ConnectorCertifiedOidcError('connector_oidc_endpoint_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new ConnectorCertifiedOidcError('connector_oidc_endpoint_invalid');
  }
  return parsed.toString();
};

const readDiscovery = async (response: Response): Promise<Record<string, unknown>> => {
  if (!response.ok || !/^application\/json(?:\s*;.*)?$/iu.test(response.headers.get('content-type') ?? '')) {
    throw new ConnectorCertifiedOidcError('connector_oidc_discovery_invalid');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ConnectorCertifiedOidcError('connector_oidc_discovery_invalid');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DISCOVERY_MAX_BYTES) throw new ConnectorCertifiedOidcError('connector_oidc_discovery_invalid');
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total);
    try {
      const value = JSON.parse(raw.toString('utf8')) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ConnectorCertifiedOidcError('connector_oidc_discovery_invalid');
      }
      return value as Record<string, unknown>;
    } finally { raw.fill(0); }
  } finally { reader.releaseLock(); }
};

/**
 * Adapts one certified cross-origin OIDC tuple to the shared verifier without
 * weakening its same-origin default for any other caller.
 */
export const createCertifiedConnectorOidcVerifier = (input: Readonly<{
  spec: ByoAppSpec;
  clientId: string;
  fetchImpl?: typeof fetch;
}>) => {
  if (input.spec.identity.method !== 'oidc') {
    throw new ConnectorCertifiedOidcError('connector_oidc_identity_contract_unavailable');
  }
  const discoveryEndpoint = exactHttps(input.spec.identity.discoveryEndpoint);
  const authorizationEndpoint = exactHttps(input.spec.endpoints.authorization);
  const tokenEndpoint = exactHttps(input.spec.endpoints.token);
  const jwksUri = exactHttps(input.spec.identity.jwksUri);
  const issuer = exactHttps(input.spec.expectedIssuer).replace(/\/$/u, '');
  const synthetic = Object.freeze({
    discovery: `${issuer}/.well-known/openid-configuration`,
    authorization: `${issuer}/.well-known/nassaj-certified-authorization`,
    token: `${issuer}/.well-known/nassaj-certified-token`,
    jwks: `${issuer}/.well-known/nassaj-certified-jwks`,
  });
  const trustedFetch = input.fetchImpl ?? globalThis.fetch;
  const fetchImpl = (async (target: string | URL | Request, init?: RequestInit) => {
    const url = String(target);
    if (url === synthetic.discovery) {
      const live = await trustedFetch(discoveryEndpoint, { ...init, redirect: 'error' });
      const metadata = await readDiscovery(live);
      if (metadata.issuer !== issuer
        || metadata.authorization_endpoint !== authorizationEndpoint
        || metadata.token_endpoint !== tokenEndpoint
        || metadata.jwks_uri !== jwksUri) {
        throw new ConnectorCertifiedOidcError('connector_oidc_discovery_drift');
      }
      return new Response(JSON.stringify({
        ...metadata,
        authorization_endpoint: synthetic.authorization,
        token_endpoint: synthetic.token,
        jwks_uri: synthetic.jwks,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === synthetic.jwks) return trustedFetch(jwksUri, { ...init, redirect: 'error' });
    if (url === synthetic.token) return trustedFetch(tokenEndpoint, { ...init, redirect: 'error' });
    throw new ConnectorCertifiedOidcError('connector_oidc_endpoint_not_certified');
  }) as typeof fetch;
  return verifierFactory({ issuer, clientId: input.clientId, fetchImpl });
};
