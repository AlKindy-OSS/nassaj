/** Production lifecycle/readiness composition for inert Policy V2 Substrate-Only. */

import { createHash, randomUUID } from 'node:crypto';


import type { Database } from 'better-sqlite3';
import express from 'express';

// eslint-disable-next-line boundaries/no-unknown -- root-verified bootstrap context is a builtins-only authority leaf outside feature modules.
import { requireStartupAdmission } from '../../bootstrap-startup-context.js';
import { CONNECTOR_AUTH_CATALOG_REVISION, PROVIDER_AUTH_SPECS } from '../../../shared/connector-auth-registry.js';
// eslint-disable-next-line boundaries/dependencies -- substrate composition validates the canonical migration marker.
import { initialConnectorPolicyV2SubstrateState } from '../database/connector-policy-v2.migration.js';
// eslint-disable-next-line boundaries/dependencies -- sole readiness composition reads sanitized auth sessions.
import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';

import {
  ConnectorInstallationOriginV2Store,
  createConnectorInstallationReadinessV2Routes,
  type ConnectorReadinessFact,
} from './connector-installation-readiness-v2.js';
import { CONNECTOR_PUBLIC_ORIGIN_ENV } from './connector-auth-security.js';
import { connectorEnvironmentOriginProposal,
  ConnectorInstallationOriginResolver } from './connector-installation-origin-resolver.js';
import { connectorRecentAuthCookieName,
  createConnectorOwnerOperationGate } from './connector-owner-operation-gate.js';
import { configureConnectorOwnerAuthSessionProduction } from './connector-owner-auth-session.js';
import { runConnectorAutoSetupOnBoot } from './connector-auto-setup.js';
import { createConnectorOwnerSetupRoutes } from './connector-owner-setup.routes.js';
import { ConnectorOwnerSetupService } from './connector-owner-setup.service.js';
import { ConnectorProvisioningService } from './connector-provisioning.service.js';
import { createConnectorProvisioningRoutes } from './connector-provisioning.routes.js';
import { decideConnectorActivation } from './connector-activation-gate.js';
import { verifyConnectorGlobalCertificationPack,
  decideConnectorGlobalCertification,
  type ConnectorCertificationAuthMethod,
  type ConnectorGlobalPackVerification } from './connector-global-certification-pack.js';
import { parseConnectorLocalActivationRecord,
  type ConnectorLocalActivationVerification } from './connector-local-activation.js';
import { connectorJcs } from './connector-jcs.js';
import { SqliteConnectorPolicyV2Store } from './connector-policy-v2-store.js';
import { LIFECYCLE_CONNECTOR_OPERATIONS, validateConnectorKillRules,
  ConnectorPolicyOperation, type ConnectorPolicyState } from './connector-policy-v2.js';
import { CONNECTOR_RUNTIME_PACK_EXPECTATIONS } from './connector-runtime-manifest.js';
import { ConnectorSetupStore } from './connector-setup-store.js';
import { parseConnectorTrustBundle } from './connector-trust-bundle.js';
import {
  openOrCreateConnectorRuntimeAuthorityRoot,
  readConnectorRuntimeAuthorityRoot,
} from './connector-runtime-authority-root.js';
import {
  CONNECTOR_POLICY_SCHEMA_VERSION,
  CONNECTOR_RUNTIME_FLOOR,
  ConnectorRuntimeAuthority,
  ConnectorRuntimeWriteGate,
  preflightConnectorRuntime,
  reinstallConnectorRuntimeFence,
  verifyConnectorRuntimeActivationMac,
  verifyExistingConnectorRuntimeFence,
} from './connector-runtime-fence.js';

const BUILD = Object.freeze({ runtimeVersion: CONNECTOR_RUNTIME_FLOOR,
  maximumPolicySchemaVersion: CONNECTOR_POLICY_SCHEMA_VERSION, supportsWriterFencing: true });

type Runtime = Readonly<{ installationId: string; routes: express.Router; ownerSetupRoutes: express.Router; provisioningRoutes: express.Router;
  originResolver: ConnectorInstallationOriginResolver; database: Database;
  authority: ConnectorRuntimeAuthority; setupStore: ConnectorSetupStore }>;
let runtime: Runtime | null = null;
let unavailableReason = 'not_initialized';
let lifecycleWrite: ((effect: () => void) => boolean) | null = null;
let substrateInstalled = false;

