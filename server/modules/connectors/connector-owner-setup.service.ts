/** Owner-only installation setup application service. All effects are local, fenced, and secret-free. */

import { createHash } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { connectorGlobalPackDigest, parseConnectorGlobalCertificationPack,
  effectiveConnectorGlobalCertifications,
  verifyConnectorGlobalCertificationPack,
  type SignedConnectorGlobalCertificationPack } from './connector-global-certification-pack.js';
import { ConnectorInstallationOwnerCapability,
  type ConnectorCanonicalOrigin, type ConnectorInstallationOriginV2Store } from './connector-installation-readiness-v2.js';
import { CONNECTOR_LOCAL_ACTIVATION_DOMAIN, connectorLocalActivationDigest,
  parseConnectorLocalActivationRecord, type ConnectorLocalActivation,
  type ConnectorLocalActivationRecord } from './connector-local-activation.js';
import { connectorJcs } from './connector-jcs.js';
import { connectorRuntimeActivationMac, type ConnectorRuntimeAuthority } from './connector-runtime-fence.js';
import { CONNECTOR_RUNTIME_PACK_EXPECTATIONS } from './connector-runtime-manifest.js';
import { type ConnectorSetupDoctorReport, inspectConnectorSetup } from './connector-setup-doctor.js';
import { type ConnectorSetupStore } from './connector-setup-store.js';
import { connectorTrustBundleDigest, parseConnectorTrustBundle } from './connector-trust-bundle.js';
import type { AuthorizedOwnerOperation } from './connector-owner-operation-gate.js';
import type { ConnectorProfileDto } from './connector-auth-profile-management.js';

export class ConnectorOwnerSetupError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

/** Owner is warned this long before the global pack expires (T-1527); expiry silently kills connectors. */
export const CONNECTOR_PACK_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1_000;

export type ConnectorOwnerSetupStatus = ConnectorSetupDoctorReport & Readonly<{
  origin: ConnectorCanonicalOrigin | null;
  trustBundleRevision: number;
  activePack:
    Readonly<{ issuer: string; channel: string; sequence: number; digest: string; expiresAt: string | null }>
    | null;
  packExpiresAt: string | null;
  warnings: readonly ('pack_expiring_soon' | 'pack_expired')[];
  activationRecordRevision: number;
  activationCandidates: readonly ConnectorOwnerActivationCandidate[];
}>;

export type ConnectorOwnerActivationCandidate = Readonly<{
  providerId: string; serviceId: string; operation: string;
  authMethod: 'dcr_pkce'|'byo_app'|'api_key'; certification: 'certified'|'suspended';
  enabled: boolean; profileRequired: boolean;
  profileState: 'not_required'|'missing'|'ready'|'stale'; profileRevision: number|null;
  blockerCodes: readonly string[];
}>;

type Context = Readonly<{ ownerUserId: number; idempotencyKey: string; expectedRevision: number;
  requestOrigin: string; authTimeMs: number; expiresAtMs: number; nowMs: number }>;
type ExecuteWrite = (advanceWriterEpoch: boolean, effect: () => void) => boolean;

const fail = (code: string, status: number): never => { throw new ConnectorOwnerSetupError(code, status); };
const sha256 = (value: unknown): string => createHash('sha256').update(connectorJcs(value)).digest('base64url');

export class ConnectorOwnerSetupService {
  constructor(private readonly database: Database, private readonly installationId: string,
    private readonly authority: ConnectorRuntimeAuthority, private readonly setup: ConnectorSetupStore,
    private readonly origins: ConnectorInstallationOriginV2Store,
    private readonly executeWrite: ExecuteWrite, private readonly now: () => number = Date.now,
    private readonly verifyProfileEffect?: (providerId: string,
      body: Readonly<{ method: 'dcr_pkce'|'byo_app'; clientId?: string; clientSecret?: string }>,
      authority: AuthorizedOwnerOperation) => Promise<ConnectorProfileDto>) {}

