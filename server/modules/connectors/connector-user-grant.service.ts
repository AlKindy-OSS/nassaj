import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import {
  isProviderAuthSpecCertified,
  isProviderAuthRegistryEnabled,
  providerAuthSpecFor,
  type ProviderAuthSpec,
} from '../../../shared/connector-auth-registry.js';
import { CONNECTOR_ROLLOUT_BODY_PROVIDERS } from '../../../shared/connector-rollout-policy.js';

import { executeConnectorPolicyV2SynchronousWrite } from './connector-substrate-only.production.js';
import {
  decryptConnectorVaultSecret,
  encryptConnectorVaultSecret,
  indexProviderSubject,
  indexProviderSubjectAtVersion,
  providerSubjectNeedsReindex,
  type ConnectorKekKeyring,
  type ConnectorVaultEnvelope,
  type ProviderSubjectHmacKeyring,
} from './connector-auth-vault.crypto.js';
import {
  connectorCredentialContractFor,
  validateConnectorCredentialBundle,
} from './connector-credential-contracts.js';
import type { ConnectorApiKeyIdentityEvidence } from './connector-api-key-probe.js';
import type { ConnectorCredentialRuntimePolicy } from './connector-credential-eligibility.js';
import { evaluateConnectorRuntimePolicy } from './connector-credential-eligibility.js';

export const CONNECTOR_GRANTS_V2_FLAG = 'NASSAJ_CONNECTOR_GRANTS_V2';
const LEASE_TTL_SECONDS = 60;
const UNVERIFIED_CANDIDATE_TTL_SECONDS = 24 * 60 * 60;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export class ConnectorUserGrantError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ConnectorUserGrantError';
  }
}

type GrantRow = Readonly<{
  grant_id: string; profile_id: string; provider_id: string; service_id: string;
  user_id: number; account_label: string; account_label_key?: string; is_default: 0 | 1;
  status: 'pending' | 'active' | 'revoked' | 'error'; version: number;
  secret_ref: string | null; secret_revision: number | null; legacy_provenance?: string | null;
  credential_state?: 'stored_unverified' | 'verified' | 'stale' | 'rejected' | 'unavailable' | 'corrupt' | null;
  credential_expires_at?: string | null;
  bundle_state?: 'candidate' | 'stored' | 'superseded' | 'deleted' | null;
  operational_state?: 'ineligible' | 'eligible' | 'disabled' | 'revoking' | 'deleted' | null;
  verification_reason?: string | null;
  credential_shape?: 'single_api_key' | 'geidea_basic' | null;
  granted_services?: string | null; available_bodies?: string | null; pending_bodies?: string | null;
}>;

type GrantMaterial =
  | Readonly<{ state: 'absent' | 'corrupt' }>
  | Readonly<{ state: 'ineligible'; reason: string }>
  | Readonly<{
    state: 'ready'; grantId: string; profileId: string; providerId: string; secretRef: string;
    serviceId: string; userId: number; ownership: 'personal'; version: number;
    providerSubjectHmac: string; providerSubjectCiphertext: Buffer;
    providerSubjectNonce: Buffer; providerSubjectTag: Buffer;
    providerSubjectKekVersion: number; hmacKeyVersion: number;
    materialGeneration: 'm1' | 'm2';
    envelope: ConnectorVaultEnvelope;
  }>;

type ConnectorAuthLease = Readonly<{
  leaseKey: string;
  ownerToken: string;
  fencingToken: number;
  expiresAt: string;
}>;

type GrantCreateInput = Readonly<{
  grantId: string;
  profileId: string;
  userId: number;
  providerSubjectHmac: string;
  providerSubjectCiphertext: Buffer;
  providerSubjectNonce: Buffer;
  providerSubjectTag: Buffer;
  hmacKeyVersion: number;
  providerSubjectKekVersion?: number;
  serviceId?: string;
  accountLabel: string;
  accountLabelKey?: string;
  isDefault?: boolean;
  legacyProvenance?: string | null;
  secretRef: string | null;
  secretRevision: number | null;
  status: GrantRow['status'];
}>;

type VaultSecretCreateInput = Readonly<{
  secretRef: string;
  installationId: string;
  providerId: string;
  subjectType: 'installation' | 'profile' | 'grant' | 'oauth_transaction';
  subjectId: string;
  profileId: string | null;
  userId: number | null;
  fieldPurpose: string;
  secretKind: string;
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
  wrappedDekNonce: Buffer;
  wrappedDekTag: Buffer;
  kekVersion: number;
  aadVersion: number;
  secretRevision: number;
}>;

export interface ConnectorUserGrantRepository {
  runCredentialWrite<T>(operation: () => T): T;
  listProfiles(installationId: string): readonly Readonly<{
    profileId: string; providerId: string; status: string;
  }>[];
  ensureApiKeyGrantProfile?(input: Readonly<{
    profileId: string; installationId: string; providerId: string;
    canonicalOrigin: string; catalogRevision: string;
  }>): Readonly<{ profileId: string; providerId: string; status: string }>;
  listUserGrants(installationId: string, userId: number, serviceId?: string): readonly GrantRow[];
  findUserGrant(
    installationId: string, userId: number, serviceId: string, accountLabelKey: string,
  ): GrantRow | null;
  readActiveGrantMaterial(
    installationId: string, userId: number, serviceId: string, grantId: string | undefined,
    policy: ConnectorCredentialRuntimePolicy,
  ): GrantMaterial;
  readStoredUnverifiedApiKey(
    installationId: string, userId: number, grantId: string,
  ): Readonly<{
    serviceId: string; accountLabel: string; providerId: string; profileId: string;
    bundleId: string; bundleRevision: number; bundleVersion: number;
    secretRef: string; envelope: ConnectorVaultEnvelope;
  }> | null;
  storedUnverifiedBundleIsCurrent(input: Readonly<{
    bundleId: string; bundleRevision: number; bundleVersion: number;
    grantId: string; userId: number; fence: ConnectorAuthLease;
  }>): boolean;
  rotateGrantSubjectIndex(input: Readonly<{
    grantId: string; userId: number; expectedVersion: number; expectedHmacKeyVersion: number;
    providerSubjectHmac: string; hmacKeyVersion: number; fence: ConnectorAuthLease;
  }>): boolean;
  adoptPendingGrantIdentity(input: Readonly<{
    grantId: string; userId: number; expectedVersion: number;
    providerSubjectHmac: string; providerSubjectCiphertext: Buffer;
    providerSubjectNonce: Buffer; providerSubjectTag: Buffer;
    providerSubjectKekVersion: number; hmacKeyVersion: number; fence: ConnectorAuthLease;
  }>): boolean;
  acquireLease(leaseKey: string, ownerToken: string, ttlSeconds: number): ConnectorAuthLease | null;
  releaseLease(fence: ConnectorAuthLease): boolean;
  createGrant(input: GrantCreateInput): string;
  createVaultSecret(input: VaultSecretCreateInput): string;
  activateUserGrant(input: Readonly<{
    grantId: string; expectedVersion: number; accountLabel: string; accountLabelKey: string;
    secretRef: string; secretRevision: number; isDefault: boolean; fence: ConnectorAuthLease;
  }>): boolean;
  createCredentialBundleRevision(input: Readonly<{
    bundleId: string; bundleRevision: number; installationId: string; userId: number;
    providerId: string; serviceId: string; grantId: string; profileId: string;
    credentialShape: 'single_api_key' | 'geidea_basic'; shapeRevision: number;
    secretRevision: number; expiresAt: string;
    fields: readonly Readonly<{
      fieldId: 'api_key' | 'merchant_public_key' | 'api_password';
      sensitivity: 'secret' | 'confidential_identifier'; secretRef: string;
    }>[];
    evidenceHmac: string; evidenceExpiresAt: string; fence: ConnectorAuthLease;
  }>): boolean;
  storeCredentialBundleRevision(input: Readonly<{
    bundleId: string; bundleRevision: number; expectedVersion: number; fence: ConnectorAuthLease;
  }>): boolean;
  retireOtherUnverifiedCredentialBundles(input: Readonly<{
    grantId: string; keepBundleId: string; keepBundleRevision: number;
    userId: number; fence: ConnectorAuthLease;
  }>): boolean;
  recordCredentialVerification(input: Readonly<{
    bundleId: string; bundleRevision: number; expectedBundleVersion: number;
    expectedVerificationVersion: number; installationId: string; userId: number;
    providerId: string; serviceId: string; grantId: string; secretRevision: number;
    shapeRevision: number; contractRevision: number;
    state: 'verified' | 'stale' | 'rejected' | 'unavailable' | 'corrupt';
    reasonCode: string; identityKind: 'user' | 'store' | 'merchant' | 'account' | null;
    identityHmac: string | null; evidenceHmac: string; expiresAt: string;
    fence: ConnectorAuthLease;
  }>): boolean;
  promoteCredentialBundle(input: Readonly<{
    bundleId: string; bundleRevision: number; expectedOperationalVersion: number;
    grantId: string; secretRevision: number; fence: ConnectorAuthLease;
    activation?: Readonly<{
      accountLabel: string; accountLabelKey: string; isDefault: boolean;
    }>;
  }>): boolean;
  deleteCredentialBundleAndEnvelopeReferences(input: Readonly<{
    bundleId: string; bundleRevision: number; userId: number; fence: ConnectorAuthLease;
  }>): boolean;
  deleteCandidateVaultSecrets(input: Readonly<{
    grantId: string; userId: number; secretRefs: readonly string[]; fence: ConnectorAuthLease;
  }>): number;
  purgeExpiredCredentialCandidates?(limit: number): number;
  discardOAuthGrantCandidate(input: Readonly<{
    grantId: string; secretRef: string; createdGrant: boolean;
  }>): boolean;
  revokeUserGrant(input: Readonly<{
    grantId: string; expectedVersion: number; userId: number; fence: ConnectorAuthLease;
  }>): boolean;
}

