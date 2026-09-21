/**
 * Portable connector authentication catalog (ADR-132, M1.0).
 *
 * This module is deliberately inert: it contains no token writer, vault, DCR
 * request, or route handler.  It is the trusted, closed server-side vocabulary
 * that later milestones can execute.  Keeping URLs here means a request can
 * select a known service, but can never choose where Nassaj sends credentials.
 */

export type AuthMethod = 'dcr_pkce' | 'byo_app' | 'api_key';

export type ProviderAuthReadiness =
  | 'ready'
  | 'owner_setup_required'
  | 'unsupported'
  | 'temporarily_unavailable';

export type ProviderCertificationStatus = 'certified' | 'pending' | 'suspended';
export type ProviderCertificationReason =
  | 'dcr_live_registration_contract_unverified'
  | 'safe_identity_probe_unverified'
  | 'compound_credential_probe_unavailable'
  | 'provider_identity_contract_not_certified';

type ProviderAuthSpecCommon = Readonly<{
  profileId: string;
  services: readonly [string, ...string[]];
  expectedIssuer: string;
  allowedOrigins: readonly string[];
  source: Readonly<{
    officialUrl: string;
    verifiedAt: string;
    catalogRevision: string;
  }>;
  certification: Readonly<{
    status: ProviderCertificationStatus;
    reason?: ProviderCertificationReason;
    /** Must be explicitly true in addition to the global M1 flag. */
    featureFlag: string;
  }>;
  /**
   * Services that reuse one provider application and provider account
   * identity. This never means their scopes are granted together: each
   * service still requests and records its own incremental scope grant.
   */
  accountBundle?: Readonly<{
    id: string;
    label: string;
    sharedApplicationIdentity: true;
    sharedAccountIdentity: true;
    scopeGrantPolicy: 'per_service_incremental';
  }>;
}>;

export type DcrPkceSpec = ProviderAuthSpecCommon & Readonly<{
  method: 'dcr_pkce';
  /** Certified least-privilege scopes; discovery may never broaden this list. */
  minimumScopes: readonly [string, ...string[]];
  endpoints: Readonly<{
    resource: string;
    protectedResourceMetadata: string;
    authorizationServerMetadata: string;
  }>;
  /** Exact values discovered metadata must match before DCR can be enabled. */
  metadataExpectations: Readonly<{
    resource: string;
    authorizationServer: string;
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint: string;
    revocationEndpoint: string;
    codeChallengeMethod: 'S256';
    tokenEndpointAuthMethod: 'none';
  }>;
}>;

export type ByoAppSpec = ProviderAuthSpecCommon & Readonly<{
  method: 'byo_app';
  identity: Readonly<{
    method: 'oidc';
    discoveryEndpoint: string;
    jwksUri: string;
  }> | Readonly<{
    method: 'unavailable';
    reason: 'provider_identity_contract_not_certified';
  }>;
  endpoints: Readonly<{
    authorization: string;
    token: string;
    appRegistration: string;
    revocation?: string;
    calendarResource?: string;
    driveResource?: string;
    gmailResource?: string;
  }>;
}>;

export type ApiKeySpec = ProviderAuthSpecCommon & Readonly<{
  method: 'api_key';
  endpoints: Readonly<{ credentialHelp: string }>;
  /** A key is actionable only after its least-privilege service probe is certified. */
  serviceProbe: Readonly<{
    status: ProviderCertificationStatus;
    reason?: ProviderCertificationReason;
    endpoint?: string;
    method?: 'GET' | 'POST';
    credentialHeader?: 'authorization' | 'x-figma-token' | 'api-key';
    credentialPrefix?: 'Bearer ' | 'Api-Key ' | '';
    staticHeaders?: Readonly<Record<string, string>>;
    /** Documentary contract only; pending probes remain non-executable. */
    verificationContract?: Readonly<{
      endpoint: string;
      method: 'GET' | 'POST';
      credentialHeader: 'authorization' | 'x-figma-token' | 'api-key';
      credentialPrefix: 'Bearer ' | 'Api-Key ' | '';
      identitySemantics: readonly ['user', 'store'];
    }>;
  }>;
}>;

