import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import {
  isProviderAuthRegistryEnabled,
  isProviderAuthSpecCertified,
  PROVIDER_AUTH_SPECS,
  providerAuthSpecFor,
  type DcrPkceSpec,
  type ProviderAuthSpec,
} from '../../../shared/connector-auth-registry.js';

import {
  decryptConnectorVaultSecret,
  encryptConnectorVaultSecret,
  indexProviderSubject,
  type ConnectorKekKeyring,
  type ConnectorVaultEnvelope,
  type ProviderSubjectHmacKeyring,
} from './connector-auth-vault.crypto.js';
import { fetchCertifiedProviderMetadata, safeFetchProviderJson } from './connector-auth-safe-fetch.js';
import type { CertifiedProviderMetadata } from './connector-auth-safe-fetch.js';
import {
  connectorRuntimePolicyFor,
  assertConnectorGrantSubjectIdentity,
  type ConnectorUserGrantRepository,
} from './connector-user-grant.service.js';
import {
  evaluateConnectorRuntimePolicy,
  type ConnectorCredentialRuntimePolicy,
} from './connector-credential-eligibility.js';

export const CONNECTOR_OAUTH_V2_FLAG = 'NASSAJ_CONNECTOR_OAUTH_V2';
const TTL_SECONDS = 10 * 60;
const LEASE_SECONDS = 60;
const STATE_PATTERN = /^v2\.[A-Za-z0-9_-]{43}$/u;
const GOOGLE_SCOPES = Object.freeze({
  'google-calendar': 'https://www.googleapis.com/auth/calendar',
  'google-drive': 'https://www.googleapis.com/auth/drive',
  gmail: 'https://www.googleapis.com/auth/gmail.modify',
} as const);

type OAuthSpec = Exclude<ProviderAuthSpec, { method: 'api_key' }>;
type Profile = Readonly<{
  profileId: string; installationId: string; providerId: string; status: string; version: number;
}>;
type ReadyMaterial = Readonly<{
  state: 'ready'; grantId: string; profileId: string; providerId: string; serviceId: string;
  userId: number; ownership: 'personal'; version: number; secretRef: string;
  providerSubjectHmac: string; providerSubjectCiphertext: Buffer; providerSubjectNonce: Buffer;
  providerSubjectTag: Buffer; providerSubjectKekVersion: number; hmacKeyVersion: number;
  materialGeneration: 'm1' | 'm2';
  envelope: ConnectorVaultEnvelope;
  services?: readonly Readonly<{ serviceId: string; scopes: readonly string[] }>[];
}>;
type MissingMaterial = Readonly<{ state: 'absent' }> | Readonly<{ state: 'corrupt' }>;
type IneligibleMaterial = Readonly<{ state: 'ineligible'; reason: string }>;
type OAuthMaterial = MissingMaterial | IneligibleMaterial | ReadyMaterial;
type TransactionMaterial = MissingMaterial | Readonly<{
  state: 'ready'; transactionId: string; profileId: string; installationId: string;
  providerId: string; userId: number; version: number; secretRef: string;
  envelope: ConnectorVaultEnvelope;
}>;
type ProfileSecret = MissingMaterial | Readonly<{
  state: 'ready'; secretRef: string; profile: Profile; envelope: ConnectorVaultEnvelope;
}>;

type OAuthRepository = Pick<ConnectorUserGrantRepository,
  'acquireLease' | 'releaseLease' | 'createGrant' | 'createVaultSecret'> & Readonly<{
  findProfile(installationId: string, providerId: string): Profile | null;
  getProfile(profileId: string): Profile | null;
  readActiveProfileSecret(profileId: string, purpose: string): ProfileSecret;
  createOAuthTransaction(input: Readonly<{
    profileId: string; userId: number; stateHash: string; secretRef: null;
    secretRevision: null; ttlSeconds: number;
  }>): string;
  finalizeOAuthTransactionSecret(input: Readonly<{
    transactionId: string; expectedVersion: number; secretRef: string;
    secretRevision: number; fence: OAuthLease;
  }>): boolean;
  readOAuthTransactionMaterial(stateHash: string): TransactionMaterial;
  consumeOAuthTransaction(stateHash: string, fence: OAuthLease): unknown | null;
  deleteOAuthTransaction(transactionId: string, secretRef: string, fence: OAuthLease): boolean;
  readActiveOAuthGrantMaterial(
    installationId: string, userId: number, profileId: string, serviceId: string,
    policy: ConnectorCredentialRuntimePolicy, grantId?: string,
  ): OAuthMaterial;
  readOAuthGrantForProfileExtension(
    installationId: string, userId: number, profileId: string, requestedServiceId: string,
    policy: ConnectorCredentialRuntimePolicy, grantId: string,
  ): OAuthMaterial;
  promoteOAuthGrant(input: Readonly<{
    grantId: string; expectedVersion: number; serviceId: string; scopes: readonly string[];
    secretRef: string; secretRevision: number; profileVersion: number; fence: OAuthLease;
  }>): boolean;
  revokeOAuthGrantAndDeleteSecrets(input: Readonly<{
    grantId: string; userId: number; expectedVersion: number; fence: OAuthLease;
  }>): boolean;
  discardOAuthGrantCandidate(input: Readonly<{
    grantId: string; secretRef: string; createdGrant: boolean;
  }>): boolean;
}>;

