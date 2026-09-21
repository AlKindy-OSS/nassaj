import { randomUUID } from 'node:crypto';

import {
  CONNECTOR_AUTH_CATALOG_REVISION,
  PROVIDER_AUTH_SPECS,
  isProviderAuthRegistryEnabled,
  isProviderAuthSpecCertified,
  providerAuthReadiness,
  type AuthMethod,
  type DcrPkceSpec,
  type ProviderAuthReadiness,
  type ProviderAuthSpec,
} from '../../../shared/connector-auth-registry.js';

import {
  encryptConnectorVaultSecret,
  type ConnectorKekKeyring,
  type ConnectorVaultEnvelope,
} from './connector-auth-vault.crypto.js';
import {
  fetchCertifiedProviderMetadata,
  safeFetchProviderJson,
} from './connector-auth-safe-fetch.js';
import {
  CONNECTOR_OAUTH_CALLBACK_PATH,
} from './connector-auth-security.js';
import {
  consumeAuthorizedOwnerOperation,
  type AuthorizedOwnerOperation,
  type ConnectorOwnerOperation,
} from './connector-owner-operation-gate.js';
import { executeConnectorPolicyV2SynchronousWrite } from './connector-substrate-only.production.js';

const LEASE_TTL_SECONDS = 60;
const BYO_PROVIDERS = new Set(['google-workspace', 'canva']);
const DCR_PROVIDERS = new Set(['notion', 'sentry', 'linear', 'atlassian']);

export class ConnectorProfileManagementError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ConnectorProfileManagementError';
  }
}

export type ConnectorProfileSecretPurpose =
  | 'client_id'
  | 'client_secret'
  | 'registration_access_token'
  | 'registration_client_uri'
  | 'client_secret_expires_at'
  | 'api_key';

export type ConnectorProfileLease = Readonly<{
  leaseKey: string;
  ownerToken: string;
  fencingToken: number;
  expiresAt: string;
}>;

export type ManagedConnectorProfile = Readonly<{
  profileId: string;
  installationId: string;
  providerId: string;
  canonicalOrigin: string;
  status: 'pending' | 'ready' | 'disabled' | 'error';
  catalogRevision: string;
  secretRef: string | null;
  secretRevision: number | null;
  version: number;
  secretRefs: Readonly<Partial<Record<ConnectorProfileSecretPurpose, string>>>;
}>;

export type ConnectorProfileDto = Readonly<{
  providerId: string;
  services: readonly string[];
  authMethod: AuthMethod;
  readiness: ProviderAuthReadiness;
  configured: boolean;
  status: ManagedConnectorProfile['status'] | 'not_configured';
}>;

type MaybePromise<T> = T | Promise<T>;

export interface ConnectorProfileRepository {
  listProfiles(installationId: string): MaybePromise<readonly ManagedConnectorProfile[]>;
  findProfile(installationId: string, providerId: string): MaybePromise<ManagedConnectorProfile | null>;
  acquireLease(leaseKey: string, ownerToken: string, ttlSeconds: number): MaybePromise<ConnectorProfileLease | null>;
  releaseLease(fence: ConnectorProfileLease): MaybePromise<boolean>;
  consumeOwnerOperation(input: Readonly<{
    nonceHash: string; requestId: string; sessionId: string; installationId: string;
    userId: number; operation: ConnectorOwnerOperation; nowMs: number;
  }>): boolean;
  createPendingProfile(input: Readonly<{
    profileId: string;
    installationId: string;
    providerId: string;
    canonicalOrigin: string;
    catalogRevision: string;
    fence: ConnectorProfileLease;
  }>): MaybePromise<ManagedConnectorProfile | null>;
  /**
   * B-848: fence-free idempotent creator of a `ready` api_key profile row keyed
   * on (installation, provider, origin) with `ON CONFLICT DO NOTHING`. Optional
   * so existing repository fakes need not implement it; the production adapter
   * always does.
   */
  ensureApiKeyGrantProfile?(input: Readonly<{
    profileId: string;
    installationId: string;
    providerId: string;
    canonicalOrigin: string;
    catalogRevision: string;
  }>): ManagedConnectorProfile;
  stageVaultSecret(input: Readonly<{
    secretRef: string;
    installationId: string;
    providerId: string;
    profileId: string;
    fieldPurpose: ConnectorProfileSecretPurpose;
    secretKind: string;
    envelope: ConnectorVaultEnvelope;
    fence: ConnectorProfileLease;
  }>): MaybePromise<boolean>;
  activateProfile(input: Readonly<{
    profileId: string;
    expectedVersion: number;
    catalogRevision: string;
    secretRefs: Readonly<Partial<Record<ConnectorProfileSecretPurpose, string>>>;
    fence: ConnectorProfileLease;
  }>): MaybePromise<ManagedConnectorProfile | null>;
  disableProfile(input: Readonly<{
    profileId: string;
    expectedVersion: number;
    fence: ConnectorProfileLease;
  }>): MaybePromise<ManagedConnectorProfile | null>;
}