/** Sole production mutation seam for owner-session lifecycle rows under the M2 fence. */
export const executeConnectorPolicyV2LifecycleWrite = (effect: () => void): boolean =>
  lifecycleWrite?.(effect) ?? false;

/** Execute a synchronous mutation in the declared mode; runtime failure never selects legacy. */
export const executeConnectorPolicyV2SynchronousWrite = <T, Args extends unknown[]>(effect: (...args: Args) => T, ...args: Args): T => {
  if (!substrateInstalled) return effect(...args);
  let result: T | undefined;
  if (!executeConnectorPolicyV2LifecycleWrite(() => { result = effect(...args); })) {
    throw new Error('connector_runtime_lifecycle_write_unavailable');
  }
  return result as T;
};

/** Database-only runtime origin authority. Environment values never escape as runtime origin. */
export const resolveConnectorRuntimeInstallationOrigin = () => runtime?.originResolver
  .resolve(runtime.installationId) ?? null;

/** True after schema-2 installation is observed, including fail-closed runtime states. */
export const connectorPolicyV2ClaimsLegacyPaths = (): boolean => substrateInstalled;

const lifecycleOperations = new Set<string>(LIFECYCLE_CONNECTOR_OPERATIONS);

export type ConnectorProviderEffect = Readonly<{ operation: ConnectorPolicyOperation;
  providerId: string; serviceId: string; userId?: number; grantId?: string }>;

const invalidPack = (reason: string): ConnectorGlobalPackVerification => ({ verified: false, reason });
const invalidActivation = (reason: string): ConnectorLocalActivationVerification => ({ verified: false, reason });

const policyState = (current: Runtime): ConnectorPolicyState | null => {
  try {
    const row = current.database.prepare(`SELECT state_json AS json FROM connector_policy_v2_state
      WHERE installation_id=?`).get(current.installationId) as { json: string }|undefined;
    const state = JSON.parse(row?.json ?? 'null') as ConnectorPolicyState|null;
    return state?.policySchemaVersion === 2 && validateConnectorKillRules(state.kills) ? state : null;
  } catch { return null; }
};

const verifiedFoundation = (current: Runtime, nowMs: number): Readonly<{
  state: ConnectorPolicyState|null; pack: ConnectorGlobalPackVerification;
  local: ConnectorLocalActivationVerification; quarantined: boolean }> => {
  const state = policyState(current); const trustRow = current.setupStore.readTrustBundle(current.installationId);
  const packRow = current.setupStore.readActivePack(current.installationId);
  if (!state || !trustRow || !packRow) return { state, pack: invalidPack('foundation_missing'),
    local: invalidActivation('foundation_missing'), quarantined: true };
  let trust; let envelope: unknown;
  try { trust = parseConnectorTrustBundle(JSON.parse(trustRow.bundleJson));
    envelope = JSON.parse(packRow.envelopeJson); }
  catch { return { state, pack: invalidPack('foundation_malformed'),
    local: invalidActivation('foundation_malformed'), quarantined: true }; }
  if (!trust) return { state, pack: invalidPack('trust_bundle_invalid'),
    local: invalidActivation('trust_bundle_invalid'), quarantined: true };
  const pack = verifyConnectorGlobalCertificationPack(envelope, { now: new Date(nowMs),
    wallClockHighWaterMs: packRow.clockHighWaterMs, priorSequence: 0,
    minimumTrustBundleRevision: packRow.trustBundleRevision, runtimeFloor: CONNECTOR_RUNTIME_FLOOR,
    policySchemaVersion: CONNECTOR_POLICY_SCHEMA_VERSION, trustBundle: trust,
    ...CONNECTOR_RUNTIME_PACK_EXPECTATIONS });
  if (!pack.verified || pack.digest !== packRow.digest || pack.acceptedSequence !== packRow.sequence) {
    return { state, pack: invalidPack(pack.verified ? 'pack_binding_invalid' : pack.reason),
      local: invalidActivation('pack_invalid'), quarantined: true };
  }
  const localRow = current.database.prepare(`SELECT envelope_json AS json,record_revision AS revision
    FROM connector_setup_local_activation WHERE installation_id=? AND valid=1`)
    .get(current.installationId) as { json: string; revision: number }|undefined;
  if (!localRow) return { state, pack, local: invalidActivation('local_missing'), quarantined: false };
  try {
    const localEnvelope = JSON.parse(localRow.json) as { record?: unknown; mac?: unknown };
    const record = parseConnectorLocalActivationRecord(localEnvelope.record);
    const macOk = record && typeof localEnvelope.mac === 'string'
      && verifyConnectorRuntimeActivationMac(current.authority,
        Buffer.from(connectorJcs(record), 'utf8'), localEnvelope.mac);
    const bindingsOk = record && record.installationId === current.installationId
      && record.policyEpoch === state.policyEpoch && record.writerEpoch === state.writerEpoch
      && record.originRevision === state.originRevision && record.globalPackIssuerId === pack.pack.issuerId
      && record.globalPackChannel === pack.pack.channel && record.globalPackSequence === pack.pack.sequence
      && record.globalPackDigest === pack.digest && record.trustBundleRevision === pack.trustBundleRevision
      && record.recordRevision >= localRow.revision && Date.parse(record.issuedAt) <= nowMs + 300_000;
    return { state, pack, local: macOk && bindingsOk
      ? { verified: true, record, digest: localRow.json }
      : invalidActivation('local_binding_invalid'), quarantined: false };
  } catch { return { state, pack, local: invalidActivation('local_malformed'), quarantined: true }; }
};

