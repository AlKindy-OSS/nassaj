/**
 * In-process mock OpenID Provider for end-to-end relying-party tests
 * (ADR-194 test plan). It is a `pinnedFetchJson` transport plus resolver, so
 * the REAL pinned fetch, verifier, callback and database run unchanged and no
 * socket or Docker is involved. The provider serves discovery, JWKS and a
 * token endpoint that enforces PKCE S256, the redirect URI and the configured
 * client authentication, and signs RS256 id_tokens and logout tokens.
 */
import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

import type { PinnedResolver, PinnedTransport } from '../../modules/net/pinned-transport.js';

type ClientAuth = 'none' | 'client_secret_basic' | 'client_secret_post';

type PendingCode = { nonce: string; codeChallenge: string; redirectUri: string; claims: Record<string, unknown> };

export type MockProviderOptions = {
  issuer?: string;
  clientId?: string;
  clientAuth?: ClientAuth;
  clientSecret?: string;
};

export type RecordedRequest = { url: string; method: string; headers: Record<string, string>; body: string };

const PUBLIC_TEST_ADDRESS = '93.184.216.34';

function jsonResponse(status: number, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: (async function* body() { yield bytes; })(),
  };
}

function formDecode(value: string) {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}

/** Creates one provider; mutate `discoveryOverrides` to simulate endpoint drift. */
export function createMockOpenIdProvider(options: MockProviderOptions = {}) {
  const issuer = options.issuer ?? 'https://idp.example';
  const clientId = options.clientId ?? 'nassaj-client';
  const clientAuth = options.clientAuth ?? 'none';
  const kid = 'mock-key-1';
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, PendingCode>();
  const requests: RecordedRequest[] = [];
  const discoveryOverrides: Record<string, unknown> = {};

  const discovery = () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [clientAuth],
    ...discoveryOverrides,
  });

  function clientAuthenticated(headers: Record<string, string>, params: URLSearchParams) {
    if (clientAuth === 'none') return params.get('client_id') === clientId && !headers.authorization;
    if (clientAuth === 'client_secret_post') {
      return params.get('client_id') === clientId && params.get('client_secret') === options.clientSecret;
    }
    const header = headers.authorization ?? '';
    if (!header.startsWith('Basic ') || params.has('client_secret')) return false;
    const [id, secret] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').map(formDecode);
    return id === clientId && secret === options.clientSecret;
  }

  function idToken(pending: PendingCode) {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({
      iss: issuer, aud: clientId, iat: now, exp: now + 300, nonce: pending.nonce, auth_time: now, ...pending.claims,
    }, privateKey, { algorithm: 'RS256', keyid: kid });
  }

  function token(headers: Record<string, string>, body: string) {
    const params = new URLSearchParams(body);
    if (!clientAuthenticated(headers, params)) return jsonResponse(401, { error: 'invalid_client' });
    const pending = codes.get(params.get('code') ?? '');
    codes.delete(params.get('code') ?? '');
    const challenge = crypto.createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
    if (!pending || params.get('grant_type') !== 'authorization_code' || challenge !== pending.codeChallenge
      || params.get('redirect_uri') !== pending.redirectUri) {
      return jsonResponse(400, { error: 'invalid_grant' });
    }
    return jsonResponse(200, { access_token: 'opaque', token_type: 'Bearer', id_token: idToken(pending) });
  }

  const transport: PinnedTransport = async (input) => {
    let body = '';
    if (input.body) body = input.body.toString('utf8');
    requests.push({ url: input.url.href, method: input.method, headers: { ...input.headers }, body });
    if (input.url.origin !== new URL(issuer).origin) return jsonResponse(404, {});
    switch (input.url.pathname) {
      case '/.well-known/openid-configuration': return jsonResponse(200, discovery());
      case '/jwks': return jsonResponse(200, { keys: [jwk] });
      case '/token': return token(input.headers as Record<string, string>, body);
      default: return jsonResponse(404, {});
    }
  };
  const resolver: PinnedResolver = async () => [{ address: PUBLIC_TEST_ADDRESS, family: 4 }];

  return {
    issuer,
    clientId,
    requests,
    discoveryOverrides,
    /** pinnedFetchJson dependencies routing every request to this provider. */
    network: { dependencies: { transport, resolver, interfaceAddresses: () => new Set<string>() } },
    /** The user "signs in" at the IdP: returns the code for an authorization URL. */
    authorize(authorizationUrl: string, claims: Record<string, unknown>) {
      const url = new URL(authorizationUrl);
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, {
        nonce: url.searchParams.get('nonce') ?? '',
        codeChallenge: url.searchParams.get('code_challenge') ?? '',
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
        claims,
      });
      return { code, state: url.searchParams.get('state') ?? '' };
    },
    /** A signed back-channel logout token for `sub`. */
    logoutToken(sub: string) {
      const now = Math.floor(Date.now() / 1000);
      return jwt.sign({
        iss: issuer, aud: clientId, sub, iat: now, exp: now + 120, jti: crypto.randomUUID(),
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      }, privateKey, { algorithm: 'RS256', keyid: kid });
    },
    discoveryFetches: () => requests.filter((request) => request.url.endsWith('/.well-known/openid-configuration')).length,
  };
}
