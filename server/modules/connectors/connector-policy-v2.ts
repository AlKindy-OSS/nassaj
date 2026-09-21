/** Inert Policy V2 substrate. No production connector path imports this module. */

import { createHash, randomBytes } from 'node:crypto';

export enum ConnectorPolicyOperation {
  ProfileConfigure = 'profile.configure',
  GrantCreate = 'grant.create',
  OauthStart = 'oauth.start',
  CredentialVerify = 'credential.verify',
  CredentialStoreUnverified = 'credential.store_unverified',
  CredentialUse = 'credential.use',
  TokenRefresh = 'token.refresh',
  PlacementWrite = 'placement.write',
  GrantList = 'grant.list',
  GrantRemove = 'grant.remove',
  TokenRevoke = 'token.revoke',
  CredentialDelete = 'credential.delete',
  PlacementRemove = 'placement.remove',
}

export const KILLABLE_CONNECTOR_OPERATIONS = Object.freeze([
  ConnectorPolicyOperation.ProfileConfigure, ConnectorPolicyOperation.GrantCreate,
  ConnectorPolicyOperation.OauthStart,
  ConnectorPolicyOperation.CredentialVerify, ConnectorPolicyOperation.CredentialStoreUnverified,
  ConnectorPolicyOperation.CredentialUse, ConnectorPolicyOperation.TokenRefresh,
  ConnectorPolicyOperation.PlacementWrite,
] as const);

export const LIFECYCLE_CONNECTOR_OPERATIONS = Object.freeze([
  ConnectorPolicyOperation.GrantList, ConnectorPolicyOperation.GrantRemove,
  ConnectorPolicyOperation.TokenRevoke, ConnectorPolicyOperation.CredentialDelete,
  ConnectorPolicyOperation.PlacementRemove,
] as const);

export type ConnectorInstallationMode = 'portable_default' | 'legacy_quarantined';
export type ConnectorOwnership = 'personal' | 'team';

/** Exact ADR-132 snapshot vocabulary; consumers must not append ambient fields. */
export type ConnectorPolicySnapshot = Readonly<{
  policySchemaVersion: 2;
  policyEpoch: number;
  registryRevision: string;
  certificationManifestDigest: string;
  installationMode: ConnectorInstallationMode;
  originRevision: number;
  killRevision: number;
  writerEpoch: number;
  capturedAt: string;
}>;

export type ConnectorPolicyBinding = Readonly<{
  installationId: string;
  userId: number;
  ownership: ConnectorOwnership;
  providerId: string;
  serviceId: string;
  accountId: string;
  grantId: string;
  consumerBody: string;
  operation: ConnectorPolicyOperation;
}>;

export type ConnectorKillRules = Readonly<{
  global: boolean;
  providers: readonly string[];
  serviceOperations: readonly Readonly<{
    serviceId: string;
    operation: typeof KILLABLE_CONNECTOR_OPERATIONS[number];
  }>[];
}>;

export type ConnectorCertificationBinding = Readonly<{
  certified: boolean;
  providerId: string;
  serviceId: string;
  operation: typeof KILLABLE_CONNECTOR_OPERATIONS[number];
  manifestSequence: number;
  manifestDigest: string;
  originRevision: number;
  registryRevision: string;
  registryDigest: string;
  operationsRevision: string;
  operationsDigest: string;
  capabilityRevision: string;
  capabilityDigest: string;
  shapeRevision: number;
  shapeDigest: string;
  contractRevision: number;
  contractDigest: string;
}>;

export type ConnectorPolicyState = Readonly<{
  policySchemaVersion: 2;
  policyEpoch: number;
  registryRevision: string;
  certificationManifestDigest: string;
  installationMode: ConnectorInstallationMode;
  originRevision: number;
  killRevision: number;
  writerEpoch: number;
  kills: ConnectorKillRules;
}>;

