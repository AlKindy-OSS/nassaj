/**
 * Transport for the owner SSO settings API (ADR-194 D8), mounted at
 * /api/settings/sso. `authenticatedFetch` adds the bearer token and the
 * cookie-session CSRF material, like every other settings write.
 *
 * Every call resolves (never throws) to `{ ok: true, data }` or a coded
 * failure, so the UI can map the code to plain language.
 */
import { authenticatedFetch } from '../../../../../utils/api';

import type {
  SsoActionResult,
  SsoDiscoveryResult,
  SsoDraftForm,
  SsoStatus,
  SsoTestResult,
  StepUpEvidence,
} from './ssoTypes';

export const SSO_SETTINGS_PATH = '/api/settings/sso';

type Json = Record<string, unknown>;

async function call<T>(path: string, init?: RequestInit): Promise<SsoActionResult<T>> {
  let response: Response;
  try {
    response = await authenticatedFetch(`${SSO_SETTINGS_PATH}${path}`, init);
  } catch {
    return { ok: false, code: 'network', status: 0 };
  }
  const body = await response.json().catch(() => null) as Json | null;
  if (response.ok) return { ok: true, data: (body ?? {}) as T };
  const code = typeof body?.code === 'string' && body.code ? body.code : (response.status === 429 ? 'rate_limited' : 'internal_error');
  const seconds = Number(response.headers?.get?.('Retry-After'));
  const details = Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => key !== 'code' && key !== 'error'));
  return {
    ok: false, code, status: response.status, details,
    ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterSeconds: Math.ceil(seconds) } : {}),
  };
}

const post = <T>(path: string, body: Json = {}) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });
const put = <T>(path: string, body: Json) => call<T>(path, { method: 'PUT', body: JSON.stringify(body) });

/** Splits the tenant textarea into trimmed, non-empty values. */
export function tenantValuesOf(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** Builds the PUT /draft body from the form; the secret travels only when typed. */
export function draftBody(form: SsoDraftForm, expectedDraftVersion?: number): Json {
  const port = form.issuerPort.trim();
  const tenantClaimPath = form.tenantClaimPath.trim();
  const body: Json = {
    issuer: form.issuer.trim(),
    clientId: form.clientId.trim(),
    clientAuth: form.clientAuth,
    extraScopes: form.extraScopes.trim().replace(/\s+/g, ' '),
    roleClaimPath: form.roleClaimPath.trim(),
    roleRules: form.roleRules
      .map((rule) => ({ value: rule.value.trim(), role: rule.role }))
      .filter((rule) => rule.value !== ''),
    tenantMode: form.tenantMode,
    tenantClaimPath: form.tenantMode === 'claim' && tenantClaimPath ? tenantClaimPath : null,
    tenantValues: form.tenantMode === 'none' ? [] : tenantValuesOf(form.tenantValuesText),
    jitEnabled: form.tenantMode === 'none' ? false : form.jitEnabled,
    attestationMaxAgeHours: form.attestationMaxAgeHours,
    allowPrivateNetwork: form.allowPrivateNetwork,
    issuerPort: form.allowPrivateNetwork && port ? Number(port) : null,
  };
  if (form.clientAuth !== 'none' && form.clientSecret) body.clientSecret = form.clientSecret;
  if (form.clientAuth !== 'none' && !form.clientSecret && form.clearClientSecret) body.clearClientSecret = true;
  if (expectedDraftVersion !== undefined) body.expectedDraftVersion = expectedDraftVersion;
  return body;
}

export const ssoApi = {
  status: () => call<SsoStatus>('/'),
  saveDraft: (form: SsoDraftForm, expectedDraftVersion?: number, stepUp?: StepUpEvidence) =>
    put<{ draft: unknown }>('/draft', { ...draftBody(form, expectedDraftVersion), ...(stepUp ? { stepUp } : {}) }),
  testDiscovery: () => post<SsoDiscoveryResult>('/draft/test-discovery'),
  startTestLogin: () => post<{ authorizationUrl?: string }>('/draft/test-login/start'),
  testResult: (id: string) => call<{ result: SsoTestResult }>(`/draft/test-login/result/${encodeURIComponent(id)}`),
  apply: (body: {
    draftVersion: number; configHash: string; enable?: boolean;
    keepOrphanedSessions?: boolean; confirmation?: string; stepUp: StepUpEvidence;
  }) => post<{ applied: unknown }>('/apply', body),
  enable: (stepUp: StepUpEvidence) => post('/enable', { stepUp }),
  disable: (body: { keepLinkedSessions?: boolean; stepUp?: StepUpEvidence }) => post('/disable', body),
  importEnv: () => post<{ warnings?: Array<{ code: string; legacyRedirectUri?: string; redirectUri?: string }> }>('/import-env'),
  confirmOrigin: (origin: string, stepUp: StepUpEvidence) => put<{ origin: string }>('/installation-origin', { origin, stepUp }),
};