type AssertCallbackEffect = (input: Readonly<{ providerId: string; serviceId: string;
  userId: number; grantId?: string }>) => void;

type OAuthLease = Readonly<{
  leaseKey: string; ownerToken: string; fencingToken: number; expiresAt: string;
}>;
type Keyring = ConnectorKekKeyring & ProviderSubjectHmacKeyring;
type Pending = Readonly<{
  installationId: string; profileId: string; providerId: string; serviceId: string;
  userId: number; sessionId: string; redirectUri: string; verifier: string; nonce: string;
  clientId: string; clientSecret: string | null; scopes: readonly string[]; profileVersion: number;
  accountLabel: string;
  connectorId?: string;
  grantId?: string;
}>;
type TokenBundle = Readonly<{
  accessToken: string; refreshToken: string | null; expiresAt: number | null;
  scopes: readonly string[]; subject: string; tokenType: string;
}>;

export class ConnectorOAuthEngineError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ConnectorOAuthEngineError';
  }
}

const enabledSpec = (
  serviceId: string,
  env: Readonly<Record<string, string | undefined>>,
): OAuthSpec => {
  const spec = providerAuthSpecFor(serviceId);
  const engineFlag = spec && `NASSAJ_CONNECTOR_OAUTH_CERT_${spec.profileId.toUpperCase().replace(/-/gu, '_')}`;
  if (!spec || spec.method === 'api_key') throw new ConnectorOAuthEngineError('connector_oauth_provider_unsupported');
  if (env[CONNECTOR_OAUTH_V2_FLAG] !== '1' || !isProviderAuthRegistryEnabled(env)
    || !isProviderAuthSpecCertified(spec, env) || !engineFlag || env[engineFlag] !== '1') {
    throw new ConnectorOAuthEngineError('connector_oauth_provider_disabled');
  }
  if (spec.method === 'byo_app' && spec.identity.method === 'unavailable') {
    throw new ConnectorOAuthEngineError('connector_oauth_identity_contract_unavailable');
  }
  return spec;
};

const b64url = (value: Buffer): string => value.toString('base64url');
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const cleanStrings = (value: unknown): string[] => Array.isArray(value)
  ? [...new Set(value.filter(item => typeof item === 'string' && item.length > 0 && item.length <= 512))].sort()
  : [];
const tokenScopes = (value: unknown): string[] => typeof value === 'string'
  ? [...new Set(value.split(/\s+/u).filter(Boolean))].sort()
  : cleanStrings(value);

const requestedScopes = (
  spec: OAuthSpec,
  serviceId: string,
  prior: readonly string[],
): string[] => {
  const scopes = new Set(prior);
  if (spec.profileId === 'google-workspace') {
    scopes.add('openid');
    scopes.add('email');
    const serviceScope = GOOGLE_SCOPES[serviceId as keyof typeof GOOGLE_SCOPES];
    if (!serviceScope) throw new ConnectorOAuthEngineError('connector_oauth_service_unsupported');
    scopes.add(serviceScope);
  } else if (spec.profileId === 'canva') {
    scopes.add('profile:read');
  } else if (spec.method === 'dcr_pkce') {
    const allowed = new Set(spec.minimumScopes);
    for (const scope of scopes) {
      if (!allowed.has(scope)) scopes.delete(scope);
    }
    for (const scope of spec.minimumScopes) scopes.add(scope);
  } else {
    throw new ConnectorOAuthEngineError('connector_oauth_scopes_unavailable');
  }
  if (scopes.size === 0) throw new ConnectorOAuthEngineError('connector_oauth_scopes_unavailable');
  return [...scopes].sort();
};

/** Pure registry scope plan used before any provider response can influence consent. */
export const connectorOAuthScopePlan = (serviceId: string, prior: readonly string[] = []): string[] => {
  const spec = providerAuthSpecFor(serviceId);
  if (!spec || spec.method === 'api_key') {
    throw new ConnectorOAuthEngineError('connector_oauth_provider_unsupported');
  }
  return requestedScopes(spec, serviceId, prior);
};