const POLICY_OPERATIONS = new Set<string>(Object.values(ConnectorPolicyOperation));
const KILLABLE_OPERATIONS = new Set<string>(KILLABLE_CONNECTOR_OPERATIONS);
const LIFECYCLE_OPERATIONS = new Set<string>(LIFECYCLE_CONNECTOR_OPERATIONS);
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA512_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
export const CONNECTOR_REVISION_DIGEST_ALGORITHM = 'sha256' as const;
export const CONNECTOR_MANIFEST_DIGEST_ALGORITHM = 'sha512' as const;
/** Capabilities use strict server time; no early-consumption skew is permitted. */
export const CONNECTOR_CAPABILITY_CLOCK_SKEW_MS = 0 as const;

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};

const isStrictIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
};

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const validId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);
const validRevisionDigest = (value: unknown): value is string =>
  typeof value === 'string' && SHA256_BASE64URL_PATTERN.test(value);
const validManifestDigest = (value: unknown): value is string =>
  typeof value === 'string' && SHA512_BASE64URL_PATTERN.test(value);

const validBinding = (binding: ConnectorPolicyBinding): boolean =>
  binding !== null && typeof binding === 'object'
  && validId(binding.installationId) && positiveInteger(binding.userId)
  && (binding.ownership === 'personal' || binding.ownership === 'team')
  && [binding.providerId, binding.serviceId, binding.accountId, binding.grantId,
    binding.consumerBody].every(validId)
  && typeof binding.operation === 'string' && POLICY_OPERATIONS.has(binding.operation);

export const validateConnectorKillRules = (rules: ConnectorKillRules): boolean => {
  if (!rules || typeof rules !== 'object' || typeof rules.global !== 'boolean' || !Array.isArray(rules.providers)
    || !Array.isArray(rules.serviceOperations)) return false;
  if (!rules.providers.every(validId)
    || new Set(rules.providers).size !== rules.providers.length) return false;
  const pairs = new Set<string>();
  for (const entry of rules.serviceOperations) {
    if (!entry || typeof entry !== 'object' || !validId(entry.serviceId)
      || typeof entry.operation !== 'string' || !KILLABLE_OPERATIONS.has(entry.operation)) return false;
    const pair = `${entry.serviceId}\0${entry.operation}`;
    if (pairs.has(pair)) return false;
    pairs.add(pair);
  }
  return true;
};

export const connectorOperationKilled = (
  rules: ConnectorKillRules,
  binding: Pick<ConnectorPolicyBinding, 'providerId' | 'serviceId' | 'operation'>,
): boolean => {
  if (!binding || typeof binding !== 'object' || typeof binding.operation !== 'string'
    || !POLICY_OPERATIONS.has(binding.operation)) return true;
  if (LIFECYCLE_OPERATIONS.has(binding.operation)) return false;
  if (!validateConnectorKillRules(rules)) return true;
  return rules.global || rules.providers.includes(binding.providerId)
    || rules.serviceOperations.some(entry => entry.serviceId === binding.serviceId
      && entry.operation === binding.operation);
};

const validSnapshot = (snapshot: ConnectorPolicySnapshot): boolean =>
  snapshot !== null && typeof snapshot === 'object' && Object.keys(snapshot).sort().join(',') === [
    'capturedAt', 'certificationManifestDigest', 'installationMode', 'killRevision',
    'originRevision', 'policyEpoch', 'policySchemaVersion', 'registryRevision', 'writerEpoch',
  ].join(',') && snapshot.policySchemaVersion === 2 && positiveInteger(snapshot.policyEpoch)
  && validId(snapshot.registryRevision) && validManifestDigest(snapshot.certificationManifestDigest)
  && (snapshot.installationMode === 'portable_default' || snapshot.installationMode === 'legacy_quarantined')
  && positiveInteger(snapshot.originRevision) && nonnegativeInteger(snapshot.killRevision)
  && positiveInteger(snapshot.writerEpoch) && isStrictIsoDate(snapshot.capturedAt);

const validState = (state: ConnectorPolicyState): boolean =>
  state !== null && typeof state === 'object'
  && state.policySchemaVersion === 2 && positiveInteger(state.policyEpoch)
  && validId(state.registryRevision) && validManifestDigest(state.certificationManifestDigest)
  && (state.installationMode === 'portable_default' || state.installationMode === 'legacy_quarantined')
  && positiveInteger(state.originRevision) && nonnegativeInteger(state.killRevision)
  && positiveInteger(state.writerEpoch) && validateConnectorKillRules(state.kills);

