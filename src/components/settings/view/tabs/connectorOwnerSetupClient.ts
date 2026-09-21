import { authenticatedFetch } from '../../../../utils/api';

export const CONNECTOR_OWNER_SETUP_ENDPOINT = '/api/connectors/v2/owner/setup';

export type OwnerSetupStep = 'origin' | 'trust' | 'provider_pack' | 'activation' | 'complete';
export type OwnerSetupCheck = {
  id: 'substrate' | 'origin' | 'trust' | 'pack' | 'activation';
  status: 'ok' | 'required' | 'blocked';
  code: string;
};
export type ActivationCandidate = {
  providerId: string;
  serviceId: string;
  operation: string;
  authMethod: string;
  certification: 'certified' | 'suspended';
  enabled: boolean;
  profileRequired: boolean;
  profileState: 'not_required' | 'missing' | 'ready' | 'stale';
  profileRevision: number | null;
  blockerCodes: string[];
};
export type ConnectorOwnerSetupStatus = {
  schemaVersion: 1;
  readyForAccountLinking: boolean;
  resumableStep: OwnerSetupStep;
  checks: OwnerSetupCheck[];
  origin: null | {
    installationId: string;
    canonicalOrigin: string;
    callbackUrl: string;
    originRevision: number;
  };
  trustBundleRevision: number;
  activePack: null | {
    issuer: string; channel: string; sequence: number; digest: string; expiresAt: string | null;
  };
  /** ISO-8601 expiry of the active global certification pack (T-1527/T-1532). */
  packExpiresAt: string | null;
  /** Non-empty when pack is expiring within the warning window or has already expired. */
  warnings: readonly ('pack_expiring_soon' | 'pack_expired')[];
  activationRecordRevision: number;
  activationCandidates: ActivationCandidate[];
};

export class ConnectorOwnerSetupRequestError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export type ConnectorOwnerProfileVerification = {
  providerId: string;
  profileState: 'ready' | 'stale' | 'missing';
  profileRevision: number;
  setupRevision: number;
};

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^[A-Za-z0-9_-]{20,128}$/u;
const STEPS = new Set<OwnerSetupStep>(['origin', 'trust', 'provider_pack', 'activation', 'complete']);
const CHECK_IDS = new Set(['substrate', 'origin', 'trust', 'pack', 'activation']);
const CHECK_STATES = new Set(['ok', 'required', 'blocked']);
const CERTIFICATIONS = new Set(['certified', 'suspended']);
const PROFILE_STATES = new Set(['not_required', 'missing', 'ready', 'stale']);
const exact = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const canonicalOrigin = (value: unknown): value is ConnectorOwnerSetupStatus['origin'] => {
  if (!record(value) || !exact(value, ['installationId', 'canonicalOrigin', 'callbackUrl', 'originRevision'])
    || !text(value.installationId, 128) || !ID.test(value.installationId)
    || !text(value.canonicalOrigin) || !text(value.callbackUrl)
    || !integer(value.originRevision) || value.originRevision < 1) return false;
  try {
    const parsed = new URL(value.canonicalOrigin);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    return parsed.origin === value.canonicalOrigin
      && (parsed.protocol === 'https:' || parsed.protocol === 'http:' && loopback)
      && value.callbackUrl === `${value.canonicalOrigin}/connectors/oauth/callback`;
  } catch { return false; }
};

const PACK_WARNINGS = new Set(['pack_expiring_soon', 'pack_expired']);