/** Pack-only precondition for profile verification; local activation deliberately follows profile readiness. */
export const connectorProviderProfileOperationCertified = (providerId: string,
  method: ConnectorCertificationAuthMethod): boolean => {
  const current = runtime; if (!current) return false;
  const foundation = verifiedFoundation(current, Date.now());
  return foundation.pack.verified && !foundation.state?.kills.global
    && !foundation.state?.kills.providers.includes(providerId)
    && foundation.pack.pack.certifications.some(item => item.providerId === providerId
      && item.operation === ConnectorPolicyOperation.ProfileConfigure && item.authMethod === method
      && decideConnectorGlobalCertification(foundation.pack, item.providerId, item.serviceId,
        ConnectorPolicyOperation.ProfileConfigure).status === 'certified'
      && !foundation.state?.kills.serviceOperations.some(kill => kill.serviceId === item.serviceId
        && kill.operation === ConnectorPolicyOperation.ProfileConfigure));
};

/** Dynamic final effect seam. Missing identity/readiness facts always deny. */
export const assertConnectorProviderEffectEnabled = (
  effect: ConnectorPolicyOperation | ConnectorProviderEffect,
): void => {
  const operation = typeof effect === 'string' ? effect : effect.operation;
  if (lifecycleOperations.has(operation)) return;
  const current = runtime;
  if (!current || typeof effect === 'string') throw new Error(current
    ? 'connector_activation_required' : 'connector_runtime_unavailable');
  const nowMs = Date.now(); const foundation = verifiedFoundation(current, nowMs);
  const state = foundation.state;
  const profile = current.database.prepare(`SELECT status,version FROM connector_auth_profiles
    WHERE installation_id=? AND provider_id=?`).get(current.installationId, effect.providerId) as
    { status: string; version: number }|undefined;
  const activation = foundation.local.verified ? foundation.local.record.activations.find(item =>
    item.providerId === effect.providerId && item.serviceId === effect.serviceId
      && item.operation === operation) : undefined;
  const profileReady = operation === ConnectorPolicyOperation.ProfileConfigure
    || Boolean(profile?.status === 'ready' && (!activation?.profileRevision
      || activation.profileRevision === profile.version));
  const needsGrant = [ConnectorPolicyOperation.CredentialUse,
    ConnectorPolicyOperation.TokenRefresh, ConnectorPolicyOperation.PlacementWrite].includes(operation);
  const grant = needsGrant && effect.userId && effect.grantId
    ? current.database.prepare(`SELECT status FROM connector_user_grants WHERE installation_id=?
      AND user_id=? AND grant_id=? AND provider_id=? AND service_id=?`).get(current.installationId,
      effect.userId, effect.grantId, effect.providerId, effect.serviceId) as { status: string }|undefined
    : null;
  const needsVerification = [ConnectorPolicyOperation.CredentialUse,
    ConnectorPolicyOperation.TokenRefresh, ConnectorPolicyOperation.PlacementWrite].includes(operation);
  const verificationReady = !needsVerification || Boolean(effect.grantId && current.database.prepare(`SELECT 1
    FROM connector_credential_bundle_revisions b JOIN connector_credential_verifications v
      USING(bundle_id,bundle_revision) WHERE b.installation_id=? AND b.grant_id=?
      AND b.bundle_state='stored' AND v.verification_state='verified'
      AND (v.expires_at IS NULL OR v.expires_at>CURRENT_TIMESTAMP) LIMIT 1`)
    .get(current.installationId, effect.grantId));
  const decision = decideConnectorActivation({ operation, providerId: effect.providerId,
    serviceId: effect.serviceId, runtimeReady: inspectConnectorPolicyV2Substrate(current.database,
      current.authority, nowMs).ready, foundationQuarantined: foundation.quarantined
      || state?.installationMode !== 'portable_default', globalKilled: state?.kills.global ?? true,
    providerKilled: state?.kills.providers.includes(effect.providerId) ?? true,
    serviceOperationKilled: state?.kills.serviceOperations.some(item => item.serviceId === effect.serviceId
      && item.operation === operation) ?? true, globalPack: foundation.pack,
    localActivation: foundation.local, profileReady, grantReady: !needsGrant || grant?.status === 'active',
    verificationReady });
  if (!decision.eligible) throw new Error(`connector_activation_denied:${decision.reason}`);
};

