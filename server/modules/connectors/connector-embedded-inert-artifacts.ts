/**
 * Public, inert distribution fixture for validating OSS setup plumbing.
 * It certifies zero operations and is never imported or activated automatically.
 */

import type { SignedConnectorGlobalCertificationPack } from './connector-global-certification-pack.js';
import type { ConnectorTrustBundle } from './connector-trust-bundle.js';

export const CONNECTOR_EMBEDDED_ARTIFACT_KIND = 'inert_test_fixture' as const;

export const CONNECTOR_EMBEDDED_TRUST_BUNDLE: ConnectorTrustBundle = Object.freeze({
  schemaVersion: 1, revision: 1, distributionIssuerId: 'nassaj-oss-fixture', revokedKeyIds: [],
  roots: [Object.freeze({ issuerId: 'nassaj-oss-fixture', keyId: 'fixture-root-2026-08',
    algorithm: 'Ed25519',
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAA3qEsI1g+fnPlWMF6NQBY4zwPBKF9XwJsPKKqOxmpaQ=\n-----END PUBLIC KEY-----\n',
    validFrom: '2026-08-27T00:00:00.000Z', validUntil: '2027-08-27T00:00:00.000Z',
    source: 'distribution' })],
});

export const CONNECTOR_EMBEDDED_INERT_PACK: SignedConnectorGlobalCertificationPack = Object.freeze({
  pack: Object.freeze({ schemaVersion: 1, domain: 'nassaj.connector-certification-pack.v1',
    issuerId: 'nassaj-oss-fixture', channel: 'stable', sequence: 1,
    issuedAt: '2026-08-27T00:00:00.000Z', expiresAt: '2026-09-26T00:00:00.000Z',
    minimumRuntimeFloor: 1, maximumPolicySchemaVersion: 2,
    registryRevision: '2026-08-26.m1', registryDigest: 'ZqY_b5y1tPvRBApa8-DieBQhqaMCIOYtIC3ZDYhDLeM',
    operationsRevision: 'policy-v2.operations.v1', operationsDigest: 'wELcmuHRCLzIFvrdbcbV5Vi81xcHRy70cwjPTRN2_Pg',
    capabilityRevision: 'policy-v2.capability.v1', capabilityDigest: 'oXYFC_VaLWvTTgGolk3c8tlz-mJrXtKaYx1zNX8AuSI',
    certifications: [], signingKeyId: 'fixture-root-2026-08' }),
  signature: '_kvwNwSaWOhC2I1KcAel9_SGVtwVRH0V5iBXdQcaKTgcMeMFUDSecKeQBoZzmSC02k6dCYaLFHbm4kJB0Xs8DA',
});