/** Strictly accepts only the secret-free owner status contract. */
export const parseConnectorOwnerSetupStatus = (raw: unknown): ConnectorOwnerSetupStatus | null => {
  if (!record(raw) || !exact(raw, ['schemaVersion', 'readyForAccountLinking', 'resumableStep',
    'checks', 'origin', 'trustBundleRevision', 'activePack', 'packExpiresAt', 'warnings',
    'activationRecordRevision', 'activationCandidates'])
    || raw.schemaVersion !== 1 || typeof raw.readyForAccountLinking !== 'boolean'
    || typeof raw.resumableStep !== 'string' || !STEPS.has(raw.resumableStep as OwnerSetupStep)
    || !Array.isArray(raw.checks) || (raw.origin !== null && !canonicalOrigin(raw.origin))
    || !integer(raw.trustBundleRevision) || !integer(raw.activationRecordRevision)
    || (raw.packExpiresAt !== null && typeof raw.packExpiresAt !== 'string')
    || !Array.isArray(raw.warnings)
    || raw.warnings.some((w: unknown) => typeof w !== 'string' || !PACK_WARNINGS.has(w))
    || new Set(raw.warnings).size !== raw.warnings.length) return null;
  const checks: OwnerSetupCheck[] = [];
  for (const candidate of raw.checks) {
    if (!record(candidate) || !exact(candidate, ['id', 'status', 'code'])
      || typeof candidate.id !== 'string' || !CHECK_IDS.has(candidate.id)
      || typeof candidate.status !== 'string' || !CHECK_STATES.has(candidate.status)
      || !text(candidate.code, 128)) return null;
    checks.push(candidate as OwnerSetupCheck);
  }
  if (checks.length !== CHECK_IDS.size || new Set(checks.map(check => check.id)).size !== checks.length) return null;
  const activePack = raw.activePack;
  if (activePack !== null && (!record(activePack)
    || !exact(activePack, ['issuer', 'channel', 'sequence', 'digest', 'expiresAt'])
    || !text(activePack.issuer, 128) || !text(activePack.channel, 64)
    || !integer(activePack.sequence) || activePack.sequence < 1
    || !text(activePack.digest, 128) || !DIGEST.test(activePack.digest)
    || (activePack.expiresAt !== null && typeof activePack.expiresAt !== 'string'))) return null;
  const activationCandidates: ActivationCandidate[] = [];
  if (raw.activationCandidates !== undefined) {
    if (!Array.isArray(raw.activationCandidates)) return null;
    const seen = new Set<string>();
    for (const candidate of raw.activationCandidates) {
      if (!record(candidate) || !exact(candidate, ['providerId', 'serviceId', 'operation', 'authMethod',
        'certification', 'enabled', 'profileRequired', 'profileState', 'profileRevision', 'blockerCodes'])
        || ![candidate.providerId, candidate.serviceId, candidate.operation]
        .every(value => typeof value === 'string' && ID.test(value))
        || typeof candidate.authMethod !== 'string' || !ID.test(candidate.authMethod)
        || typeof candidate.certification !== 'string' || !CERTIFICATIONS.has(candidate.certification)
        || typeof candidate.enabled !== 'boolean'
        || typeof candidate.profileRequired !== 'boolean'
        || typeof candidate.profileState !== 'string' || !PROFILE_STATES.has(candidate.profileState)
        || !(candidate.profileRevision === null
          || integer(candidate.profileRevision) && candidate.profileRevision > 0)
        || !Array.isArray(candidate.blockerCodes) || candidate.blockerCodes.length > 64
        || !candidate.blockerCodes.every(code => typeof code === 'string' && ID.test(code))
        || new Set(candidate.blockerCodes).size !== candidate.blockerCodes.length
        || candidate.certification === 'suspended' && candidate.enabled
        || candidate.profileRequired !== (candidate.profileState !== 'not_required')) return null;
      const key = `${candidate.providerId}\0${candidate.serviceId}\0${candidate.operation}`;
      if (seen.has(key)) return null;
      seen.add(key);
      activationCandidates.push(candidate as ActivationCandidate);
    }
  }
  return {
    schemaVersion: 1, readyForAccountLinking: raw.readyForAccountLinking,
    resumableStep: raw.resumableStep as OwnerSetupStep, checks,
    origin: raw.origin as ConnectorOwnerSetupStatus['origin'],
    trustBundleRevision: raw.trustBundleRevision,
    activePack: activePack as ConnectorOwnerSetupStatus['activePack'],
    packExpiresAt: raw.packExpiresAt as string | null,
    warnings: raw.warnings as ConnectorOwnerSetupStatus['warnings'],
    activationRecordRevision: raw.activationRecordRevision, activationCandidates,
  };
};

