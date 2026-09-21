/**
 * connector-oauth-flow — nassaj performs the browser grant itself (ADR-098 rev3).
 *
 * WHY THE FIRST APPROACH HAD TO GO. The link used to be delegated to
 * `mcp-remote`, which opens an HTTP listener ON THE SERVER and registers
 * `http://<host>:<port>/oauth/callback` as the redirect. Two measured failures
 * killed that path (2026-08-05):
 *
 *   1. UNREACHABLE. nassaj is normally reached through a tunnel, so the member's
 *      browser cannot open a raw port on the origin machine. Rewriting the
 *      hostname (`--host`) only moves the problem: the platform accepts the
 *      redirect, but nothing answers it from the member's network.
 *   2. SELF-POISONING. `mcp-remote` calls `findExistingClientPort` on EVERY
 *      launch and throws "Cannot find localhost callback URI from existing
 *      client information" when the stored registration's redirect is not
 *      localhost. So a grant obtained through a rewritten host does not merely
 *      inconvenience the next link — it makes the connector fail to start at all,
 *      forever, in every engine.
 *
 * WHAT THIS DOES INSTEAD. nassaj already IS an origin the member's browser
 * trusts: it is the page they clicked. So the whole authorization-code + PKCE
 * exchange happens here, against endpoints discovered from the MCP server's own
 * metadata, with the redirect pointing back at this server over the same scheme
 * and host the member is already using. No port, no tunnel, no terminal.
 *
 * The result is one locked grant.json consumed by nassaj's remote-bridge. No
 * engine launches mcp-remote against a shared writable store: bridge refreshes
 * are serialized across Claude/Codex processes and ambiguous rotating-token
 * outcomes fail closed until the member relinks.
 *
 * NOTHING SECRET IS LOGGED. Tokens travel from the platform's token endpoint
 * into the member's own 0600 file and nowhere else — not into the audit log,
 * not into a response body, not into an error message.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { connectorsDb, type ConnectorRow } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import type { CatalogEntry } from '../../../shared/connector-catalog.js';

import { connectorAuthDir, ensureConnectorAuthDir } from './connector-oauth.js';
import {
  assertGrantActive,
  atomicWritePrivateJson,
  GrantRevocationPendingError,
  withGrantLock,
  withGrantRequestLease,
} from './grant-file.js';
import { oauthPendingStateStore } from './oauth-pending-state.store.js';

function assertLinkNotRevoking(file: string): void {
  try {
    assertGrantActive(file);
  } catch {
    throw new AppError(
      'This connector is pending revocation. Finish cleanup or create a separate connection; the pending grant cannot be reused.',
      { code: 'CONNECTOR_OAUTH_REVOCATION_PENDING', statusCode: 409 },
    );
  }
}

type AuthServerMetadata = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopes: string[];
};

type ClientInfo = {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  [key: string]: unknown;
};

type PendingLink = {
  userId: number;
  connectorId: string;
  remoteUrl: string;
  redirectUri: string;
  codeVerifier: string;
  clientInfo: ClientInfo;
  tokenEndpoint: string;
  /** RFC 8707 applies to remote MCP OAuth, but not to Google's OAuth endpoints. */
  includeResource: boolean;
  /** Google documents client_secret in the form body; generic/Canva also use Basic. */
  useBasicClientAuth: boolean;
  startedAt: number;
};

/**
 * Resolves an operator-registered client from the environment.
 *
 * Returns null when the operator has not registered one, which the route turns
 * into a message naming the two variables and the page where the app is made —
 * the alternative is a member clicking "link" and meeting the platform's own
 * error, which explains nothing about what nassaj needs.
 */
