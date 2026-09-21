/**
 * Server-owned credential vocabulary for ADR-132.
 *
 * Nothing in this module is accepted from an HTTP request.  A service id is
 * resolved to one of these frozen contracts before bytes are stored, verified,
 * or assembled for a connector process.
 */

export type ConnectorCredentialField = Readonly<{
  id: 'api_key' | 'merchant_public_key' | 'api_password';
  label: string;
  minBytes: number;
  maxBytes: number;
  sensitivity: 'secret' | 'confidential_identifier';
}>;

export type ConnectorCredentialShape = Readonly<{
  id: 'single_api_key' | 'geidea_basic';
  revision: 1;
  fields: readonly [ConnectorCredentialField, ...ConnectorCredentialField[]];
  assembly: 'opaque_api_key' | 'basic_authorization';
}>;

export type ConnectorVerificationContract = Readonly<{
  id: string;
  revision: 1;
  status: 'certified' | 'pending';
  identityKinds: readonly ('user' | 'store' | 'merchant' | 'account')[];
  evidenceTtlSeconds: number;
}>;

export type ConnectorCredentialContract = Readonly<{
  serviceId: string;
  providerId: string;
  shape: ConnectorCredentialShape;
  verification: ConnectorVerificationContract;
}>;

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};

const SINGLE_API_KEY: ConnectorCredentialShape = deepFreeze({
  id: 'single_api_key', revision: 1, assembly: 'opaque_api_key',
  fields: [{ id: 'api_key', label: 'API key', minBytes: 1, maxBytes: 65_536, sensitivity: 'secret' }],
});

const GEIDEA_BASIC: ConnectorCredentialShape = deepFreeze({
  id: 'geidea_basic', revision: 1, assembly: 'basic_authorization',
  fields: [
    { id: 'merchant_public_key', label: 'Merchant public key', minBytes: 1, maxBytes: 256, sensitivity: 'confidential_identifier' },
    { id: 'api_password', label: 'API password', minBytes: 1, maxBytes: 4_096, sensitivity: 'secret' },
  ],
});

const apiKeyContract = (
  serviceId: string,
  status: ConnectorVerificationContract['status'],
  identityKinds: ConnectorVerificationContract['identityKinds'] = ['account'],
): ConnectorCredentialContract => deepFreeze({
  serviceId,
  providerId: serviceId,
  shape: SINGLE_API_KEY,
  verification: {
    id: `${serviceId}.identity`, revision: 1, status, identityKinds,
    evidenceTtlSeconds: 86_400,
  },
});

const contracts = [
  apiKeyContract('github', 'certified', ['user']),
  apiKeyContract('slack', 'certified', ['user', 'account']),
  apiKeyContract('figma', 'certified', ['user']),
  apiKeyContract('wafeq', 'certified', ['account']),
  apiKeyContract('stripe', 'certified', ['account']),
  apiKeyContract('salla', 'pending', ['user', 'store']),
  apiKeyContract('infomaniak-mail', 'pending'),
  apiKeyContract('infomaniak-contacts', 'pending'),
  apiKeyContract('viator', 'pending'),
  apiKeyContract('getyourguide', 'pending'),
  apiKeyContract('tamara', 'pending'),
  apiKeyContract('geidea', 'pending', ['merchant']),
] as const;

const geidea = deepFreeze({
  ...contracts[contracts.length - 1],
  shape: GEIDEA_BASIC,
}) as ConnectorCredentialContract;

export const CONNECTOR_CREDENTIAL_CONTRACTS: readonly ConnectorCredentialContract[] = deepFreeze([
  ...contracts.slice(0, -1), geidea,
]);

const byService = new Map(CONNECTOR_CREDENTIAL_CONTRACTS.map(contract => [contract.serviceId, contract]));

/** Resolve a trusted service id to its closed, server-owned credential contract. */
export const connectorCredentialContractFor = (
  serviceId: string,
): ConnectorCredentialContract | null => byService.get(serviceId) ?? null;

/** Validate a complete candidate without assembling provider headers or environment variables. */
export const validateConnectorCredentialBundle = (
  serviceId: string,
  values: Readonly<Record<string, Buffer>>,
): ConnectorCredentialContract => {
  const contract = connectorCredentialContractFor(serviceId);
  if (!contract) throw new Error('connector_credential_contract_unknown');
  const expected = new Set(contract.shape.fields.map(field => field.id));
  const actual = Object.keys(values);
  if (actual.length !== expected.size || actual.some(field => !expected.has(field as ConnectorCredentialField['id']))) {
    throw new Error('connector_credential_bundle_incomplete');
  }
  for (const field of contract.shape.fields) {
    const value = values[field.id];
    if (!Buffer.isBuffer(value) || value.length < field.minBytes || value.length > field.maxBytes
      || value.includes(0)) throw new Error('connector_credential_field_invalid');
  }
  return contract;
};

/** Geidea stays intentionally non-operable until an atomic consumer capability is certified. */
export const GEIDEA_RUNTIME_SUPPORTED = false as const;