export type ByoCandidate = Readonly<{
  spec: ProviderAuthSpec & { method: 'byo_app' };
  callbackUrl: string;
  clientId: string;
  clientSecret: string;
}>;

export type ApiKeyCandidate = Readonly<{
  spec: ProviderAuthSpec & { method: 'api_key' };
  apiKey: string;
  ownership: 'installation_shared';
}>;

export type ConnectorProfileManagementDependencies = Readonly<{
  installation: Readonly<{ installationId: string; canonicalOrigin: string; callbackUrl: string }>;
  repository: ConnectorProfileRepository;
  keyring: ConnectorKekKeyring;
  env?: Readonly<Record<string, string | undefined>>;
  ids?: () => string;
  now?: () => number;
  testByoCandidate: (candidate: ByoCandidate) => Promise<void>;
  testApiKeyCandidate: (candidate: ApiKeyCandidate) => Promise<void>;
  /** Policy V2 certification authority. When supplied, ambient feature flags are ignored. */
  providerCertified?: (providerId: string, method: AuthMethod) => boolean;
}>;

type DcrRegistration = Readonly<{
  client_id: string;
  client_secret?: string;
  registration_access_token?: string;
  registration_client_uri?: string;
  client_secret_expires_at?: number;
}>;

const authorizeOwner = (
  deps: ConnectorProfileManagementDependencies,
  authority: AuthorizedOwnerOperation,
  operation: ConnectorOwnerOperation,
): void => {
  try {
    consumeAuthorizedOwnerOperation(authority, operation, {
      repository: deps.repository,
      installationId: deps.installation.installationId,
      now: deps.now,
    });
  } catch {
    throw new ConnectorProfileManagementError('connector_profile_owner_verification_failed');
  }
};

const canonicalProviderOrigin = (spec: ProviderAuthSpec): string => new URL(spec.expectedIssuer).origin;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const validProviderId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);

const validSecretInput = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength && !value.includes('\0');

const leaseKeyFor = (installationId: string, providerId: string): string =>
  `profile-provider:${installationId}:${providerId}`;

const profileAuthSpecFor = (providerId: string): ProviderAuthSpec | null =>
  PROVIDER_AUTH_SPECS.find(spec => spec.profileId === providerId) ?? null;

const enabledSpec = (
  providerId: string,
  method: AuthMethod,
  env: Readonly<Record<string, string | undefined>>,
  providerCertified?: (providerId: string, method: AuthMethod) => boolean,
): ProviderAuthSpec => {
  const spec = profileAuthSpecFor(providerId);
  if (!spec || spec.profileId !== providerId || spec.method !== method) {
    throw new ConnectorProfileManagementError('connector_profile_provider_not_supported');
  }
  const certified = providerCertified
    ? providerCertified(providerId, method)
    : isProviderAuthRegistryEnabled(env) && isProviderAuthSpecCertified(spec, env);
  if (!certified) {
    throw new ConnectorProfileManagementError('connector_profile_provider_not_certified');
  }
  if (spec.method === 'api_key' && spec.serviceProbe.status !== 'certified') {
    throw new ConnectorProfileManagementError('connector_profile_provider_not_certified');
  }
  return spec;
};

const validateComposition = (deps: ConnectorProfileManagementDependencies): void => {
  const origin = new URL(deps.installation.canonicalOrigin);
  const callback = new URL(deps.installation.callbackUrl);
  if (origin.origin !== deps.installation.canonicalOrigin
    || callback.origin !== origin.origin
    || callback.pathname !== CONNECTOR_OAUTH_CALLBACK_PATH
    || callback.search || callback.hash) {
    throw new ConnectorProfileManagementError('connector_profile_composition_invalid');
  }
};

const requireLease = async (
  deps: ConnectorProfileManagementDependencies,
  providerId: string,
): Promise<ConnectorProfileLease> => {
  const ownerToken = (deps.ids ?? randomUUID)();
  const lease = await deps.repository.acquireLease(
    leaseKeyFor(deps.installation.installationId, providerId), ownerToken, LEASE_TTL_SECONDS,
  );
  if (!lease) throw new ConnectorProfileManagementError('connector_profile_write_in_progress');
  return lease;
};