export const loadConnectorOwnerSetup = async (signal?: AbortSignal): Promise<ConnectorOwnerSetupStatus> => {
  const response = await authenticatedFetch(CONNECTOR_OWNER_SETUP_ENDPOINT, { signal });
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ConnectorOwnerSetupRequestError(
    record(raw) && text(raw.code, 128) ? raw.code : 'CONNECTOR_SETUP_UNAVAILABLE', response.status);
  const parsed = parseConnectorOwnerSetupStatus(raw);
  if (!parsed) throw new ConnectorOwnerSetupRequestError('CONNECTOR_SETUP_RESPONSE_INVALID', 502);
  return parsed;
};

type Mutation = 'origin' | 'trust/import' | 'packs/import' | 'activations';
export const mutateConnectorOwnerSetup = async (input: Readonly<{
  route: Mutation;
  method: 'PUT' | 'POST';
  expectedRevision: number;
  csrfToken: string;
  body: unknown;
  signal?: AbortSignal;
  idempotencyKey?: string;
}>): Promise<unknown> => {
  const response = await authenticatedFetch(`${CONNECTOR_OWNER_SETUP_ENDPOINT}/${input.route}`, {
    method: input.method, signal: input.signal,
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': input.csrfToken,
      'If-Match': `"${input.expectedRevision}"`,
      'Idempotency-Key': input.idempotencyKey ?? crypto.randomUUID() },
    body: JSON.stringify(input.body),
  });
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ConnectorOwnerSetupRequestError(
    record(raw) && text(raw.code, 128) ? raw.code : 'CONNECTOR_SETUP_UNAVAILABLE', response.status);
  return raw;
};

/** Configures an installation-shared sign-in profile without ever accepting a secret in a response. */
export const verifyConnectorOwnerProfile = async (input: Readonly<{
  providerId: string;
  expectedRevision: number;
  csrfToken: string;
  body: Readonly<{ method: 'dcr_pkce' }> | Readonly<{
    method: 'byo_app'; clientId: string; clientSecret: string;
  }>;
  signal?: AbortSignal;
  idempotencyKey?: string;
}>): Promise<ConnectorOwnerProfileVerification> => {
  if (!ID.test(input.providerId)) {
    throw new ConnectorOwnerSetupRequestError('CONNECTOR_PROFILE_PROVIDER_INVALID', 422);
  }
  const response = await authenticatedFetch(
    `${CONNECTOR_OWNER_SETUP_ENDPOINT}/profiles/${encodeURIComponent(input.providerId)}/verify`, {
      method: 'POST', signal: input.signal,
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': input.csrfToken,
        'If-Match': `"${input.expectedRevision}"`,
        'Idempotency-Key': input.idempotencyKey ?? crypto.randomUUID() },
      body: JSON.stringify(input.body),
    },
  );
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ConnectorOwnerSetupRequestError(
    record(raw) && text(raw.code, 128) ? raw.code : 'CONNECTOR_SETUP_UNAVAILABLE', response.status);
  if (!record(raw) || !exact(raw, ['providerId', 'profileState', 'profileRevision', 'setupRevision'])
    || raw.providerId !== input.providerId || !['ready', 'stale', 'missing'].includes(String(raw.profileState))
    || !integer(raw.profileRevision) || raw.profileRevision < 1
    || !integer(raw.setupRevision)) {
    throw new ConnectorOwnerSetupRequestError('CONNECTOR_SETUP_RESPONSE_INVALID', 502);
  }
  return raw as ConnectorOwnerProfileVerification;
};