type GrantKeyring = ConnectorKekKeyring & ProviderSubjectHmacKeyring;

export type ConnectorUserGrantDto = Readonly<{
  grantId: string;
  serviceId: string;
  accountLabel: string;
  isDefault: boolean;
  status: GrantRow['status'];
  ownership: 'personal';
  credentialStatus: 'stored_unverified' | 'verified' | 'stale' | 'rejected' | 'unavailable' | 'corrupt' | null;
  credentialExpiresAt: string | null;
  bundleState: GrantRow['bundle_state'];
  verificationState: GrantRow['credential_state'];
  operationalState: GrantRow['operational_state'];
  eligible: boolean;
  availabilityState: 'stored_only' | 'available_next_session' | 'needs_reconciliation'
    | 'verification_expired' | 'credential_rejected' | 'credential_corrupt'
    | 'temporarily_unavailable' | 'not_available';
  reasonCode: 'not_verified' | 'verification_expired' | 'credential_rejected'
    | 'credential_corrupt' | 'verification_unavailable' | 'operational_ineligible'
    | 'placement_pending' | 'policy_disabled' | 'grant_inactive' | 'no_credential' | null;
  canRetryVerification: boolean;
  canReconnect: boolean;
  canRemove: boolean;
  grantedServices: readonly string[];
  availableBodies: readonly ('claude' | 'codex')[];
  pendingBodies: readonly ('claude' | 'codex')[];
}>;

const grantsEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env[CONNECTOR_GRANTS_V2_FLAG] === '1';

const grantFlag = (serviceId: string): string =>
  `NASSAJ_CONNECTOR_GRANT_CERT_${serviceId.toUpperCase().replace(/-/gu, '_')}`;

export const CONNECTOR_CREDENTIAL_RUNTIME_FLAG = 'NASSAJ_CONNECTOR_CREDENTIAL_RUNTIME_V2';

const switchName = (prefix: string, id: string): string =>
  `${prefix}${id.toUpperCase().replace(/-/gu, '_')}`;

export const connectorRuntimePolicyFor = (
  serviceId: string,
  env: Readonly<Record<string, string | undefined>>,
): ConnectorCredentialRuntimePolicy => {
  const spec = providerAuthSpecFor(serviceId);
  const contract = connectorCredentialContractFor(serviceId);
  return Object.freeze({
    registryEnabled: isProviderAuthRegistryEnabled(env),
    grantsEnabled: grantsEnabled(env),
    runtimeEnabled: env[CONNECTOR_CREDENTIAL_RUNTIME_FLAG] === '1',
    providerCertified: Boolean(spec && (spec.method !== 'api_key'
      || contract?.verification.status === 'certified')
      && isProviderAuthSpecCertified(spec, env)),
    providerEnabled: Boolean(spec && env[spec.certification.featureFlag] === '1'),
    serviceEnabled: env[switchName('NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_', serviceId)] === '1',
    expectedCatalogRevision: spec?.source.catalogRevision ?? '',
    expectedShapeRevision: contract?.shape.revision ?? 1,
    expectedContractRevision: contract?.verification.revision ?? 1,
  });
};

const enabledApiKeySpec = (
  serviceId: string,
  env: Readonly<Record<string, string | undefined>>,
  resolve: (serviceId: string) => ProviderAuthSpec | null = providerAuthSpecFor,
): ProviderAuthSpec & { method: 'api_key' } => {
  const spec = resolve(serviceId);
  if (!spec || spec.method !== 'api_key') throw new ConnectorUserGrantError('connector_grant_service_unsupported');
  if (!grantsEnabled(env) || !isProviderAuthRegistryEnabled(env) || env[grantFlag(serviceId)] !== '1'
    || !isProviderAuthSpecCertified(spec, env)) {
    throw new ConnectorUserGrantError('connector_grant_writer_disabled');
  }
  return spec;
};

const normalizeLabel = (value: unknown): Readonly<{ label: string; key: string }> => {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label || label.length > 128 || label.includes('\0')) {
    throw new ConnectorUserGrantError('connector_grant_label_invalid');
  }
  return { label, key: label.normalize('NFKC').toLocaleLowerCase('en-US') };
};

const validSecret = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 65_536 && !value.includes('\0');

const sqliteTimestamp = (millis: number): string =>
  new Date(millis).toISOString().replace('T', ' ').slice(0, 19);

const subjectAad = (input: Readonly<{
  installationId: string; providerId: string; profileId: string; grantId: string; kekVersion: number;
}>): Buffer => Buffer.from(
  `nassaj:grant-subject:v1\0${input.installationId}\0${input.providerId}\0${input.profileId}\0${input.grantId}\0${input.kekVersion}`,
  'utf8',
);

const encryptSubject = (
  raw: Buffer,
  context: Readonly<{ installationId: string; providerId: string; profileId: string; grantId: string }>,
  keyring: GrantKeyring,
) => {
  const kekVersion = keyring.activeKekVersion();
  const key = keyring.readKek(kekVersion);
  const nonce = randomBytes(12);
  const aad = subjectAad({ ...context, kekVersion });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
    return { ciphertext, nonce, authTag: cipher.getAuthTag(), kekVersion };
  } finally {
    key.fill(0);
    aad.fill(0);
  }
};

const bodyList = (value: string | null | undefined): readonly ('claude' | 'codex')[] =>
  [...new Set((value ?? '').split(',').filter((item): item is 'claude' | 'codex' =>
    item === 'claude' || item === 'codex'))].sort();

