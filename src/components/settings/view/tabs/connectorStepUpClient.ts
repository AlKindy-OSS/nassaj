/**
 * Connector recent-auth step-up — client transport (T-1939 slice 6C).
 *
 *   POST /api/connectors/owner-session/step-up  { stepUp } → 204
 *   POST /api/auth/oidc/step-up/start                      → { authorizationUrl }
 *
 * Local accounts prove themselves with their password or an eligible passkey.
 * SSO-linked members have no usable local password: they re-authenticate at
 * SSO, which returns to the SPA with a one-time grant (`?oidc_step_up=`)
 * that the return page redeems here as `{ method: 'oidc_grant', grant }`.
 *
 * The grant itself is never stored. Only two small, non-secret markers cross
 * the IdP round trip in sessionStorage: which connector view to reopen, and
 * the outcome code the return page observed.
 */

import { browserSupportsWebAuthn } from '@simplewebauthn/browser';

import { api, authenticatedFetch } from '../../../../utils/api';
import {
  CONNECTOR_STEP_UP_OUTCOME_KEY,
  CONNECTOR_STEP_UP_PENDING_KEY,
} from '../../../auth/connectorStepUpMarker';
import { OIDC_ERROR_PARAM } from '../../../auth/oidc';
import { isSsoRedirectInFlight } from '../../../auth/ssoReauth';
import {
  collectStepUpEvidence,
  type StepUpEvidence,
} from '../../../auth/hooks/useWebAuthn';

export type ConnectorStepUpEvidence = StepUpEvidence | { method: 'oidc_grant'; grant: string };
export type ConnectorStepUpResult =
  | { ok: true }
  | { ok: false; code: string; retryAfterSeconds?: number };
export type ConnectorReturnView = 'accounts' | 'installation';

export const CONNECTOR_STEP_UP_PATH = '/api/connectors/owner-session/step-up';
export const OIDC_STEP_UP_START_PATH = '/api/auth/oidc/step-up/start';
export const OIDC_STEP_UP_PARAM = 'oidc_step_up';
export const OIDC_STEP_UP_ERROR_PARAM = 'oidc_step_up_error';
export const CONNECTOR_SETTINGS_PATH = '/?settings=connectors';

const PENDING_KEY = CONNECTOR_STEP_UP_PENDING_KEY;
const OUTCOME_KEY = CONNECTOR_STEP_UP_OUTCOME_KEY;
/** A pending marker older than the IdP round trip is ignored. */
const PENDING_TTL_MS = 10 * 60_000;
/** An outcome the connectors tab did not read soon after the return is stale. */
const OUTCOME_TTL_MS = 2 * 60_000;
/** step-up/start includes IdP discovery; past this the member may retry. */
export const OIDC_STEP_UP_START_TIMEOUT_MS = 15_000;
/**
 * A navigation that has not unloaded the page by now was stopped (Esc, Stop)
 * or refused by the browser; a new attempt is allowed.
 */
const REDIRECT_IN_FLIGHT_MS = 15_000;
const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/u;

/**
 * Server codes meaning "this connector write needs a fresh step-up" — distinct
 * from CONNECTOR_ORIGIN_REJECTED, which no password can fix.
 */
export const CONNECTOR_RECENT_AUTH_CODES: ReadonlySet<string> = new Set([
  'CONNECTOR_RECENT_AUTH_REQUIRED',
  'CONNECTOR_CSRF_REJECTED',
  'CONNECTOR_RECENT_AUTH_OR_CSRF_REQUIRED',
  'CONNECTOR_SETUP_RECENT_AUTH_OR_CSRF_REQUIRED',
  'CONNECTOR_PROVISIONING_RECENT_AUTH_OR_CSRF_REQUIRED',
]);

const readCode = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { code?: unknown };
    return typeof body?.code === 'string' && body.code ? body.code : 'step_up_unavailable';
  } catch {
    return 'step_up_unavailable';
  }
};