/** Closed discriminated union: adding a method requires an exhaustive handler. */
export type ProviderAuthSpec = DcrPkceSpec | ByoAppSpec | ApiKeySpec;

export const CONNECTOR_AUTH_REGISTRY_FLAG = 'NASSAJ_CONNECTOR_AUTH_REGISTRY_V1';
export const CONNECTOR_AUTH_CATALOG_REVISION = '2026-08-26.m1';
const VERIFIED_AT = '2026-08-26';

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};

const apiKeySpec = (
  profileId: string,
  service: string,
  officialUrl: string,
  expectedIssuer: string,
  probe: Readonly<{
    endpoint: string;
    method: 'GET' | 'POST';
    credentialHeader: 'authorization' | 'x-figma-token' | 'api-key';
    credentialPrefix: 'Bearer ' | 'Api-Key ' | '';
    staticHeaders?: Readonly<Record<string, string>>;
  }> | null = null,
  pendingReason: ProviderCertificationReason = 'safe_identity_probe_unverified',
  verificationContract?: ApiKeySpec['serviceProbe']['verificationContract'],
): ApiKeySpec => deepFreeze({
  profileId,
  services: [service],
  method: 'api_key',
  endpoints: { credentialHelp: officialUrl },
  serviceProbe: probe
    ? { status: 'certified', ...probe }
    : { status: 'pending', reason: pendingReason, ...(verificationContract ? { verificationContract } : {}) },
  expectedIssuer,
  allowedOrigins: [...new Set([
    new URL(officialUrl).origin,
    new URL(expectedIssuer).origin,
    ...(probe ? [new URL(probe.endpoint).origin] : []),
    ...(verificationContract ? [new URL(verificationContract.endpoint).origin] : []),
  ])],
  source: {
    officialUrl,
    verifiedAt: VERIFIED_AT,
    catalogRevision: CONNECTOR_AUTH_CATALOG_REVISION,
  },
  certification: {
    status: 'certified',
    featureFlag: `NASSAJ_CONNECTOR_AUTH_CERT_${profileId.toUpperCase().replace(/-/g, '_')}`,
  },
});

const dcrSpec = (input: {
  profileId: string;
  service: string;
  resource: string;
  expectedIssuer: string;
  allowedOrigins: readonly string[];
  officialUrl: string;
  protectedResourceMetadata: string;
  authorizationServerMetadata: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string;
  minimumScopes: readonly [string, ...string[]];
}): DcrPkceSpec => deepFreeze({
  profileId: input.profileId,
  services: [input.service],
  method: 'dcr_pkce',
  minimumScopes: input.minimumScopes,
  endpoints: {
    resource: input.resource,
    protectedResourceMetadata: input.protectedResourceMetadata,
    authorizationServerMetadata: input.authorizationServerMetadata,
  },
  metadataExpectations: {
    resource: input.resource,
    authorizationServer: input.expectedIssuer,
    issuer: input.expectedIssuer,
    authorizationEndpoint: input.authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint,
    registrationEndpoint: input.registrationEndpoint,
    revocationEndpoint: input.revocationEndpoint,
    codeChallengeMethod: 'S256',
    tokenEndpointAuthMethod: 'none',
  },
  expectedIssuer: input.expectedIssuer,
  allowedOrigins: [...input.allowedOrigins],
  source: {
    officialUrl: input.officialUrl,
    verifiedAt: VERIFIED_AT,
    catalogRevision: CONNECTOR_AUTH_CATALOG_REVISION,
  },
  certification: {
    // Definitions exist for validation and certification work, but M1 cannot
    // execute them until its provider-specific conformance suite is approved.
    status: 'pending',
    reason: 'dcr_live_registration_contract_unverified',
    featureFlag: `NASSAJ_CONNECTOR_AUTH_CERT_${input.profileId.toUpperCase().replace(/-/g, '_')}`,
  },
});