const installationId = (database: Database): string => {
  const row = database.prepare(`SELECT installation_id AS installationId FROM connector_installations
    WHERE singleton = 1`).get() as { installationId: string } | undefined;
  if (!row) throw new Error('connector_substrate_installation_missing');
  return row.installationId;
};

const cookie = (req: express.Request, name: string): string | null => {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const [candidate, ...value] = part.trim().split('=');
    if (candidate === name && /^[a-f0-9]{64}$/u.test(value.join('='))) return value.join('=');
  }
  return null;
};

const facts = (installation: string): readonly ConnectorReadinessFact[] => Object.freeze(
  PROVIDER_AUTH_SPECS.flatMap(spec => spec.services.map(serviceId => Object.freeze({
    installationId: installation, providerId: spec.profileId, serviceId, authMethod: spec.method,
    productionManifestActive: false, featureEnabled: false, temporarilyDisabled: false,
    migrationRequired: false, savedInactive: false, operationalConnected: false,
  }))),
);

/** Pure read-only preflight; it never installs, repairs, or activates anything. */
export const inspectConnectorPolicyV2Substrate = (database: Database,
  authority: ConnectorRuntimeAuthority, nowMs = Date.now()): Readonly<{ ready: boolean; reason: string }> => {
  try {
    const id = installationId(database);
    const health = preflightConnectorRuntime(database, BUILD, authority, nowMs);
    if (!health.subsystemReady) return Object.freeze({ ready: false, reason: health.reason });
    const metadata = database.prepare(`SELECT mode,production_manifest_active AS manifest,
      stored_unverified_creation_enabled AS unverified,provider_activation_enabled AS activation,
      runtime_floor AS runtimeFloor FROM connector_policy_v2_substrate WHERE installation_id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    const state = database.prepare(`SELECT state_json AS stateJson FROM connector_policy_v2_state
      WHERE installation_id = ?`).get(id) as { stateJson: string } | undefined;
    const valid = metadata?.mode === 'substrate_only' && metadata.manifest === 0
      && metadata.unverified === 0 && metadata.activation === 0
      && metadata.runtimeFloor === CONNECTOR_RUNTIME_FLOOR && Boolean(state);
    if (!valid) return Object.freeze({ ready: false, reason: 'substrate_metadata_invalid' });
    const parsed = JSON.parse(state!.stateJson) as Record<string, unknown>;
    const expectedDigest = initialConnectorPolicyV2SubstrateState().certificationManifestDigest;
    return parsed.policySchemaVersion === 2 && parsed.installationMode === 'portable_default'
      && parsed.certificationManifestDigest === expectedDigest
      ? Object.freeze({ ready: true, reason: 'ready' })
      : Object.freeze({ ready: false, reason: 'policy_state_invalid' });
  } catch { return Object.freeze({ ready: false, reason: 'substrate_unavailable' }); }
};

/** Inspect existing security state only; missing authority or origin is never bootstrapped. */
export const inspectExistingConnectorPolicyV2Substrate = (database: Database,
  authorityRootPath: string, nowMs = Date.now(), allowLoopbackDevelopment = false) => {
  const authority = readConnectorRuntimeAuthorityRoot(authorityRootPath).authority;
  verifyExistingConnectorRuntimeFence(database, BUILD, authority, nowMs);
  const health = inspectConnectorPolicyV2Substrate(database, authority, nowMs);
  if (!health.ready) throw new Error(`connector_existing_substrate_invalid:${health.reason}`);
  const id = installationId(database);
  const setupStore = new ConnectorSetupStore(database, false);
  const origin = new ConnectorInstallationOriginResolver(database, setupStore, allowLoopbackDevelopment).resolve(id);
  if (!origin) throw new Error('connector_existing_origin_missing');
  return Object.freeze({ installationId: id, origin });
};

/**
 * Re-enters an already-fenced installation for synchronous schema/migration work.
 * A fresh database has no control plane and executes normally; a partial or
 * unverifiable existing plane fails closed before any schema statement runs.
 */
export const runConnectorPolicyV2GuardedBootstrap = (database: Database,
  authorityRootPath: string, effect: () => void, now: () => number = Date.now): void => {
  const authorityTables = new Set((database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'connector_runtime_%'",
  ).all() as Array<{ name: string }>).map(row => row.name));
  const expected = ['connector_runtime_anchor', 'connector_runtime_control',
    'connector_runtime_writer_lease'];
  if (expected.every(table => !authorityTables.has(table))) { effect(); return; }
  if (!expected.every(table => authorityTables.has(table))) {
    throw new Error('connector_runtime_authority_partial_or_deleted');
  }
  const authority = readConnectorRuntimeAuthorityRoot(authorityRootPath).authority;
  const gate = new ConnectorRuntimeWriteGate(database, BUILD, authority, now);
  const health = gate.preflight();
  if (!health.subsystemReady) throw new Error(`connector_subsystem_blocked:${health.reason}`);
  const lease = gate.acquireForInitialization(randomUUID(), 30_000);
  if (!lease || !gate.runFencedMutation(effect, false)) {
    throw new Error('connector_runtime_bootstrap_fence_unavailable');
  }
};

/** Called after migrations; authority/bootstrap failure leaves the public route on schema 1. */
export const initializeConnectorPolicyV2SubstrateOnly = (database: Database,
  authorityRootPath: string, now: () => number = Date.now): Readonly<{ ready: boolean; reason: string }> => {
  const existingStartup = requireStartupAdmission();
  runtime = null;
  lifecycleWrite = null;
  // Invocation declares the reviewed schema-2 mode before any fallible DB probe.
  // A failed installation lookup must never re-enable the legacy writer.
  substrateInstalled = true;
  try {
    const id = installationId(database);
    const authority = existingStartup ? readConnectorRuntimeAuthorityRoot(authorityRootPath).authority
      : openOrCreateConnectorRuntimeAuthorityRoot(authorityRootPath).authority;
    const gate = new ConnectorRuntimeWriteGate(database, BUILD, authority, now);
    if (existingStartup) inspectExistingConnectorPolicyV2Substrate(database, authorityRootPath, now());
    else reinstallConnectorRuntimeFence(database, authority);
    const health = inspectConnectorPolicyV2Substrate(database, authority, now());
    if (!health.ready) { unavailableReason = health.reason; return health; }
    const policy = new SqliteConnectorPolicyV2Store(database, id, initialConnectorPolicyV2SubstrateState(),
      { initializeSchema: false, recoverPlacementIntents: false });
    const originStore = new ConnectorInstallationOriginV2Store(database, policy,
      { initializeSchema: false, allowInitialOriginBootstrap: !existingStartup });
    const repository = createConnectorAuthDb(database);
    const setupStore = new ConnectorSetupStore(database, false);
    const originResolver = new ConnectorInstallationOriginResolver(database, setupStore,
      process.env.NODE_ENV !== 'production');
    let lease = gate.acquireForInitialization(randomUUID(), 30_000);
    if (existingStartup && !lease) throw new Error('connector_existing_initialization_lease_unavailable');
    const executeOriginWrite = (advance: boolean, effect: () => void): boolean => {
      if (!lease || !gate.leaseIsCurrent(lease)) lease = gate.acquire(randomUUID(), 30_000);
      return Boolean(lease && gate.runFencedMutation(effect, advance));
    };
    lifecycleWrite = effect => executeOriginWrite(false, effect);
    try {
      const persistedOrigin = originResolver.resolve(id);
      const bootstrapProposal = existingStartup || persistedOrigin ? null : connectorEnvironmentOriginProposal(
        process.env[CONNECTOR_PUBLIC_ORIGIN_ENV], process.env.NODE_ENV !== 'production');
      configureConnectorOwnerAuthSessionProduction({ repository, installationId: id,
        canonicalOrigin: persistedOrigin?.canonicalOrigin ?? bootstrapProposal?.canonicalOrigin ?? '',
        executeWrite: executeConnectorPolicyV2LifecycleWrite });
    } catch {
      // Schema 2 remains readable without a public origin; owner mutation stays
      // unavailable until the installation supplies its exact deployment origin.
    }
    const resolveIdentity = (req: express.Request): { userId: number; role: string } | null => {
      const user = database.prepare(`SELECT id,role FROM users WHERE id = ? AND is_active = 1
        AND status = 'active'`).get(
        (req as express.Request & { user?: { id?: number; userId?: number } }).user?.id
          ?? (req as express.Request & { user?: { userId?: number } }).user?.userId,
      ) as { id: number; role: string } | undefined;
      return user ? { userId: user.id, role: user.role } : null;
    };
    const readRecentSession = (req: express.Request) => {
      const identity = resolveIdentity(req); const token = cookie(req, connectorRecentAuthCookieName);
      if (!identity || !token) return null;
      const session = repository.readOwnerAuthSession({ sessionTokenHash: createHash('sha256')
        .update(token).digest('hex'), installationId: id, userId: identity.userId, nowMs: now() });
      return session ? { installationId: id, userId: identity.userId, authTimeMs: session.authTime,
        expiresAtMs: session.expiresAt, csrfTokenHash: session.csrfTokenHash } : null;
    };
    const routes = createConnectorInstallationReadinessV2Routes({ installationId: id, store: originStore,
      now, readFacts: exactInstallation => facts(exactInstallation), executeOriginWrite,
      resolveInstallationMember: (_req, exactInstallation) => {
        if (exactInstallation !== id) return null;
        const user = resolveIdentity(_req);
        if (!user || !['owner', 'admin', 'user'].includes(user.role)) return null;
        return { installationId: id, userId: user.userId, role: user.role === 'owner' ? 'owner' : 'member' };
      },
      readRecentOwnerSession: req => {
        const userId = (req as express.Request & { user?: { id?: number } }).user?.id;
        const token = cookie(req, connectorRecentAuthCookieName);
        if (!Number.isSafeInteger(userId) || Number(userId) < 1 || !token) return null;
        const session = repository.readOwnerAuthSession({ sessionTokenHash: createHash('sha256')
          .update(token).digest('hex'), installationId: id, userId: Number(userId), nowMs: now() });
        return session ? { installationId: id, userId: Number(userId), authTimeMs: session.authTime,
          expiresAtMs: session.expiresAt, csrfTokenHash: session.csrfTokenHash } : null;
      } });
    const verifyProfileEffect = async (providerId: string,
      body: Readonly<{ method: 'dcr_pkce'|'byo_app'; clientId?: string; clientSecret?: string }>,
      ownerAuthority: Parameters<NonNullable<ConstructorParameters<typeof ConnectorOwnerSetupService>[7]>>[2]) => {
      const { connectorAuthProfileRuntimeForOwnerSetup } = await import('./connector-auth-profile.routes.js');
      const profileRuntime = connectorAuthProfileRuntimeForOwnerSetup();
      return body.method === 'dcr_pkce'
        ? profileRuntime.service.registerDcr(ownerAuthority, providerId)
        : profileRuntime.service.upsertByo(ownerAuthority, { providerId: providerId as 'google-workspace'|'canva',
          clientId: body.clientId ?? '', clientSecret: body.clientSecret ?? '' });
    };
    const setupService = new ConnectorOwnerSetupService(database, id, authority, setupStore,
      originStore, executeOriginWrite, now, verifyProfileEffect);
    // No production trust/proof/DCR channel is configured in this release. The
    // service therefore records manual_recovery and cannot activate a provider.
    const provisioningService = new ConnectorProvisioningService(database, id, originResolver,
      effect => executeOriginWrite(false, effect), {}, now);
    const ownerSetupRoutes = createConnectorOwnerSetupRoutes({ service: setupService,
      installationId: id, resolveIdentity, readRecentSession, now,
      profileOperationGate: (req, res, next) => {
        const operation = req.body?.method === 'dcr_pkce' ? 'register_dcr'
          : req.body?.method === 'byo_app' ? 'upsert_byo' : null;
        const origin = originResolver.resolve(id)?.canonicalOrigin;
        if (!operation || !origin) { res.status(operation ? 503 : 422).json({
          code: operation ? 'CONNECTOR_PROFILE_SETUP_UNAVAILABLE' : 'CONNECTOR_PROFILE_NOT_REQUIRED' }); return; }
        createConnectorOwnerOperationGate({ repository, installationId: id,
          canonicalOrigin: origin, operation, now })(req, res, next);
      } });
    const provisioningRoutes = createConnectorProvisioningRoutes({ service: provisioningService,
      installationId: id, origins: originResolver, resolveIdentity, readRecentSession, now });
    runtime = Object.freeze({ installationId: id, routes, ownerSetupRoutes, provisioningRoutes, originResolver,
      database, authority, setupStore });
    unavailableReason = 'ready';
    // ADR-162 / T-1831: opt-in first-boot operator auto-setup. Runs only after the
    // substrate is ready, is a no-op unless NASSAJ_CONNECTOR_AUTO_SETUP=1 with a valid
    // origin, and is fail-closed. It returns a result rather than throwing; the extra
    // try/catch here is defense-in-depth so this OPTIONAL step can never turn a ready
    // substrate into substrate_unavailable (which the outer catch below would do).
    try {
      const autoSetup = runConnectorAutoSetupOnBoot({ database, installationId: id, authority,
        service: setupService, setupStore, env: process.env, now, repoRoot: process.cwd() });
      if (autoSetup.blocker) {
        console.warn(`[connector-substrate] first-boot auto-setup did not complete: ${autoSetup.blocker}.`);
      }
    } catch (autoSetupError) {
      const code = autoSetupError instanceof Error
        ? (autoSetupError as { code?: string }).code ?? autoSetupError.name : 'unknown';
      console.warn(`[connector-substrate] first-boot auto-setup threw unexpectedly and was contained: ${code}.`);
    }
    return Object.freeze({ ready: true, reason: 'ready' });
  } catch { runtime = null; lifecycleWrite = null; unavailableReason = 'substrate_unavailable';
    return Object.freeze({ ready: false, reason: unavailableReason }); }
};

/** Dynamic mount: schema 2 delegates only after full preflight; otherwise GET is schema 1. */
export const connectorPolicyV2SubstrateRoutes = express.Router();
connectorPolicyV2SubstrateRoutes.use((req, res, next) => {
  if (runtime) { runtime.routes(req, res, next); return; }
  res.set('Cache-Control', 'no-store');
  if (req.method === 'GET' && req.path === '/catalog') {
    res.json({ schemaVersion: 1, substrateReady: false, reason: unavailableReason }); return;
  }
  res.status(503).json({ schemaVersion: 1, code: 'CONNECTOR_SUBSTRATE_UNAVAILABLE' });
});

/** Dynamic owner-only mount; absent substrate is indistinguishable from a missing route. */
export const connectorPolicyV2OwnerSetupRoutes = express.Router();
connectorPolicyV2OwnerSetupRoutes.use((req, res, next) => {
  if (runtime) { runtime.ownerSetupRoutes(req, res, next); return; }
  res.set('Cache-Control', 'no-store'); res.status(404).json({ code: 'CONNECTOR_SETUP_NOT_FOUND' });
});

/** Dynamic owner-only provisioning mount. It remains fail-closed without a production channel. */
export const connectorPolicyV2ProvisioningRoutes = express.Router();
connectorPolicyV2ProvisioningRoutes.use((req, res, next) => {
  if (runtime) { runtime.provisioningRoutes(req, res, next); return; }
  res.set('Cache-Control', 'no-store'); res.status(404).json({ code: 'CONNECTOR_PROVISIONING_NOT_FOUND' });
});

export const connectorPolicyV2CatalogRevision = CONNECTOR_AUTH_CATALOG_REVISION;