const ensureProfile = async (
  deps: ConnectorProfileManagementDependencies,
  spec: ProviderAuthSpec,
  fence: ConnectorProfileLease,
): Promise<ManagedConnectorProfile> => {
  const existing = await deps.repository.findProfile(deps.installation.installationId, spec.profileId);
  if (existing) return existing;
  const created = await deps.repository.createPendingProfile({
    profileId: (deps.ids ?? randomUUID)(),
    installationId: deps.installation.installationId,
    providerId: spec.profileId,
    canonicalOrigin: canonicalProviderOrigin(spec),
    catalogRevision: CONNECTOR_AUTH_CATALOG_REVISION,
    fence,
  });
  if (!created) throw new ConnectorProfileManagementError('connector_profile_fence_stale');
  return created;
};

const encryptAndStage = async (
  deps: ConnectorProfileManagementDependencies,
  profile: ManagedConnectorProfile,
  fence: ConnectorProfileLease,
  purpose: ConnectorProfileSecretPurpose,
  plaintext: string,
): Promise<string> => {
  const secretRef = (deps.ids ?? randomUUID)();
  const bytes = Buffer.from(plaintext, 'utf8');
  try {
    const envelope = encryptConnectorVaultSecret(bytes, {
      vaultSecretId: secretRef,
      installationId: deps.installation.installationId,
      providerId: profile.providerId,
      subjectType: 'profile',
      subjectId: profile.profileId,
      profileId: profile.profileId,
      userId: null,
      fieldPurpose: purpose,
      secretRevision: 1,
    }, deps.keyring);
    const staged = await deps.repository.stageVaultSecret({
      secretRef,
      installationId: deps.installation.installationId,
      providerId: profile.providerId,
      profileId: profile.profileId,
      fieldPurpose: purpose,
      secretKind: purpose,
      envelope,
      fence,
    });
    if (!staged) throw new ConnectorProfileManagementError('connector_profile_fence_stale');
    return secretRef;
  } finally {
    bytes.fill(0);
  }
};

const stageFields = async (
  deps: ConnectorProfileManagementDependencies,
  profile: ManagedConnectorProfile,
  fence: ConnectorProfileLease,
  values: Readonly<Partial<Record<ConnectorProfileSecretPurpose, string>>>,
) => {
  const refs: Partial<Record<ConnectorProfileSecretPurpose, string>> = {};
  for (const [purpose, value] of Object.entries(values)) {
    if (value === undefined) continue;
    refs[purpose as ConnectorProfileSecretPurpose] = await encryptAndStage(
      deps, profile, fence, purpose as ConnectorProfileSecretPurpose, value,
    );
  }
  return Object.freeze(refs);
};

const activate = async (
  deps: ConnectorProfileManagementDependencies,
  profile: ManagedConnectorProfile,
  fence: ConnectorProfileLease,
  secretRefs: Readonly<Partial<Record<ConnectorProfileSecretPurpose, string>>>,
): Promise<ConnectorProfileDto> => {
  const active = await deps.repository.activateProfile({
    profileId: profile.profileId,
    expectedVersion: profile.version,
    catalogRevision: CONNECTOR_AUTH_CATALOG_REVISION,
    secretRefs,
    fence,
  });
  if (!active) throw new ConnectorProfileManagementError('connector_profile_fence_stale');
  const spec = profileAuthSpecFor(active.providerId);
  if (!spec) throw new ConnectorProfileManagementError('connector_profile_provider_not_supported');
  return profileDto(spec, active, deps.env ?? {});
};

const profileDto = (
  spec: ProviderAuthSpec,
  profile: ManagedConnectorProfile | null,
  env: Readonly<Record<string, string | undefined>>,
): ConnectorProfileDto => Object.freeze({
  providerId: spec.profileId,
  services: [...spec.services],
  authMethod: spec.method,
  readiness: providerAuthReadiness(spec, env, profile?.status === 'ready'),
  configured: profile?.status === 'ready',
  status: profile?.status ?? 'not_configured',
});