export const PROVIDER_AUTH_SPECS: readonly ProviderAuthSpec[] = deepFreeze([
  dcrSpec({
    profileId: 'notion', service: 'notion', resource: 'https://mcp.notion.com/mcp',
    expectedIssuer: 'https://mcp.notion.com', allowedOrigins: ['https://mcp.notion.com'],
    officialUrl: 'https://developers.notion.com/docs/get-started-with-mcp',
    protectedResourceMetadata: 'https://mcp.notion.com/.well-known/oauth-protected-resource/mcp',
    authorizationServerMetadata: 'https://mcp.notion.com/.well-known/oauth-authorization-server',
    authorizationEndpoint: 'https://mcp.notion.com/authorize',
    tokenEndpoint: 'https://mcp.notion.com/token',
    registrationEndpoint: 'https://mcp.notion.com/register',
    revocationEndpoint: 'https://mcp.notion.com/token',
    minimumScopes: ['default'],
  }),
  apiKeySpec('github', 'github', 'https://github.com/settings/tokens', 'https://github.com', {
    endpoint: 'https://api.github.com/user', method: 'GET',
    credentialHeader: 'authorization', credentialPrefix: 'Bearer ',
    staticHeaders: {
      accept: 'application/vnd.github+json',
      'user-agent': 'nassaj-connector-probe',
      'x-github-api-version': '2022-11-28',
    },
  }),
  apiKeySpec('slack', 'slack', 'https://api.slack.com/apps', 'https://slack.com', {
    endpoint: 'https://slack.com/api/auth.test', method: 'POST',
    credentialHeader: 'authorization', credentialPrefix: 'Bearer ',
  }),
  apiKeySpec('figma', 'figma', 'https://www.figma.com/developers/api#access-tokens', 'https://www.figma.com', {
    endpoint: 'https://api.figma.com/v1/me', method: 'GET',
    credentialHeader: 'x-figma-token', credentialPrefix: '',
  }),
  {
    profileId: 'canva',
    services: ['canva'],
    method: 'byo_app',
    identity: Object.freeze({
      method: 'unavailable',
      reason: 'provider_identity_contract_not_certified',
    }),
    endpoints: Object.freeze({
      authorization: 'https://www.canva.com/api/oauth/authorize',
      token: 'https://api.canva.com/rest/v1/oauth/token',
      appRegistration: 'https://www.canva.com/developers/integrations',
      revocation: 'https://api.canva.com/rest/v1/oauth/revoke',
    }),
    expectedIssuer: 'https://www.canva.com',
    allowedOrigins: Object.freeze(['https://www.canva.com', 'https://api.canva.com']),
    source: Object.freeze({
      officialUrl: 'https://www.canva.dev/docs/connect/authentication/',
      verifiedAt: VERIFIED_AT,
      catalogRevision: CONNECTOR_AUTH_CATALOG_REVISION,
    }),
    certification: Object.freeze({
      status: 'suspended',
      featureFlag: 'NASSAJ_CONNECTOR_AUTH_CERT_CANVA',
    }),
  },
  apiKeySpec('wafeq', 'wafeq', 'https://app.wafeq.com/settings/api-keys', 'https://app.wafeq.com', {
    endpoint: 'https://api.wafeq.com/v1/organization/', method: 'GET',
    credentialHeader: 'authorization', credentialPrefix: 'Api-Key ',
  }),
  apiKeySpec('stripe', 'stripe', 'https://dashboard.stripe.com/apikeys', 'https://dashboard.stripe.com', {
    endpoint: 'https://api.stripe.com/v1/account', method: 'GET',
    credentialHeader: 'authorization', credentialPrefix: 'Bearer ',
  }),
  dcrSpec({
    profileId: 'sentry', service: 'sentry', resource: 'https://mcp.sentry.dev/mcp',
    expectedIssuer: 'https://mcp.sentry.dev',
    allowedOrigins: ['https://mcp.sentry.dev', 'https://sentry.io'],
    officialUrl: 'https://docs.sentry.io/product/sentry-mcp/',
    protectedResourceMetadata: 'https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp',
    authorizationServerMetadata: 'https://mcp.sentry.dev/.well-known/oauth-authorization-server',
    authorizationEndpoint: 'https://mcp.sentry.dev/oauth/authorize',
    tokenEndpoint: 'https://mcp.sentry.dev/oauth/token',
    registrationEndpoint: 'https://mcp.sentry.dev/oauth/register',
    revocationEndpoint: 'https://mcp.sentry.dev/oauth/token',
    minimumScopes: ['org:read'],
  }),
  dcrSpec({
    profileId: 'linear', service: 'linear', resource: 'https://mcp.linear.app/mcp',
    expectedIssuer: 'https://mcp.linear.app',
    allowedOrigins: ['https://mcp.linear.app', 'https://linear.app'],
    officialUrl: 'https://linear.app/docs/mcp',
    protectedResourceMetadata: 'https://mcp.linear.app/.well-known/oauth-protected-resource/mcp',
    authorizationServerMetadata: 'https://mcp.linear.app/.well-known/oauth-authorization-server',
    authorizationEndpoint: 'https://mcp.linear.app/authorize',
    tokenEndpoint: 'https://mcp.linear.app/token',
    registrationEndpoint: 'https://mcp.linear.app/register',
    revocationEndpoint: 'https://mcp.linear.app/token',
    minimumScopes: ['read'],
  }),
  dcrSpec({
    profileId: 'atlassian', service: 'atlassian',
    resource: 'https://mcp.atlassian.com/v1/mcp/authv2',
    expectedIssuer: 'https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3',
    allowedOrigins: ['https://mcp.atlassian.com', 'https://auth.atlassian.com'],
    officialUrl: 'https://support.atlassian.com/atlassian-rovo-mcp-server/',
    protectedResourceMetadata: 'https://mcp.atlassian.com/.well-known/oauth-protected-resource/v1/mcp/authv2',
    authorizationServerMetadata: 'https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/.well-known/oauth-authorization-server',
    authorizationEndpoint: 'https://auth.atlassian.com/authorize',
    tokenEndpoint: 'https://auth.atlassian.com/oauth/token',
    registrationEndpoint: 'https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register',
    revocationEndpoint: 'https://auth.atlassian.com/oauth/revoke',
    minimumScopes: ['read:jira-work'],
  }),
  apiKeySpec(
    'salla', 'salla', 'https://salla.dev/', 'https://salla.dev',
    null, 'safe_identity_probe_unverified', {
      endpoint: 'https://api.salla.dev/admin/v2/oauth2/user/info',
      method: 'GET', credentialHeader: 'authorization', credentialPrefix: 'Bearer ',
      identitySemantics: ['user', 'store'],
    },
  ),
  apiKeySpec('infomaniak-mail', 'infomaniak-mail', 'https://manager.infomaniak.com/v3/ng/accounts/token/list', 'https://manager.infomaniak.com'),
  apiKeySpec('infomaniak-contacts', 'infomaniak-contacts', 'https://manager.infomaniak.com/v3/ng/accounts/token/list', 'https://manager.infomaniak.com'),
  apiKeySpec('viator', 'viator', 'https://partnerresources.viator.com/', 'https://partnerresources.viator.com'),
  apiKeySpec('getyourguide', 'getyourguide', 'https://supplier.getyourguide.com/', 'https://supplier.getyourguide.com'),
  apiKeySpec('tamara', 'tamara', 'https://docs.tamara.co/docs/direct-quick-start-guide', 'https://docs.tamara.co'),
  apiKeySpec(
    'geidea', 'geidea', 'https://docs.geidea.net/docs/pre-requisites', 'https://docs.geidea.net',
    null, 'compound_credential_probe_unavailable',
  ),
  {
    profileId: 'google-workspace',
    services: ['google-calendar', 'google-drive', 'gmail'],
    method: 'byo_app',
    identity: Object.freeze({
      method: 'oidc',
      discoveryEndpoint: 'https://accounts.google.com/.well-known/openid-configuration',
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    }),
    endpoints: Object.freeze({
      authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      appRegistration: 'https://console.cloud.google.com/apis/credentials',
      revocation: 'https://oauth2.googleapis.com/revoke',
      calendarResource: 'https://calendarmcp.googleapis.com/mcp/v1',
      driveResource: 'https://drivemcp.googleapis.com/mcp/v1',
      gmailResource: 'https://gmailmcp.googleapis.com/mcp/v1',
    }),
    expectedIssuer: 'https://accounts.google.com',
    allowedOrigins: Object.freeze([
      'https://accounts.google.com',
      'https://oauth2.googleapis.com',
      'https://www.googleapis.com',
      'https://console.cloud.google.com',
      'https://calendarmcp.googleapis.com',
      'https://drivemcp.googleapis.com',
      'https://gmailmcp.googleapis.com',
    ]),
    source: Object.freeze({
      officialUrl: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
      verifiedAt: VERIFIED_AT,
      catalogRevision: CONNECTOR_AUTH_CATALOG_REVISION,
    }),
    certification: Object.freeze({
      status: 'certified',
      featureFlag: 'NASSAJ_CONNECTOR_AUTH_CERT_GOOGLE_WORKSPACE',
    }),
    accountBundle: {
      id: 'google-workspace',
      label: 'Google Workspace',
      sharedApplicationIdentity: true,
      sharedAccountIdentity: true,
      scopeGrantPolicy: 'per_service_incremental',
    },
  },
]);

