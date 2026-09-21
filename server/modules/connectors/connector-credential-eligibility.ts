/** The only policy gate allowed to turn a persisted credential into usable material. */

export type ConnectorCredentialVerificationState =
  | 'stored_unverified' | 'verified' | 'rejected' | 'stale' | 'corrupt';
export type ConnectorCredentialOperationalState =
  | 'ineligible' | 'eligible' | 'disabled' | 'revoking' | 'deleted';

export type ConnectorCredentialRuntimePolicy = Readonly<{
  registryEnabled: boolean;
  grantsEnabled: boolean;
  runtimeEnabled: boolean;
  providerCertified: boolean;
  providerEnabled: boolean;
  serviceEnabled: boolean;
  expectedCatalogRevision: string;
  expectedShapeRevision: number;
  expectedContractRevision: number;
}>;

export type ConnectorCredentialEligibilitySnapshot = Readonly<{
  materialGeneration: 'm1' | 'm2';
  installationId: string;
  userId: number;
  providerId: string;
  serviceId: string;
  grantId: string;
  grantStatus: 'pending' | 'active' | 'revoked' | 'error';
  bundleId: string | null;
  bundleRevision: number | null;
  secretRevision: number | null;
  shapeRevision: number | null;
  contractRevision: number | null;
  expectedShapeRevision: number;
  expectedContractRevision: number;
  catalogRevision: string;
  expectedCatalogRevision: string;
  profileStatus: 'pending' | 'ready' | 'disabled' | 'error';
  profileVersion: number;
  boundProfileVersion: number | null;
  providerSubjectHmacMatches: boolean;
  revoked: boolean;
  verificationState: ConnectorCredentialVerificationState | null;
  operationalState: ConnectorCredentialOperationalState | null;
  verificationExpiresAt: string | null;
  credentialExpiresAt: string | null;
  now: string;
  identityBound: boolean;
  bundleComplete: boolean;
  ownership: 'personal' | 'team';
  registryEnabled: boolean;
  grantsEnabled: boolean;
  runtimeEnabled: boolean;
  providerCertified: boolean;
  providerEnabled: boolean;
  serviceEnabled: boolean;
}>;

export type ConnectorCredentialEligibility =
  | Readonly<{ eligible: true }>
  | Readonly<{ eligible: false; reason:
    | 'grant_inactive' | 'bundle_absent' | 'bundle_incomplete' | 'identity_mismatch'
    | 'revision_invalid' | 'not_verified' | 'verification_expired'
    | 'credential_expired' | 'operationally_inactive' | 'ownership_invalid'
    | 'policy_disabled' | 'provider_uncertified' | 'profile_inactive'
    | 'revision_mismatch' | 'subject_identity_mismatch' | 'revoked' }>;

const validRevision = (value: number | null): value is number =>
  Number.isSafeInteger(value) && (value ?? 0) > 0;

export const evaluateConnectorRuntimePolicy = (
  policy: ConnectorCredentialRuntimePolicy,
): ConnectorCredentialEligibility => {
  if (!policy.registryEnabled || !policy.grantsEnabled || !policy.runtimeEnabled
    || !policy.providerEnabled || !policy.serviceEnabled) {
    return { eligible: false, reason: 'policy_disabled' };
  }
  if (!policy.providerCertified) return { eligible: false, reason: 'provider_uncertified' };
  if (!policy.expectedCatalogRevision || !validRevision(policy.expectedShapeRevision)
    || !validRevision(policy.expectedContractRevision)) {
    return { eligible: false, reason: 'revision_invalid' };
  }
  return { eligible: true };
};

/** Pure fail-closed policy, shared by repository reads and every downstream capability. */
export const evaluateConnectorCredentialEligibility = (
  snapshot: ConnectorCredentialEligibilitySnapshot,
): ConnectorCredentialEligibility => {
  if (snapshot.grantStatus !== 'active') return { eligible: false, reason: 'grant_inactive' };
  if (snapshot.revoked) return { eligible: false, reason: 'revoked' };
  if (snapshot.profileStatus !== 'ready') return { eligible: false, reason: 'profile_inactive' };
  if (snapshot.ownership !== 'personal') return { eligible: false, reason: 'ownership_invalid' };
  const policy = evaluateConnectorRuntimePolicy(snapshot);
  if (!policy.eligible) return policy;
  if (snapshot.catalogRevision !== snapshot.expectedCatalogRevision) {
    return { eligible: false, reason: 'revision_mismatch' };
  }
  if (!snapshot.providerSubjectHmacMatches) {
    return { eligible: false, reason: 'subject_identity_mismatch' };
  }
  if (snapshot.materialGeneration === 'm1') return { eligible: true };
  if (!snapshot.bundleId) return { eligible: false, reason: 'bundle_absent' };
  if (!snapshot.identityBound) return { eligible: false, reason: 'identity_mismatch' };
  if (!snapshot.bundleComplete) return { eligible: false, reason: 'bundle_incomplete' };
  if (!validRevision(snapshot.bundleRevision) || !validRevision(snapshot.secretRevision)
    || !validRevision(snapshot.shapeRevision) || !validRevision(snapshot.contractRevision)) {
    return { eligible: false, reason: 'revision_invalid' };
  }
  if (snapshot.shapeRevision !== snapshot.expectedShapeRevision
    || snapshot.contractRevision !== snapshot.expectedContractRevision
    || snapshot.boundProfileVersion !== snapshot.profileVersion) {
    return { eligible: false, reason: 'revision_mismatch' };
  }
  if (snapshot.verificationState !== 'verified') return { eligible: false, reason: 'not_verified' };
  if (!snapshot.verificationExpiresAt || snapshot.verificationExpiresAt <= snapshot.now) {
    return { eligible: false, reason: 'verification_expired' };
  }
  if (snapshot.credentialExpiresAt && snapshot.credentialExpiresAt <= snapshot.now) {
    return { eligible: false, reason: 'credential_expired' };
  }
  if (snapshot.operationalState !== 'eligible') {
    return { eligible: false, reason: 'operationally_inactive' };
  }
  return { eligible: true };
};
