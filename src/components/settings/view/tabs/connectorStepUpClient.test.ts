/** T-1939 slice 6C: connector step-up transport and the SSO round-trip markers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  collectStepUpEvidence: vi.fn(),
  ssoInFlight: vi.fn(() => false),
  selfLinkStatus: vi.fn(),
}));
vi.mock('../../../../utils/api', () => ({
  api: { auth: { oidc: { selfLinkStatus: mocks.selfLinkStatus } } },
  authenticatedFetch: mocks.authenticatedFetch,
}));
vi.mock('../../../auth/ssoReauth', () => ({ isSsoRedirectInFlight: mocks.ssoInFlight }));
vi.mock('../../../auth/hooks/useWebAuthn', () => ({ collectStepUpEvidence: mocks.collectStepUpEvidence }));

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  clearConnectorStepUpState,
  clearPendingConnectorStepUp,
} from '../../../auth/connectorStepUpMarker';

import {
  CONNECTOR_RECENT_AUTH_CODES,
  consumeConnectorStepUpOutcome,
  hasPendingConnectorStepUp,
  isNavigableUrl,
  loadStepUpMethod,
  OIDC_STEP_UP_RETURN_ERROR_CODES,
  readStepUpReturn,
  stepUpMethodFor,
  recordConnectorStepUpOutcome,
  resetConnectorStepUpRedirect,
  startConnectorOidcStepUp,
  submitConnectorPasskeyStepUp,
  submitConnectorStepUp,
} from './connectorStepUpClient';

const json = (status: number, body: unknown, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
  mocks.authenticatedFetch.mockReset();
  mocks.collectStepUpEvidence.mockReset();
  mocks.ssoInFlight.mockReturnValue(false);
  mocks.selfLinkStatus.mockReset();
  resetConnectorStepUpRedirect();
  window.sessionStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe('submitConnectorStepUp', () => {
  it('posts the evidence and treats 204 as success', async () => {
    mocks.authenticatedFetch.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await submitConnectorStepUp({ method: 'password', password: 'p' })).toEqual({ ok: true });
    const [url, init] = mocks.authenticatedFetch.mock.calls[0];
    expect(url).toBe('/api/connectors/owner-session/step-up');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ stepUp: { method: 'password', password: 'p' } });
  });

  it('returns the refusal code and Retry-After', async () => {
    mocks.authenticatedFetch.mockResolvedValue(json(429, { code: 'step_up_rate_limited' }, { 'Retry-After': '30' }));
    expect(await submitConnectorStepUp({ method: 'password', password: 'p' }))
      .toEqual({ ok: false, code: 'step_up_rate_limited', retryAfterSeconds: 30 });
  });

  it('classifies a body without a code and a network failure', async () => {
    mocks.authenticatedFetch.mockResolvedValueOnce(new Response('oops', { status: 500 }));
    expect(await submitConnectorStepUp({ method: 'oidc_grant', grant: 'g' }))
      .toEqual({ ok: false, code: 'step_up_unavailable' });
    mocks.authenticatedFetch.mockRejectedValueOnce(new TypeError('offline'));
    expect(await submitConnectorStepUp({ method: 'oidc_grant', grant: 'g' })).toEqual({ ok: false, code: 'network' });
  });
});

describe('submitConnectorPasskeyStepUp', () => {
  it('collects evidence for the connector audience and presents it', async () => {
    mocks.collectStepUpEvidence.mockResolvedValue({ ok: true, evidence: { method: 'passkey', response: { id: 'a' } } });
    mocks.authenticatedFetch.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await submitConnectorPasskeyStepUp()).toEqual({ ok: true });
    expect(mocks.collectStepUpEvidence).toHaveBeenCalledWith({ method: 'passkey' }, 'connector_owner');
    expect(JSON.parse(String(mocks.authenticatedFetch.mock.calls[0][1]?.body)))
      .toEqual({ stepUp: { method: 'passkey', response: { id: 'a' } } });
  });

  it('maps a cancelled ceremony and a server refusal', async () => {
    mocks.collectStepUpEvidence.mockResolvedValueOnce({ ok: false, failure: { success: false, kind: 'cancelled' } });
    expect(await submitConnectorPasskeyStepUp()).toEqual({ ok: false, code: 'passkey_cancelled' });
    mocks.collectStepUpEvidence.mockResolvedValueOnce({ ok: false, failure: { success: false, kind: 'stepUp', code: 'no_eligible_passkey' } });
    expect(await submitConnectorPasskeyStepUp()).toEqual({ ok: false, code: 'no_eligible_passkey' });
    // A failed passkey never reads as "check your password".
    mocks.collectStepUpEvidence.mockResolvedValueOnce({ ok: false, failure: { success: false, kind: 'stepUp', code: 'step_up_failed' } });
    expect(await submitConnectorPasskeyStepUp()).toEqual({ ok: false, code: 'passkey_failed' });
    expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
  });

  it('reports a server-refused passkey as passkey_failed, not a wrong password', async () => {
    mocks.collectStepUpEvidence.mockResolvedValueOnce({ ok: true, evidence: { method: 'passkey', response: { id: 'a' } } });
    mocks.authenticatedFetch.mockResolvedValueOnce(json(401, { code: 'step_up_failed' }));
    expect(await submitConnectorPasskeyStepUp()).toEqual({ ok: false, code: 'passkey_failed' });
  });

  it('keeps the Retry-After of a rate-limited passkey options request', async () => {
    mocks.collectStepUpEvidence.mockResolvedValueOnce({
      ok: false, failure: { success: false, kind: 'stepUp', code: 'step_up_rate_limited', retryAfterSeconds: 60 },
    });
    expect(await submitConnectorPasskeyStepUp())
      .toEqual({ ok: false, code: 'step_up_rate_limited', retryAfterSeconds: 60 });
  });
});

describe('startConnectorOidcStepUp', () => {
  it('records the view to reopen, then leaves for the IdP exactly once', async () => {
    mocks.authenticatedFetch.mockResolvedValue(json(200, { authorizationUrl: 'https://idp.example/authorize?x=1' }));
    const assign = vi.fn();
    expect(await startConnectorOidcStepUp('installation', { assign })).toEqual({ ok: true, outcome: 'redirected' });
    expect(assign).toHaveBeenCalledWith('https://idp.example/authorize?x=1');
    expect(mocks.authenticatedFetch.mock.calls[0][0]).toBe('/api/auth/oidc/step-up/start');
    expect(hasPendingConnectorStepUp()).toBe(true);

    expect(await startConnectorOidcStepUp('installation', { assign })).toEqual({ ok: true, outcome: 'in_flight' });
    expect(assign).toHaveBeenCalledOnce();
  });

  it('does not start while an SSO re-attestation navigation is in flight', async () => {
    mocks.ssoInFlight.mockReturnValue(true);
    expect(await startConnectorOidcStepUp('accounts', { assign: vi.fn() })).toEqual({ ok: true, outcome: 'in_flight' });
    expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
  });

  it('surfaces a refusal and allows another attempt', async () => {
    mocks.authenticatedFetch.mockResolvedValueOnce(json(409, { code: 'sso_step_up_not_applicable' }));
    expect(await startConnectorOidcStepUp('accounts', { assign: vi.fn() }))
      .toEqual({ ok: false, code: 'sso_step_up_not_applicable' });
    mocks.authenticatedFetch.mockResolvedValueOnce(json(200, { authorizationUrl: 'javascript:alert(1)' }));
    expect(await startConnectorOidcStepUp('accounts', { assign: vi.fn() }))
      .toEqual({ ok: false, code: 'step_up_unavailable' });
    expect(hasPendingConnectorStepUp()).toBe(false);
  });
});

describe('startConnectorOidcStepUp — Cancel', () => {
  it('never navigates nor leaves a pending marker once Cancel aborts a pending start', async () => {
    let release: (response: Response) => void = () => {};
    mocks.authenticatedFetch.mockImplementation((_url, init) => new Promise((resolve, reject) => {
      release = resolve;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const assign = vi.fn();
    const cancel = new AbortController();
    const pending = startConnectorOidcStepUp('accounts', { assign, signal: cancel.signal });
    cancel.abort();
    release(json(200, { authorizationUrl: 'https://idp.example/authorize' }));
    expect(await pending).toEqual({ ok: false, code: 'cancelled' });
    expect(assign).not.toHaveBeenCalled();
    expect(hasPendingConnectorStepUp()).toBe(false);
    // Cancel frees the next attempt instead of reporting it as in flight.
    mocks.authenticatedFetch.mockResolvedValueOnce(json(200, { authorizationUrl: 'https://idp.example/authorize' }));
    expect(await startConnectorOidcStepUp('accounts', { assign })).toEqual({ ok: true, outcome: 'redirected' });
  });

  it('honours a Cancel that lands after the response but before the body is read', async () => {
    const cancel = new AbortController();
    const response = json(200, { authorizationUrl: 'https://idp.example/authorize' });
    const read = response.json.bind(response);
    response.json = async () => { cancel.abort(); return read(); };
    mocks.authenticatedFetch.mockResolvedValueOnce(response);
    const assign = vi.fn();
    expect(await startConnectorOidcStepUp('accounts', { assign, signal: cancel.signal }))
      .toEqual({ ok: false, code: 'cancelled' });
    expect(assign).not.toHaveBeenCalled();
    expect(hasPendingConnectorStepUp()).toBe(false);
  });

  it('does not even ask the server when already cancelled', async () => {
    const cancel = new AbortController();
    cancel.abort();
    expect(await startConnectorOidcStepUp('accounts', { assign: vi.fn(), signal: cancel.signal }))
      .toEqual({ ok: false, code: 'cancelled' });
    expect(mocks.authenticatedFetch).not.toHaveBeenCalled();
  });
});

describe('authorize URL scheme', () => {
  it('accepts only https on an https page, and http only in local http development', () => {
    expect(isNavigableUrl('https://idp.example/a', 'https:')).toBe(true);
    expect(isNavigableUrl('http://idp.example/a', 'https:')).toBe(false);
    expect(isNavigableUrl('http://localhost:9000/a', 'http:')).toBe(true);
    expect(isNavigableUrl('javascript:alert(1)', 'http:')).toBe(false);
    expect(isNavigableUrl('', 'https:')).toBe(false);
  });
});

describe('startConnectorOidcStepUp — never stuck', () => {
  it('gives up on a hanging start request after the timeout', async () => {
    mocks.authenticatedFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    expect(await startConnectorOidcStepUp('accounts', { assign: vi.fn(), timeoutMs: 10 }))
      .toEqual({ ok: false, code: 'step_up_timeout' });
    mocks.authenticatedFetch.mockResolvedValueOnce(json(200, { authorizationUrl: 'https://idp.example/a' }));
    expect(await startConnectorOidcStepUp('accounts', { assign: vi.fn() })).toEqual({ ok: true, outcome: 'redirected' });
  });

  it('allows a new attempt once a stopped navigation has gone stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    mocks.authenticatedFetch.mockImplementation(async () => json(200, { authorizationUrl: 'https://idp.example/a' }));
    const assign = vi.fn();
    await startConnectorOidcStepUp('accounts', { assign });
    expect(await startConnectorOidcStepUp('accounts', { assign })).toEqual({ ok: true, outcome: 'in_flight' });
    vi.setSystemTime(Date.now() + 16_000);
    expect(await startConnectorOidcStepUp('accounts', { assign })).toEqual({ ok: true, outcome: 'redirected' });
    expect(assign).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight flag on a back/forward-cache restore', async () => {
    mocks.authenticatedFetch.mockImplementation(async () => json(200, { authorizationUrl: 'https://idp.example/a' }));
    const assign = vi.fn();
    await startConnectorOidcStepUp('accounts', { assign });
    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    expect(await startConnectorOidcStepUp('accounts', { assign })).toEqual({ ok: true, outcome: 'redirected' });
  });
});

describe('step-up method', () => {
  const linked = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('keeps a linked owner local without asking the server', async () => {
    mocks.selfLinkStatus.mockResolvedValue(linked({ linked: true }));
    expect(await loadStepUpMethod('owner')).toBe('local');
    expect(mocks.selfLinkStatus).not.toHaveBeenCalled();
  });

  it('sends a linked member to SSO and an unlinked one to local', async () => {
    mocks.selfLinkStatus.mockResolvedValueOnce(linked({ linked: true }));
    expect(await loadStepUpMethod('member')).toBe('sso');
    mocks.selfLinkStatus.mockResolvedValueOnce(linked({ linked: false }));
    expect(await loadStepUpMethod(null)).toBe('local');
    mocks.selfLinkStatus.mockResolvedValueOnce(new Response('{}', { status: 501 }));
    expect(await loadStepUpMethod(null)).toBeNull();
  });

  it('uses the server ssoStepUp answer from /link/self and passes the abort signal', async () => {
    const abort = new AbortController();
    mocks.selfLinkStatus.mockResolvedValueOnce(linked({ linked: true, ssoStepUp: false }));
    expect(await loadStepUpMethod('member', abort.signal)).toBe('local');
    expect(mocks.selfLinkStatus).toHaveBeenCalledWith({ signal: abort.signal });
    mocks.selfLinkStatus.mockResolvedValueOnce(linked({ linked: false, ssoStepUp: true }));
    expect(await loadStepUpMethod('member')).toBe('sso');
  });

  it('lets an explicit server answer win over the link flag', () => {
    expect(stepUpMethodFor({ linked: true, ssoStepUp: false, role: 'member' })).toBe('local');
    expect(stepUpMethodFor({ linked: true, ssoStepUp: true, role: 'owner' })).toBe('sso');
  });

  // Parity guard: the owner exemption mirrors requiresSsoLogin on the server.
  it('matches the server owner exemption in requiresSsoLogin', () => {
    const policy = readFileSync(join(process.cwd(), 'server/services/sso-only-policy.js'), 'utf8');
    const body = policy.slice(policy.indexOf('export function requiresSsoLogin'));
    expect(body.slice(0, 300)).toMatch(/user\.role === 'owner'/u);
  });
});

// Parity guard: every refusal code the server's step-up callback can put in
// ?oidc_step_up_error= must be known here, or the member sees a generic text.
describe('step-up return code parity with the server', () => {
  it('knows every code redirectStepUpRefusal can send', () => {
    const source = readFileSync(join(process.cwd(), 'server/routes/oidc.js'), 'utf8');
    const found = new Set<string>();
    for (const call of source.matchAll(/redirectStepUpRefusal\(res,([^;]*)\);/gu)) {
      for (const literal of call[1].matchAll(/['"`]([a-z_]+)['"`]/gu)) found.add(literal[1]);
    }
    // `checked.error` comes from stepUpRefusal's `error:` values.
    const refusal = source.slice(source.indexOf('function stepUpRefusal('));
    const body = refusal.slice(0, refusal.indexOf('\n}\n'));
    for (const literal of body.matchAll(/error:\s*['"`]([a-z_]+)['"`]/gu)) found.add(literal[1]);
    expect(found.size).toBeGreaterThanOrEqual(6);
    expect([...found].filter(code => !OIDC_STEP_UP_RETURN_ERROR_CODES.has(code))).toEqual([]);
  });
});

describe('return URL classification', () => {
  const params = (query: string) => new URLSearchParams(query);

  it('never turns a crafted error value into a verified outcome', () => {
    expect(readStepUpReturn(params('oidc_step_up_error=ok'))).toEqual({ errorCode: 'step_up_unavailable' });
    expect(readStepUpReturn(params('oidc_step_up_error=constructor'))).toEqual({ errorCode: 'step_up_unavailable' });
    expect(readStepUpReturn(params('oidc_step_up_error=oidc_reauth_required')))
      .toEqual({ errorCode: 'oidc_reauth_required' });
  });

  it('forgets a pending step-up once cleared (sign-out, ordinary sign-in return)', () => {
    window.sessionStorage.setItem('nassaj:connector-step-up-pending', JSON.stringify({ view: 'accounts', at: Date.now() }));
    expect(readStepUpReturn(params('error=access_denied'))).toEqual({ errorCode: 'provider_denied' });
    clearPendingConnectorStepUp();
    expect(readStepUpReturn(params('error=access_denied'))).toBeNull();
  });
});

describe('round-trip markers', () => {
  it('hands one outcome to the connectors tab and clears the pending marker', () => {
    window.sessionStorage.setItem('nassaj:connector-step-up-pending', JSON.stringify({ view: 'installation', at: Date.now() }));
    recordConnectorStepUpOutcome({ verified: true });
    expect(hasPendingConnectorStepUp()).toBe(false);
    expect(consumeConnectorStepUpOutcome()).toEqual({ verified: true, view: 'installation' });
    expect(consumeConnectorStepUpOutcome()).toBeNull();
  });

  it('sanitizes an unexpected code and defaults the view', () => {
    recordConnectorStepUpOutcome({ verified: false, code: '<script>' });
    expect(consumeConnectorStepUpOutcome()).toEqual({ verified: false, code: 'step_up_unavailable', view: 'accounts' });
  });

  it('never reads a refusal code as verified', () => {
    recordConnectorStepUpOutcome({ verified: false, code: 'ok' });
    expect(consumeConnectorStepUpOutcome()).toEqual({ verified: false, code: 'ok', view: 'accounts' });
    window.sessionStorage.setItem('nassaj:connector-step-up-outcome', JSON.stringify({ code: 'ok', view: 'accounts', at: Date.now() }));
    expect(consumeConnectorStepUpOutcome()).toBeNull();
  });

  it('drops an outcome the tab did not read within two minutes', () => {
    const at = Date.now();
    recordConnectorStepUpOutcome({ verified: true }, undefined, at);
    expect(consumeConnectorStepUpOutcome(undefined, at + 2 * 60_000 + 1)).toBeNull();
    expect(consumeConnectorStepUpOutcome()).toBeNull();
  });

  it('sign-out forgets an unread outcome as well as the pending marker', () => {
    window.sessionStorage.setItem('nassaj:connector-step-up-pending', JSON.stringify({ view: 'accounts', at: Date.now() }));
    recordConnectorStepUpOutcome({ verified: false, code: 'step_up_failed' });
    window.sessionStorage.setItem('nassaj:connector-step-up-pending', JSON.stringify({ view: 'accounts', at: Date.now() }));
    clearConnectorStepUpState();
    expect(hasPendingConnectorStepUp()).toBe(false);
    expect(consumeConnectorStepUpOutcome()).toBeNull();
  });

  it('ignores a stale pending marker', () => {
    window.sessionStorage.setItem('nassaj:connector-step-up-pending', JSON.stringify({ view: 'accounts', at: Date.now() - 11 * 60_000 }));
    expect(hasPendingConnectorStepUp()).toBe(false);
  });
});

// Parity guard: every server connector code asking for a fresh step-up (or a
// CSRF token) must open the dialog; unavailable/origin codes must not.
describe('recent-auth code parity with the server', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return /\.(?:ts|js|mjs)$/u.test(name) && !/\.test\./u.test(name) ? [path] : [];
  });

  it('knows every CONNECTOR_*RECENT_AUTH*/CSRF* requirement code the server emits', () => {
    const found = new Set<string>();
    for (const file of walk(join(process.cwd(), 'server'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/'(CONNECTOR_[A-Z_]*(?:RECENT_AUTH|CSRF)[A-Z_]*)'/gu)) {
        found.add(match[1]);
      }
    }
    const notPrompts = new Set(['CONNECTOR_RECENT_AUTH_UNAVAILABLE', 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED']);
    const required = [...found].filter(code => !notPrompts.has(code));
    expect(required.length).toBeGreaterThan(0);
    expect(required.filter(code => !CONNECTOR_RECENT_AUTH_CODES.has(code))).toEqual([]);
    expect([...notPrompts].filter(code => CONNECTOR_RECENT_AUTH_CODES.has(code))).toEqual([]);
  });
});
