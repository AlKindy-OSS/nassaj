/**
 * B-1076: one classification and one structured log for every permission-admission failure,
 * shared by the WebSocket chat, btw side-query and REST launch entrypoints.
 *
 * Codes are normalized through a FIXED table. Only the two permanent refusals change their
 * transport semantics (409, not retryable); every other known admission code keeps its code
 * and the 503/retryable behavior it already had, and any unknown code collapses to
 * `permission_admission_unavailable` so raw storage errors never reach a client.
 */

export type AdmissionFenceScopeKind = 'session' | 'user_provider_purpose' | 'generation';

/** Client-safe fence hint: the refusing scope kind and its recorded reason, nothing else. */
export type AdmissionFenceHint = Readonly<{ scopeKind: AdmissionFenceScopeKind; reasonCode: string }>;

export type AdmissionFailureClassification = Readonly<{
  code: string;
  retryable: boolean;
  httpStatus: 409 | 503;
  fence?: AdmissionFenceHint;
}>;

export type AdmissionFailureContext = Readonly<{
  entrypoint: string;
  sessionId?: string | null;
  userId?: number | string | null;
  provider?: string | null;
  purpose?: string | null;
}>;

export const PERMISSION_ADMISSION_UNAVAILABLE = 'permission_admission_unavailable';

const PERMANENT_CODES: ReadonlySet<string> = new Set(['effect_scope_fenced', 'generation_blocked']);

/** Admission codes already surfaced to clients before B-1076; they keep 503 + retryable. */
const KNOWN_TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'generation_transitioning',
  'actor_revoked_or_stale',
  'identity_stale',
  'device_identity_stale',
  'actor_authenticated_at_invalid',
  'actor_authentication_kind_invalid',
  'actor_authorization_generation_invalid',
  'actor_credential_id_invalid',
  'actor_credential_id_required',
  'actor_device_binding_invalid',
  'actor_id_invalid',
  'actor_inactive',
  'actor_role_invalid',
  'platform_actor_unverified',
  'invalid_decisionid',
  'invalid_decision_id',
  'invalid_denial',
  'invalid_leaseid',
  'invalid_principalid',
  'invalid_launchid',
  'invalid_projectid',
  'invalid_provider',
  'invalid_body',
  'invalid_engine',
  'invalid_entrypoint',
  'invalid_ownerid',
  'invalid_effectidentity',
  'invalid_workspace',
  'invalid_user_id',
  'invalid_authorization_generation',
  'invalid_device_binding',
  'invalid_protocol_generation',
  'invalid_lease_expiry',
  'invalid_effect_scope',
  PERMISSION_ADMISSION_UNAVAILABLE,
]);

const SCOPE_KINDS: ReadonlySet<string> = new Set(['session', 'user_provider_purpose', 'generation']);
const REASON_CODE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_LOGGED_MESSAGE = 200;
const MAX_LOGGED_CLIENT_FIELD = 128;

const readProperty = (value: unknown, key: string): unknown => {
  try {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
};

const rawErrorCode = (error: unknown): string | null => {
  const code = readProperty(error, 'code');
  return typeof code === 'string' && code ? code : null;
};

/**
 * Extracts the refusing scope carried on the error. Never throws: an unreadable or malformed
 * hint yields undefined and can never change the classified code or retry decision.
 */
export const extractAdmissionFence = (error: unknown): AdmissionFenceHint | undefined => {
  const fence = readProperty(error, 'fence');
  const scopeKind = readProperty(fence, 'scopeKind');
  const reasonCode = readProperty(fence, 'reasonCode');
  if (typeof scopeKind !== 'string' || !SCOPE_KINDS.has(scopeKind)) return undefined;
  if (typeof reasonCode !== 'string' || !REASON_CODE_PATTERN.test(reasonCode)) return undefined;
  return Object.freeze({ scopeKind: scopeKind as AdmissionFenceScopeKind, reasonCode });
};

/** Maps any admission failure to its client code, retry decision, HTTP status and fence hint. */
export const classifyAdmissionFailure = (error: unknown): AdmissionFailureClassification => {
  const normalized = rawErrorCode(error)?.toLowerCase() ?? PERMISSION_ADMISSION_UNAVAILABLE;
  if (PERMANENT_CODES.has(normalized)) {
    const fence = extractAdmissionFence(error);
    return Object.freeze({
      code: normalized, retryable: false, httpStatus: 409, ...(fence ? { fence } : {}),
    });
  }
  const code = KNOWN_TRANSIENT_CODES.has(normalized) ? normalized : PERMISSION_ADMISSION_UNAVAILABLE;
  return Object.freeze({ code, retryable: true, httpStatus: 503 });
};

const safeMessage = (error: unknown): string | null => {
  const message = readProperty(error, 'message');
  if (typeof message !== 'string') return null;
  return message.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, MAX_LOGGED_MESSAGE);
};

/** Bounds a possibly client-supplied log field: control characters stripped, 128 chars max. */
const boundedField = (value: unknown): string | number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, MAX_LOGGED_CLIENT_FIELD);
};

/**
 * Emits exactly one structured warn line for an admission failure and returns its
 * classification. Logs identifiers and codes only: never a prompt, body or scope key.
 */
export const reportAdmissionFailure = (
  context: AdmissionFailureContext,
  error: unknown,
  log: (line: string) => void = (line) => console.warn(line),
): AdmissionFailureClassification => {
  const classification = classifyAdmissionFailure(error);
  const entry = {
    event: 'permission_admission_failed',
    code: classification.code,
    retryable: classification.retryable,
    originalCode: rawErrorCode(error),
    originalMessage: safeMessage(error),
    entrypoint: boundedField(context.entrypoint),
    sessionId: boundedField(context.sessionId),
    userId: boundedField(context.userId),
    provider: boundedField(context.provider),
    purpose: boundedField(context.purpose),
    ...(classification.fence ? {
      fenceScopeKind: classification.fence.scopeKind,
      fenceReasonCode: classification.fence.reasonCode,
    } : {}),
  };
  try {
    log(JSON.stringify(entry));
  } catch {
    // Logging must never change the fail-closed response.
  }
  return classification;
};

/** Fields every transport adds to its not-started failure payload. */
export const admissionFailurePayload = (
  classification: AdmissionFailureClassification,
): Readonly<{ code: string; retryable: boolean; fence?: AdmissionFenceHint }> => Object.freeze({
  code: classification.code,
  retryable: classification.retryable,
  ...(classification.fence ? { fence: classification.fence } : {}),
});

type JsonResponse = { status: (code: number) => { json: (body: unknown) => unknown } };

/**
 * REST entrypoints: logs the failure once and answers with the classified status and the
 * shared not-started body `{ error, code, retryable, fence?, notStarted }`.
 */
export const sendAdmissionFailureResponse = (
  res: JsonResponse,
  context: AdmissionFailureContext,
  error: unknown,
): unknown => {
  const failure = reportAdmissionFailure(context, error);
  return res.status(failure.httpStatus).json({
    error: 'Permission admission failed closed.',
    ...admissionFailurePayload(failure),
    notStarted: true,
  });
};