export const captureConnectorPolicySnapshot = (
  state: ConnectorPolicyState,
  capturedAt: Date,
): ConnectorPolicySnapshot | null => {
  if (!validState(state) || !(capturedAt instanceof Date)
    || !Number.isFinite(capturedAt.getTime())) return null;
  const snapshot = {
    policySchemaVersion: state.policySchemaVersion, policyEpoch: state.policyEpoch,
    registryRevision: state.registryRevision,
    certificationManifestDigest: state.certificationManifestDigest,
    installationMode: state.installationMode, originRevision: state.originRevision,
    killRevision: state.killRevision, writerEpoch: state.writerEpoch,
    capturedAt: capturedAt.toISOString(),
  };
  return validSnapshot(snapshot) ? deepFreeze(snapshot) : null;
};

export type ConnectorPolicyDecision = Readonly<{
  snapshot: ConnectorPolicySnapshot;
  bindingDigest: string;
  eligible: boolean;
  reason: 'eligible' | 'binding_invalid' | 'snapshot_invalid' | 'uncertified'
  | 'certification_mismatch' | 'policy_killed';
}>;

/** Pure, offline, fail-closed resolver. It accepts no environment or provider-I/O input. */
export const resolveConnectorPolicy = (input: Readonly<{
  snapshot: ConnectorPolicySnapshot;
  binding: ConnectorPolicyBinding;
  certification: ConnectorCertificationBinding;
  kills: ConnectorKillRules;
}>): ConnectorPolicyDecision => {
  let reason: ConnectorPolicyDecision['reason'] = 'eligible';
  if (!validSnapshot(input.snapshot)) reason = 'snapshot_invalid';
  else if (!validBinding(input.binding)) reason = 'binding_invalid';
  else if (connectorOperationKilled(input.kills, input.binding)) reason = 'policy_killed';
  else if (!input.certification || typeof input.certification !== 'object'
    || !input.certification.certified) reason = 'uncertified';
  else if (!validCertificationBinding(input.certification)
    || input.certification.providerId !== input.binding.providerId
    || input.certification.serviceId !== input.binding.serviceId
    || input.certification.operation !== input.binding.operation
    || input.certification.manifestDigest !== input.snapshot.certificationManifestDigest
    || input.certification.registryRevision !== input.snapshot.registryRevision
    || input.certification.originRevision !== input.snapshot.originRevision) reason = 'certification_mismatch';
  return deepFreeze({ snapshot: { ...input.snapshot },
    bindingDigest: reason === 'eligible' ? policyBindingDigest(input.binding, input.certification) : '',
    eligible: reason === 'eligible', reason });
};

const validCertificationBinding = (binding: ConnectorCertificationBinding): boolean =>
  binding !== null && typeof binding === 'object'
  && binding.certified === true && validId(binding.providerId) && validId(binding.serviceId)
  && typeof binding.operation === 'string' && KILLABLE_OPERATIONS.has(binding.operation)
  && positiveInteger(binding.manifestSequence) && validManifestDigest(binding.manifestDigest)
  && positiveInteger(binding.originRevision) && validId(binding.registryRevision)
  && validRevisionDigest(binding.registryDigest)
  && validId(binding.operationsRevision) && validRevisionDigest(binding.operationsDigest)
  && validId(binding.capabilityRevision) && validRevisionDigest(binding.capabilityDigest)
  && positiveInteger(binding.shapeRevision) && validRevisionDigest(binding.shapeDigest)
  && positiveInteger(binding.contractRevision) && validRevisionDigest(binding.contractDigest);

const policyBindingDigest = (
  binding: ConnectorPolicyBinding,
  certification: ConnectorCertificationBinding,
): string => createHash('sha256').update('NASSAJ\0CONNECTOR_POLICY_DECISION\0V2\0')
  .update(JSON.stringify([binding, certification])).digest('base64url');

type CapabilityRecord = Readonly<ConnectorPolicyBinding & ConnectorCertificationBinding & {
  snapshot: ConnectorPolicySnapshot;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  subjectDigest: string;
  bindingDigest: string;
}>;