type GrantEligibilityView = Readonly<{ state: 'ready' | 'absent' | 'corrupt' }>
  | Readonly<{ state: 'ineligible'; reason: Extract<GrantMaterial, { state: 'ineligible' }>['reason'] }>;

export const connectorGrantDto = (
  row: GrantRow,
  env: Readonly<Record<string, string | undefined>>,
  material: GrantEligibilityView = { state: 'absent' },
  selectedServiceId = row.service_id,
): ConnectorUserGrantDto => {
  const policy = connectorRuntimePolicyFor(selectedServiceId, env);
  const availableBodies = bodyList(row.available_bodies);
  const pendingBodies = bodyList(row.pending_bodies);
  const eligible = material.state === 'ready';
  let availabilityState: ConnectorUserGrantDto['availabilityState'] = 'not_available';
  let reasonCode: ConnectorUserGrantDto['reasonCode'] = null;
  if (material.state === 'absent') reasonCode = 'no_credential';
  if (row.credential_state === 'stored_unverified') {
    availabilityState = 'stored_only'; reasonCode = 'not_verified';
  } else if (row.credential_state === 'stale') {
    availabilityState = 'verification_expired'; reasonCode = 'verification_expired';
  } else if (row.credential_state === 'rejected') {
    availabilityState = 'credential_rejected'; reasonCode = 'credential_rejected';
  } else if (row.credential_state === 'corrupt') {
    availabilityState = 'credential_corrupt'; reasonCode = 'credential_corrupt';
  } else if (row.credential_state === 'unavailable') {
    availabilityState = 'temporarily_unavailable'; reasonCode = 'verification_unavailable';
  } else if (material.state === 'corrupt') {
    availabilityState = 'credential_corrupt'; reasonCode = 'credential_corrupt';
  } else if (material.state === 'ineligible') {
    if (material.reason === 'verification_expired' || material.reason === 'credential_expired') {
      availabilityState = 'verification_expired'; reasonCode = 'verification_expired';
    } else if (material.reason === 'policy_disabled' || material.reason === 'provider_uncertified'
      || material.reason === 'revision_mismatch' || material.reason === 'revision_invalid'
      || material.reason === 'profile_inactive' || material.reason === 'identity_mismatch'
      || material.reason === 'subject_identity_mismatch' || material.reason === 'bundle_incomplete'
      || material.reason === 'ownership_invalid' || material.reason === 'revoked') {
      reasonCode = material.reason === 'policy_disabled' || material.reason === 'provider_uncertified'
        ? 'policy_disabled' : 'operational_ineligible';
      if (reasonCode === 'operational_ineligible') availabilityState = 'needs_reconciliation';
    } else if (material.reason === 'grant_inactive') reasonCode = 'grant_inactive';
    else if (material.reason === 'bundle_absent') reasonCode = 'no_credential';
    else if (material.reason === 'not_verified') reasonCode = 'not_verified';
    else {
      availabilityState = 'needs_reconciliation'; reasonCode = 'operational_ineligible';
    }
  } else if (row.credential_state === 'verified' && row.operational_state !== 'eligible') {
    availabilityState = 'needs_reconciliation'; reasonCode = 'operational_ineligible';
  } else if (eligible && pendingBodies.length === 0
    && CONNECTOR_ROLLOUT_BODY_PROVIDERS.every(body => availableBodies.includes(body))) {
    availabilityState = 'available_next_session';
  } else if (eligible) {
    availabilityState = 'needs_reconciliation'; reasonCode = 'placement_pending';
  } else if (row.status !== 'active') reasonCode = 'grant_inactive';
  const probeReady = connectorCredentialContractFor(selectedServiceId)?.verification.status === 'certified'
    && row.credential_shape === 'single_api_key';
  const spec = providerAuthSpecFor(selectedServiceId);
  const writesEnabled = Boolean(spec && policy.registryEnabled && policy.grantsEnabled
    && policy.providerEnabled && isProviderAuthSpecCertified(spec, env));
  const apiKeyWritesEnabled = writesEnabled && spec?.method === 'api_key'
    && env[grantFlag(selectedServiceId)] === '1';
  const oauthWritesEnabled = writesEnabled && spec?.method !== 'api_key'
    && env.NASSAJ_CONNECTOR_OAUTH_V2 === '1'
    && env[switchName('NASSAJ_CONNECTOR_OAUTH_CERT_', spec?.profileId ?? '')] === '1';
  return Object.freeze({
  grantId: row.grant_id,
  serviceId: row.service_id,
  accountLabel: row.account_label,
  isDefault: row.is_default === 1,
  status: row.status,
  ownership: 'personal' as const,
  credentialStatus: row.credential_state ?? null,
  credentialExpiresAt: row.credential_expires_at ?? null,
  bundleState: row.bundle_state ?? null,
  verificationState: row.credential_state ?? null,
  operationalState: row.operational_state ?? null,
  eligible, availabilityState, reasonCode,
  canRetryVerification: Boolean(probeReady && apiKeyWritesEnabled
    && row.credential_state === 'stored_unverified'),
  canReconnect: Boolean((apiKeyWritesEnabled || oauthWritesEnabled) && row.status !== 'revoked'),
  canRemove: row.status !== 'revoked',
  grantedServices: [...new Set((row.granted_services ?? row.service_id).split(',').filter(Boolean))].sort(),
  availableBodies,
  pendingBodies,
  });
};

export type ConnectorGrantMaterialReference = Readonly<{
  kind: 'v2' | 'legacy';
  credentialShape?: 'single_api_key' | 'geidea_basic';
  ownership: 'personal';
  serviceId: string;
  userId: number;
  grantId: string | null;
  secretRef: string;
  provenance: string;
}>;

export type ConnectorGrantMaterialBundle = Readonly<{
  shape: 'single_api_key' | 'geidea_basic' | 'oauth_token_bundle';
  fields: ReadonlyMap<
    'api_key' | 'merchant_public_key' | 'api_password' | 'oauth_token_bundle', Buffer
  >;
}>;

const materialReaders = new WeakMap<ConnectorGrantMaterialReference, () => ConnectorGrantMaterialBundle>();
const authorizedMaterialReferences = new WeakSet<ConnectorGrantMaterialReference>();

/** Runtime-only capability check; serialized/look-alike objects are never authorized. */
export const isAuthorizedConnectorGrantMaterialReference = (
  reference: ConnectorGrantMaterialReference | undefined,
  userId: number,
  serviceId: string,
): boolean => Boolean(reference && authorizedMaterialReferences.has(reference)
  && reference.userId === userId && reference.serviceId === serviceId
  && reference.ownership === 'personal');

/** Ends a temporal capability; subsequent look-alike or repeated use is denied. */
export const revokeAuthorizedConnectorGrantMaterialReference = (
  reference: ConnectorGrantMaterialReference,
): void => {
  authorizedMaterialReferences.delete(reference);
  materialReaders.delete(reference);
};

/** OAuth composition factory; boundary tests restrict this authority to the production root. */
export const createAuthorizedOAuthGrantMaterialReference = (input: Readonly<{
  userId: number; serviceId: string; grantId: string; secretRef: string;
  readBundle: () => Buffer;
}>): ConnectorGrantMaterialReference => {
  const reference = Object.freeze({
    kind: 'v2' as const, ownership: 'personal' as const,
    serviceId: input.serviceId, userId: input.userId,
    grantId: input.grantId, secretRef: input.secretRef, provenance: 'v2-oauth',
  });
  authorizedMaterialReferences.add(reference);
  materialReaders.set(reference, () => Object.freeze({
    shape: 'oauth_token_bundle' as const,
    fields: new Map([['oauth_token_bundle', input.readBundle()] as const]),
  }));
  return reference;
};

