/** Read-only, secret-free cryptographic installation diagnostics shared by HTTP and CLI. */

import type { Database } from 'better-sqlite3';

import { verifyConnectorGlobalCertificationPack } from './connector-global-certification-pack.js';
import { connectorJcs } from './connector-jcs.js';
import { connectorLocalActivationDigest, decideConnectorFoundationEligibility,
  parseConnectorLocalActivationRecord,
  type ConnectorLocalActivationVerification } from './connector-local-activation.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';
import {
  CONNECTOR_POLICY_SCHEMA_VERSION, CONNECTOR_RUNTIME_FLOOR, type ConnectorRuntimeAuthority,
  preflightConnectorRuntime, verifyConnectorRuntimeActivationMac,
} from './connector-runtime-fence.js';
import { CONNECTOR_RUNTIME_PACK_EXPECTATIONS } from './connector-runtime-manifest.js';
import { connectorTrustBundleDigest, parseConnectorTrustBundle } from './connector-trust-bundle.js';

export type ConnectorSetupDoctorCheck = Readonly<{
  id: 'substrate'|'origin'|'trust'|'pack'|'activation';
  status: 'ok'|'required'|'blocked'; code: string;
}>;
export type ConnectorSetupDoctorReport = Readonly<{
  schemaVersion: 1; readyForAccountLinking: boolean;
  resumableStep: 'origin'|'trust'|'provider_pack'|'activation'|'complete';
  checks: readonly ConnectorSetupDoctorCheck[];
}>;
type Policy = { policySchemaVersion: number; policyEpoch: number; writerEpoch: number;
  originRevision: number; installationMode?: string; kills?: { global?: boolean;
    providers?: string[]; serviceOperations?: Array<{ serviceId: string; operation: string }> } };

const table = (database: Database, name: string): boolean => Boolean(database.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
).get(name));
const check = (id: ConnectorSetupDoctorCheck['id'], status: ConnectorSetupDoctorCheck['status'],
  code: string): ConnectorSetupDoctorCheck => Object.freeze({ id, status, code });