  status(): ConnectorOwnerSetupStatus {
    const report = inspectConnectorSetup(this.database, this.installationId, this.authority, this.now());
    const origin = this.origins.read(this.installationId);
    const trust = this.setup.readTrustBundle(this.installationId);
    const pack = this.setup.readActivePack(this.installationId);
    const activation = this.database.prepare(`SELECT record_revision AS revision
      FROM connector_setup_local_activation WHERE installation_id=? AND valid=1`)
      .get(this.installationId) as { revision: number }|undefined;
    const activationRecord = report.checks.find(item => item.id === 'activation')?.status === 'ok'
      ? this.#activationRecord() : null;
    const packEnvelope = report.checks.find(item => item.id === 'pack')?.status === 'ok' && pack
      ? JSON.parse(pack.envelopeJson) as { pack?: unknown } : null;
    const verifiedPack = parseConnectorGlobalCertificationPack(packEnvelope?.pack);
    const profiles = new Map<string, { status: string; version: number }>();
    if (this.#table('connector_auth_profiles')) {
      for (const row of this.database.prepare(`SELECT provider_id AS providerId,status,version
        FROM connector_auth_profiles WHERE installation_id=?`).all(this.installationId) as
        Array<{ providerId: string; status: string; version: number }>) {
        profiles.set(row.providerId, row);
      }
    }
    const candidates = Object.freeze((verifiedPack
      ? effectiveConnectorGlobalCertifications(verifiedPack) : []).map(certification => {
      const profileRequired = certification.authMethod !== 'api_key';
      const profile = profiles.get(certification.providerId);
      const local = activationRecord?.activations.find(item => item.providerId === certification.providerId
        && item.serviceId === certification.serviceId && item.operation === certification.operation);
      const profileState: ConnectorOwnerActivationCandidate['profileState'] = !profileRequired ? 'not_required'
        : !profile || profile.status !== 'ready' ? 'missing'
          : local?.profileRevision && local.profileRevision !== profile.version ? 'stale' : 'ready';
      const enabled = Boolean(local?.enabled && certification.status === 'certified'
        && (!profileRequired || profileState === 'ready'));
      const blockers = [...(certification.status === 'suspended' ? ['CONNECTOR_CERTIFICATION_SUSPENDED'] : []),
        ...(profileState === 'missing' ? ['CONNECTOR_PROFILE_REQUIRED'] : []),
        ...(profileState === 'stale' ? ['CONNECTOR_PROFILE_STALE'] : []),
        ...(!enabled ? ['CONNECTOR_ACTIVATION_REQUIRED'] : [])];
      return Object.freeze({ providerId: certification.providerId, serviceId: certification.serviceId,
        operation: certification.operation, authMethod: certification.authMethod,
        certification: certification.status, enabled, profileRequired, profileState,
        profileRevision: profileRequired ? profile?.version ?? null : null,
        blockerCodes: Object.freeze(blockers) });
    }));
    const nowMs = this.now();
    // Expiry is read from the stored active pack itself, not the doctor gate: an owner must be
    // warned a pack is about to (silently) kill connectors even while it still verifies (T-1527).
    let activePackParsed = verifiedPack;
    if (!activePackParsed && pack) {
      try { activePackParsed = parseConnectorGlobalCertificationPack(
        (JSON.parse(pack.envelopeJson) as { pack?: unknown }).pack); }
      catch { activePackParsed = null; }
    }
    const packExpiresAt = activePackParsed ? activePackParsed.expiresAt : null;
    const packExpiresAtMs = packExpiresAt ? Date.parse(packExpiresAt) : Number.NaN;
    const warnings: ('pack_expiring_soon' | 'pack_expired')[] = [];
    if (Number.isFinite(packExpiresAtMs)) {
      if (packExpiresAtMs <= nowMs) warnings.push('pack_expired');
      else if (packExpiresAtMs - nowMs <= CONNECTOR_PACK_EXPIRY_WARNING_MS) warnings.push('pack_expiring_soon');
    }
    return Object.freeze({ ...report, origin, trustBundleRevision: trust?.revision ?? 0,
      activePack: pack ? Object.freeze({ issuer: pack.issuer, channel: pack.channel,
        sequence: pack.sequence, digest: pack.digest, expiresAt: packExpiresAt }) : null,
      packExpiresAt, warnings: Object.freeze(warnings),
      activationRecordRevision: activation?.revision ?? 0, activationCandidates: candidates });
  }