/** Atomic placement capability; callers must zero every returned field after use. */
export const readConnectorGrantMaterialBundle = (
  reference: ConnectorGrantMaterialReference,
): ConnectorGrantMaterialBundle | null => authorizedMaterialReferences.has(reference)
  ? materialReaders.get(reference)?.() ?? null
  : null;

/** One-shot async consumer: revoke and zeroize only after the callback settles. */
export const consumeAuthorizedConnectorGrantMaterial = async <T>(
  reference: ConnectorGrantMaterialReference,
  consume: (bundle: ConnectorGrantMaterialBundle) => T | Promise<T>,
): Promise<Awaited<T>> => {
  if (!authorizedMaterialReferences.has(reference)) {
    throw new ConnectorUserGrantError('connector_grant_capability_expired');
  }
  const bundle = readConnectorGrantMaterialBundle(reference);
  if (!bundle) {
    revokeAuthorizedConnectorGrantMaterialReference(reference);
    throw new ConnectorUserGrantError('connector_grant_material_incomplete');
  }
  try {
    return await consume(bundle);
  } finally {
    for (const field of bundle.fields.values()) field.fill(0);
    revokeAuthorizedConnectorGrantMaterialReference(reference);
  }
};

/** Placement-only capability: the opaque reference remains secret-free and non-serializable. */
export const readConnectorGrantMaterialSecret = (
  reference: ConnectorGrantMaterialReference,
): Buffer | null => {
  const bundle = readConnectorGrantMaterialBundle(reference);
  if (!bundle || bundle.shape !== 'single_api_key') return null;
  return bundle.fields.get('api_key') ?? null;
};