/** Performs SELECTs only. It never creates schema, decrypts, or calls a provider. */
export const inspectConnectorSetup = (database: Database, installationId: string,
  authority: ConnectorRuntimeAuthority, nowMs = Date.now()): ConnectorSetupDoctorReport => {
  const checks: ConnectorSetupDoctorCheck[] = [];
  const health = preflightConnectorRuntime(database, { runtimeVersion: CONNECTOR_RUNTIME_FLOOR,
    maximumPolicySchemaVersion: CONNECTOR_POLICY_SCHEMA_VERSION, supportsWriterFencing: true }, authority, nowMs);
  const metadata = health.subsystemReady && table(database, 'connector_policy_v2_substrate')
    ? database.prepare(`SELECT mode,production_manifest_active AS manifest,
      stored_unverified_creation_enabled AS storedUnverified,
      provider_activation_enabled AS activation,runtime_floor AS runtimeFloor
      FROM connector_policy_v2_substrate WHERE installation_id=?`).get(installationId) as
      { mode: string; manifest: number; storedUnverified: number; activation: number;
        runtimeFloor: number }|undefined
    : undefined;
  const substrate = health.subsystemReady && metadata?.mode === 'substrate_only'
    && metadata.manifest === 0 && metadata.storedUnverified === 0
    && metadata.activation === 0 && metadata.runtimeFloor === CONNECTOR_RUNTIME_FLOOR;
  checks.push(check('substrate', substrate ? 'ok' : 'blocked', substrate
    ? 'CONNECTOR_SUBSTRATE_READY' : 'CONNECTOR_SUBSTRATE_UNAVAILABLE'));
  let policy: Policy | null = null;
  try {
    const row = substrate ? database.prepare(`SELECT state_json AS stateJson FROM connector_policy_v2_state
      WHERE installation_id=?`).get(installationId) as { stateJson: string }|undefined : undefined;
    policy = row ? JSON.parse(row.stateJson) as Policy : null;
  } catch { policy = null; }
  const originRow = substrate && table(database, 'connector_m5_installation_origin')
    ? database.prepare(`SELECT canonical_origin AS origin FROM connector_m5_installation_origin
      WHERE installation_id=?`).get(installationId) as { origin: string }|undefined : undefined;
  let origin = false;
  try { origin = Boolean(originRow && new URL(originRow.origin).origin === originRow.origin
    && policy?.originRevision && policy.originRevision > 0); } catch { origin = false; }
  checks.push(check('origin', origin ? 'ok' : substrate ? 'required' : 'blocked', origin
    ? 'CONNECTOR_ORIGIN_READY' : 'CONNECTOR_ORIGIN_REQUIRED'));
  const trustRow = origin && table(database, 'connector_setup_trust_bundle')
    ? database.prepare(`SELECT revision,bundle_json AS bundleJson,digest FROM connector_setup_trust_bundle
      WHERE installation_id=?`).get(installationId) as { revision: number; bundleJson: string; digest: string }|undefined
    : undefined;
  let trustBundle: ReturnType<typeof parseConnectorTrustBundle> = null; let trust = false;
  try {
    trustBundle = trustRow ? parseConnectorTrustBundle(JSON.parse(trustRow.bundleJson) as unknown) : null;
    trust = Boolean(trustBundle && trustBundle.revision === trustRow?.revision
      && connectorTrustBundleDigest(trustBundle).toString('base64url') === trustRow?.digest);
  } catch { trust = false; }
  checks.push(check('trust', trust ? 'ok' : origin ? 'required' : 'blocked', trust
    ? 'CONNECTOR_TRUST_READY' : trustRow ? 'CONNECTOR_TRUST_TAMPERED' : 'CONNECTOR_TRUST_REQUIRED'));
  const packRow = trust && table(database, 'connector_global_certification_packs')
    ? database.prepare(`SELECT issuer,channel,sequence,envelope_json AS envelopeJson,digest,
      trust_bundle_revision AS trustRevision,clock_high_water_ms AS clockHighWaterMs
      FROM connector_global_certification_packs WHERE installation_id=? AND state='active'`).get(installationId) as
      { issuer: string; channel: string; sequence: number; envelopeJson: string; digest: string; trustRevision: number;
        clockHighWaterMs: number }|undefined : undefined;
  let packVerification: ReturnType<typeof verifyConnectorGlobalCertificationPack> | null = null;
  try {
    packVerification = packRow && trustBundle ? verifyConnectorGlobalCertificationPack(
      JSON.parse(packRow.envelopeJson) as unknown, { now: new Date(nowMs),
        wallClockHighWaterMs: packRow.clockHighWaterMs, priorSequence: packRow.sequence - 1,
        minimumTrustBundleRevision: packRow.trustRevision, runtimeFloor: CONNECTOR_RUNTIME_FLOOR,
        policySchemaVersion: CONNECTOR_POLICY_SCHEMA_VERSION, trustBundle,
        ...CONNECTOR_RUNTIME_PACK_EXPECTATIONS }) : null;
  } catch { packVerification = null; }
  const pack = Boolean(packRow && packVerification?.verified
    && packVerification.acceptedSequence === packRow.sequence && packVerification.digest === packRow.digest
    && packVerification.trustBundleRevision === packRow.trustRevision
    && packVerification.pack.issuerId === packRow.issuer
    && packVerification.pack.channel === packRow.channel);
  checks.push(check('pack', pack ? 'ok' : trust ? 'required' : 'blocked', pack
    ? 'CONNECTOR_PACK_READY' : packRow ? 'CONNECTOR_PACK_INVALID' : 'CONNECTOR_PACK_REQUIRED'));
  const activationRow = pack && table(database, 'connector_setup_local_activation')
    ? database.prepare(`SELECT record_revision AS revision,envelope_json AS envelopeJson,digest,
      policy_epoch AS policyEpoch,writer_epoch AS writerEpoch,origin_revision AS originRevision
      FROM connector_setup_local_activation WHERE installation_id=? AND valid=1`).get(installationId) as
      { revision: number; envelopeJson: string; digest: string; policyEpoch: number;
        writerEpoch: number; originRevision: number }|undefined : undefined;
  let activation = false;
  try {
    const envelope = activationRow ? JSON.parse(activationRow.envelopeJson) as { record?: unknown; mac?: unknown } : null;
    const record = parseConnectorLocalActivationRecord(envelope?.record);
    const cryptographicallyBound = Boolean(record && typeof envelope?.mac === 'string' && packVerification?.verified
      && verifyConnectorRuntimeActivationMac(authority, Buffer.from(connectorJcs(record), 'utf8'), envelope.mac)
      && connectorLocalActivationDigest(record).toString('base64url') === activationRow?.digest
      && record.installationId === installationId
      && record.recordRevision === activationRow?.revision
      && record.policyEpoch === policy?.policyEpoch && record.writerEpoch === policy?.writerEpoch
      && record.originRevision === policy?.originRevision && record.globalPackDigest === packVerification.digest
      && record.globalPackIssuerId === packVerification.pack.issuerId
      && record.globalPackChannel === packVerification.pack.channel
      && record.globalPackSequence === packVerification.pack.sequence
      && record.trustBundleRevision === packVerification.trustBundleRevision);
    const local: ConnectorLocalActivationVerification = cryptographicallyBound && record
      ? { verified: true, record, digest: activationRow!.digest }
      : { verified: false, reason: 'activation_binding_invalid' };
    activation = Boolean(cryptographicallyBound && record && packVerification?.verified
      && policy?.policySchemaVersion === CONNECTOR_POLICY_SCHEMA_VERSION
      && policy.installationMode === 'portable_default'
      && record.activations.some(item => {
        if (!item.enabled) return false;
        const profile = item.operation === ConnectorPolicyOperation.ProfileConfigure ? { status: 'ready', version: 0 }
          : database.prepare(`SELECT status,version FROM connector_auth_profiles
            WHERE installation_id=? AND provider_id=?`).get(installationId, item.providerId) as
            { status: string; version: number }|undefined;
        const needsGrant = [ConnectorPolicyOperation.CredentialUse, ConnectorPolicyOperation.TokenRefresh,
          ConnectorPolicyOperation.PlacementWrite].includes(item.operation);
        const grant = needsGrant ? database.prepare(`SELECT grant_id AS grantId FROM connector_user_grants
          WHERE installation_id=? AND provider_id=? AND service_id=? AND status='active' LIMIT 1`)
          .get(installationId, item.providerId, item.serviceId) as { grantId: string }|undefined : undefined;
        const needsVerification = needsGrant;
        const verified = !needsVerification || Boolean(grant && database.prepare(`SELECT 1
          FROM connector_credential_bundle_revisions b JOIN connector_credential_verifications v
            USING(bundle_id,bundle_revision) WHERE b.installation_id=? AND b.grant_id=?
            AND b.bundle_state='stored' AND v.verification_state='verified'
            AND (v.expires_at IS NULL OR v.expires_at>CURRENT_TIMESTAMP) LIMIT 1`)
          .get(installationId, grant.grantId));
        return decideConnectorFoundationEligibility({ operation: item.operation,
          providerId: item.providerId, serviceId: item.serviceId, foundationQuarantined: false,
          globalKilled: policy.kills?.global ?? true,
          providerKilled: policy.kills?.providers?.includes(item.providerId) ?? true,
          serviceOperationKilled: policy.kills?.serviceOperations?.some(kill =>
            kill.serviceId === item.serviceId && kill.operation === item.operation) ?? true,
          globalPack: packVerification, localActivation: local,
          profileReady: item.operation === ConnectorPolicyOperation.ProfileConfigure
            || Boolean(profile?.status === 'ready' && (!item.profileRevision
              || item.profileRevision === profile.version)),
          grantReady: !needsGrant || Boolean(grant), verificationReady: verified }).eligible;
      }));
  } catch { activation = false; }
  checks.push(check('activation', activation ? 'ok' : pack ? 'required' : 'blocked', activation
    ? 'CONNECTOR_ACTIVATION_READY' : activationRow ? 'CONNECTOR_ACTIVATION_INVALID'
      : 'CONNECTOR_ACTIVATION_REQUIRED'));
  const resumableStep = !origin ? 'origin' : !trust ? 'trust' : !pack ? 'provider_pack'
    : !activation ? 'activation' : 'complete';
  return Object.freeze({ schemaVersion: 1, readyForAccountLinking: activation,
    resumableStep, checks: Object.freeze(checks) });
};