const acceptedCallbackScopes = (
  spec: OAuthSpec,
  requested: readonly string[],
  returned: readonly string[],
): string[] => {
  const candidate = returned.length > 0 ? returned : [...requested];
  if (requested.some(scope => !candidate.includes(scope))) {
    throw new ConnectorOAuthEngineError('connector_oauth_scope_missing');
  }
  if (spec.method !== 'dcr_pkce') return [...new Set(candidate)].sort();
  const allowed = new Set(spec.minimumScopes);
  return [...new Set(candidate.filter(scope => allowed.has(scope)))].sort();
};

/** Pure callback scope policy: DCR providers can never persist metadata-undocumented extras. */
export const connectorOAuthAcceptedScopePlan = (
  serviceId: string,
  requested: readonly string[],
  returned: readonly string[],
): string[] => {
  const spec = providerAuthSpecFor(serviceId);
  if (!spec || spec.method === 'api_key') {
    throw new ConnectorOAuthEngineError('connector_oauth_provider_unsupported');
  }
  return acceptedCallbackScopes(spec, requested, returned);
};

const decryptProfileField = (
  repository: OAuthRepository,
  profile: Profile,
  purpose: string,
  keyring: Keyring,
  required = true,
): string | null => {
  const material = repository.readActiveProfileSecret(profile.profileId, purpose);
  if (material.state === 'corrupt') throw new ConnectorOAuthEngineError('connector_oauth_profile_corrupt');
  if (material.state === 'absent') {
    if (required) throw new ConnectorOAuthEngineError('connector_oauth_profile_incomplete');
    return null;
  }
  const raw = decryptConnectorVaultSecret(material.envelope, {
    vaultSecretId: material.secretRef, installationId: profile.installationId,
    providerId: profile.providerId, subjectType: 'profile', subjectId: profile.profileId,
    profileId: profile.profileId, userId: null, fieldPurpose: purpose,
  }, keyring);
  try { return raw.toString('utf8'); } finally { raw.fill(0); }
};

const subjectAad = (input: Readonly<{
  installationId: string; providerId: string; profileId: string; grantId: string; kekVersion: number;
}>): Buffer => Buffer.from(
  `nassaj:grant-subject:v1\0${input.installationId}\0${input.providerId}\0${input.profileId}\0${input.grantId}\0${input.kekVersion}`,
);

const encryptSubject = (raw: Buffer, context: Omit<Parameters<typeof subjectAad>[0], 'kekVersion'>, keyring: Keyring) => {
  const kekVersion = keyring.activeKekVersion();
  const key = keyring.readKek(kekVersion);
  const nonce = randomBytes(12);
  const aad = subjectAad({ ...context, kekVersion });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    return { ciphertext: Buffer.concat([cipher.update(raw), cipher.final()]), nonce, tag: cipher.getAuthTag(), kekVersion };
  } finally { key.fill(0); aad.fill(0); }
};

const decryptSubject = (material: ReadyMaterial, installationId: string, keyring: Keyring): Buffer => {
  const key = keyring.readKek(material.providerSubjectKekVersion);
  const aad = subjectAad({
    installationId, providerId: material.providerId, profileId: material.profileId,
    grantId: material.grantId, kekVersion: material.providerSubjectKekVersion,
  });
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, material.providerSubjectNonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(material.providerSubjectTag);
    return Buffer.concat([decipher.update(material.providerSubjectCiphertext), decipher.final()]);
  } finally { key.fill(0); aad.fill(0); }
};

const decodeJson = <T>(raw: Buffer, code: string): T => {
  try { return JSON.parse(raw.toString('utf8')) as T; } catch { throw new ConnectorOAuthEngineError(code); }
};

const authorizationEndpoint = (spec: OAuthSpec): string => spec.method === 'dcr_pkce'
  ? spec.metadataExpectations.authorizationEndpoint : spec.endpoints.authorization;

export const connectorOAuthTokenHeaders = (
  profileId: string,
  clientId: string,
  clientSecret: string | null,
): Readonly<Record<string, string>> => {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (profileId === 'canva' && clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }
  return headers;
};