const capabilityRecords = new WeakMap<ConnectorPolicyCapability, CapabilityRecord>();

/** Opaque authority token: no bindings are exposed, enumerable, or serializable. */
export class ConnectorPolicyCapability {
  private constructor() { Object.freeze(this); }
  static create(): ConnectorPolicyCapability { return new ConnectorPolicyCapability(); }
  toJSON(): never { throw new Error('connector_policy_capability_not_serializable'); }
  [Symbol.toPrimitive](): never { throw new Error('connector_policy_capability_not_serializable'); }
}

type SnapshotRevision = Pick<ConnectorPolicySnapshot,
  'policySchemaVersion' | 'policyEpoch' | 'registryRevision' | 'certificationManifestDigest' | 'installationMode'
  | 'originRevision' | 'killRevision' | 'writerEpoch'>;

export interface ConnectorPolicyDurableStore {
  read(installationId: string): Promise<ConnectorPolicyState>;
  replace(
    installationId: string, expected: SnapshotRevision, replacement: ConnectorPolicyState,
  ): Promise<ConnectorPolicyState>;
  registerCapability(record: CapabilityRecord): Promise<boolean>;
  consumeCapability(input: Readonly<{
    installationId: string; nonce: string; bindingDigest: string; subjectDigest: string; now: string;
  }>): Promise<boolean>;
}

const capabilityDigest = (record: Omit<CapabilityRecord, 'bindingDigest'>): string => createHash('sha256')
  .update('NASSAJ\0CONNECTOR_POLICY_CAPABILITY\0V2\0')
  .update(JSON.stringify(record)).digest('base64url');

const capabilitySubjectDigest = (binding: ConnectorPolicyBinding): string => createHash('sha256')
  .update('NASSAJ\0CONNECTOR_POLICY_SUBJECT\0V2\0').update(JSON.stringify(binding)).digest('base64url');

/** Issues only an opaque token after an atomic current-policy check in the durable store. */
export const issueConnectorPolicyCapability = async (
  decision: ConnectorPolicyDecision,
  binding: ConnectorPolicyBinding,
  certification: ConnectorCertificationBinding,
  store: ConnectorPolicyDurableStore,
  options: Readonly<{ now: Date; ttlMs: number; nonce?: string }>,
): Promise<ConnectorPolicyCapability | null> => {
  if (!decision.eligible || !validBinding(binding) || !Number.isSafeInteger(options.ttlMs)
    || !validCertificationBinding(certification)
    || decision.bindingDigest !== policyBindingDigest(binding, certification)
    || options.ttlMs < 1 || options.ttlMs > 60_000 || !Number.isFinite(options.now.getTime())) return null;
  const expiryMs = options.now.getTime() + options.ttlMs;
  if (!Number.isFinite(expiryMs) || expiryMs > 8.64e15) return null;
  const partial = deepFreeze({ ...binding, ...certification, snapshot: decision.snapshot,
    nonce: options.nonce ?? randomBytes(24).toString('base64url'),
    issuedAt: options.now.toISOString(), subjectDigest: capabilitySubjectDigest(binding),
    expiresAt: new Date(expiryMs).toISOString() });
  const record = deepFreeze({ ...partial, bindingDigest: capabilityDigest(partial) });
  if (!await store.registerCapability(record)) return null;
  const capability = ConnectorPolicyCapability.create();
  capabilityRecords.set(capability, record);
  return capability;
};

/** Atomically compares current revisions, current kills, TTL, binding, and consumes the nonce. */
export const consumeConnectorPolicyCapability = async (
  capability: ConnectorPolicyCapability,
  expectedBinding: ConnectorPolicyBinding,
  store: ConnectorPolicyDurableStore,
  now: Date,
): Promise<boolean> => {
  const record = capabilityRecords.get(capability);
  if (!record || !validBinding(expectedBinding) || !Number.isFinite(now.getTime())) return false;
  return store.consumeCapability({ installationId: record.installationId, nonce: record.nonce,
    bindingDigest: record.bindingDigest, subjectDigest: capabilitySubjectDigest(expectedBinding),
    now: now.toISOString() });
};