const SPEC_BY_SERVICE = new Map<string, ProviderAuthSpec>();
for (const spec of PROVIDER_AUTH_SPECS) {
  for (const service of spec.services) {
    if (SPEC_BY_SERVICE.has(service)) throw new Error(`Duplicate provider auth service: ${service}`);
    SPEC_BY_SERVICE.set(service, spec);
  }
}

/** Exact lookup; unknown/user-invented providers are rejected, never inferred. */
export const providerAuthSpecFor = (service: string): ProviderAuthSpec | null =>
  SPEC_BY_SERVICE.get(service) ?? null;

export const isProviderAuthRegistryEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => env[CONNECTOR_AUTH_REGISTRY_FLAG] === '1';

/** Per-provider certification is fail-closed and OFF in a fresh install. */
export const isProviderAuthSpecCertified = (
  spec: ProviderAuthSpec,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => spec.certification.status === 'certified' && env[spec.certification.featureFlag] === '1';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const includesString = (value: unknown, expected: string): boolean =>
  Array.isArray(value) && value.includes(expected);

/**
 * Validates live RFC 9728 / RFC 8414 discovery against the certified exact
 * contract. A DCR provider must pass this check before its pending certificate
 * may be promoted; redirects or endpoint changes therefore fail closed.
 */
export const validateDcrMetadataForActivation = (
  spec: DcrPkceSpec,
  protectedResourceMetadata: unknown,
  authorizationServerMetadata: unknown,
): boolean => {
  if (!isRecord(protectedResourceMetadata) || !isRecord(authorizationServerMetadata)) return false;
  const expected = spec.metadataExpectations;
  return protectedResourceMetadata.resource === expected.resource
    && includesString(protectedResourceMetadata.authorization_servers, expected.authorizationServer)
    && authorizationServerMetadata.issuer === expected.issuer
    && authorizationServerMetadata.authorization_endpoint === expected.authorizationEndpoint
    && authorizationServerMetadata.token_endpoint === expected.tokenEndpoint
    && authorizationServerMetadata.registration_endpoint === expected.registrationEndpoint
    && authorizationServerMetadata.revocation_endpoint === expected.revocationEndpoint
    && spec.minimumScopes.every(scope => includesString(authorizationServerMetadata.scopes_supported, scope))
    && includesString(authorizationServerMetadata.code_challenge_methods_supported, expected.codeChallengeMethod)
    && includesString(authorizationServerMetadata.token_endpoint_auth_methods_supported, expected.tokenEndpointAuthMethod);
};

const assertNever = (value: never): never => {
  throw new Error(`Unhandled provider auth method: ${String(value)}`);
};

/** Additive M1 metadata only; no existing connector path consumes this yet. */
export const providerAuthReadiness = (
  spec: ProviderAuthSpec,
  env: Readonly<Record<string, string | undefined>> = process.env,
  profileReady = false,
): ProviderAuthReadiness => {
  if (!isProviderAuthRegistryEnabled(env) || !isProviderAuthSpecCertified(spec, env)) return 'unsupported';
  switch (spec.method) {
    case 'byo_app': return profileReady ? 'ready' : 'owner_setup_required';
    case 'dcr_pkce': return profileReady ? 'ready' : 'owner_setup_required';
    case 'api_key':
      if (spec.serviceProbe.status === 'certified') return 'ready';
      return spec.serviceProbe.status === 'pending' ? 'temporarily_unavailable' : 'unsupported';
    default: return assertNever(spec);
  }
};
