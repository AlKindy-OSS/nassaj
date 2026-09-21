import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type express from 'express';

import {
  createConnectorProfileManagementService,
  type ConnectorProfileLease,
  type ConnectorProfileManagementDependencies,
  type ConnectorProfileRepository,
  type ConnectorProfileSecretPurpose,
  type ManagedConnectorProfile,
} from './connector-auth-profile-management.js';
import {
  authorizedOwnerOperation,
  createConnectorOwnerOperationGate,
  type AuthorizedOwnerOperation,
  type ConnectorOwnerOperation,
} from './connector-owner-operation-gate.js';
import {
  decryptConnectorVaultSecret,
  type ConnectorKekKeyring,
  type ConnectorVaultEnvelope,
} from './connector-auth-vault.crypto.js';

const INSTALLATION_ID = '10000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://nassaj.example';
const CALLBACK = `${ORIGIN}/connectors/oauth/callback`;
const CSRF_TOKEN = 'e'.repeat(64);

const uuidFactory = () => {
  let sequence = 10;
  return () => `10000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
};

const keyring: ConnectorKekKeyring = {
  activeKekVersion: () => 1,
  readKek: () => Buffer.alloc(32, 7),
};

type StagedSecret = Readonly<{
  secretRef: string;
  profileId: string;
  fieldPurpose: ConnectorProfileSecretPurpose;
  envelope: ConnectorVaultEnvelope;
}>;

class FakeRepository implements ConnectorProfileRepository {
  profiles = new Map<string, ManagedConnectorProfile>();
  staged: StagedSecret[] = [];
  leases = new Map<string, ConnectorProfileLease>();
  staleOnStage = false;
  staleOnActivate = false;
  leaseAttempts = 0;
  operations = new Map<string, Readonly<{
    requestId: string; sessionId: string; installationId: string;
    userId: number; operation: ConnectorOwnerOperation; expiresAt: number;
  }>>();

  listProfiles() { return [...this.profiles.values()]; }
  findProfile(_installationId: string, providerId: string) {
    return this.profiles.get(providerId) ?? null;
  }
  acquireLease(leaseKey: string, ownerToken: string): ConnectorProfileLease | null {
    this.leaseAttempts += 1;
    if (this.leases.has(leaseKey)) return null;
    const lease = { leaseKey, ownerToken, fencingToken: this.leaseAttempts, expiresAt: '2999-01-01' };
    this.leases.set(leaseKey, lease);
    return lease;
  }
  releaseLease(fence: ConnectorProfileLease) {
    if (!this.currentFence(fence)) return false;
    this.leases.delete(fence.leaseKey);
    return true;
  }
  readOwnerAuthSession() {
    return {
      sessionId: '50000000-0000-4000-8000-000000000001',
      csrfTokenHash: createHash('sha256').update(CSRF_TOKEN).digest('hex'),
      authTime: 1_000_000,
      expiresAt: 2_000_000,
    };
  }
  issueOwnerOperation(input: Readonly<{
    sessionId: string; nonceHash: string; requestId: string; installationId: string;
    userId: number; operation: ConnectorOwnerOperation; nowMs: number; ttlMs: number;
  }>) {
    const sessionId = input.sessionId;
    const expiresAt = input.nowMs + input.ttlMs;
    this.operations.set(input.nonceHash, { ...input, sessionId, expiresAt });
    return { sessionId, authTime: input.nowMs, expiresAt };
  }
  consumeOwnerOperation(input: Readonly<{
    nonceHash: string; requestId: string; sessionId: string; installationId: string;
    userId: number; operation: ConnectorOwnerOperation; nowMs: number;
  }>) {
    const current = this.operations.get(input.nonceHash);
    if (!current || current.requestId !== input.requestId || current.sessionId !== input.sessionId
      || current.installationId !== input.installationId || current.userId !== input.userId
      || current.operation !== input.operation || current.expiresAt <= input.nowMs) return false;
    this.operations.delete(input.nonceHash);
    return true;
  }
  createPendingProfile(input: Parameters<ConnectorProfileRepository['createPendingProfile']>[0]) {
    if (!this.currentFence(input.fence)) return null;
    const profile: ManagedConnectorProfile = {
      profileId: input.profileId,
      installationId: input.installationId,
      providerId: input.providerId,
      canonicalOrigin: input.canonicalOrigin,
      status: 'pending',
      catalogRevision: input.catalogRevision,
      secretRef: null,
      secretRevision: null,
      secretRefs: {},
      version: 1,
    };
    this.profiles.set(input.providerId, profile);
    return profile;
  }
  stageVaultSecret(input: Parameters<ConnectorProfileRepository['stageVaultSecret']>[0]) {
    if (this.staleOnStage || !this.currentFence(input.fence)) return false;
    this.staged.push({
      secretRef: input.secretRef,
      profileId: input.profileId,
      fieldPurpose: input.fieldPurpose,
      envelope: input.envelope,
    });
    return true;
  }
  activateProfile(input: Parameters<ConnectorProfileRepository['activateProfile']>[0]) {
    const profile = [...this.profiles.values()].find(value => value.profileId === input.profileId);
    if (this.staleOnActivate || !profile || !this.currentFence(input.fence)
      || profile.version !== input.expectedVersion) return null;
    const active: ManagedConnectorProfile = {
      ...profile,
      status: 'ready',
      catalogRevision: input.catalogRevision,
      secretRefs: { ...input.secretRefs },
      version: profile.version + 1,
    };
    this.profiles.set(active.providerId, active);
    return active;
  }
  disableProfile(input: Parameters<ConnectorProfileRepository['disableProfile']>[0]) {
    const profile = [...this.profiles.values()].find(value => value.profileId === input.profileId);
    if (!profile || !this.currentFence(input.fence) || profile.version !== input.expectedVersion) return null;
    const disabled = { ...profile, status: 'disabled' as const, version: profile.version + 1 };
    this.profiles.set(disabled.providerId, disabled);
    return disabled;
  }
  releaseLeases() { this.leases.clear(); }
  private currentFence(fence: ConnectorProfileLease) {
    const current = this.leases.get(fence.leaseKey);
    return current?.ownerToken === fence.ownerToken && current.fencingToken === fence.fencingToken;
  }
}

const oldGoogleProfile = (): ManagedConnectorProfile => ({
  profileId: '20000000-0000-4000-8000-000000000001',
  installationId: INSTALLATION_ID,
  providerId: 'google-workspace',
  canonicalOrigin: 'https://accounts.google.com',
  status: 'ready',
  catalogRevision: 'old-revision',
  secretRef: null,
  secretRevision: null,
  secretRefs: {
    client_id: '30000000-0000-4000-8000-000000000001',
    client_secret: '30000000-0000-4000-8000-000000000002',
  },
  version: 7,
});

const dependencies = (
  repository: FakeRepository,
  overrides: Partial<ConnectorProfileManagementDependencies> = {},
): ConnectorProfileManagementDependencies => ({
  installation: { installationId: INSTALLATION_ID, canonicalOrigin: ORIGIN, callbackUrl: CALLBACK },
  repository,
  keyring,
  ids: uuidFactory(),
  now: () => 1_000_000,
  env: {
    NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
    NASSAJ_CONNECTOR_AUTH_CERT_GOOGLE_WORKSPACE: '1',
    NASSAJ_CONNECTOR_AUTH_CERT_GOOGLE_WORKSPACE: '1',
    NASSAJ_CONNECTOR_AUTH_CERT_GITHUB: '1',
  },
  testByoCandidate: async () => undefined,
  testApiKeyCandidate: async () => undefined,
  ...overrides,
});

const authority = (
  repository: FakeRepository,
  operation: ConnectorOwnerOperation,
  now = 1_000_000,
): AuthorizedOwnerOperation => {
  const req = {
    user: { id: 7, role: 'owner' },
    headers: {
      cookie: `nassaj_connector_recent_auth=${'a'.repeat(64)}`,
      'x-csrf-token': CSRF_TOKEN,
    },
    get: (name: string) => name.toLowerCase() === 'origin' ? ORIGIN
      : name.toLowerCase() === 'x-csrf-token' ? CSRF_TOKEN : undefined,
  } as unknown as express.Request;
  const res = {
    locals: {},
    status: () => res,
    json: () => res,
  } as unknown as express.Response;
  let next = false;
  createConnectorOwnerOperationGate({
    repository,
    installationId: INSTALLATION_ID,
    canonicalOrigin: ORIGIN,
    operation,
    now: () => now,
  })(req, res, () => { next = true; });
  assert.equal(next, true);
  return authorizedOwnerOperation(res);
};

test('BYO candidate failure leaves the prior active profile and secret refs unchanged', async () => {
  const repository = new FakeRepository();
  const previous = oldGoogleProfile();
  repository.profiles.set(previous.providerId, previous);
  const service = createConnectorProfileManagementService(dependencies(repository, {
    testByoCandidate: async () => { throw new Error('candidate rejected'); },
  }));
  await assert.rejects(() => service.upsertByo(authority(repository, 'upsert_byo'), {
    providerId: 'google-workspace', clientId: 'new-client', clientSecret: 'new-secret',
  }), /candidate_test_failed/);
  assert.deepEqual(repository.profiles.get(previous.providerId), previous);
  assert.deepEqual(repository.staged.map(secret => secret.fieldPurpose), ['client_id', 'client_secret']);
  assert.equal(repository.staged[0].secretRef === repository.staged[1].secretRef, false);
});

test('BYO activation returns an allowlisted DTO and never leaks credentials or transport metadata', async () => {
  const repository = new FakeRepository();
  const service = createConnectorProfileManagementService(dependencies(repository));
  const dto = await service.upsertByo(authority(repository, 'upsert_byo'), {
    providerId: 'google-workspace', clientId: 'client-value', clientSecret: 'secret-value',
  });
  const serialized = JSON.stringify(dto);
  assert.deepEqual(Object.keys(dto).sort(), [
    'authMethod', 'configured', 'providerId', 'readiness', 'services', 'status',
  ]);
  assert.equal(dto.configured, true);
  assert.equal(serialized.includes('client-value'), false);
  assert.equal(serialized.includes('secret-value'), false);
  assert.equal(serialized.includes('endpoint'), false);
  assert.deepEqual(repository.staged.map(secret => secret.fieldPurpose), ['client_id', 'client_secret']);
  const expected = { client_id: 'client-value', client_secret: 'secret-value' } as const;
  for (const staged of repository.staged) {
    const plaintext = decryptConnectorVaultSecret(staged.envelope, {
      vaultSecretId: staged.secretRef,
      installationId: INSTALLATION_ID,
      providerId: 'google-workspace',
      subjectType: 'profile',
      subjectId: staged.profileId,
      profileId: staged.profileId,
      userId: null,
      fieldPurpose: staged.fieldPurpose,
    }, keyring);
    try {
      assert.equal(plaintext.toString('utf8'), expected[staged.fieldPurpose as keyof typeof expected]);
    } finally {
      plaintext.fill(0);
    }
  }
});

test('all flags are off by default and pending DCR providers fail before metadata or registration', async () => {
  const repository = new FakeRepository();
  const service = createConnectorProfileManagementService(dependencies(repository, {
    env: {},
  }));
  await assert.rejects(() => service.registerDcr(
    authority(repository, 'register_dcr'), 'notion',
  ), /provider_not_certified/);
  assert.equal(repository.leaseAttempts, 0);
});

test('DCR certification cannot be overridden through production dependencies', async () => {
  const repository = new FakeRepository();
  const service = createConnectorProfileManagementService(dependencies(repository, {
    env: {
      NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
      NASSAJ_CONNECTOR_AUTH_CERT_NOTION: '1',
    },
  }));
  await assert.rejects(() => service.registerDcr(
    authority(repository, 'register_dcr'), 'notion',
  ), /provider_not_certified/);
  assert.equal(repository.leaseAttempts, 0);
});

test('a stale fence cannot stage or activate a candidate', async () => {
  const stageRepository = new FakeRepository();
  stageRepository.staleOnStage = true;
  const stageService = createConnectorProfileManagementService(dependencies(stageRepository));
  await assert.rejects(() => stageService.upsertByo(authority(stageRepository, 'upsert_byo'), {
    providerId: 'google-workspace', clientId: 'client', clientSecret: 'secret',
  }), /fence_stale/);
  assert.equal(stageRepository.profiles.get('google-workspace')?.status, 'pending');

  const activateRepository = new FakeRepository();
  activateRepository.staleOnActivate = true;
  const activateService = createConnectorProfileManagementService(dependencies(activateRepository));
  await assert.rejects(() => activateService.upsertByo(authority(activateRepository, 'upsert_byo'), {
    providerId: 'google-workspace', clientId: 'client', clientSecret: 'secret',
  }), /fence_stale/);
  assert.equal(activateRepository.profiles.get('google-workspace')?.status, 'pending');
});

test('installation-shared API keys require a fresh operation-bound verifier and reject user ownership', async () => {
  const repository = new FakeRepository();
  const rejected = createConnectorProfileManagementService(dependencies(repository));
  const wrongOperation = authority(repository, 'disable');
  await assert.rejects(() => rejected.upsertInstallationApiKey(wrongOperation, {
    providerId: 'github', apiKey: 'key', ownership: 'installation_shared',
  }), /owner_verification_failed/);
  const service = createConnectorProfileManagementService(dependencies(repository));
  await assert.rejects(() => service.upsertInstallationApiKey(
    authority(repository, 'upsert_shared_api_key'), {
    providerId: 'github', apiKey: 'key', ownership: 'user' as 'installation_shared',
  }), /candidate_invalid/);
  const dto = await service.upsertInstallationApiKey(
    authority(repository, 'upsert_shared_api_key'), {
    providerId: 'github', apiKey: 'key', ownership: 'installation_shared',
  });
  assert.equal(dto.configured, true);
  assert.deepEqual(repository.staged.map(secret => secret.fieldPurpose), ['api_key']);
});

test('a failed API-key probe leaves staged material inert and never marks the profile ready', async () => {
  const repository = new FakeRepository();
  const service = createConnectorProfileManagementService({
    ...dependencies(repository),
    testApiKeyCandidate: async () => { throw new Error('rejected'); },
  });
  await assert.rejects(() => service.upsertInstallationApiKey(
    authority(repository, 'upsert_shared_api_key'),
    { providerId: 'github', apiKey: 'invalid-key', ownership: 'installation_shared' },
  ), /candidate_test_failed/u);
  assert.equal(repository.profiles.has('github'), false);
  assert.equal(repository.staged.length, 0);
});

test('disable changes status only and preserves every encrypted secret reference', async () => {
  const repository = new FakeRepository();
  const previous = oldGoogleProfile();
  repository.profiles.set(previous.providerId, previous);
  const service = createConnectorProfileManagementService(dependencies(repository));
  const dto = await service.disable(authority(repository, 'disable'), previous.providerId);
  const stored = repository.profiles.get(previous.providerId)!;
  assert.equal(dto.status, 'disabled');
  assert.deepEqual(stored.secretRefs, previous.secretRefs);
  assert.equal(repository.staged.length, 0);
});

test('list emits only the stable allowlist DTO surface', async () => {
  const repository = new FakeRepository();
  repository.profiles.set('google-workspace', oldGoogleProfile());
  const service = createConnectorProfileManagementService(dependencies(repository));
  const list = await service.list();
  assert.ok(list.length > 10);
  for (const dto of list) {
    assert.deepEqual(Object.keys(dto).sort(), [
      'authMethod', 'configured', 'providerId', 'readiness', 'services', 'status',
    ]);
  }
  assert.equal(JSON.stringify(list).includes('allowedOrigins'), false);
  assert.equal(JSON.stringify(list).includes('secretRefs'), false);
});

test('null, undefined, and malformed provider inputs fail with sanitized service codes', async () => {
  const repository = new FakeRepository();
  const service = createConnectorProfileManagementService(dependencies(repository));
  await assert.rejects(
    () => service.upsertByo(authority(repository, 'upsert_byo'), null as never),
    error => error instanceof Error && error.message === 'connector_profile_candidate_invalid',
  );
  await assert.rejects(
    () => service.upsertInstallationApiKey(
      authority(repository, 'upsert_shared_api_key'), undefined as never,
    ),
    error => error instanceof Error && error.message === 'connector_profile_candidate_invalid',
  );
  await assert.rejects(
    () => service.registerDcr(authority(repository, 'register_dcr'), '../notion'),
    error => error instanceof Error && error.message === 'connector_profile_provider_not_supported',
  );
  await assert.rejects(
    () => service.disable(authority(repository, 'disable'), 'x'.repeat(129)),
    error => error instanceof Error && error.message === 'connector_profile_provider_not_supported',
  );
});

test('operation authority is single-use and cannot be replayed', async () => {
  const repository = new FakeRepository();
  const service = createConnectorProfileManagementService(dependencies(repository));
  const oneUse = authority(repository, 'register_dcr');
  await assert.rejects(() => service.registerDcr(oneUse, 'notion'), /provider_not_certified/);
  await assert.rejects(() => service.registerDcr(oneUse, 'notion'), /owner_verification_failed/);
});

test('operation authority rejects a mismatched stored request or session', async () => {
  for (const mismatch of ['requestId', 'sessionId'] as const) {
    const repository = new FakeRepository();
    const service = createConnectorProfileManagementService(dependencies(repository));
    const issued = authority(repository, 'register_dcr');
    const key = createHash('sha256').update(issued.nonce).digest('hex');
    const stored = repository.operations.get(key)!;
    repository.operations.set(key, { ...stored, [mismatch]: '60000000-0000-4000-8000-000000000001' });
    await assert.rejects(() => service.registerDcr(issued, 'notion'), /owner_verification_failed/);
  }
});

test('operation authority expires independently of the login session', async () => {
  const repository = new FakeRepository();
  const issued = authority(repository, 'register_dcr', 1_000_000);
  const service = createConnectorProfileManagementService(dependencies(repository, {
    now: () => 1_030_001,
  }));
  await assert.rejects(() => service.registerDcr(issued, 'notion'), /owner_verification_failed/);
});

test('write gate rejects missing or wrong CSRF before issuing an operation nonce', () => {
  for (const supplied of [undefined, '0'.repeat(64)]) {
    const repository = new FakeRepository();
    let status = 200;
    let body: unknown;
    let next = false;
    const req = {
      user: { id: 7, role: 'owner' },
      headers: { cookie: `nassaj_connector_recent_auth=${'a'.repeat(64)}` },
      get: (name: string) => name.toLowerCase() === 'origin' ? ORIGIN
        : name.toLowerCase() === 'x-csrf-token' ? supplied : undefined,
    } as unknown as express.Request;
    const res = {
      locals: {},
      status: (value: number) => { status = value; return res; },
      json: (value: unknown) => { body = value; return res; },
    } as unknown as express.Response;
    createConnectorOwnerOperationGate({
      repository, installationId: INSTALLATION_ID, canonicalOrigin: ORIGIN, operation: 'disable',
    })(req, res, () => { next = true; });
    assert.equal(next, false);
    assert.equal(status, 403);
    assert.equal((body as { code: string }).code, 'CONNECTOR_CSRF_REJECTED');
    assert.equal(repository.operations.size, 0);
  }
});