const retryAfter = (response: Response): number | undefined => {
  const seconds = Number(response.headers?.get?.('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
};

/** Presents step-up evidence; 204 means both connector cookies were set. */
export async function submitConnectorStepUp(
  stepUp: ConnectorStepUpEvidence,
  signal?: AbortSignal,
): Promise<ConnectorStepUpResult> {
  try {
    const response = await authenticatedFetch(CONNECTOR_STEP_UP_PATH, {
      method: 'POST', body: JSON.stringify({ stepUp }), signal,
    });
    if (response.status === 204 || response.ok) return { ok: true };
    const code = await readCode(response);
    const seconds = retryAfter(response);
    return seconds ? { ok: false, code, retryAfterSeconds: seconds } : { ok: false, code };
  } catch {
    return { ok: false, code: 'network' };
  }
}

/** Whether this browser can run a passkey ceremony at all. */
export function passkeysSupported(): boolean {
  try { return browserSupportsWebAuthn(); } catch { return false; }
}

/** Runs the passkey ceremony for the connector audience, then presents it. */
export async function submitConnectorPasskeyStepUp(): Promise<ConnectorStepUpResult> {
  const collected = await collectStepUpEvidence({ method: 'passkey' }, 'connector_owner');
  if (!collected.ok) {
    const { failure } = collected;
    if (failure.kind === 'cancelled') return { ok: false, code: 'passkey_cancelled' };
    if (failure.kind === 'network') return { ok: false, code: 'network' };
    // The server's generic step_up_failed would read as "wrong password".
    const code = !failure.code || failure.code === 'step_up_failed' ? 'passkey_failed' : failure.code;
    return failure.retryAfterSeconds
      ? { ok: false, code, retryAfterSeconds: failure.retryAfterSeconds }
      : { ok: false, code };
  }
  const result = await submitConnectorStepUp(collected.evidence);
  return !result.ok && result.code === 'step_up_failed' ? { ...result, code: 'passkey_failed' } : result;
}

export type StepUpMethod = 'local' | 'sso';

/**
 * Which step-up the server will accept. Mirrors `requiresSsoLogin(user)` in
 * server/services/sso-only-policy.js: the owner always stays local (emergency
 * access) even when linked; any other linked member must use SSO. A future
 * `ssoStepUp` boolean in the link-status body is the server's own answer and
 * wins. Keep in step with that function (parity test in the client tests).
 */
export function stepUpMethodFor(
  { linked, ssoStepUp, role }: { linked?: unknown; ssoStepUp?: unknown; role?: string | null },
): StepUpMethod | null {
  if (typeof ssoStepUp === 'boolean') return ssoStepUp ? 'sso' : 'local';
  if (role === 'owner') return 'local';
  return typeof linked === 'boolean' ? (linked ? 'sso' : 'local') : null;
}

/**
 * The step-up method for the caller, or `null` when SSO is off (501) or the
 * status cannot be read — the dialog then offers the local methods and
 * switches if the server answers `sso_step_up_required`.
 */
export async function loadStepUpMethod(
  role: string | null | undefined,
  signal?: AbortSignal,
): Promise<StepUpMethod | null> {
  if (role === 'owner') return 'local';
  try {
    const response = await api.auth.oidc.selfLinkStatus({ signal });
    if (signal?.aborted || !response.ok) return null;
    const body = await response.json() as { linked?: unknown; ssoStepUp?: unknown };
    return stepUpMethodFor({ linked: body?.linked, ssoStepUp: body?.ssoStepUp, role });
  } catch {
    return null;
  }
}

// When the IdP navigation started; the page normally unloads with it. Cleared
// on a back/forward-cache restore or a failed start, and ignored once old.
let stepUpRedirectStartedAt: number | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (event) => {
    if ((event as PageTransitionEvent).persisted) stepUpRedirectStartedAt = null;
  });
}

const redirectInFlight = (now: number): boolean =>
  stepUpRedirectStartedAt !== null && now - stepUpRedirectStartedAt < REDIRECT_IN_FLIGHT_MS;

/** Test seam: forget a pending IdP navigation (module state outlives a test). */
export function resetConnectorStepUpRedirect(): void {
  stepUpRedirectStartedAt = null;
}

type StartDeps = {
  assign?: (url: string) => void;
  /** The dialog's Cancel: aborts the request and forbids the navigation. */
  signal?: AbortSignal;
  storage?: Storage | null;
  timeoutMs?: number;
};

const sessionStore = (storage?: Storage | null): Storage | null => {
  if (storage !== undefined) return storage;
  try { return window.sessionStorage; } catch { return null; }
};

/** https only; plain http is accepted only when the SPA itself runs on http (local dev). */
export const isNavigableUrl = (raw: unknown, pageProtocol = window.location.protocol): raw is string => {
  if (typeof raw !== 'string' || !raw) return false;
  const allowed = pageProtocol === 'http:' ? ['https:', 'http:'] : ['https:'];
  try { return allowed.includes(new URL(raw, window.location.origin).protocol); } catch { return false; }
};