export function resolveConfiguredClient(
  spec: NonNullable<CatalogEntry['oauthClient']>,
): { clientId: string; clientSecret?: string } | null {
  const clientId = process.env[`${spec.clientEnvPrefix}_CLIENT_ID`];
  const clientSecret = process.env[`${spec.clientEnvPrefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Where a built-in server reads its grant. One file per member per connector,
 * inside the member's own auth directory, holding the tokens and what the
 * server needs to refresh them without asking nassaj.
 */
export function grantFilePath(userId: number | string, connectorId: string): string {
  return path.join(connectorAuthDir(userId, connectorId), 'grant.json');
}

async function writeGrantFile(
  userId: number,
  connectorId: string,
  tokens: Record<string, unknown>,
  tokenEndpoint: string,
  clientInfo: ClientInfo,
  tokenAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post',
): Promise<string> {
  ensureConnectorAuthDir(userId, connectorId);
  const file = grantFilePath(userId, connectorId);
  await withGrantLock(file, () => {
    assertLinkNotRevoking(file);
    let previousRefreshToken: string | null = null;
    let generation = 0;
    try {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (typeof previous.refresh_token === 'string' && previous.refresh_token.length > 0) {
        previousRefreshToken = previous.refresh_token;
      }
      if (Number.isSafeInteger(previous.generation)) generation = Number(previous.generation);
    } catch {
      // First authorization or an unreadable legacy file: the token response is
      // authoritative. Never turn a parse failure into reuse of uncertain data.
    }
    const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600;
    atomicWritePrivateJson(file, {
      access_token: tokens.access_token,
      refresh_token:
        typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0
          ? tokens.refresh_token
          : previousRefreshToken,
      expires_at: Date.now() + expiresIn * 1000,
      token_url: tokenEndpoint,
      scope: tokens.scope ?? null,
      generation: generation + 1,
      client_id: clientInfo.client_id,
      ...(typeof clientInfo.client_secret === 'string'
        ? { client_secret: clientInfo.client_secret }
        : {}),
      token_auth_method: tokenAuthMethod,
    });
    // A completed browser authorization supplies a new authoritative grant and
    // is the recovery path for an earlier ambiguous rotating-token refresh.
    fs.rmSync(`${file}.refreshing.json`, { force: true });
  });
  return file;
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) {
    // The body of a failed OAuth call is a diagnostic, not a secret (it carries
    // an error code, never the credential), and without it the member sees
    // "something went wrong" with nothing to act on.
    const detail = await response.text().catch(() => '');
    throw new AppError(
      `${new URL(url).host} answered ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      { code: 'CONNECTOR_OAUTH_HTTP', statusCode: 502 },
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

/**
 * The remote MCP endpoint a connector proxies. Read from the stored launch
 * command rather than from a second field, so the URL the grant is obtained for
 * is BY CONSTRUCTION the URL the engines will connect to — two copies could
 * disagree and produce a grant that authorises the wrong resource.
 */
export function remoteUrlFromArgs(args: readonly string[] | undefined): string | null {
  const url = (args ?? []).find((arg) => /^https?:\/\//.test(arg));
  return url ?? null;
}

/**
 * Discovers where to authorise, following the MCP spec's two-step metadata
 * chain: the protected resource names its authorization server, and that server
 * publishes its endpoints. Falls back to the resource's own origin when the
 * first document is absent, which is what a server that predates the split does.
 */
export async function discoverAuthServer(remoteUrl: string): Promise<AuthServerMetadata> {
  const origin = new URL(remoteUrl).origin;

  let issuer = origin;
  let scopes: string[] = [];
  try {
    const resource = await fetchJson(`${origin}/.well-known/oauth-protected-resource`);
    const servers = resource.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === 'string') {
      issuer = servers[0];
    }
    if (Array.isArray(resource.scopes_supported)) {
      scopes = resource.scopes_supported.filter((s): s is string => typeof s === 'string');
    }
  } catch {
    // No protected-resource document: the resource is its own issuer.
  }

  const base = issuer.replace(/\/$/, '');
  const meta = await fetchJson(`${base}/.well-known/oauth-authorization-server`);

  const authorizationEndpoint = meta.authorization_endpoint;
  const tokenEndpoint = meta.token_endpoint;
  if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
    throw new AppError(
      `${new URL(base).host} does not publish the OAuth endpoints nassaj needs.`,
      { code: 'CONNECTOR_OAUTH_UNSUPPORTED', statusCode: 502 },
    );
  }

  if (scopes.length === 0 && Array.isArray(meta.scopes_supported)) {
    scopes = meta.scopes_supported.filter((s): s is string => typeof s === 'string');
  }

  return {
    issuer: base,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint:
      typeof meta.registration_endpoint === 'string' ? meta.registration_endpoint : null,
    scopes,
  };
}

/**
 * Registers nassaj with the platform for THIS member and THIS redirect.
 *
 * Dynamic registration is used rather than a pre-provisioned app id because the
 * redirect is the operator's own hostname: a shipped client id would carry
 * whatever redirect its author registered and would be wrong for every install
 * but one. A public client (`token_endpoint_auth_method: none`) with PKCE is the
 * correct shape here — there is no server-side secret nassaj could keep that the
 * platform would treat as confidential across installs.
 */
async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<ClientInfo> {
  const registered = await fetchJson(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'nassaj',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (typeof registered.client_id !== 'string') {
    throw new AppError('The platform did not return a client id.', {
      code: 'CONNECTOR_OAUTH_REGISTRATION',
      statusCode: 502,
    });
  }
  return registered as ClientInfo;
}

/**
 * Starts a link and returns the URL the member must open.
 *
 * The verifier stays HERE, in nassaj's private short-lived state store, and
 * never reaches the browser. Persistence lets the callback survive a restart
 * or land on another process; atomic consume still makes it single-use. That is
 * the point of PKCE: an intercepted authorization code lacks the second half of
 * the proof.
 */
export async function beginLink(input: {
  userId: number;
  connectorId: string;
  remoteUrl: string;
  redirectUri: string;
  /**
   * Set for a platform that refuses to self-register a public redirect. Then
   * there is no discovery and no registration: the endpoints are known and the
   * client is the operator's own app.
   */
  configuredClient?: CatalogEntry['oauthClient'];
  /** True when the grant is consumed by a server nassaj ships, not mcp-remote. */
  builtIn?: boolean;
}): Promise<{ authorizeUrl: string; state: string }> {
  assertLinkNotRevoking(grantFilePath(input.userId, input.connectorId));
  if (input.builtIn !== true) {
    throw new AppError(
      'This OAuth connector is not managed by nassaj’s locked bridge and cannot be linked safely.',
      { code: 'CONNECTOR_OAUTH_UNMANAGED', statusCode: 409 },
    );
  }

  const configured = input.configuredClient ? resolveConfiguredClient(input.configuredClient) : null;
  const googleProfile = input.configuredClient?.providerProfile === 'google';

  let clientInfo: ClientInfo;
  let tokenEndpoint: string;
  let authorizationEndpoint: string;
  let scopes: readonly string[];

  if (configured) {
    clientInfo = {
      client_id: configured.clientId,
      ...(configured.clientSecret ? { client_secret: configured.clientSecret } : {}),
      redirect_uris: [input.redirectUri],
    };
    authorizationEndpoint = input.configuredClient!.authorizeUrl;
    tokenEndpoint = input.configuredClient!.tokenUrl;
    scopes = input.configuredClient!.scopes;
  } else {
    const meta = await discoverAuthServer(input.remoteUrl);
    if (!meta.registrationEndpoint) {
      throw new AppError(
        'This platform does not accept self-registration, so it needs an app registered by hand.',
        { code: 'CONNECTOR_OAUTH_NO_REGISTRATION', statusCode: 400 },
      );
    }
    clientInfo = await registerClient(meta.registrationEndpoint, input.redirectUri);
    authorizationEndpoint = meta.authorizationEndpoint;
    tokenEndpoint = meta.tokenEndpoint;
    scopes = meta.scopes;
  }

  const meta = { authorizationEndpoint, tokenEndpoint, scopes };

  const codeVerifier = base64url(crypto.randomBytes(64));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(32));

  const authorizeUrl = new URL(meta.authorizationEndpoint);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientInfo.client_id);
  authorizeUrl.searchParams.set('redirect_uri', input.redirectUri);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', state);
  if (meta.scopes.length > 0) {
    authorizeUrl.searchParams.set('scope', meta.scopes.join(' '));
  }
  if (googleProfile) {
    authorizeUrl.searchParams.set('access_type', 'offline');
    authorizeUrl.searchParams.set('include_granted_scopes', 'true');
    // Google returns a refresh token on the first offline consent. Ask for
    // consent again only when the connector has no durable refresh credential;
    // a permanent prompt would needlessly re-consent on every reconnect.
    let hasRefreshToken = false;
    try {
      const grant = JSON.parse(
        fs.readFileSync(grantFilePath(input.userId, input.connectorId), 'utf8'),
      ) as Record<string, unknown>;
      hasRefreshToken = typeof grant.refresh_token === 'string' && grant.refresh_token.length > 0;
    } catch {
      // No readable grant means we cannot rely on a refresh token being present.
    }
    if (!hasRefreshToken) authorizeUrl.searchParams.set('prompt', 'consent');
  } else {
    // RFC 8707: bind a generic MCP/Canva grant to its protected resource.
    authorizeUrl.searchParams.set('resource', input.remoteUrl);
  }

  // Persisting pending state is intentionally the final fallible step. Callers
  // may safely remove a row they just created when discovery/registration/URL
  // construction fails; once this succeeds, the callback owns that row.
  oauthPendingStateStore().put(state, {
    userId: input.userId,
    connectorId: input.connectorId,
    remoteUrl: input.remoteUrl,
    redirectUri: input.redirectUri,
    codeVerifier,
    clientInfo,
    tokenEndpoint: meta.tokenEndpoint,
    includeResource: !googleProfile,
    useBasicClientAuth: !googleProfile,
    startedAt: Date.now(),
  });

  return { authorizeUrl: authorizeUrl.toString(), state };
}

