import { PROVIDER_AUTH_SPECS, type ProviderAuthSpec } from '../../../shared/connector-auth-registry.js';

import {
  safeFetchProviderJson,
  type SafeProviderFetchDependencies,
} from './connector-auth-safe-fetch.js';

type ApiKeySpec = ProviderAuthSpec & { method: 'api_key' };
export type ConnectorApiKeyIdentityEvidence = Readonly<{
  providerSubject: string;
  identityKind: 'user' | 'account';
}>;
type ProbeParser = (
  response: Readonly<Record<string, unknown>>,
) => ConnectorApiKeyIdentityEvidence | null;

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parsers are deliberately provider-specific: HTTP 2xx alone never certifies a key. */
export const CERTIFIED_PROBES: Readonly<Record<string, ProbeParser>> = Object.freeze({
  github: response => positiveSafeInteger(response.id) && nonEmpty(response.login)
    ? { providerSubject: String(response.id), identityKind: 'user' }
    : null,
  slack: response => response.ok === true && nonEmpty(response.team_id) && nonEmpty(response.user_id)
    ? { providerSubject: `${response.team_id}:${response.user_id}`, identityKind: 'user' }
    : null,
  figma: response => nonEmpty(response.id) && nonEmpty(response.handle)
    ? { providerSubject: response.id, identityKind: 'user' }
    : null,
  wafeq: response => nonEmpty(response.id) && nonEmpty(response.name)
    ? { providerSubject: response.id, identityKind: 'account' }
    : null,
  stripe: response => response.object === 'account' && typeof response.id === 'string'
    && /^acct_[A-Za-z0-9]+$/u.test(response.id)
    ? { providerSubject: response.id, identityKind: 'account' }
    : null,
});

const certifiedProbeSpec = (spec: ApiKeySpec) => spec.serviceProbe.status === 'certified'
  && nonEmpty(spec.serviceProbe.endpoint)
  && (spec.serviceProbe.method === 'GET' || spec.serviceProbe.method === 'POST')
  && nonEmpty(spec.serviceProbe.credentialHeader)
  && typeof spec.serviceProbe.credentialPrefix === 'string';

/**
 * Executes a read-only, exact-endpoint credential probe through the pinned
 * transport. Credentials are never returned, logged, or persisted here.
 */
export const probeConnectorApiKeyCandidate = async (
  input: Readonly<{ spec: ApiKeySpec; apiKey: string }>,
  dependencies: SafeProviderFetchDependencies = {},
): Promise<ConnectorApiKeyIdentityEvidence> => {
  if (!PROVIDER_AUTH_SPECS.includes(input.spec)) {
    throw new Error('connector_api_key_probe_untrusted_spec');
  }
  const parse = CERTIFIED_PROBES[input.spec.profileId];
  if (!parse || !certifiedProbeSpec(input.spec)) {
    throw new Error('connector_api_key_probe_not_certified');
  }
  const probe = input.spec.serviceProbe;
  const response = await safeFetchProviderJson({
    spec: input.spec,
    endpoint: 'apiKeyProbe',
    method: probe.method,
    headers: {
      ...probe.staticHeaders,
      [probe.credentialHeader!]: `${probe.credentialPrefix!}${input.apiKey}`,
    },
  }, {
    ...dependencies,
    timeoutMs: Math.min(dependencies.timeoutMs ?? 5_000, 5_000),
    maxRedirects: 0,
    maxResponseBytes: Math.min(dependencies.maxResponseBytes ?? 32 * 1024, 32 * 1024),
  });
  const evidence = record(response) ? parse(response) : null;
  if (!evidence) {
    throw new Error('connector_api_key_candidate_rejected');
  }
  return evidence;
};