export type OidcStepUpStart =
  | { ok: true; outcome: 'redirected' | 'in_flight' }
  | { ok: false; code: string; retryAfterSeconds?: number };

const CANCELLED: OidcStepUpStart = { ok: false, code: 'cancelled' };

/**
 * Starts "Confirm with SSO": asks the server for the IdP URL, records the
 * view to reopen, and leaves the SPA. `in_flight` means another SSO navigation
 * (this one or an SSO re-attestation) already started; the caller waits. Once
 * `signal` aborts (Cancel), no marker is written and no navigation starts:
 * the result is `cancelled`.
 */
export async function startConnectorOidcStepUp(
  view: ConnectorReturnView,
  { assign = url => window.location.assign(url), signal, storage, timeoutMs = OIDC_STEP_UP_START_TIMEOUT_MS }: StartDeps = {},
): Promise<OidcStepUpStart> {
  if (signal?.aborted) return CANCELLED;
  if (redirectInFlight(Date.now()) || isSsoRedirectInFlight()) return { ok: true, outcome: 'in_flight' };
  stepUpRedirectStartedAt = Date.now();
  const abort = new AbortController();
  const onCancel = () => abort.abort();
  signal?.addEventListener('abort', onCancel, { once: true });
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await authenticatedFetch(OIDC_STEP_UP_START_PATH, {
      method: 'POST', body: '{}', signal: abort.signal,
    });
    if (!response.ok) {
      stepUpRedirectStartedAt = null;
      const seconds = retryAfter(response);
      const code = await readCode(response);
      return seconds ? { ok: false, code, retryAfterSeconds: seconds } : { ok: false, code };
    }
    const body = await response.json() as { authorizationUrl?: unknown };
    if (signal?.aborted) {
      stepUpRedirectStartedAt = null;
      return CANCELLED;
    }
    if (!isNavigableUrl(body?.authorizationUrl)) {
      stepUpRedirectStartedAt = null;
      return { ok: false, code: 'step_up_unavailable' };
    }
    try {
      sessionStore(storage)?.setItem(PENDING_KEY, JSON.stringify({ view, at: Date.now() }));
    } catch { /* The round trip still works; the accounts view reopens. */ }
    stepUpRedirectStartedAt = Date.now();
    assign(body.authorizationUrl);
    return { ok: true, outcome: 'redirected' };
  } catch {
    stepUpRedirectStartedAt = null;
    if (signal?.aborted) return CANCELLED;
    return { ok: false, code: abort.signal.aborted ? 'step_up_timeout' : 'network' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCancel);
  }
}

/** True when this tab started a SSO step-up in the last ten minutes. */
export function hasPendingConnectorStepUp(storage?: Storage | null, now = Date.now()): boolean {
  try {
    const raw = sessionStore(storage)?.getItem(PENDING_KEY);
    const at = raw ? Number((JSON.parse(raw) as { at?: unknown }).at) : NaN;
    return Number.isFinite(at) && now - at >= 0 && now - at < PENDING_TTL_MS;
  } catch {
    return false;
  }
}

/** What a SSO step-up return carries: a one-time grant or a refusal code. */
export type StepUpReturn = { grant: string } | { errorCode: string };

/**
 * Refusal codes the server's step-up callback may put in `?oidc_step_up_error=`
 * (server/routes/oidc.js). Anything else in a URL is someone else's text and
 * becomes `step_up_unavailable`; no URL value can mean "verified".
 */
export const OIDC_STEP_UP_RETURN_ERROR_CODES: ReadonlySet<string> = new Set([
  'oidc_reauth_required',
  'oidc_step_up_identity_mismatch',
  'oidc_duplicate_links',
  'oidc_not_authorized',
  'account_unavailable',
  'temporarily_unavailable',
  'provider_denied',
]);

const returnErrorCode = (raw: string): string =>
  OIDC_STEP_UP_RETURN_ERROR_CODES.has(raw) ? raw : 'step_up_unavailable';

/**
 * Classifies the return URL. A plain IdP `error` counts as a step-up refusal
 * only when this tab started a connector step-up moments ago; otherwise it is
 * an ordinary sign-in failure for the login return page.
 */
export function readStepUpReturn(params: URLSearchParams): StepUpReturn | null {
  const grant = params.get(OIDC_STEP_UP_PARAM);
  if (grant) return { grant };
  const errorCode = params.get(OIDC_STEP_UP_ERROR_PARAM);
  if (errorCode) return { errorCode: returnErrorCode(errorCode) };
  if (params.get(OIDC_ERROR_PARAM) && hasPendingConnectorStepUp()) return { errorCode: 'provider_denied' };
  return null;
}