/**
 * Finishes a link: exchanges the code and seeds the grant.
 *
 * The state lookup is also the authorisation check. The callback arrives with no
 * session (the browser is coming back from the platform), so WHO this grant
 * belongs to is decided by the unguessable value nassaj generated at the start —
 * never by anything the request carries about itself.
 */
type OAuthSourceGate = {
  get(id: string): Pick<ConnectorRow, 'id' | 'credentialMode' | 'ownerUserId' | 'sourceRevision'> | null;
  beginSourceMutation(id: string, expectedEvenRevision?: number): number | null;
  finishSourceMutation(id: string, oddRevision: number): number | null;
};

export async function completeLink(input: {
  state: string;
  code: string;
  /** Test seam; production always uses the durable connector repository. */
  sourceGate?: OAuthSourceGate;
}): Promise<{ userId: number; connectorId: string }> {
  const link = oauthPendingStateStore().consume(input.state);
  if (!link) {
    throw new AppError(
      'This link has expired or was already used. Start it again from the connectors page.',
      { code: 'CONNECTOR_OAUTH_STATE_UNKNOWN', statusCode: 400 },
    );
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: link.redirectUri,
    client_id: link.clientInfo.client_id,
    code_verifier: link.codeVerifier,
  });
  if (link.includeResource) body.set('resource', link.remoteUrl);
  if (typeof link.clientInfo.client_secret === 'string') {
    body.set('client_secret', link.clientInfo.client_secret);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (typeof link.clientInfo.client_secret === 'string' && link.useBasicClientAuth) {
    // A confidential client authenticates the TOKEN call, not the redirect.
    // Canva expects Basic as well as the form field. Google is deliberately
    // excluded because its documented client_secret_post flow needs no Basic.
    headers.Authorization = `Basic ${Buffer.from(
      `${link.clientInfo.client_id}:${link.clientInfo.client_secret}`,
    ).toString('base64')}`;
  }

  const file = grantFilePath(link.userId, link.connectorId);
  try {
    return await withGrantRequestLease(file, async () => {
    const tokens = await fetchJson(link.tokenEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });

    if (typeof tokens.access_token !== 'string') {
      throw new AppError('The platform did not return an access token.', {
        code: 'CONNECTOR_OAUTH_NO_TOKEN',
        statusCode: 502,
      });
    }

    // The network exchange stays outside the source seqlock. Only promotion of
    // the durable grant makes the revision odd, so a slow platform cannot block
    // metadata operations while no local credential is changing.
    const sourceGate = input.sourceGate ?? connectorsDb;
    const connector = sourceGate.get(link.connectorId);
    if (!connector || connector.credentialMode !== 'per_member'
      || connector.ownerUserId !== link.userId || connector.sourceRevision % 2 !== 0) {
      throw new AppError('Connector not found or its source is being changed.', {
        code: 'CONNECTOR_SOURCE_MUTATION_INCOMPLETE', statusCode: 409,
      });
    }
    const oddRevision = sourceGate.beginSourceMutation(
      connector.id,
      connector.sourceRevision,
    );
    if (oddRevision === null) {
      throw new AppError('The connector source is being changed; retry linking.', {
        code: 'CONNECTOR_SOURCE_MUTATION_INCOMPLETE', statusCode: 409,
      });
    }
    let promotionError: unknown;
    try {
      await writeGrantFile(
        link.userId,
        link.connectorId,
        tokens,
        link.tokenEndpoint,
        link.clientInfo,
        typeof link.clientInfo.client_secret !== 'string'
          ? 'none'
          : link.useBasicClientAuth
            ? 'client_secret_basic'
            : 'client_secret_post',
      );
    } catch (error) {
      promotionError = error;
    }
    if (sourceGate.finishSourceMutation(connector.id, oddRevision) === null) {
      throw new AppError('The connector source mutation could not be finalized.', {
        code: 'CONNECTOR_SOURCE_MUTATION_INCOMPLETE', statusCode: 409,
      });
    }
    if (promotionError !== undefined) throw promotionError;

      return { userId: link.userId, connectorId: link.connectorId };
    });
  } catch (error) {
    if (error instanceof GrantRevocationPendingError) {
      throw new AppError(
        'This connector is pending revocation. The token exchange did not start.',
        { code: 'CONNECTOR_OAUTH_REVOCATION_PENDING', statusCode: 409 },
      );
    }
    throw error;
  }
}

/** Test seam: how many links are waiting. Never exposes their contents. */
export function pendingLinkCount(): number {
  return oauthPendingStateStore().count();
}