export const createConnectorUserGrantService = (deps: Readonly<{
  installationId: string;
  repository: ConnectorUserGrantRepository;
  keyring: GrantKeyring;
  env?: Readonly<Record<string, string | undefined>>;
  ids?: () => string;
  testApiKeyCandidate: (input: Readonly<{
    spec: ProviderAuthSpec & { method: 'api_key' }; apiKey: string;
  }>) => Promise<ConnectorApiKeyIdentityEvidence>;
  providerAuthSpecFor?: (serviceId: string) => ProviderAuthSpec | null;
  credentialContractFor?: typeof connectorCredentialContractFor;
}>) => {
  const env = deps.env ?? {};
  const resolveSpec = deps.providerAuthSpecFor ?? providerAuthSpecFor;
  const resolveContract = deps.credentialContractFor ?? connectorCredentialContractFor;

  const profileFor = (spec: ProviderAuthSpec & { method: 'api_key' }) => {
    let profile = deps.repository.listProfiles(deps.installationId)
      .find(candidate => candidate.providerId === spec.profileId && candidate.status === 'ready');
    if (!profile && deps.repository.ensureApiKeyGrantProfile) {
      profile = executeConnectorPolicyV2SynchronousWrite(deps.repository.ensureApiKeyGrantProfile.bind(deps.repository), {
        profileId: (deps.ids ?? randomUUID)(), installationId: deps.installationId,
        providerId: spec.profileId, canonicalOrigin: new URL(spec.expectedIssuer).origin,
        catalogRevision: spec.source.catalogRevision,
      });
    }
    if (!profile) throw new ConnectorUserGrantError('connector_grant_profile_unavailable');
    return { spec, profile };
  };

  const storeUnverifiedApiKey = async (
    userId: number,
    input: Readonly<{
      serviceId: string; apiKey?: string; accountLabel?: string;
      credentialFields?: Readonly<Record<string, string>>;
      acceptStoredUnverified?: boolean;
    }>,
    spec: ProviderAuthSpec & { method: 'api_key' },
  ): Promise<ConnectorUserGrantDto> => {
    const contract = resolveContract(input.serviceId);
    if (!contract || contract.verification.status !== 'pending') {
      throw new ConnectorUserGrantError('connector_grant_contract_unavailable');
    }
    const rawFields: Readonly<Record<string, string | undefined>> = contract.shape.id === 'single_api_key'
      ? { api_key: input.apiKey }
      : input.credentialFields ?? {};
    const expectedFieldIds = contract.shape.fields.map(field => field.id).sort();
    const suppliedFieldIds = Object.keys(rawFields).sort();
    if (JSON.stringify(expectedFieldIds) !== JSON.stringify(suppliedFieldIds)
      || (contract.shape.id === 'geidea_basic' && input.apiKey !== undefined)
      || (contract.shape.id === 'single_api_key' && input.credentialFields !== undefined)) {
      throw new ConnectorUserGrantError('connector_grant_request_invalid');
    }
    const fieldBytes = new Map(contract.shape.fields.map(field => [
      field.id, Buffer.from(typeof rawFields[field.id] === 'string' ? rawFields[field.id]! : '', 'utf8'),
    ] as const));
    try {
      validateConnectorCredentialBundle(input.serviceId, Object.fromEntries(fieldBytes));
    } catch {
      for (const bytes of fieldBytes.values()) bytes.fill(0);
      throw new ConnectorUserGrantError('connector_grant_request_invalid');
    }
    const { label, key } = normalizeLabel(input.accountLabel ?? 'Default');
    const { profile } = profileFor(spec);
    const existing = deps.repository.findUserGrant(deps.installationId, userId, input.serviceId, key);
    const grantId = existing?.grant_id ?? (deps.ids ?? randomUUID)();
    const grantFence = executeConnectorPolicyV2SynchronousWrite(deps.repository.acquireLease.bind(deps.repository), `grant:${grantId}`, (deps.ids ?? randomUUID)(), LEASE_TTL_SECONDS);
    if (!grantFence) throw new ConnectorUserGrantError('connector_grant_write_in_progress');
    const secretRefs: string[] = [];
    let bundleId: string | null = null;
    let credentialFence: ConnectorAuthLease | null = null;
    try {
      return executeConnectorPolicyV2SynchronousWrite(deps.repository.runCredentialWrite.bind(deps.repository), () => {
      if (existing?.status === 'active') {
        throw new ConnectorUserGrantError('connector_grant_verified_rotation_requires_probe');
      }
      if (!existing) {
        const provisional = Buffer.from(`unverified:${(deps.ids ?? randomUUID)()}`, 'utf8');
        try {
          const indexed = indexProviderSubject(provisional, {
            installationId: deps.installationId, providerId: spec.profileId, profileId: profile.profileId,
          }, deps.keyring);
          const encrypted = encryptSubject(provisional, {
            installationId: deps.installationId, providerId: spec.profileId,
            profileId: profile.profileId, grantId,
          }, deps.keyring);
          deps.repository.createGrant({
            grantId, profileId: profile.profileId, userId, serviceId: input.serviceId,
            providerSubjectHmac: indexed.providerSubjectHmac,
            providerSubjectCiphertext: encrypted.ciphertext,
            providerSubjectNonce: encrypted.nonce, providerSubjectTag: encrypted.authTag,
            providerSubjectKekVersion: encrypted.kekVersion,
            hmacKeyVersion: indexed.hmacKeyVersion, accountLabel: label, accountLabelKey: key,
            isDefault: false, secretRef: null, secretRevision: null, status: 'pending',
          });
        } finally { provisional.fill(0); }
      }
      const secretRevision = 1;
      const bundleFields = contract.shape.fields.map(field => {
        const secretRef = (deps.ids ?? randomUUID)();
        secretRefs.push(secretRef);
        const envelope = encryptConnectorVaultSecret(fieldBytes.get(field.id)!, {
          vaultSecretId: secretRef, installationId: deps.installationId,
          providerId: spec.profileId, subjectType: 'grant', subjectId: grantId,
          profileId: profile.profileId, userId, fieldPurpose: field.id, secretRevision,
        }, deps.keyring);
        deps.repository.createVaultSecret({
          secretRef, installationId: deps.installationId, providerId: spec.profileId,
          subjectType: 'grant', subjectId: grantId, profileId: profile.profileId, userId,
          fieldPurpose: field.id, secretKind: field.id, ...envelope,
        });
        return { fieldId: field.id, sensitivity: field.sensitivity, secretRef };
      });
      bundleId = (deps.ids ?? randomUUID)();
      credentialFence = deps.repository.acquireLease(
        `credential:${bundleId}:1`, (deps.ids ?? randomUUID)(), LEASE_TTL_SECONDS,
      );
      if (!credentialFence) throw new ConnectorUserGrantError('connector_grant_write_in_progress');
      const expiresAt = sqliteTimestamp(Date.now() + UNVERIFIED_CANDIDATE_TTL_SECONDS * 1_000);
      const hmacVersion = deps.keyring.activeHmacKeyVersion();
      const hmacKey = deps.keyring.readHmacKey(hmacVersion);
      let evidenceHmac: string;
      try {
        evidenceHmac = createHmac('sha256', hmacKey)
          .update(`nassaj:stored-unverified:v1\0${deps.installationId}\0${userId}\0`)
          .update(`${input.serviceId}\0${grantId}\0${bundleId}`)
          .digest('hex');
      } finally { hmacKey.fill(0); }
      if (!deps.repository.createCredentialBundleRevision({
        bundleId, bundleRevision: 1, installationId: deps.installationId, userId,
        providerId: spec.profileId, serviceId: input.serviceId, grantId,
        profileId: profile.profileId, credentialShape: contract.shape.id,
        shapeRevision: contract.shape.revision, secretRevision, expiresAt,
        fields: bundleFields,
        evidenceHmac, evidenceExpiresAt: expiresAt, fence: credentialFence,
      }) || !deps.repository.storeCredentialBundleRevision({
        bundleId, bundleRevision: 1, expectedVersion: 1, fence: credentialFence,
      }) || !deps.repository.retireOtherUnverifiedCredentialBundles({
        grantId, keepBundleId: bundleId, keepBundleRevision: 1, userId, fence: credentialFence,
      })) throw new ConnectorUserGrantError('connector_grant_fence_stale');
      return dtoForRow(deps.repository.listUserGrants(
        deps.installationId, userId, input.serviceId,
      ).find(row => row.grant_id === grantId)!);
      });
    } catch (error) {
      if (bundleId && credentialFence) {
        executeConnectorPolicyV2SynchronousWrite(deps.repository.deleteCredentialBundleAndEnvelopeReferences.bind(deps.repository), {
          bundleId, bundleRevision: 1, userId, fence: credentialFence,
        });
        if (!existing && secretRefs[0]) executeConnectorPolicyV2SynchronousWrite(deps.repository.discardOAuthGrantCandidate.bind(deps.repository), {
          grantId, secretRef: secretRefs[0], createdGrant: true,
        });
      } else if (secretRefs[0]) executeConnectorPolicyV2SynchronousWrite(deps.repository.discardOAuthGrantCandidate.bind(deps.repository), {
        grantId, secretRef: secretRefs[0], createdGrant: !existing,
      });
      if (secretRefs.length > 0) executeConnectorPolicyV2SynchronousWrite(deps.repository.deleteCandidateVaultSecrets.bind(deps.repository), {
        grantId, userId, secretRefs, fence: grantFence,
      });
      if (error instanceof ConnectorUserGrantError) throw error;
      throw new ConnectorUserGrantError('connector_grant_candidate_rejected');
    } finally {
      for (const bytes of fieldBytes.values()) bytes.fill(0);
      if (credentialFence) executeConnectorPolicyV2SynchronousWrite(deps.repository.releaseLease.bind(deps.repository), credentialFence);
      executeConnectorPolicyV2SynchronousWrite(deps.repository.releaseLease.bind(deps.repository), grantFence);
    }
  };

  const reverifyAttempts = new WeakMap<object, Readonly<{
    evidence: ConnectorApiKeyIdentityEvidence;
    source: Readonly<{ bundleId: string; bundleRevision: number; bundleVersion: number; grantId: string }>;
  }>>();
  const dtoForRow = (row: GrantRow, requestedServiceId?: string): ConnectorUserGrantDto => {
    const selectedServiceId = requestedServiceId ?? (providerAuthSpecFor(row.service_id)
      ? row.service_id
      : (row.granted_services ?? '').split(',').filter(Boolean).sort()[0] ?? row.service_id);
    return connectorGrantDto(row, env, deps.repository.readActiveGrantMaterial(
      deps.installationId, row.user_id, selectedServiceId, row.grant_id,
      connectorRuntimePolicyFor(selectedServiceId, env),
    ), selectedServiceId);
  };
  const service = {
    list(userId: number, serviceId?: string): readonly ConnectorUserGrantDto[] {
      if (!Number.isSafeInteger(userId) || userId <= 0
        || serviceId !== undefined && !ID_PATTERN.test(serviceId)) {
        throw new ConnectorUserGrantError('connector_grant_request_invalid');
      }
      executeConnectorPolicyV2SynchronousWrite(() => deps.repository.purgeExpiredCredentialCandidates?.(25));
      return deps.repository.listUserGrants(deps.installationId, userId, serviceId)
        .map(row => dtoForRow(row, serviceId));
    },

    /**
     * B-845: idempotently materialise the api_key provider profile row in the
     * `ready` state BEFORE the routing layer asserts the `CredentialVerify`
     * effect. The gate treats `CredentialVerify` as read-only and denies it with
     * `profile_unready` until a ready profile exists, but the only creator of an
     * api_key profile row lived inside `putPersonalApiKey` — after the gate — so
     * the first key save on a clean install always failed. Exposing the creator
     * lets the router run ProfileConfigure parity first (ADR-138 §ج/decision 1).
     *
     * Concurrency: `ensureApiKeyGrantProfile` uses `ON CONFLICT DO NOTHING` keyed
     * on (installation, provider, origin), so two concurrent first-saves for the
     * same member/service converge on exactly one row; the loser re-reads it.
     */
    ensureApiKeyProfile(serviceId: string): void {
      if (typeof serviceId !== 'string' || !ID_PATTERN.test(serviceId)) {
        throw new ConnectorUserGrantError('connector_grant_request_invalid');
      }
      profileFor(enabledApiKeySpec(serviceId, env, resolveSpec));
    },

    async putPersonalApiKey(userId: number, input: Readonly<{
      serviceId: string; apiKey?: string; accountLabel?: string;
      credentialFields?: Readonly<Record<string, string>>;
      acceptStoredUnverified?: boolean;
      providerSubject?: string; isDefault?: boolean; legacyProvenance?: string;
    }>): Promise<ConnectorUserGrantDto> {
      if (!Number.isSafeInteger(userId) || userId <= 0 || !input || !ID_PATTERN.test(input.serviceId)) {
        throw new ConnectorUserGrantError('connector_grant_request_invalid');
      }
      executeConnectorPolicyV2SynchronousWrite(() => deps.repository.purgeExpiredCredentialCandidates?.(25));
      const { label, key } = normalizeLabel(input.accountLabel ?? 'Default');
      const spec = enabledApiKeySpec(input.serviceId, env, resolveSpec);
      if (spec.serviceProbe.status !== 'certified') {
        if (input.acceptStoredUnverified !== true) {
          throw new ConnectorUserGrantError('connector_grant_unverified_opt_in_required');
        }
        return storeUnverifiedApiKey(userId, input, spec);
      }
      if (!validSecret(input.apiKey)) throw new ConnectorUserGrantError('connector_grant_request_invalid');
      const reverify = reverifyAttempts.get(input);
      let identityEvidence: ConnectorApiKeyIdentityEvidence;
      if (reverify) identityEvidence = reverify.evidence;
      else try {
          identityEvidence = await deps.testApiKeyCandidate({ spec, apiKey: input.apiKey });
        } catch {
          throw new ConnectorUserGrantError('connector_grant_candidate_rejected');
        }
      const { profile } = profileFor(spec);
      const contract = resolveContract(input.serviceId);
      if (!contract || contract.verification.status !== 'certified'
        || contract.shape.id !== 'single_api_key'
        || !contract.verification.identityKinds.includes(identityEvidence.identityKind)) {
        throw new ConnectorUserGrantError('connector_grant_contract_unavailable');
      }
      const existing = deps.repository.findUserGrant(deps.installationId, userId, input.serviceId, key);
      const grantId = existing?.grant_id ?? (deps.ids ?? randomUUID)();
      const fence = executeConnectorPolicyV2SynchronousWrite(deps.repository.acquireLease.bind(deps.repository), `grant:${grantId}`, (deps.ids ?? randomUUID)(), LEASE_TTL_SECONDS);
      if (!fence) throw new ConnectorUserGrantError('connector_grant_write_in_progress');
      if (reverify && (reverify.source.grantId !== grantId
        || !deps.repository.storedUnverifiedBundleIsCurrent({
          ...reverify.source, userId, fence,
        }))) {
        executeConnectorPolicyV2SynchronousWrite(deps.repository.releaseLease.bind(deps.repository), fence);
        throw new ConnectorUserGrantError('connector_grant_unverified_source_stale');
      }
      const secretBytes = Buffer.from(input.apiKey, 'utf8');
      let secretRef: string | null = null;
      let bundleId: string | null = null;
      let credentialFence: ConnectorAuthLease | null = null;
      try {
        let identityHmac: string;
        if (!existing) {
          // Identity is derived only from the certified provider response. A
          // client label, local fingerprint, or caller-supplied subject must
          // never become the authorization identity.
          const subject = Buffer.from(identityEvidence.providerSubject, 'utf8');
          try {
            const indexed = indexProviderSubject(subject, {
              installationId: deps.installationId, providerId: spec.profileId, profileId: profile.profileId,
            }, deps.keyring);
            identityHmac = indexed.providerSubjectHmac;
            const encrypted = encryptSubject(subject, {
              installationId: deps.installationId, providerId: spec.profileId,
              profileId: profile.profileId, grantId,
            }, deps.keyring);
            executeConnectorPolicyV2SynchronousWrite(deps.repository.createGrant.bind(deps.repository), {
              grantId, profileId: profile.profileId, userId, serviceId: input.serviceId,
              providerSubjectHmac: indexed.providerSubjectHmac,
              providerSubjectCiphertext: encrypted.ciphertext,
              providerSubjectNonce: encrypted.nonce, providerSubjectTag: encrypted.authTag,
              providerSubjectKekVersion: encrypted.kekVersion,
              hmacKeyVersion: indexed.hmacKeyVersion, accountLabel: label,
              accountLabelKey: key, isDefault: false,
              legacyProvenance: input.legacyProvenance ?? null,
              secretRef: null, secretRevision: null, status: 'pending',
            });
          } finally {
            subject.fill(0);
          }
        } else {
          const subject = Buffer.from(identityEvidence.providerSubject, 'utf8');
          try {
            const indexed = indexProviderSubject(subject, {
              installationId: deps.installationId, providerId: spec.profileId,
              profileId: profile.profileId,
            }, deps.keyring);
            identityHmac = indexed.providerSubjectHmac;
            if (existing.status === 'pending') {
              const encrypted = encryptSubject(subject, {
                installationId: deps.installationId, providerId: spec.profileId,
                profileId: profile.profileId, grantId,
              }, deps.keyring);
              if (!executeConnectorPolicyV2SynchronousWrite(deps.repository.adoptPendingGrantIdentity.bind(deps.repository), {
                grantId, userId, expectedVersion: existing.version,
                providerSubjectHmac: indexed.providerSubjectHmac,
                providerSubjectCiphertext: encrypted.ciphertext,
                providerSubjectNonce: encrypted.nonce, providerSubjectTag: encrypted.authTag,
                providerSubjectKekVersion: encrypted.kekVersion,
                hmacKeyVersion: indexed.hmacKeyVersion, fence,
              })) throw new ConnectorUserGrantError('connector_grant_fence_stale');
            }
          } finally { subject.fill(0); }
        }
        secretRef = (deps.ids ?? randomUUID)();
        const secretRevision = (existing?.secret_revision ?? 0) + 1;
        const envelope = encryptConnectorVaultSecret(secretBytes, {
          vaultSecretId: secretRef, installationId: deps.installationId,
          providerId: spec.profileId, subjectType: 'grant', subjectId: grantId,
          profileId: profile.profileId, userId, fieldPurpose: 'api_key', secretRevision,
        }, deps.keyring);
        executeConnectorPolicyV2SynchronousWrite(deps.repository.createVaultSecret.bind(deps.repository), {
          secretRef, installationId: deps.installationId, providerId: spec.profileId,
          subjectType: 'grant', subjectId: grantId, profileId: profile.profileId, userId,
          fieldPurpose: 'api_key', secretKind: 'api_key', ...envelope,
        });
        bundleId = (deps.ids ?? randomUUID)();
        const bundleRevision = 1;
        credentialFence = executeConnectorPolicyV2SynchronousWrite(deps.repository.acquireLease.bind(deps.repository), `credential:${bundleId}:${bundleRevision}`, (deps.ids ?? randomUUID)(), LEASE_TTL_SECONDS);
        if (!credentialFence) throw new ConnectorUserGrantError('connector_grant_write_in_progress');
        try {
          const now = Date.now();
          const evidenceExpiresAt = sqliteTimestamp(
            now + contract.verification.evidenceTtlSeconds * 1_000,
          );
          const hmacVersion = deps.keyring.activeHmacKeyVersion();
          const hmacKey = deps.keyring.readHmacKey(hmacVersion);
          let evidenceHmac: string;
          try {
            evidenceHmac = createHmac('sha256', hmacKey)
              .update(`nassaj:credential-evidence:v1\0${deps.installationId}\0${userId}\0`)
              .update(`${input.serviceId}\0${grantId}\0${identityEvidence.identityKind}\0${identityHmac}`)
              .digest('hex');
          } finally { hmacKey.fill(0); }
          if (!executeConnectorPolicyV2SynchronousWrite(deps.repository.createCredentialBundleRevision.bind(deps.repository), {
            bundleId, bundleRevision, installationId: deps.installationId, userId,
            providerId: spec.profileId, serviceId: input.serviceId, grantId,
            profileId: profile.profileId, credentialShape: 'single_api_key',
            shapeRevision: contract.shape.revision, secretRevision,
            expiresAt: '9999-12-31 23:59:59',
            fields: [{ fieldId: 'api_key', sensitivity: 'secret', secretRef }],
            evidenceHmac, evidenceExpiresAt, fence: credentialFence,
          }) || !executeConnectorPolicyV2SynchronousWrite(deps.repository.storeCredentialBundleRevision.bind(deps.repository), {
            bundleId, bundleRevision, expectedVersion: 1, fence: credentialFence,
          }) || !executeConnectorPolicyV2SynchronousWrite(deps.repository.recordCredentialVerification.bind(deps.repository), {
            bundleId, bundleRevision, expectedBundleVersion: 2,
            expectedVerificationVersion: 1, installationId: deps.installationId, userId,
            providerId: spec.profileId, serviceId: input.serviceId, grantId,
            secretRevision, shapeRevision: contract.shape.revision,
            contractRevision: contract.verification.revision, state: 'verified',
            reasonCode: 'provider_identity_verified', identityKind: identityEvidence.identityKind,
            identityHmac, evidenceHmac, expiresAt: evidenceExpiresAt, fence: credentialFence,
          }) || !executeConnectorPolicyV2SynchronousWrite(deps.repository.promoteCredentialBundle.bind(deps.repository), {
            bundleId, bundleRevision, expectedOperationalVersion: 1,
            grantId, secretRevision, fence: credentialFence,
            activation: {
              accountLabel: label, accountLabelKey: key,
              isDefault: input.isDefault ?? !deps.repository.listUserGrants(
                deps.installationId, userId, input.serviceId,
              ).some(row => row.status === 'active' && row.is_default === 1),
            },
          })) throw new ConnectorUserGrantError('connector_grant_fence_stale');
        } catch (error) {
          executeConnectorPolicyV2SynchronousWrite(deps.repository.deleteCredentialBundleAndEnvelopeReferences.bind(deps.repository), {
            bundleId, bundleRevision, userId, fence: credentialFence,
          });
          throw error;
        } finally {
          if (credentialFence) executeConnectorPolicyV2SynchronousWrite(deps.repository.releaseLease.bind(deps.repository), credentialFence);
        }
        const activated = deps.repository.listUserGrants(deps.installationId, userId, input.serviceId)
          .find(row => row.grant_id === grantId);
        if (!activated) throw new ConnectorUserGrantError('connector_grant_activation_failed');
        return dtoForRow(activated);
      } catch (error) {
        if (secretRef) executeConnectorPolicyV2SynchronousWrite(deps.repository.discardOAuthGrantCandidate.bind(deps.repository), {
          grantId, secretRef, createdGrant: !existing,
        });
        if (error instanceof ConnectorUserGrantError) throw error;
        throw new ConnectorUserGrantError('connector_grant_candidate_rejected');
      } finally {
        secretBytes.fill(0);
        executeConnectorPolicyV2SynchronousWrite(deps.repository.releaseLease.bind(deps.repository), fence);
      }
    },

    async reverifyStoredApiKey(userId: number, grantId: string): Promise<ConnectorUserGrantDto> {
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new ConnectorUserGrantError('connector_grant_request_invalid');
      }
      const stored = deps.repository.readStoredUnverifiedApiKey(deps.installationId, userId, grantId);
      if (!stored) throw new ConnectorUserGrantError('connector_grant_unverified_not_found');
      const spec = enabledApiKeySpec(stored.serviceId, env, resolveSpec);
      if (spec.serviceProbe.status !== 'certified') {
        throw new ConnectorUserGrantError('connector_grant_probe_not_certified');
      }
      const bytes = decryptConnectorVaultSecret(stored.envelope, {
        vaultSecretId: stored.secretRef, installationId: deps.installationId,
        providerId: stored.providerId, subjectType: 'grant', subjectId: grantId,
        profileId: stored.profileId, userId, fieldPurpose: 'api_key',
      }, deps.keyring);
      try {
        const apiKey = bytes.toString('utf8');
        let evidence: ConnectorApiKeyIdentityEvidence;
        try {
          evidence = await deps.testApiKeyCandidate({ spec, apiKey });
        } catch {
          throw new ConnectorUserGrantError('connector_grant_candidate_rejected');
        }
        const replacement = {
          serviceId: stored.serviceId, apiKey: bytes.toString('utf8'),
          accountLabel: stored.accountLabel,
        };
        reverifyAttempts.set(replacement, {
          evidence,
          source: {
            bundleId: stored.bundleId, bundleRevision: stored.bundleRevision,
            bundleVersion: stored.bundleVersion, grantId,
          },
        });
        return await service.putPersonalApiKey(userId, replacement);
      } finally { bytes.fill(0); }
    },

    revoke(userId: number, grantId: string): void {
      if (!Number.isSafeInteger(userId) || userId <= 0) throw new ConnectorUserGrantError('connector_grant_request_invalid');
      const row = deps.repository.listUserGrants(deps.installationId, userId)
        .find(candidate => candidate.grant_id === grantId);
      if (!row) throw new ConnectorUserGrantError('connector_grant_not_found');
      const fence = executeConnectorPolicyV2SynchronousWrite(deps.repository.acquireLease.bind(deps.repository), `grant:${grantId}`, (deps.ids ?? randomUUID)(), LEASE_TTL_SECONDS);
      if (!fence) throw new ConnectorUserGrantError('connector_grant_write_in_progress');
      try {
        if (!executeConnectorPolicyV2SynchronousWrite(deps.repository.revokeUserGrant.bind(deps.repository), { grantId, expectedVersion: row.version, userId, fence })) {
          throw new ConnectorUserGrantError('connector_grant_fence_stale');
        }
      } finally {
        executeConnectorPolicyV2SynchronousWrite(deps.repository.releaseLease.bind(deps.repository), fence);
      }
    },
  };
  return service;
};

