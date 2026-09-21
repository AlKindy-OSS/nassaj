/** Exact connector registries compiled into this runtime. Packs must bind to these values. */

import { createHash } from 'node:crypto';

import {
  CONNECTOR_AUTH_CATALOG_REVISION, PROVIDER_AUTH_SPECS,
} from '../../../shared/connector-auth-registry.js';

import { connectorJcs } from './connector-jcs.js';
import {
  KILLABLE_CONNECTOR_OPERATIONS, LIFECYCLE_CONNECTOR_OPERATIONS,
} from './connector-policy-v2.js';

const sha256 = (value: unknown): string => createHash('sha256')
  .update(connectorJcs(value), 'utf8').digest('base64url');

export const CONNECTOR_OPERATIONS_REVISION = 'policy-v2.operations.v1' as const;
export const CONNECTOR_CAPABILITY_REVISION = 'policy-v2.capability.v1' as const;

const registryDescriptor = Object.freeze({
  revision: CONNECTOR_AUTH_CATALOG_REVISION,
  providers: PROVIDER_AUTH_SPECS,
});
const operationsDescriptor = Object.freeze({
  revision: CONNECTOR_OPERATIONS_REVISION,
  killable: KILLABLE_CONNECTOR_OPERATIONS,
  lifecycle: LIFECYCLE_CONNECTOR_OPERATIONS,
});
const capabilityDescriptor = Object.freeze({
  revision: CONNECTOR_CAPABILITY_REVISION,
  binding: Object.freeze(['installationId', 'userId', 'ownership', 'providerId', 'serviceId',
    'accountId', 'grantId', 'consumerBody', 'operation']),
  decisionInputs: Object.freeze(['foundationQuarantined', 'globalKilled', 'providerKilled',
    'serviceOperationKilled', 'globalPack', 'localActivation', 'profileReady', 'grantReady',
    'verificationReady']),
});

export const CONNECTOR_RUNTIME_MANIFEST = Object.freeze({
  registryRevision: CONNECTOR_AUTH_CATALOG_REVISION,
  registryDigest: sha256(registryDescriptor),
  operationsRevision: CONNECTOR_OPERATIONS_REVISION,
  operationsDigest: sha256(operationsDescriptor),
  capabilityRevision: CONNECTOR_CAPABILITY_REVISION,
  capabilityDigest: sha256(capabilityDescriptor),
});

export const CONNECTOR_RUNTIME_PACK_EXPECTATIONS = Object.freeze({
  expectedRegistryRevision: CONNECTOR_RUNTIME_MANIFEST.registryRevision,
  expectedRegistryDigest: CONNECTOR_RUNTIME_MANIFEST.registryDigest,
  expectedOperationsRevision: CONNECTOR_RUNTIME_MANIFEST.operationsRevision,
  expectedOperationsDigest: CONNECTOR_RUNTIME_MANIFEST.operationsDigest,
  expectedCapabilityRevision: CONNECTOR_RUNTIME_MANIFEST.capabilityRevision,
  expectedCapabilityDigest: CONNECTOR_RUNTIME_MANIFEST.capabilityDigest,
});

export type ConnectorRuntimeManifest = typeof CONNECTOR_RUNTIME_MANIFEST;