const initialState = (): ConnectorPolicyState => deepFreeze({
  policySchemaVersion: 2, policyEpoch: 1, registryRevision: 'registry-1',
  certificationManifestDigest: '0'.repeat(86),
  installationMode: 'portable_default', originRevision: 1, killRevision: 0,
  writerEpoch: 1, kills: { global: false, providers: [], serviceOperations: [] },
});

/** Test/dev fixture only; every mutation is synchronous inside its async transaction boundary. */
export class MemoryConnectorPolicyStore implements ConnectorPolicyDurableStore {
  readonly #states = new Map<string, ConnectorPolicyState>();
  readonly #capabilities = new Map<string, CapabilityRecord>();

  constructor(seed?: Readonly<{ installationId: string; state: ConnectorPolicyState }>) {
    if (seed && validId(seed.installationId) && validState(seed.state)) {
      this.#states.set(seed.installationId, cloneState(seed.state));
    }
  }

  async read(id: string): Promise<ConnectorPolicyState> {
    return this.#states.get(id) ?? initialState();
  }

  async replace(id: string, expected: SnapshotRevision, next: ConnectorPolicyState): Promise<ConnectorPolicyState> {
    const current = this.#states.get(id) ?? initialState();
    if (!sameRevision(current, expected) || !validStateReplacement(current, next)) {
      throw new Error('connector_policy_revision_conflict');
    }
    const stored = cloneState(next);
    this.#states.set(id, stored);
    return stored;
  }

  async registerCapability(record: CapabilityRecord): Promise<boolean> {
    const current = this.#states.get(record.installationId) ?? initialState();
    if (!snapshotCurrent(record.snapshot, current) || !validateConnectorKillRules(current.kills)
      || connectorOperationKilled(current.kills, record) || this.#capabilities.has(record.nonce)) return false;
    this.#capabilities.set(record.nonce, record);
    return true;
  }

  async consumeCapability(input: Readonly<{
    installationId: string; nonce: string; bindingDigest: string; subjectDigest: string; now: string;
  }>): Promise<boolean> {
    const record = this.#capabilities.get(input.nonce);
    this.#capabilities.delete(input.nonce);
    const current = this.#states.get(input.installationId) ?? initialState();
    return Boolean(record && record.installationId === input.installationId
      && record.bindingDigest === input.bindingDigest && isStrictIsoDate(input.now)
      && record.subjectDigest === input.subjectDigest
      && Date.parse(record.issuedAt) <= Date.parse(input.now) + CONNECTOR_CAPABILITY_CLOCK_SKEW_MS
      && record.expiresAt > input.now
      && snapshotCurrent(record.snapshot, current)
      && validateConnectorKillRules(current.kills) && !connectorOperationKilled(current.kills, record));
  }
}

const sameRevision = (state: ConnectorPolicyState, revision: SnapshotRevision): boolean =>
  state.policySchemaVersion === revision.policySchemaVersion && state.policyEpoch === revision.policyEpoch
  && state.registryRevision === revision.registryRevision
  && state.certificationManifestDigest === revision.certificationManifestDigest
  && state.installationMode === revision.installationMode
  && state.originRevision === revision.originRevision && state.killRevision === revision.killRevision
  && state.writerEpoch === revision.writerEpoch;

const snapshotCurrent = (snapshot: ConnectorPolicySnapshot, state: ConnectorPolicyState): boolean =>
  sameRevision(state, snapshot);

const validStateReplacement = (current: ConnectorPolicyState, next: ConnectorPolicyState): boolean => {
  if (!validState(next)) return false;
  if (next.policyEpoch < current.policyEpoch || next.originRevision < current.originRevision
    || next.writerEpoch <= current.writerEpoch) return false;
  const killsChanged = JSON.stringify(current.kills) !== JSON.stringify(next.kills);
  return next.killRevision === current.killRevision + (killsChanged ? 1 : 0);
};

const cloneState = (state: ConnectorPolicyState): ConnectorPolicyState => deepFreeze({
  ...state, kills: { global: state.kills.global, providers: [...state.kills.providers],
    serviceOperations: state.kills.serviceOperations.map(entry => ({ ...entry })) },
});