const parseDcrRegistration = (raw: unknown, spec: DcrPkceSpec): DcrRegistration => {
  if (!isRecord(raw)) throw new ConnectorProfileManagementError('connector_profile_dcr_response_invalid');
  if (typeof raw.client_id !== 'string' || raw.client_id.length < 1 || raw.client_id.length > 4096) {
    throw new ConnectorProfileManagementError('connector_profile_dcr_response_invalid');
  }
  const optional = ['client_secret', 'registration_access_token', 'registration_client_uri'] as const;
  if (optional.some(key => raw[key] !== undefined
    && (typeof raw[key] !== 'string' || raw[key].length < 1 || raw[key].length > 8192))) {
    throw new ConnectorProfileManagementError('connector_profile_dcr_response_invalid');
  }
  if ((raw.registration_access_token === undefined) !== (raw.registration_client_uri === undefined)) {
    throw new ConnectorProfileManagementError('connector_profile_dcr_response_invalid');
  }
  if (typeof raw.registration_client_uri === 'string') {
    let uri: URL;
    try {
      uri = new URL(raw.registration_client_uri);
    } catch {
      throw new ConnectorProfileManagementError('connector_profile_dcr_response_invalid');
    }
    if (uri.protocol !== 'https:' || uri.username || uri.password || uri.hash
      || !spec.allowedOrigins.includes(uri.origin)) {
      throw new ConnectorProfileManagementError('connector_profile_dcr_response_invalid');
    }
  }
  if (raw.client_secret_expires_at !== undefined
    && (!Number.isSafeInteger(raw.client_secret_expires_at) || (raw.client_secret_expires_at as number) < 0)) {
    throw new ConnectorProfileManagementError('connector_profile_dcr_response_invalid');
  }
  return raw as DcrRegistration;
};

const dcrSecretValues = (registration: DcrRegistration) => ({
  client_id: registration.client_id,
  client_secret: registration.client_secret,
  registration_access_token: registration.registration_access_token,
  registration_client_uri: registration.registration_client_uri,
  client_secret_expires_at: registration.client_secret_expires_at === undefined
    ? undefined : String(registration.client_secret_expires_at),
});

/** Exact RFC 7591 request shape shared by every certified DCR adapter. */
export const connectorDcrRegistrationRequest = (callbackUrl: string) => Object.freeze({
  client_name: 'Nassaj',
  redirect_uris: [callbackUrl],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
});

