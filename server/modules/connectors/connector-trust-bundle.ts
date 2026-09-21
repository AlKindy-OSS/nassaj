/** Pure parsing and digesting of installation-pinned connector trust roots. */

import { createHash } from 'node:crypto';

import {
  connectorDeepFreeze, connectorExactKeys, connectorJcs, connectorPositiveInteger,
  connectorStrictIsoTime, connectorValidId, isConnectorPlainObject, ownConnectorJsonValue,
} from './connector-jcs.js';

const TRUST_BUNDLE_PREFIX = Buffer.from('NASSAJ\0CONNECTOR_TRUST_BUNDLE\0V1\0', 'utf8');

export type ConnectorTrustRoot = Readonly<{
  issuerId: string;
  keyId: string;
  algorithm: 'Ed25519';
  publicKeyPem: string;
  validFrom: string;
  validUntil: string;
  source: 'distribution' | 'owner_import';
}>;

export type ConnectorTrustBundle = Readonly<{
  schemaVersion: 1;
  revision: number;
  distributionIssuerId: string;
  roots: readonly ConnectorTrustRoot[];
  revokedKeyIds: readonly string[];
}>;

const ROOT_KEYS = ['issuerId', 'keyId', 'algorithm', 'publicKeyPem', 'validFrom', 'validUntil', 'source'] as const;
const BUNDLE_KEYS = ['schemaVersion', 'revision', 'distributionIssuerId', 'roots', 'revokedKeyIds'] as const;

const validRoot = (value: unknown): value is ConnectorTrustRoot => {
  if (!isConnectorPlainObject(value) || !connectorExactKeys(value, ROOT_KEYS)) return false;
  const validFrom = connectorStrictIsoTime(value.validFrom);
  const validUntil = connectorStrictIsoTime(value.validUntil);
  return connectorValidId(value.issuerId) && connectorValidId(value.keyId)
    && value.algorithm === 'Ed25519' && typeof value.publicKeyPem === 'string'
    && value.publicKeyPem.length >= 64 && value.publicKeyPem.length <= 8_192
    && validFrom !== null && validUntil !== null && validFrom < validUntil
    && (value.source === 'distribution' || value.source === 'owner_import');
};

/** Closed-schema parser. It owns and freezes the returned bundle. */
export const parseConnectorTrustBundle = (value: unknown): ConnectorTrustBundle | null => {
  const owned = ownConnectorJsonValue(value);
  if (!isConnectorPlainObject(owned) || !connectorExactKeys(owned, BUNDLE_KEYS)
    || owned.schemaVersion !== 1 || !connectorPositiveInteger(owned.revision)
    || !connectorValidId(owned.distributionIssuerId) || !Array.isArray(owned.roots)
    || owned.roots.length < 1 || owned.roots.length > 64 || !owned.roots.every(validRoot)
    || !Array.isArray(owned.revokedKeyIds) || owned.revokedKeyIds.length > 64
    || !owned.revokedKeyIds.every(connectorValidId)
    || new Set(owned.revokedKeyIds).size !== owned.revokedKeyIds.length) return null;
  const identities = owned.roots.map(root => {
    const typed = root as ConnectorTrustRoot;
    return `${typed.issuerId}\0${typed.keyId}`;
  });
  if (new Set(identities).size !== identities.length
    || owned.roots.some(root => (root as ConnectorTrustRoot).source === 'distribution'
      && (root as ConnectorTrustRoot).issuerId !== owned.distributionIssuerId)) return null;
  try { connectorJcs(owned); } catch { return null; }
  return connectorDeepFreeze(owned) as ConnectorTrustBundle;
};

export const connectorTrustBundleDigest = (bundle: ConnectorTrustBundle): Buffer =>
  createHash('sha512').update(TRUST_BUNDLE_PREFIX).update(connectorJcs(bundle), 'utf8').digest();

/** Returns one unrevoked root for an exact issuer/key pair, valid at issue time and verification time. */
export const selectConnectorTrustRoot = (
  bundle: ConnectorTrustBundle,
  issuerId: string,
  keyId: string,
  issuedAtMs: number,
  nowMs: number,
): ConnectorTrustRoot | null => {
  const parsed = parseConnectorTrustBundle(bundle);
  if (!parsed || parsed.revokedKeyIds.includes(keyId)) return null;
  const roots = parsed.roots.filter(root => root.issuerId === issuerId && root.keyId === keyId);
  if (roots.length !== 1) return null;
  const root = roots[0];
  const validFrom = connectorStrictIsoTime(root.validFrom) as number;
  const validUntil = connectorStrictIsoTime(root.validUntil) as number;
  return validFrom <= issuedAtMs && issuedAtMs < validUntil
    && validFrom <= nowMs && nowMs < validUntil ? root : null;
};