export interface ConnectorLegacyCredentialReader {
  readCopy(userId: number, serviceId: string): Readonly<{
    secret: Buffer; provenance: string;
  }> | null;
}

const decryptSubject = (
  material: Extract<GrantMaterial, { state: 'ready' }>,
  installationId: string,
  keyring: ConnectorKekKeyring,
): Buffer => {
  const key = keyring.readKek(material.providerSubjectKekVersion);
  const aad = subjectAad({
    installationId, providerId: material.providerId, profileId: material.profileId,
    grantId: material.grantId, kekVersion: material.providerSubjectKekVersion,
  });
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, material.providerSubjectNonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(material.providerSubjectTag);
    return Buffer.concat([
      decipher.update(material.providerSubjectCiphertext), decipher.final(),
    ]);
  } finally {
    key.fill(0);
    aad.fill(0);
  }
};

/** Cryptographically bind a persisted grant subject to its stored HMAC before material use. */
export const assertConnectorGrantSubjectIdentity = (
  material: Extract<GrantMaterial, { state: 'ready' }>,
  installationId: string,
  keyring: ConnectorKekKeyring & ProviderSubjectHmacKeyring,
): void => {
  const subject = decryptSubject(material, installationId, keyring);
  try {
    const stored = indexProviderSubjectAtVersion(subject, {
      installationId, providerId: material.providerId, profileId: material.profileId,
    }, keyring, material.hmacKeyVersion);
    const left = Buffer.from(stored.providerSubjectHmac, 'hex');
    const right = Buffer.from(material.providerSubjectHmac, 'hex');
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new ConnectorUserGrantError('connector_grant_subject_corrupt');
    }
  } finally {
    subject.fill(0);
  }
};