/**
 * A verified outcome only ever comes from a 204 on the grant redemption; a
 * refusal carries its code. The two shapes never mix.
 */
export type ConnectorStepUpOutcome = Readonly<
  | { verified: true; view: ConnectorReturnView }
  | { verified: false; code: string; view: ConnectorReturnView }
>;
export type ConnectorStepUpOutcomeInput = { verified: true } | { verified: false; code: string };

/** Recorded by the return page; read once by the connectors tab. */
export function recordConnectorStepUpOutcome(
  outcome: ConnectorStepUpOutcomeInput,
  storage?: Storage | null,
  now = Date.now(),
): void {
  const store = sessionStore(storage);
  try {
    const raw = store?.getItem(PENDING_KEY);
    const view = raw && (JSON.parse(raw) as { view?: unknown }).view === 'installation'
      ? 'installation' : 'accounts';
    store?.removeItem(PENDING_KEY);
    const record = outcome.verified
      ? { verified: true, view, at: now }
      : { verified: false, code: SAFE_CODE.test(outcome.code) ? outcome.code : 'step_up_unavailable', view, at: now };
    store?.setItem(OUTCOME_KEY, JSON.stringify(record));
  } catch { /* Without storage the tab simply refetches readiness. */ }
}

/** Reads and clears the one-shot, short-lived outcome of a SSO step-up. */
export function consumeConnectorStepUpOutcome(
  storage?: Storage | null,
  now = Date.now(),
): ConnectorStepUpOutcome | null {
  const store = sessionStore(storage);
  try {
    const raw = store?.getItem(OUTCOME_KEY);
    if (!raw) return null;
    store?.removeItem(OUTCOME_KEY);
    const parsed = JSON.parse(raw) as { verified?: unknown; code?: unknown; view?: unknown; at?: unknown };
    const at = Number(parsed.at);
    if (!Number.isFinite(at) || now - at < 0 || now - at >= OUTCOME_TTL_MS) return null;
    const view = parsed.view === 'installation' ? 'installation' : 'accounts';
    if (parsed.verified === true) return { verified: true, view };
    if (parsed.verified !== false || typeof parsed.code !== 'string' || !SAFE_CODE.test(parsed.code)) return null;
    return { verified: false, code: parsed.code, view };
  } catch {
    return null;
  }
}

/**
 * i18n key, relative to `connectorsSettings.stepUp` (settings namespace), for
 * a refusal. Unknown codes fall back to a generic message; the raw code is
 * shown beside it for support.
 */
const ERROR_KEYS: Readonly<Record<string, string>> = {
  AUTH_REQUIRED: 'sessionEnded',
  CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED: 'originUnconfigured',
  CONNECTOR_ORIGIN_REJECTED: 'originRejected',
  CONNECTOR_RECENT_AUTH_UNAVAILABLE: 'unavailable',
  step_up_unavailable: 'unavailable',
  temporarily_unavailable: 'unavailable',
  step_up_failed: 'failed',
  sso_grant_failed: 'ssoGrantFailed',
  step_up_invalid_request: 'failed',
  step_up_required: 'failed',
  passkey_failed: 'passkeyFailed',
  no_eligible_passkey: 'noEligiblePasskey',
  passkey_cancelled: 'passkeyCancelled',
  password_change_required: 'passwordChangeRequired',
  step_up_rate_limited: 'rateLimited',
  sso_step_up_required: 'ssoRequired',
  sso_step_up_not_applicable: 'ssoNotApplicable',
  step_up_timeout: 'timeout',
  oidc_reauth_required: 'ssoNotFresh',
  oidc_step_up_identity_mismatch: 'ssoIdentityMismatch',
  oidc_duplicate_links: 'ssoDuplicateLinks',
  oidc_not_authorized: 'ssoNotAuthorized',
  account_unavailable: 'ssoAccountUnavailable',
  provider_denied: 'ssoProviderDenied',
  network: 'network',
};

/** Own keys only: `constructor`, `toString`, `__proto__` are unknown codes. */
export function connectorStepUpErrorKey(code: string): string {
  return `errors.${Object.prototype.hasOwnProperty.call(ERROR_KEYS, code) ? ERROR_KEYS[code] : 'generic'}`;
}

/** Refusals no password or passkey can fix: the form is hidden for them. */
export const ORIGIN_PROBLEM_CODES: ReadonlySet<string> = new Set([
  'CONNECTOR_ORIGIN_REJECTED', 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED',
]);