export const createConnectorOAuthEngine = (deps: Readonly<{
  installationId: string; callbackUrl: string; repository: OAuthRepository; keyring: Keyring;
  env?: Readonly<Record<string, string | undefined>>;
  exchange?: (input: Readonly<{
    spec: OAuthSpec; body: Buffer; headers: Readonly<Record<string, string>>;
  }>) => Promise<Record<string, unknown>>;
  fetchMetadata?: (spec: DcrPkceSpec) => Promise<CertifiedProviderMetadata>;
  verifyIdentity: (input: Readonly<{
    spec: OAuthSpec; idToken: string; clientId: string; nonce: string;
  }>) => Promise<Readonly<{ subject: string }>>;
  revokeRemote?: (input: Readonly<{ spec: OAuthSpec; token: string; clientId: string; clientSecret: string | null }>) => Promise<void>;
  assertCallbackEffect?: AssertCallbackEffect;
  now?: () => number;
  ids?: () => string;
}>) => {
  const env = deps.env ?? {};
  const ids = deps.ids ?? randomUUID;
  const exchange = deps.exchange ?? (input => safeFetchProviderJson({
    spec: input.spec, endpoint: 'token', method: 'POST', headers: input.headers, body: input.body,
  }));

  const readBundle = (material: ReadyMaterial): TokenBundle => {
    const raw = decryptConnectorVaultSecret(material.envelope, {
      vaultSecretId: material.secretRef, installationId: deps.installationId,
      providerId: material.providerId, subjectType: 'grant', subjectId: material.grantId,
      profileId: material.profileId, userId: material.userId, fieldPurpose: 'oauth_token_bundle',
    }, deps.keyring);
    try { return decodeJson<TokenBundle>(raw, 'connector_oauth_grant_corrupt'); }
    finally { raw.fill(0); }
  };

  const prior = (
    userId: number, profileId: string, serviceId: string, allowProfileExtension = false,
    grantId?: string,
  ) => {
    const profile = deps.repository.getProfile(profileId);
    if (!profile) return null;
    const spec = PROVIDER_AUTH_SPECS.find(candidate => candidate.profileId === profile.providerId);
    if (!spec) throw new ConnectorOAuthEngineError('connector_oauth_profile_unknown');
    if (!spec.services.includes(serviceId)) {
      throw new ConnectorOAuthEngineError('connector_oauth_service_profile_mismatch');
    }
    const policy = connectorRuntimePolicyFor(serviceId, deps.env ?? {});
    const material = allowProfileExtension && grantId !== undefined
      ? deps.repository.readOAuthGrantForProfileExtension(
        deps.installationId, userId, profileId, serviceId, policy, grantId,
      )
      : deps.repository.readActiveOAuthGrantMaterial(
        deps.installationId, userId, profileId, serviceId, policy, grantId,
      );
    if (material.state === 'corrupt') throw new ConnectorOAuthEngineError('connector_oauth_grant_corrupt');
    if (material.state === 'ineligible') {
      throw new ConnectorOAuthEngineError(`connector_oauth_grant_ineligible:${material.reason}`);
    }
    if (material.state === 'ready') {
      assertConnectorGrantSubjectIdentity(material, deps.installationId, deps.keyring);
    }
    return material.state === 'ready' ? { material, bundle: readBundle(material) } : null;
  };

  const promote = (input: Readonly<{
    userId: number; serviceId: string; spec: OAuthSpec; subject: string;
    token: TokenBundle; existing: ReturnType<typeof prior>; profileVersion: number; fence?: OAuthLease;
    accountLabel: string;
  }>): string => {
    const profile = deps.repository.findProfile(deps.installationId, input.spec.profileId);
    if (!profile || profile.status !== 'ready' || profile.version !== input.profileVersion) {
      throw new ConnectorOAuthEngineError('connector_oauth_profile_generation_changed');
    }
    const grantId = input.existing?.material.grantId ?? ids();
    const fence = input.fence
      ?? deps.repository.acquireLease(`grant:${grantId}`, ids(), LEASE_SECONDS);
    if (!fence) throw new ConnectorOAuthEngineError('connector_oauth_grant_busy');
    const ownsFence = input.fence === undefined;
    const subject = Buffer.from(input.subject);
    const tokenBytes = Buffer.from(JSON.stringify(input.token));
    const createdGrant = !input.existing;
    const secretRef = ids();
    try {
      if (!input.existing) {
        const indexed = indexProviderSubject(subject, {
          installationId: deps.installationId, providerId: input.spec.profileId, profileId: profile.profileId,
        }, deps.keyring);
        const encrypted = encryptSubject(subject, {
          installationId: deps.installationId, providerId: input.spec.profileId,
          profileId: profile.profileId, grantId,
        }, deps.keyring);
        deps.repository.createGrant({
          grantId, profileId: profile.profileId, userId: input.userId,
          providerSubjectHmac: indexed.providerSubjectHmac,
          providerSubjectCiphertext: encrypted.ciphertext, providerSubjectNonce: encrypted.nonce,
          providerSubjectTag: encrypted.tag, providerSubjectKekVersion: encrypted.kekVersion,
          hmacKeyVersion: indexed.hmacKeyVersion, serviceId: input.spec.profileId,
          accountLabel: input.accountLabel,
          accountLabelKey: input.accountLabel.normalize('NFKC').toLocaleLowerCase('en-US'),
          isDefault: false,
          legacyProvenance: null, secretRef: null, secretRevision: null, status: 'pending',
        });
      }
      const envelope = encryptConnectorVaultSecret(tokenBytes, {
        vaultSecretId: secretRef, installationId: deps.installationId,
        providerId: input.spec.profileId, subjectType: 'grant', subjectId: grantId,
        profileId: profile.profileId, userId: input.userId,
        fieldPurpose: 'oauth_token_bundle', secretRevision: 1,
      }, deps.keyring);
      deps.repository.createVaultSecret({
        secretRef, installationId: deps.installationId, providerId: input.spec.profileId,
        subjectType: 'grant', subjectId: grantId, profileId: profile.profileId,
        userId: input.userId, fieldPurpose: 'oauth_token_bundle', secretKind: 'oauth_token_bundle',
        ...envelope,
      });
      if (!deps.repository.promoteOAuthGrant({
        grantId, expectedVersion: input.existing?.material.version ?? 1,
          serviceId: input.serviceId, scopes: input.token.scopes,
          secretRef, secretRevision: 1, profileVersion: input.profileVersion, fence,
      })) throw new ConnectorOAuthEngineError('connector_oauth_grant_stale');
      return grantId;
    } catch (error) {
      if (!deps.repository.discardOAuthGrantCandidate({ grantId, secretRef, createdGrant })) {
        throw new ConnectorOAuthEngineError('connector_oauth_candidate_cleanup_failed');
      }
      throw error;
    } finally {
      subject.fill(0); tokenBytes.fill(0);
      if (ownsFence) deps.repository.releaseLease(fence);
    }
  };

  return {
    async start(input: Readonly<{
      userId: number; sessionId: string; serviceId: string; connectorId?: string; grantId?: string;
      accountLabel?: string;
    }>) {
      if (!Number.isSafeInteger(input.userId) || input.userId <= 0
        || !/^[A-Za-z0-9._:-]{16,256}$/u.test(input.sessionId)
        || input.connectorId !== undefined && !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(input.connectorId)
        || input.grantId !== undefined && !/^[0-9a-f-]{36}$/iu.test(input.grantId)
        || input.accountLabel !== undefined && (!input.accountLabel.trim()
          || input.accountLabel.length > 128 || input.accountLabel.includes('\0'))) {
        throw new ConnectorOAuthEngineError('connector_oauth_start_invalid');
      }
      const spec = enabledSpec(input.serviceId, env);
      const runtimePolicy = evaluateConnectorRuntimePolicy(
        connectorRuntimePolicyFor(input.serviceId, env),
      );
      if (!runtimePolicy.eligible) {
        throw new ConnectorOAuthEngineError(`connector_oauth_grant_ineligible:${runtimePolicy.reason}`);
      }
      const profile = deps.repository.findProfile(deps.installationId, spec.profileId);
      if (!profile || profile.status !== 'ready') throw new ConnectorOAuthEngineError('connector_oauth_profile_missing');
      if (spec.method === 'dcr_pkce') {
        await (deps.fetchMetadata ?? fetchCertifiedProviderMetadata)(spec);
      }
      const clientId = decryptProfileField(deps.repository, profile, 'client_id', deps.keyring)!;
      const clientSecret = decryptProfileField(
        deps.repository, profile, 'client_secret', deps.keyring, spec.method === 'byo_app',
      );
      // An unbound connector is a new account slot. Only an exact durable
      // connector→grant binding is allowed to extend or refresh an account.
      const existing = input.grantId
        ? prior(input.userId, profile.profileId, input.serviceId, true, input.grantId)
        : null;
      const scopes = requestedScopes(spec, input.serviceId, existing?.bundle.scopes ?? []);
      const verifier = b64url(randomBytes(64));
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      const state = `v2.${b64url(randomBytes(32))}`;
      const nonce = b64url(randomBytes(32));
      const pending: Pending = {
        installationId: deps.installationId, profileId: profile.profileId,
        providerId: spec.profileId, serviceId: input.serviceId, userId: input.userId,
        sessionId: input.sessionId, redirectUri: deps.callbackUrl, verifier, nonce,
        clientId, clientSecret, scopes, profileVersion: profile.version,
        accountLabel: input.accountLabel?.normalize('NFKC').trim().replace(/\s+/gu, ' ')
          ?? `Account ${(input.connectorId ?? state).slice(-16)}`,
        ...(input.connectorId ? { connectorId: input.connectorId } : {}),
        ...(input.grantId ? { grantId: input.grantId } : {}),
      };
      const transactionId = deps.repository.createOAuthTransaction({
        profileId: profile.profileId, userId: input.userId, stateHash: sha256(state),
        secretRef: null, secretRevision: null, ttlSeconds: TTL_SECONDS,
      });
      const fence = deps.repository.acquireLease(`oauth:${transactionId}`, ids(), LEASE_SECONDS);
      if (!fence) throw new ConnectorOAuthEngineError('connector_oauth_transaction_busy');
      const secretRef = ids();
      const raw = Buffer.from(JSON.stringify(pending));
      try {
        const envelope = encryptConnectorVaultSecret(raw, {
          vaultSecretId: secretRef, installationId: deps.installationId,
          providerId: spec.profileId, subjectType: 'oauth_transaction', subjectId: transactionId,
          profileId: profile.profileId, userId: input.userId,
          fieldPurpose: 'oauth_pending', secretRevision: 1,
        }, deps.keyring);
        deps.repository.createVaultSecret({
          secretRef, installationId: deps.installationId, providerId: spec.profileId,
          subjectType: 'oauth_transaction', subjectId: transactionId, profileId: profile.profileId,
          userId: input.userId, fieldPurpose: 'oauth_pending', secretKind: 'oauth_pending', ...envelope,
        });
        if (!deps.repository.finalizeOAuthTransactionSecret({
          transactionId, expectedVersion: 1, secretRef, secretRevision: 1, fence,
        })) throw new ConnectorOAuthEngineError('connector_oauth_transaction_stale');
      } finally { raw.fill(0); deps.repository.releaseLease(fence); }
      const url = new URL(authorizationEndpoint(spec));
      for (const [key, value] of Object.entries({
        response_type: 'code', client_id: clientId, redirect_uri: deps.callbackUrl,
        code_challenge: challenge, code_challenge_method: 'S256', state, nonce,
        scope: scopes.join(' '),
      })) url.searchParams.set(key, value);
      if (spec.profileId === 'google-workspace') {
        url.searchParams.set('access_type', 'offline');
        url.searchParams.set('include_granted_scopes', 'true');
      } else if (spec.method === 'dcr_pkce') url.searchParams.set('resource', spec.endpoints.resource);
      return Object.freeze({ authorizeUrl: url.toString(), state, expiresIn: TTL_SECONDS });
    },

    async callback(input: Readonly<{ state: string; code: string }>) {
      if (!STATE_PATTERN.test(input.state) || !input.code || input.code.length > 8_192) {
        throw new ConnectorOAuthEngineError('connector_oauth_callback_invalid');
      }
      const stateHash = sha256(input.state);
      const transaction = deps.repository.readOAuthTransactionMaterial(stateHash);
      if (transaction.state === 'absent') throw new ConnectorOAuthEngineError('connector_oauth_state_unknown');
      if (transaction.state === 'corrupt') throw new ConnectorOAuthEngineError('connector_oauth_transaction_corrupt');
      const pendingRaw = decryptConnectorVaultSecret(transaction.envelope, {
        vaultSecretId: transaction.secretRef, installationId: transaction.installationId,
        providerId: transaction.providerId, subjectType: 'oauth_transaction',
        subjectId: transaction.transactionId, profileId: transaction.profileId,
        userId: transaction.userId, fieldPurpose: 'oauth_pending',
      }, deps.keyring);
      const pending = decodeJson<Pending>(pendingRaw, 'connector_oauth_transaction_corrupt');
      pendingRaw.fill(0);
      if (pending.installationId !== deps.installationId || pending.profileId !== transaction.profileId
        || pending.providerId !== transaction.providerId || pending.userId !== transaction.userId
        || pending.redirectUri !== deps.callbackUrl) {
        throw new ConnectorOAuthEngineError('connector_oauth_transaction_binding_invalid');
      }
      const spec = enabledSpec(pending.serviceId, env);
      if (spec.profileId !== pending.providerId) throw new ConnectorOAuthEngineError('connector_oauth_transaction_binding_invalid');
      deps.assertCallbackEffect?.({ providerId: pending.providerId, serviceId: pending.serviceId,
        userId: pending.userId, ...(pending.grantId ? { grantId: pending.grantId } : {}) });
      const currentProfile = deps.repository.findProfile(deps.installationId, pending.providerId);
      if (!currentProfile || currentProfile.status !== 'ready'
        || currentProfile.profileId !== pending.profileId
        || currentProfile.version !== pending.profileVersion) {
        throw new ConnectorOAuthEngineError('connector_oauth_profile_generation_changed');
      }
      const fence = deps.repository.acquireLease(`oauth:${transaction.transactionId}`, ids(), LEASE_SECONDS);
      if (!fence) throw new ConnectorOAuthEngineError('connector_oauth_transaction_busy');
      let consumed = false;
      try {
        if (!deps.repository.consumeOAuthTransaction(stateHash, fence)) {
          throw new ConnectorOAuthEngineError('connector_oauth_state_unknown');
        }
        consumed = true;
        const body = new URLSearchParams({
          grant_type: 'authorization_code', code: input.code, redirect_uri: pending.redirectUri,
          client_id: pending.clientId, code_verifier: pending.verifier,
        });
        if (pending.clientSecret) body.set('client_secret', pending.clientSecret);
        if (spec.method === 'dcr_pkce') body.set('resource', spec.endpoints.resource);
        const headers = connectorOAuthTokenHeaders(
          spec.profileId, pending.clientId, pending.clientSecret,
        );
        const requestBody = Buffer.from(body.toString());
        let response: Record<string, unknown>;
        try { response = await exchange({ spec, body: requestBody, headers }); }
        finally { requestBody.fill(0); }
        if (typeof response.access_token !== 'string' || response.access_token.length === 0) {
          throw new ConnectorOAuthEngineError('connector_oauth_token_invalid');
        }
        let subject: string;
        if (spec.method === 'byo_app' && spec.identity.method === 'oidc') {
          if (typeof response.id_token !== 'string' || response.id_token.length === 0) {
            throw new ConnectorOAuthEngineError('connector_oauth_id_token_required');
          }
          subject = (await deps.verifyIdentity({
            spec, idToken: response.id_token, clientId: pending.clientId, nonce: pending.nonce,
          })).subject;
        } else {
          const candidate = response.sub ?? response.user_id ?? response.account_id;
          if (typeof candidate !== 'string' || !candidate || candidate.length > 512) {
            throw new ConnectorOAuthEngineError('connector_oauth_subject_missing');
          }
          subject = candidate;
        }
        const existing = pending.grantId
          ? prior(pending.userId, pending.profileId, pending.serviceId, true, pending.grantId)
          : null;
        if (existing) {
          const priorSubject = decryptSubject(existing.material, deps.installationId, deps.keyring);
          const nextSubject = Buffer.from(subject);
          try {
            if (priorSubject.length !== nextSubject.length || !timingSafeEqual(priorSubject, nextSubject)) {
              throw new ConnectorOAuthEngineError('connector_oauth_account_swap');
            }
          } finally { priorSubject.fill(0); nextSubject.fill(0); }
        }
        const returnedScopes = tokenScopes(response.scope);
        const scopes = acceptedCallbackScopes(spec, pending.scopes, returnedScopes);
        const token: TokenBundle = {
          accessToken: response.access_token,
          refreshToken: typeof response.refresh_token === 'string' && response.refresh_token
            ? response.refresh_token : existing?.bundle.refreshToken ?? null,
          expiresAt: typeof response.expires_in === 'number'
            ? (deps.now?.() ?? Date.now()) + response.expires_in * 1_000 : null,
          scopes, subject, tokenType: typeof response.token_type === 'string' ? response.token_type : 'Bearer',
        };
        const grantId = promote({
          userId: pending.userId, serviceId: pending.serviceId, spec, subject, token, existing,
          profileVersion: pending.profileVersion, accountLabel: pending.accountLabel,
        });
        return Object.freeze({
          userId: pending.userId, serviceId: pending.serviceId, grantId,
          ...(pending.connectorId ? { connectorId: pending.connectorId } : {}),
        });
      } finally {
        if (consumed) deps.repository.deleteOAuthTransaction(
          transaction.transactionId, transaction.secretRef, fence,
        );
        deps.repository.releaseLease(fence);
      }
    },

    async refresh(userId: number, serviceId: string, grantId?: string) {
      const spec = enabledSpec(serviceId, env);
      const profile = deps.repository.findProfile(deps.installationId, spec.profileId);
      if (!profile) throw new ConnectorOAuthEngineError('connector_oauth_profile_missing');
      const observed = prior(userId, profile.profileId, serviceId, false, grantId);
      if (!observed) throw new ConnectorOAuthEngineError('connector_oauth_grant_missing');
      if (!observed.material.services?.some(service => service.serviceId === serviceId)) {
        throw new ConnectorOAuthEngineError('connector_oauth_service_not_linked');
      }
      const fence = deps.repository.acquireLease(`grant:${observed.material.grantId}`, ids(), LEASE_SECONDS);
      if (!fence) throw new ConnectorOAuthEngineError('connector_oauth_grant_busy');
      try {
        const existing = prior(
          userId, profile.profileId, serviceId, false, observed.material.grantId,
        );
        if (!existing || existing.material.grantId !== observed.material.grantId) {
          throw new ConnectorOAuthEngineError('connector_oauth_grant_stale');
        }
        if (!existing.material.services?.some(service => service.serviceId === serviceId)) {
          throw new ConnectorOAuthEngineError('connector_oauth_service_not_linked');
        }
        if (!existing.bundle.refreshToken) throw new ConnectorOAuthEngineError('connector_oauth_refresh_missing');
        const clientId = decryptProfileField(deps.repository, profile, 'client_id', deps.keyring)!;
        const clientSecret = decryptProfileField(
          deps.repository, profile, 'client_secret', deps.keyring, spec.method === 'byo_app',
        );
        const body = new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: existing.bundle.refreshToken, client_id: clientId,
        });
        if (clientSecret) body.set('client_secret', clientSecret);
        if (spec.method === 'dcr_pkce') body.set('resource', spec.endpoints.resource);
        const requestBody = Buffer.from(body.toString());
        let response: Record<string, unknown>;
        const headers = connectorOAuthTokenHeaders(spec.profileId, clientId, clientSecret);
        try {
          response = await exchange({
            spec, body: requestBody,
            headers,
          });
        } finally { requestBody.fill(0); }
        if (typeof response.access_token !== 'string' || !response.access_token) {
          throw new ConnectorOAuthEngineError('connector_oauth_token_invalid');
        }
        const token: TokenBundle = {
          ...existing.bundle, accessToken: response.access_token,
          refreshToken: typeof response.refresh_token === 'string' && response.refresh_token
            ? response.refresh_token : existing.bundle.refreshToken,
          expiresAt: typeof response.expires_in === 'number'
            ? (deps.now?.() ?? Date.now()) + response.expires_in * 1_000 : existing.bundle.expiresAt,
          scopes: spec.method === 'dcr_pkce'
            ? requestedScopes(spec, serviceId, existing.bundle.scopes)
            : existing.bundle.scopes,
        };
        promote({
          userId, serviceId, spec, subject: existing.bundle.subject, token, existing,
          profileVersion: profile.version, fence, accountLabel: 'unchanged',
        });
        return Object.freeze({ grantId: existing.material.grantId, refreshed: true });
      } finally { deps.repository.releaseLease(fence); }
    },

    async revoke(userId: number, serviceId: string, grantId?: string) {
      const spec = enabledSpec(serviceId, env);
      const profile = deps.repository.findProfile(deps.installationId, spec.profileId);
      if (!profile) throw new ConnectorOAuthEngineError('connector_oauth_profile_missing');
      const existing = prior(userId, profile.profileId, serviceId, false, grantId);
      if (!existing) throw new ConnectorOAuthEngineError('connector_oauth_grant_missing');
      if (!existing.material.services?.some(service => service.serviceId === serviceId)) {
        throw new ConnectorOAuthEngineError('connector_oauth_service_not_linked');
      }
      const clientId = decryptProfileField(deps.repository, profile, 'client_id', deps.keyring)!;
      const clientSecret = decryptProfileField(
        deps.repository, profile, 'client_secret', deps.keyring, spec.method === 'byo_app',
      );
      const hasCertifiedRevocation = spec.method === 'byo_app' && Boolean(spec.endpoints.revocation);
      if (hasCertifiedRevocation) {
        try {
          await deps.revokeRemote?.({
            spec, token: existing.bundle.refreshToken ?? existing.bundle.accessToken, clientId, clientSecret,
          });
        } catch { /* Best effort: local revocation remains authoritative. */ }
      }
      const fence = deps.repository.acquireLease(`grant:${existing.material.grantId}`, ids(), LEASE_SECONDS);
      if (!fence) throw new ConnectorOAuthEngineError('connector_oauth_grant_busy');
      try {
        if (!deps.repository.revokeOAuthGrantAndDeleteSecrets({
          grantId: existing.material.grantId, userId,
          expectedVersion: existing.material.version, fence,
        })) throw new ConnectorOAuthEngineError('connector_oauth_grant_stale');
      } finally { deps.repository.releaseLease(fence); }
      return Object.freeze({
        revoked: true,
        remoteRevocation: hasCertifiedRevocation && deps.revokeRemote ? 'best_effort' as const : 'local_only' as const,
      });
    },
  };
};