/** Core owner setup service. It returns allowlisted DTOs and never secret material. */
export const createConnectorProfileManagementService = (
  deps: ConnectorProfileManagementDependencies,
) => {
  validateComposition(deps);
  const env = deps.env ?? {};
  const registerDcr = (spec: DcrPkceSpec, request: Readonly<Record<string, unknown>>) => safeFetchProviderJson({
    spec,
    endpoint: 'registration',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(request), 'utf8'),
  });

  return {
    async list(): Promise<readonly ConnectorProfileDto[]> {
      const profiles = await deps.repository.listProfiles(deps.installation.installationId);
      const byProvider = new Map(profiles.map(profile => [profile.providerId, profile]));
      return PROVIDER_AUTH_SPECS.map(spec => profileDto(spec, byProvider.get(spec.profileId) ?? null, env));
    },

    async upsertByo(authority: AuthorizedOwnerOperation, input: Readonly<{
      providerId: 'google-workspace' | 'canva';
      clientId: string;
      clientSecret: string;
    }>): Promise<ConnectorProfileDto> {
      authorizeOwner(deps, authority, 'upsert_byo');
      if (!isRecord(input) || !validProviderId(input.providerId)
        || !BYO_PROVIDERS.has(input.providerId)
        || !validSecretInput(input.clientId, 4_096)
        || !validSecretInput(input.clientSecret, 8_192)) {
        throw new ConnectorProfileManagementError('connector_profile_candidate_invalid');
      }
      const spec = enabledSpec(input.providerId, 'byo_app', env, deps.providerCertified) as ByoCandidate['spec'];
      const fence = await requireLease(deps, spec.profileId);
      try {
        const profile = await ensureProfile(deps, spec, fence);
        const refs = await stageFields(deps, profile, fence, {
          client_id: input.clientId,
          client_secret: input.clientSecret,
        });
        try {
          await deps.testByoCandidate({
            spec, callbackUrl: deps.installation.callbackUrl,
            clientId: input.clientId, clientSecret: input.clientSecret,
          });
        } catch {
          throw new ConnectorProfileManagementError('connector_profile_candidate_test_failed');
        }
        return await activate(deps, profile, fence, refs);
      } finally {
        await deps.repository.releaseLease(fence);
      }
    },

    async registerDcr(authority: AuthorizedOwnerOperation, providerId: string): Promise<ConnectorProfileDto> {
      authorizeOwner(deps, authority, 'register_dcr');
      if (!validProviderId(providerId) || !DCR_PROVIDERS.has(providerId)) {
        throw new ConnectorProfileManagementError('connector_profile_provider_not_supported');
      }
      const spec = enabledSpec(providerId, 'dcr_pkce', env, deps.providerCertified) as DcrPkceSpec;
      const fence = await requireLease(deps, spec.profileId);
      try {
        const profile = await ensureProfile(deps, spec, fence);
        await fetchCertifiedProviderMetadata(spec);
        const registration = parseDcrRegistration(await registerDcr(
          spec,
          connectorDcrRegistrationRequest(deps.installation.callbackUrl),
        ), spec);
        const refs = await stageFields(deps, profile, fence, dcrSecretValues(registration));
        return await activate(deps, profile, fence, refs);
      } finally {
        await deps.repository.releaseLease(fence);
      }
    },

    /**
     * B-848 (mirrors B-845 / ADR-138 §ج decision 1): idempotently materialise the
     * installation-shared api_key provider profile row in the `ready` state so the
     * router can run `CredentialVerify` after it. That gate is read-only and denies
     * with `profile_unready` until a ready row exists, but the only creator lived
     * inside `upsertInstallationApiKey` — after the gate — so the first shared-key
     * save on a clean install always failed. Exposing the creator lets the router
     * run `ProfileConfigure` parity first, then this, then `CredentialVerify`,
     * without the gate ever writing.
     *
     * Owner authority and CSRF are enforced upstream by the route's owner-operation
     * gate; this materialiser performs no authorization and stages no secret, so it
     * never opens an escalation for a non-owner. Concurrency: the underlying
     * `ensureApiKeyGrantProfile` INSERTs with `ON CONFLICT DO NOTHING` keyed on
     * (installation, provider, origin), so two concurrent first-saves converge on
     * exactly one row and neither overwrites a live shared secret_ref.
     */
    ensureApiKeyProfile(providerId: string): void {
      const spec = enabledSpec(providerId, 'api_key', env, deps.providerCertified) as ApiKeyCandidate['spec'];
      if (!deps.repository.ensureApiKeyGrantProfile) {
        throw new ConnectorProfileManagementError('connector_profile_provider_not_supported');
      }
      const ensure = deps.repository.ensureApiKeyGrantProfile.bind(deps.repository);
      executeConnectorPolicyV2SynchronousWrite(ensure, {
        profileId: (deps.ids ?? randomUUID)(),
        installationId: deps.installation.installationId,
        providerId: spec.profileId,
        canonicalOrigin: canonicalProviderOrigin(spec),
        catalogRevision: CONNECTOR_AUTH_CATALOG_REVISION,
      });
    },

    async upsertInstallationApiKey(authority: AuthorizedOwnerOperation, input: Readonly<{
      providerId: string;
      apiKey: string;
      ownership: 'installation_shared';
    }>): Promise<ConnectorProfileDto> {
      authorizeOwner(deps, authority, 'upsert_shared_api_key');
      if (!isRecord(input) || !validProviderId(input.providerId)
        || input.ownership !== 'installation_shared' || !validSecretInput(input.apiKey, 65_536)) {
        throw new ConnectorProfileManagementError('connector_profile_candidate_invalid');
      }
      const spec = enabledSpec(input.providerId, 'api_key', env, deps.providerCertified) as ApiKeyCandidate['spec'];
      const fence = await requireLease(deps, spec.profileId);
      try {
        try {
          await deps.testApiKeyCandidate({ spec, apiKey: input.apiKey, ownership: input.ownership });
        } catch {
          throw new ConnectorProfileManagementError('connector_profile_candidate_test_failed');
        }
        // A rejected key must never create a profile or reach secret staging.
        const profile = await ensureProfile(deps, spec, fence);
        const refs = await stageFields(deps, profile, fence, { api_key: input.apiKey });
        return await activate(deps, profile, fence, refs);
      } finally {
        await deps.repository.releaseLease(fence);
      }
    },

    async disable(authority: AuthorizedOwnerOperation, providerId: string): Promise<ConnectorProfileDto> {
      authorizeOwner(deps, authority, 'disable');
      if (!validProviderId(providerId)) {
        throw new ConnectorProfileManagementError('connector_profile_provider_not_supported');
      }
      const spec = profileAuthSpecFor(providerId);
      if (!spec) throw new ConnectorProfileManagementError('connector_profile_provider_not_supported');
      const fence = await requireLease(deps, spec.profileId);
      try {
        const profile = await deps.repository.findProfile(deps.installation.installationId, spec.profileId);
        if (!profile) throw new ConnectorProfileManagementError('connector_profile_not_found');
        const disabled = await deps.repository.disableProfile({
          profileId: profile.profileId, expectedVersion: profile.version, fence,
        });
        if (!disabled) throw new ConnectorProfileManagementError('connector_profile_fence_stale');
        return profileDto(spec, disabled, env);
      } finally {
        await deps.repository.releaseLease(fence);
      }
    },
  };
};