const verifyV2Material = async (
  material: Extract<GrantMaterial, { state: 'ready' }>,
  installationId: string,
  userId: number,
  serviceId: string,
  repository: Pick<ConnectorUserGrantRepository,
    'acquireLease' | 'releaseLease' | 'rotateGrantSubjectIndex' | 'readActiveGrantMaterial'>,
  keyring: ConnectorKekKeyring & ProviderSubjectHmacKeyring,
  policy: ConnectorCredentialRuntimePolicy,
): Promise<ConnectorGrantMaterialReference> => {
  if (material.userId !== userId || material.serviceId !== serviceId || material.ownership !== 'personal') {
    throw new ConnectorUserGrantError('connector_grant_material_identity_mismatch');
  }
  assertConnectorGrantSubjectIdentity(material, installationId, keyring);
  const subject = decryptSubject(material, installationId, keyring);
  const context = { installationId, providerId: material.providerId, profileId: material.profileId };
  try {
    if (providerSubjectNeedsReindex(material.hmacKeyVersion, keyring)) {
      const next = indexProviderSubject(subject, context, keyring);
      const fence = repository.acquireLease(`grant:${material.grantId}`, randomUUID(), LEASE_TTL_SECONDS);
      if (!fence) throw new ConnectorUserGrantError('connector_grant_reindex_in_progress');
      try {
        if (!repository.rotateGrantSubjectIndex({
          grantId: material.grantId, userId, expectedVersion: material.version,
          expectedHmacKeyVersion: material.hmacKeyVersion,
          providerSubjectHmac: next.providerSubjectHmac, hmacKeyVersion: next.hmacKeyVersion, fence,
        })) {
          const concurrent = repository.readActiveGrantMaterial(
            installationId, userId, serviceId, material.grantId, policy,
          );
          const rotated = concurrent.state === 'ready'
            && concurrent.hmacKeyVersion === next.hmacKeyVersion
            && concurrent.providerSubjectHmac === next.providerSubjectHmac;
          const safelyDeferred = concurrent.state === 'ready'
            && concurrent.hmacKeyVersion === material.hmacKeyVersion
            && concurrent.providerSubjectHmac === material.providerSubjectHmac;
          // M2 evidence is immutable. Until a replacement bundle is reverified,
          // the prior HMAC key version remains an explicit readable generation;
          // it is not marked stale and the keyring retains that version.
          if (!rotated && !safelyDeferred) {
            throw new ConnectorUserGrantError('connector_grant_reindex_stale');
          }
        }
      } finally {
        repository.releaseLease(fence);
      }
    }
  } finally {
    subject.fill(0);
  }
  const plaintext = decryptConnectorVaultSecret(material.envelope, {
    vaultSecretId: material.secretRef, installationId, providerId: material.providerId,
    subjectType: 'grant', subjectId: material.grantId, profileId: material.profileId,
    userId, fieldPurpose: 'api_key',
  }, keyring);
  plaintext.fill(0);
  const reference = Object.freeze({
    kind: 'v2', credentialShape: 'single_api_key' as const,
    ownership: 'personal', serviceId, userId, grantId: material.grantId,
    secretRef: material.secretRef, provenance: material.materialGeneration,
  });
  materialReaders.set(reference, () => Object.freeze({
    shape: 'single_api_key' as const,
    fields: new Map([['api_key', decryptConnectorVaultSecret(material.envelope, {
      vaultSecretId: material.secretRef, installationId, providerId: material.providerId,
      subjectType: 'grant', subjectId: material.grantId, profileId: material.profileId,
      userId, fieldPurpose: 'api_key',
    }, keyring)] as const]),
  }));
  authorizedMaterialReferences.add(reference);
  return reference;
};

