import crypto from 'node:crypto';

import { getProviderSecretsKey } from '@/services/isolation/provider-secrets-key-manager.js';

import type { ConnectorGrantMaterialReference } from './connector-user-grant.service.js';

export const CONNECTOR_PLACEMENT_HMAC_CURRENT_VERSION = 2 as const;
export const CONNECTOR_PLACEMENT_HMAC_PREVIOUS_VERSION = 1 as const;

export type ConnectorPlacementHmacVersion = 1 | 2;

export type ConnectorPlacementMaterial = {
  connectorId: string;
  memberUserId: number;
  bodyProvider: 'claude' | 'codex';
  contractVersion: 'mcp-user-v1';
  body: unknown;
  credential: string;
  /** Opaque vault identity shared by both body plans; it never contains plaintext. */
  grantMaterialRef?: ConnectorGrantMaterialReference;
};

export type ConnectorPlacementFingerprint = {
  version: ConnectorPlacementHmacVersion;
  fingerprint: string;
};

export type ConnectorPlacementFingerprintVerification = {
  valid: boolean;
  needsRotation: boolean;
};

const PURPOSE = 'nassaj/connector-placement/material';
const ABSENCE_PURPOSE = 'nassaj/connector-placement/absence';
const HKDF_SALT = Buffer.from('nassaj/provider-secrets/purpose-keys/v1', 'utf8');

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('connector_placement_material_invalid');
    return value;
  }
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))
      || Object.keys(value).length !== value.length
    ) throw new Error('connector_placement_material_invalid');
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
        throw new Error('connector_placement_material_invalid');
      }
      output.push(canonicalize(descriptor.value));
    }
    return output;
  }
  if (typeof value !== 'object') throw new Error('connector_placement_material_invalid');

  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('connector_placement_material_invalid');
  }
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new Error('connector_placement_material_invalid');
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of (ownKeys as string[]).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
      throw new Error('connector_placement_material_invalid');
    }
    output[key] = canonicalize(descriptor.value);
  }
  return output;
}

function assertIdentity(material: Omit<ConnectorPlacementMaterial, 'body' | 'credential'>): void {
  if (
    !material.connectorId
    || !Number.isSafeInteger(material.memberUserId)
    || material.memberUserId <= 0
    || (material.bodyProvider !== 'claude' && material.bodyProvider !== 'codex')
    || material.contractVersion !== 'mcp-user-v1'
  ) {
    throw new Error('connector_placement_material_invalid');
  }
}

function assertMaterial(material: ConnectorPlacementMaterial): void {
  assertIdentity(material);
  if (!material.credential) throw new Error('connector_placement_material_invalid');
}

function derivePurposeKey(
  masterKey: Buffer,
  version: ConnectorPlacementHmacVersion,
  purpose = PURPOSE,
): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    masterKey,
    HKDF_SALT,
    Buffer.from(`${purpose}/hmac-v${version}`, 'utf8'),
    32,
  ));
}

/** Authenticated deletion intent; deliberately has no credential field or fallback sentinel. */
export function fingerprintConnectorPlacementAbsence(
  key: Omit<ConnectorPlacementMaterial, 'body' | 'credential'>,
  options: { masterKey?: Buffer } = {},
): ConnectorPlacementFingerprint {
  assertIdentity(key);
  const masterKey = options.masterKey ?? getProviderSecretsKey();
  if (masterKey.length !== 32) throw new Error('connector_placement_hmac_key_invalid');
  const payload = JSON.stringify(canonicalize({
    purpose: ABSENCE_PURPOSE,
    version: CONNECTOR_PLACEMENT_HMAC_CURRENT_VERSION,
    ...key,
  }));
  return {
    version: CONNECTOR_PLACEMENT_HMAC_CURRENT_VERSION,
    fingerprint: crypto
      .createHmac('sha256', derivePurposeKey(
        masterKey,
        CONNECTOR_PLACEMENT_HMAC_CURRENT_VERSION,
        ABSENCE_PURPOSE,
      ))
      .update(payload, 'utf8')
      .digest('hex'),
  };
}

function payloadFor(
  material: ConnectorPlacementMaterial,
  version: ConnectorPlacementHmacVersion,
): string {
  assertMaterial(material);
  return JSON.stringify(canonicalize({
    purpose: PURPOSE,
    version,
    connectorId: material.connectorId,
    memberUserId: material.memberUserId,
    bodyProvider: material.bodyProvider,
    contractVersion: material.contractVersion,
    body: material.body,
    credential: material.credential,
  }));
}

/**
 * Authenticates the complete desired placement, including its credential.
 * The credential is used only inside the HMAC and is never included in the result.
 */
export function fingerprintConnectorPlacementMaterial(
  material: ConnectorPlacementMaterial,
  options: {
    version?: ConnectorPlacementHmacVersion;
    masterKey?: Buffer;
  } = {},
): ConnectorPlacementFingerprint {
  const version = options.version ?? CONNECTOR_PLACEMENT_HMAC_CURRENT_VERSION;
  if (version !== 1 && version !== 2) {
    throw new Error('connector_placement_hmac_version_blocked');
  }
  const masterKey = options.masterKey ?? getProviderSecretsKey();
  if (masterKey.length !== 32) throw new Error('connector_placement_hmac_key_invalid');
  const fingerprint = crypto
    .createHmac('sha256', derivePurposeKey(masterKey, version))
    .update(payloadFor(material, version), 'utf8')
    .digest('hex');
  return { version, fingerprint };
}

/** Verifies the current or one explicitly supported previous format without disclosing comparison data. */
export function verifyConnectorPlacementFingerprint(
  material: ConnectorPlacementMaterial,
  proof: ConnectorPlacementFingerprint,
  options: { masterKey?: Buffer } = {},
): ConnectorPlacementFingerprintVerification {
  if (proof.version !== 1 && proof.version !== 2) {
    throw new Error('connector_placement_hmac_version_blocked');
  }
  if (!/^[0-9a-f]{64}$/.test(proof.fingerprint)) {
    return { valid: false, needsRotation: false };
  }
  const expected = fingerprintConnectorPlacementMaterial(material, {
    version: proof.version,
    masterKey: options.masterKey,
  });
  const valid = crypto.timingSafeEqual(
    Buffer.from(proof.fingerprint, 'hex'),
    Buffer.from(expected.fingerprint, 'hex'),
  );
  return {
    valid,
    needsRotation: valid && proof.version === CONNECTOR_PLACEMENT_HMAC_PREVIOUS_VERSION,
  };
}
