import {
  isProviderAuthRegistryEnabled,
  isProviderAuthSpecCertified,
  providerAuthSpecFor,
  type ApiKeySpec,
} from '../../../shared/connector-auth-registry.js';

import {
  connectorCredentialContractFor,
  type ConnectorCredentialContract,
} from './connector-credential-contracts.js';

type CredentialInputSchema = Readonly<{
  schemaVersion: 1;
  shape: 'single_api_key' | 'geidea_basic';
  fields: readonly Readonly<{
    id: 'api_key' | 'merchant_public_key' | 'api_password';
    label: string;
    inputType: 'password' | 'text';
    required: true;
  }>[];
}>;

type SubmitSemantics =
  | Readonly<{
    operation: 'put_personal_api_key';
    credentialPayload: 'apiKey' | 'credentialFields';
    activation: 'after_verification' | 'stored_inert';
    requiresExplicitUnverifiedConsent: boolean;
    unverifiedConsentPayload: 'acceptStoredUnverified' | 'none';
  }>
  | Readonly<{
    operation: 'start_oauth';
    credentialPayload: 'none';
    activation: 'after_callback_verification';
    requiresExplicitUnverifiedConsent: false;
    unverifiedConsentPayload: 'none';
  }>
  | Readonly<{
    operation: 'none';
    credentialPayload: 'none';
    activation: 'unavailable';
    requiresExplicitUnverifiedConsent: false;
    unverifiedConsentPayload: 'none';
  }>;

export type ConnectorAuthServiceCapability = Readonly<{
  serviceId: string;
  canSubmitCredential: boolean;
  canStartOAuth: boolean;
  canStoreUnverified: boolean;
  credentialInputSchema: CredentialInputSchema | null;
  submitSemantics: SubmitSemantics;
}>;

const enabled = (env: Readonly<Record<string, string | undefined>>, name: string): boolean =>
  env[name] === '1';

const serviceFlag = (prefix: string, id: string): string =>
  `${prefix}${id.toUpperCase().replace(/-/gu, '_')}`;

const unavailableSemantics = (): SubmitSemantics => Object.freeze({
  operation: 'none',
  credentialPayload: 'none',
  activation: 'unavailable',
  requiresExplicitUnverifiedConsent: false,
  unverifiedConsentPayload: 'none',
});

const oauthCapability = (
  serviceId: string,
  spec: NonNullable<ReturnType<typeof providerAuthSpecFor>>,
  providerEnabled: boolean,
  env: Readonly<Record<string, string | undefined>>,
): ConnectorAuthServiceCapability => {
  const canStartOAuth = providerEnabled
    && enabled(env, 'NASSAJ_CONNECTOR_GRANTS_V2')
    && enabled(env, 'NASSAJ_CONNECTOR_CREDENTIAL_RUNTIME_V2')
    && enabled(env, serviceFlag('NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_', serviceId))
    && enabled(env, 'NASSAJ_CONNECTOR_OAUTH_V2')
    && enabled(env, serviceFlag('NASSAJ_CONNECTOR_OAUTH_CERT_', spec.profileId))
    && !(spec.method === 'byo_app' && spec.identity.method === 'unavailable');
  return Object.freeze({
    serviceId,
    canSubmitCredential: false,
    canStartOAuth,
    canStoreUnverified: false,
    credentialInputSchema: null,
    submitSemantics: canStartOAuth ? Object.freeze({
      operation: 'start_oauth', credentialPayload: 'none',
      activation: 'after_callback_verification', requiresExplicitUnverifiedConsent: false,
      unverifiedConsentPayload: 'none',
    }) : unavailableSemantics(),
  });
};

const credentialInputSchemaFor = (
  contract: NonNullable<ReturnType<typeof connectorCredentialContractFor>>,
): CredentialInputSchema => Object.freeze({
  schemaVersion: 1,
  shape: contract.shape.id,
  fields: Object.freeze(contract.shape.fields.map(field => Object.freeze({
    id: field.id,
    label: field.label,
    inputType: field.sensitivity === 'secret' ? 'password' as const : 'text' as const,
    required: true as const,
  }))),
});

/** Reject registry drift before projecting a writable credential capability. */
export const credentialContractMatchesAuthSpec = (
  contract: ConnectorCredentialContract,
  spec: ApiKeySpec,
): boolean => {
  if (!spec.services.includes(contract.serviceId)
    || contract.providerId !== spec.profileId
    || contract.verification.status !== spec.serviceProbe.status) return false;
  const semantics = spec.serviceProbe.verificationContract?.identitySemantics;
  return !semantics || (semantics.length === contract.verification.identityKinds.length
    && semantics.every((kind, index) => contract.verification.identityKinds[index] === kind));
};

export const projectApiKeyServiceCapability = (
  serviceId: string,
  spec: ApiKeySpec,
  contract: ConnectorCredentialContract | null,
  providerEnabled: boolean,
  env: Readonly<Record<string, string | undefined>>,
): ConnectorAuthServiceCapability => {
  const trustedContract = contract && credentialContractMatchesAuthSpec(contract, spec)
    ? contract : null;
  const canSubmitCredential = Boolean(trustedContract && providerEnabled
    && enabled(env, 'NASSAJ_CONNECTOR_GRANTS_V2')
    && enabled(env, serviceFlag('NASSAJ_CONNECTOR_GRANT_CERT_', serviceId)));
  const canStoreUnverified = canSubmitCredential
    && trustedContract?.verification.status === 'pending';
  return Object.freeze({
    serviceId,
    canSubmitCredential,
    canStartOAuth: false,
    canStoreUnverified,
    credentialInputSchema: trustedContract ? credentialInputSchemaFor(trustedContract) : null,
    submitSemantics: canSubmitCredential ? Object.freeze({
      operation: 'put_personal_api_key',
      credentialPayload: trustedContract?.shape.id === 'single_api_key' ? 'apiKey' : 'credentialFields',
      activation: canStoreUnverified ? 'stored_inert' : 'after_verification',
      requiresExplicitUnverifiedConsent: canStoreUnverified,
      unverifiedConsentPayload: canStoreUnverified ? 'acceptStoredUnverified' : 'none',
    }) : unavailableSemantics(),
  });
};

/** Secret-free, per-service capability projection from the closed auth and credential registries. */
export const connectorAuthServiceCapability = (
  serviceId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConnectorAuthServiceCapability | null => {
  const spec = providerAuthSpecFor(serviceId);
  if (!spec) return null;
  const providerEnabled = isProviderAuthRegistryEnabled(env)
    && isProviderAuthSpecCertified(spec, env);
  return spec.method === 'api_key'
    ? projectApiKeyServiceCapability(
      serviceId, spec, connectorCredentialContractFor(serviceId), providerEnabled, env,
    )
    : oauthCapability(serviceId, spec, providerEnabled, env);
};