export const createConnectorGrantDualReader = (deps: Readonly<{
  installationId: string;
  repository: Pick<ConnectorUserGrantRepository,
    'readActiveGrantMaterial' | 'acquireLease' | 'releaseLease' | 'rotateGrantSubjectIndex'>;
  keyring: ConnectorKekKeyring & ProviderSubjectHmacKeyring;
  legacy: ConnectorLegacyCredentialReader;
  migrateLegacy?: (input: Readonly<{
    userId: number; serviceId: string; secret: Buffer; provenance: string; fingerprint: string;
  }>) => Promise<void>;
  env?: Readonly<Record<string, string | undefined>>;
}>) => ({
  async resolve(
    userId: number, serviceId: string, grantId?: string,
  ): Promise<ConnectorGrantMaterialReference | null> {
    const policy = connectorRuntimePolicyFor(serviceId, deps.env ?? {});
    const v2 = deps.repository.readActiveGrantMaterial(
      deps.installationId, userId, serviceId, grantId, policy,
    );
    if (v2.state === 'corrupt') throw new ConnectorUserGrantError('connector_grant_v2_corrupt');
    if (v2.state === 'ineligible') {
      throw new ConnectorUserGrantError(`connector_grant_v2_ineligible:${v2.reason}`);
    }
    if (v2.state === 'ready') {
      return verifyV2Material(
        v2, deps.installationId, userId, serviceId, deps.repository, deps.keyring, policy,
      );
    }
    if (deps.migrateLegacy && policy.registryEnabled && policy.grantsEnabled
      && policy.runtimeEnabled && policy.providerEnabled && policy.serviceEnabled) {
      enabledApiKeySpec(serviceId, deps.env ?? {});
    }
    const runtime = evaluateConnectorRuntimePolicy(policy);
    if (!runtime.eligible) throw new ConnectorUserGrantError('connector_grant_runtime_disabled');
    const legacy = deps.legacy.readCopy(userId, serviceId);
    if (!legacy) return null;
    const copy = Buffer.from(legacy.secret);
    try {
      const hmacVersion = deps.keyring.activeHmacKeyVersion();
      const hmacKey = deps.keyring.readHmacKey(hmacVersion);
      let fingerprint: string;
      try {
        fingerprint = createHmac('sha256', hmacKey)
          .update(`nassaj:legacy-grant:v1\0${userId}\0${serviceId}\0${legacy.provenance}\0`)
          .update(copy).digest('hex');
      } finally {
        hmacKey.fill(0);
      }
      if (grantsEnabled(deps.env ?? {}) && deps.migrateLegacy) {
        enabledApiKeySpec(serviceId, deps.env ?? {});
        await deps.migrateLegacy({ userId, serviceId, secret: copy, provenance: legacy.provenance, fingerprint });
        const migrated = deps.repository.readActiveGrantMaterial(
          deps.installationId, userId, serviceId, grantId, policy,
        );
        if (migrated.state !== 'ready') throw new ConnectorUserGrantError('connector_grant_migration_failed');
        const verified = decryptConnectorVaultSecret(migrated.envelope, {
          vaultSecretId: migrated.secretRef, installationId: deps.installationId,
          providerId: migrated.providerId, subjectType: 'grant', subjectId: migrated.grantId,
          profileId: migrated.profileId, userId, fieldPurpose: 'api_key',
        }, deps.keyring);
        try {
          if (verified.length !== copy.length || !timingSafeEqual(verified, copy)) {
            throw new ConnectorUserGrantError('connector_grant_migration_verify_failed');
          }
        } finally {
          verified.fill(0);
        }
        return verifyV2Material(
          migrated, deps.installationId, userId, serviceId, deps.repository, deps.keyring, policy,
        );
      }
      const reference = Object.freeze({
        kind: 'legacy', credentialShape: 'single_api_key' as const,
        ownership: 'personal', serviceId, userId, grantId: null,
        secretRef: `legacy:${fingerprint}`, provenance: legacy.provenance,
      });
      materialReaders.set(reference, () => Object.freeze({
        shape: 'single_api_key' as const,
        fields: new Map([['api_key', Buffer.from(copy)] as const]),
      }));
      authorizedMaterialReferences.add(reference);
      return reference;
    } finally {
      copy.fill(0);
      legacy.secret.fill(0);
    }
  },
});

export type ConnectorGrantEligibleBody = Readonly<{
  bodyId: string; engine: 'claude' | 'codex' | string; userId: number;
  serviceIds: readonly string[]; teamShared?: boolean;
}>;

/** Resolves once and fans the SAME opaque material reference to eligible bodies for the next session. */
export const resolveConnectorGrantFanout = async (input: Readonly<{
  userId: number; serviceId: string; bodies: readonly ConnectorGrantEligibleBody[];
  resolve: () => Promise<ConnectorGrantMaterialReference | null>;
}>) => {
  const material = await input.resolve();
  if (!material) return Object.freeze([]);
  if (material.userId !== input.userId || material.serviceId !== input.serviceId
    || material.ownership !== 'personal') {
    throw new ConnectorUserGrantError('connector_grant_material_identity_mismatch');
  }
  return Object.freeze(input.bodies
    .filter(body => body.userId === input.userId
      && (body.engine === 'claude' || body.engine === 'codex')
      && body.teamShared !== true && body.serviceIds.includes(input.serviceId))
    .map(body => Object.freeze({
      bodyId: body.bodyId, engine: body.engine, material, appliesTo: 'next_session' as const,
    })));
};