  setOrigin(body: Readonly<{ canonicalOrigin: string; expectedOriginRevision: number }>, context: Context): unknown {
    const replay = this.#replay('origin', body, context); if (replay.found) return replay.value;
    if (context.expectedRevision !== body.expectedOriginRevision) fail('CONNECTOR_SETUP_REVISION_MISMATCH', 412);
    return this.#idempotent('origin', body, context, () => {
      const authority = ConnectorInstallationOwnerCapability.fixture({ installationId: this.installationId,
        userId: context.ownerUserId, role: 'owner', recentAuth: true, csrfVerified: true,
        requestOrigin: context.requestOrigin, intent: 'set_installation_origin', issuedAtMs: context.authTimeMs,
        expiresAtMs: context.expiresAtMs });
      return this.origins.setOrigin({ installationId: this.installationId, userId: context.ownerUserId,
        proposedOrigin: body.canonicalOrigin, expectedOriginRevision: body.expectedOriginRevision,
        authority, nowMs: context.nowMs });
    }, this.status().origin !== null && this.status().origin?.canonicalOrigin !== body.canonicalOrigin);
  }

  importTrust(body: Readonly<{ bundle: unknown; expectedTrustBundleRevision: number }>, context: Context): unknown {
    const replay = this.#replay('trust_import', body, context); if (replay.found) return replay.value;
    if (context.expectedRevision !== body.expectedTrustBundleRevision) fail('CONNECTOR_SETUP_REVISION_MISMATCH', 412);
    const bundle = parseConnectorTrustBundle(body.bundle);
    if (!bundle || bundle.revision !== body.expectedTrustBundleRevision + 1) {
      throw new ConnectorOwnerSetupError('CONNECTOR_TRUST_INVALID', 422);
    }
    if (!this.status().origin) fail('CONNECTOR_ORIGIN_REQUIRED', 409);
    if (body.expectedTrustBundleRevision > 0) fail('CONNECTOR_TRUST_ROTATION_REQUIRES_RECOVERY', 409);
    return this.#idempotent('trust_import', body, context, () => {
      const revision = this.setup.saveTrustBundle({ installationId: this.installationId,
        expectedRevision: body.expectedTrustBundleRevision, bundleJson: connectorJcs(bundle),
        digest: connectorTrustBundleDigest(bundle).toString('base64url'), nowMs: context.nowMs });
      return { trustBundleRevision: revision };
    }, false);
  }

  importPack(body: Readonly<{ envelope: unknown }>, context: Context): unknown {
    const replay = this.#replay('pack_import', body, context); if (replay.found) return replay.value;
    const trustRow = this.setup.readTrustBundle(this.installationId);
    if (!trustRow) throw new ConnectorOwnerSetupError('CONNECTOR_TRUST_REQUIRED', 409);
    const trustBundle = parseConnectorTrustBundle(JSON.parse(trustRow.bundleJson) as unknown);
    if (!trustBundle) throw new ConnectorOwnerSetupError('CONNECTOR_TRUST_INVALID', 503);
    const prior = this.setup.readActivePack(this.installationId);
    if (context.expectedRevision !== (prior?.sequence ?? 0)) fail('CONNECTOR_SETUP_REVISION_MISMATCH', 412);
    const verification = verifyConnectorGlobalCertificationPack(body.envelope, { now: new Date(context.nowMs),
      wallClockHighWaterMs: prior?.clockHighWaterMs ?? 0, priorSequence: prior?.sequence ?? 0,
      minimumTrustBundleRevision: trustRow.revision, runtimeFloor: 1, policySchemaVersion: 2,
      trustBundle, ...CONNECTOR_RUNTIME_PACK_EXPECTATIONS });
    if (!verification.verified) throw new ConnectorOwnerSetupError('CONNECTOR_PACK_INVALID', 422);
    return this.#idempotent('pack_import', body, context, () => {
      const envelopeJson = connectorJcs(body.envelope);
      this.setup.saveVerifiedPack({ installationId: this.installationId,
        issuer: verification.pack.issuerId, channel: verification.pack.channel,
        sequence: verification.pack.sequence, envelopeJson,
        digest: connectorGlobalPackDigest(verification.pack).toString('base64url'),
        trustBundleRevision: verification.trustBundleRevision, acceptedWallMs: context.nowMs,
        clockHighWaterMs: verification.wallClockHighWaterMs });
      const policy = JSON.parse((this.database.prepare(`SELECT state_json AS stateJson
        FROM connector_policy_v2_state WHERE installation_id=?`).get(this.installationId) as
        { stateJson: string }|undefined)?.stateJson ?? '{}') as { policyEpoch?: number; writerEpoch?: number };
      if (Number.isSafeInteger(policy.policyEpoch) && Number.isSafeInteger(policy.writerEpoch)) {
        const projection = this.setup.readProjection(this.installationId, 'installation');
        this.setup.recomputeProjection({ installationId: this.installationId, scopeKey: 'installation',
          prerequisites: { substrateReady: true, authorityRootReady: true, authorityAnchorReady: true,
            originReady: true, trustReady: true, providerPackReady: true, clockReady: true,
            digestsReady: true, profileReady: true, profileRequired: false,
            activationReady: false, eligibilityReady: false, tampered: false },
          expectedProjectionRevision: projection?.projectionRevision ?? 0,
          evidenceDigest: verification.digest, invalidReason: null,
          policyEpoch: policy.policyEpoch!, writerEpoch: policy.writerEpoch!, nowMs: context.nowMs });
      }
      return { issuer: verification.pack.issuerId, channel: verification.pack.channel,
        sequence: verification.pack.sequence, digest: verification.digest };
    }, false);
  }

  setActivations(body: Readonly<{ expectedRecordRevision: number; globalPackDigest: string;
    changes: readonly ConnectorLocalActivation[] }>, context: Context): unknown {
    const replay = this.#replay('activations', body, context); if (replay.found) return replay.value;
    if (context.expectedRevision !== body.expectedRecordRevision) fail('CONNECTOR_SETUP_REVISION_MISMATCH', 412);
    const packRow = this.setup.readActivePack(this.installationId);
    const trust = this.setup.readTrustBundle(this.installationId);
    if (!packRow || !trust || packRow.digest !== body.globalPackDigest) {
      throw new ConnectorOwnerSetupError('CONNECTOR_PACK_REQUIRED', 409);
    }
    const envelope = JSON.parse(packRow.envelopeJson) as SignedConnectorGlobalCertificationPack;
    const policy = JSON.parse((this.database.prepare(`SELECT state_json AS stateJson
      FROM connector_policy_v2_state WHERE installation_id=?`).get(this.installationId) as { stateJson: string }).stateJson) as
      { policyEpoch: number; writerEpoch: number; originRevision: number; kills: { global: boolean } };
    if (policy.kills.global) fail('CONNECTOR_GLOBAL_KILLED', 409);
    const current = this.#activationRecord();
    if ((current?.recordRevision ?? 0) !== body.expectedRecordRevision) fail('CONNECTOR_SETUP_CAS_CONFLICT', 409);
    const candidates = new Map(this.status().activationCandidates.map(item =>
      [`${item.providerId}\0${item.serviceId}\0${item.operation}`, item]));
    if (!Array.isArray(body.changes) || body.changes.length < 1 || body.changes.some(change =>
      candidates.get(`${change.providerId}\0${change.serviceId}\0${change.operation}`)?.certification !== 'certified')) {
      fail('CONNECTOR_ACTIVATION_INVALID', 422);
    }
    return this.#idempotent('activations', body, context, () => {
      const merged = new Map((current?.activations ?? []).map(item =>
        [`${item.providerId}\0${item.serviceId}\0${item.operation}`, item]));
      for (const change of body.changes) {
        const key = `${change.providerId}\0${change.serviceId}\0${change.operation}`;
        const candidate = candidates.get(key)!;
        if (change.enabled && candidate.profileRequired && candidate.profileState !== 'ready') {
          fail('CONNECTOR_PROFILE_REQUIRED', 409);
        }
        merged.set(key, Object.freeze({ providerId: change.providerId, serviceId: change.serviceId,
          operation: change.operation, enabled: change.enabled,
          profileRevision: candidate.profileRequired ? candidate.profileRevision : null }));
      }
      const record = parseConnectorLocalActivationRecord({ schemaVersion: 1,
        domain: CONNECTOR_LOCAL_ACTIVATION_DOMAIN, installationId: this.installationId,
        recordRevision: body.expectedRecordRevision + 1, policyEpoch: policy.policyEpoch,
        writerEpoch: policy.writerEpoch, originRevision: policy.originRevision,
        globalPackIssuerId: envelope.pack.issuerId, globalPackChannel: envelope.pack.channel,
        globalPackSequence: envelope.pack.sequence, globalPackDigest: packRow.digest,
        trustBundleRevision: trust.revision, activations: [...merged.values()],
        issuedAt: new Date(context.nowMs).toISOString(), issuedByUserId: context.ownerUserId });
      if (!record) throw new ConnectorOwnerSetupError('CONNECTOR_ACTIVATION_INVALID', 422);
      const recordBytes = Buffer.from(connectorJcs(record), 'utf8');
      const signed = { record, mac: connectorRuntimeActivationMac(this.authority, recordBytes) };
      const revision = this.setup.saveLocalActivation({ installationId: this.installationId,
        expectedRevision: body.expectedRecordRevision, envelopeJson: connectorJcs(signed),
        digest: connectorLocalActivationDigest(record).toString('base64url'),
        policyEpoch: policy.policyEpoch, writerEpoch: policy.writerEpoch,
        originRevision: policy.originRevision });
      return { activationRecordRevision: revision };
    }, false);
  }

  async verifyProfile(providerId: string,
    body: Readonly<{ method: 'dcr_pkce'|'byo_app'; clientId?: string; clientSecret?: string }>,
    context: Context, authority: AuthorizedOwnerOperation): Promise<Readonly<{
      providerId: string; profileState: 'ready'; profileRevision: number; setupRevision: number }>> {
    const replay = this.#replay(`profile_verify:${providerId}`, body, context);
    if (replay.found) return replay.value as never;
    const verifyProfile = this.verifyProfileEffect;
    if (!verifyProfile) throw new ConnectorOwnerSetupError('CONNECTOR_PROFILE_SETUP_UNAVAILABLE', 503);
    const candidate = this.status().activationCandidates.find(item => item.providerId === providerId
      && item.operation === 'profile.configure' && item.authMethod === body.method
      && item.certification === 'certified');
    if (candidate === undefined) throw new ConnectorOwnerSetupError('CONNECTOR_PROFILE_NOT_CERTIFIED', 409);
    if (candidate.authMethod === 'api_key') fail('CONNECTOR_PROFILE_NOT_REQUIRED', 422);
    const expected = candidate.profileRevision ?? 0;
    if (context.expectedRevision !== expected) fail('CONNECTOR_SETUP_REVISION_MISMATCH', 412);
    const route = `profile_verify:${providerId}`; const bodySha256 = sha256(body);
    let started = false;
    const began = this.executeWrite(false, () => {
      started = this.setup.beginIdempotent({ installationId: this.installationId,
        ownerUserId: context.ownerUserId, route, key: context.idempotencyKey, bodySha256,
        writerEpoch: this.#writerEpoch(), phase: 'profile_verify', nowMs: context.nowMs,
        expiresAtMs: context.nowMs + 86_400_000 }) === 'started';
    });
    if (!began) fail('CONNECTOR_SETUP_RUNTIME_UNAVAILABLE', 503);
    if (!started) fail('CONNECTOR_SETUP_REQUEST_IN_PROGRESS', 409);
    try {
      const profile = await verifyProfile(providerId, body, authority);
      if (profile.providerId !== providerId || profile.status !== 'ready') {
        fail('CONNECTOR_PROFILE_VERIFICATION_FAILED', 422);
      }
      const persisted = this.database.prepare(`SELECT status,version FROM connector_auth_profiles
        WHERE installation_id=? AND provider_id=?`).get(this.installationId, providerId) as
        { status: string; version: number }|undefined;
      if (!persisted) throw new ConnectorOwnerSetupError('CONNECTOR_PROFILE_VERIFICATION_FAILED', 422);
      if (persisted.status !== 'ready' || !Number.isSafeInteger(persisted.version)
        || persisted.version < 1) fail('CONNECTOR_PROFILE_VERIFICATION_FAILED', 422);
      const result = Object.freeze({ providerId, profileState: 'ready' as const,
        profileRevision: persisted.version, setupRevision: persisted.version });
      if (!this.executeWrite(false, () => this.setup.finishIdempotent({ installationId: this.installationId,
        ownerUserId: context.ownerUserId, route, key: context.idempotencyKey, bodySha256,
        state: 'committed', responseStatus: 200, responseJson: JSON.stringify(result) }))) {
        fail('CONNECTOR_SETUP_RUNTIME_UNAVAILABLE', 503);
      }
      return result;
    } catch (error) {
      this.executeWrite(false, () => this.setup.finishIdempotent({ installationId: this.installationId,
        ownerUserId: context.ownerUserId, route, key: context.idempotencyKey, bodySha256,
        state: 'failed', responseStatus: error instanceof ConnectorOwnerSetupError ? error.status : 503,
        responseJson: JSON.stringify({ code: error instanceof ConnectorOwnerSetupError
          ? error.code : 'CONNECTOR_PROFILE_SETUP_UNAVAILABLE' }) }));
      throw error;
    }
  }

  #writerEpoch(): number {
    return (this.database.prepare(`SELECT writer_epoch AS writerEpoch FROM connector_runtime_control
      WHERE singleton=1`).get() as { writerEpoch: number }).writerEpoch;
  }

  #activationRecord(): ConnectorLocalActivationRecord | null {
    const row = this.database.prepare(`SELECT envelope_json AS envelopeJson FROM connector_setup_local_activation
      WHERE installation_id=? AND valid=1`).get(this.installationId) as { envelopeJson: string }|undefined;
    if (!row) return null;
    const envelope = JSON.parse(row.envelopeJson) as { record?: unknown };
    return parseConnectorLocalActivationRecord(envelope.record);
  }

  #table(name: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }

  #replay(route: string, body: unknown, context: Context): Readonly<{ found: boolean; value?: unknown }> {
    const row = this.database.prepare(`SELECT body_sha256 AS body,state,response_json AS json
      FROM connector_setup_owner_idempotency WHERE installation_id=? AND owner_user_id=?
      AND route=? AND idempotency_key=?`).get(this.installationId, context.ownerUserId,
      route, context.idempotencyKey) as { body: string; state: string; json: string|null }|undefined;
    if (!row) return Object.freeze({ found: false });
    if (row.body !== sha256(body)) fail('CONNECTOR_SETUP_IDEMPOTENCY_BODY_CONFLICT', 409);
    if (row.state === 'committed' && row.json) return Object.freeze({ found: true, value: JSON.parse(row.json) });
    return fail(row.state === 'pending' ? 'CONNECTOR_SETUP_REQUEST_IN_PROGRESS' : 'CONNECTOR_SETUP_REQUEST_FAILED', 409);
  }

  #idempotent(route: string, body: unknown, context: Context, effect: () => unknown,
    advanceWriterEpoch: boolean): unknown {
    const bodySha256 = sha256(body); let output: unknown;
    const executed = this.executeWrite(advanceWriterEpoch, () => {
      const writerEpoch = (this.database.prepare(`SELECT writer_epoch AS writerEpoch
        FROM connector_runtime_control WHERE singleton=1`).get() as { writerEpoch: number }).writerEpoch;
      const state = this.setup.beginIdempotent({ installationId: this.installationId,
        ownerUserId: context.ownerUserId, route, key: context.idempotencyKey, bodySha256,
        writerEpoch, phase: route, nowMs: context.nowMs, expiresAtMs: context.nowMs + 86_400_000 });
      if (state !== 'started') {
        const prior = this.database.prepare(`SELECT state,response_status AS status,response_json AS json
          FROM connector_setup_owner_idempotency WHERE installation_id=? AND owner_user_id=?
          AND route=? AND idempotency_key=?`).get(this.installationId, context.ownerUserId,
          route, context.idempotencyKey) as { state: string; status: number|null; json: string|null };
        if (state === 'committed' && prior.json) { output = JSON.parse(prior.json); return; }
        fail(state === 'pending' ? 'CONNECTOR_SETUP_REQUEST_IN_PROGRESS' : 'CONNECTOR_SETUP_REQUEST_FAILED', 409);
      }
      output = effect();
      this.setup.finishIdempotent({ installationId: this.installationId,
        ownerUserId: context.ownerUserId, route, key: context.idempotencyKey, bodySha256,
        state: 'committed', responseStatus: 200, responseJson: JSON.stringify(output) });
    });
    if (!executed) fail('CONNECTOR_SETUP_RUNTIME_UNAVAILABLE', 503);
    return output;
  }
}
