/**
 * Client shapes of the owner SSO settings API (ADR-194 D8, server/routes/settings-sso.js).
 * Field names mirror server/services/sso-settings-status.js `ssoConfigView`.
 */

export type SsoServerState = 'off' | 'active' | 'unavailable' | 'paused';
export type SsoClientAuth = 'none' | 'client_secret_basic' | 'client_secret_post';
export type SsoTenantMode = 'none' | 'claim' | 'role_grant_scope';
export type SsoLocalRole = 'admin' | 'user';

export type SsoRoleRule = { value: string; role: SsoLocalRole };

export type SsoDiscoveryFlags = {
  authorization_response_iss_parameter_supported?: boolean;
  backchannel_logout_supported?: boolean;
  token_endpoint_auth_methods_supported?: string[] | null;
  code_challenge_methods_supported?: string[] | null;
};

export type SsoPinnedEndpoints = {
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
};

export type SsoConfigView = {
  slot: 'active' | 'draft';
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientAuth: SsoClientAuth;
  hasClientSecret: boolean;
  extraScopes: string;
  redirectUri: string | null;
  roleClaimPath: string;
  roleRules: SsoRoleRule[];
  tenantMode: SsoTenantMode;
  tenantClaimPath: string | null;
  tenantValues: string[];
  jitEnabled: boolean;
  attestationMaxAgeHours: number;
  allowPrivateNetwork: boolean;
  issuerPort: number | null;
  pinnedEndpoints: SsoPinnedEndpoints | null;
  discoveryFlags: SsoDiscoveryFlags | null;
  runtimeFault: string | null;
  configHash: string;
  draftVersion: number;
  version: number;
  updatedAt?: number | string | null;
  missing?: string[];
  invalidReason?: string | null;
};

export type SsoShapeFlags = {
  roleClaimObjectOfObjects?: boolean;
  authTimePresent?: boolean;
  authTimeFresh?: boolean;
};

export type SsoProof = {
  passed: boolean;
  current: boolean;
  shapeFlags: SsoShapeFlags | null;
  createdAt: number | string;
};

export type SsoApplyImpact = {
  issuerChanged: boolean;
  mappingChanged: boolean;
  reattestRequired: number;
  orphaned: number;
  jitForcedOff: boolean;
  policyEnforcedNow: boolean;
};

export type SsoStatus = {
  ssoState: SsoServerState;
  hostDisabled: boolean;
  disabledRecord: boolean;
  legacyEnvPresent: boolean;
  active: SsoConfigView | null;
  draft: SsoConfigView | null;
  redirectOriginStatus: 'ok' | 'redirect_origin_mismatch' | 'installation_origin_unconfirmed' | null;
  ourValues: {
    origin: string | null;
    originConfirmed: boolean;
    redirectUri: string | null;
    backchannelLogoutUri: string | null;
    scopes: string;
  };
  lastProofs: { discovery: SsoProof | null; signIn: SsoProof | null };
  ignoredEnv: string[];
  identityCountsByIssuer: Array<{ issuer: string; linkedUsers: number }>;
  applyImpact: SsoApplyImpact | null;
};

/** POST /draft/test-discovery answer. */
export type SsoDiscoveryResult = {
  passed: boolean;
  failure: string | null;
  failureStage?: 'discovery_unavailable' | 'jwks_unavailable' | null;
  addressCategory?: string | null;
  privateNetworkMayHelp?: boolean;
  warnings: string[];
  endpoints: SsoPinnedEndpoints | null;
  flags: SsoDiscoveryFlags | null;
  jwksKeyCount: number;
  oauthError?: string;
  /** Client-side stamp of when the check ran. */
  checkedAt?: number;
};

/** One-time display row of a test sign-in (server/services/sso-test-signin.service.js). */
export type SsoTestResult = {
  claimNames: string[];
  roleClaimValue: string[] | { tooLarge: true } | null;
  tenantClaimValue: string[] | { tooLarge: true } | null;
  mappedRole: SsoLocalRole | null;
  tenantOk: boolean;
  authTimePresent: boolean;
  authTimeFresh: boolean;
  diagnostics: string[];
  oauthError?: string;
};

/** The PUT /draft body (without step-up). */
export type SsoDraftForm = {
  issuer: string;
  clientId: string;
  clientAuth: SsoClientAuth;
  /** Typed new secret; '' keeps the saved one. Never pre-filled. */
  clientSecret: string;
  clearClientSecret: boolean;
  extraScopes: string;
  roleClaimPath: string;
  roleRules: SsoRoleRule[];
  tenantMode: SsoTenantMode;
  tenantClaimPath: string;
  /** One value per line, as typed. */
  tenantValuesText: string;
  jitEnabled: boolean;
  attestationMaxAgeHours: number;
  allowPrivateNetwork: boolean;
  /** '' means no explicit port (443). */
  issuerPort: string;
};

export type StepUpEvidence =
  | { method: 'password'; password: string }
  | { method: 'passkey'; response: unknown };

export type SsoActionFailure = {
  ok: false;
  code: string;
  status: number;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
};
export type SsoActionResult<T = unknown> = { ok: true; data: T } | SsoActionFailure;
