/**
 * T-1962 S7 — the owner SSO settings tab against a mocked /api/settings/sso:
 * state rendering, step locking, error-code mapping (incl. unknown codes),
 * the step-up flow, the apply confirmation and the disable dialog per state,
 * and the one-time test sign-in return.
 *
 * Run: NODE_ENV=test npx vitest run src/components/settings/view/tabs/sso-settings/SsoSettingsTab.test.tsx
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enSettings from '../../../../../i18n/locales/en/settings.json';

import { activeStatus, configView, readyToApply, statusFixture } from './__fixtures__/ssoStatus';
import type { SsoStatus } from './ssoTypes';

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), enSettings);
}
function translate(key: string, options?: Record<string, unknown>): string {
  const count = options?.count;
  const plural = typeof count === 'number' ? lookup(`${key}_${count === 1 ? 'one' : 'other'}`) : undefined;
  const raw = typeof plural === 'string' ? plural : lookup(key);
  if (typeof raw !== 'string') return key;
  return raw.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''));
}
const s = (key: string, options?: Record<string, unknown>) => translate(`sso.${key}`, options);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
}));
vi.mock('../connectorStepUpClient', () => ({ passkeysSupported: () => false }));

type Call = { method: string; path: string; body: Record<string, unknown> | null };
const api = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; path: string; body: Record<string, unknown> | null }>,
  handler: null as null | ((call: { method: string; path: string; body: Record<string, unknown> | null }) => { status: number; body: unknown }),
}));
vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: async (url: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? 'GET', path: url.replace('/api/settings/sso', '') || '/',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null,
    };
    api.calls.push(call);
    const { status, body } = api.handler!(call);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  },
}));

import SsoSettingsTab from './SsoSettingsTab';

let current: SsoStatus;
let routes: Record<string, (call: Call) => { status: number; body: unknown }>;

function serve(status: SsoStatus, extra: typeof routes = {}) {
  current = status;
  routes = extra;
  api.handler = (call) => {
    const route = routes[`${call.method} ${call.path}`];
    if (route) return route(call);
    if (call.method === 'GET' && call.path === '/') return { status: 200, body: current };
    return { status: 404, body: { code: 'not_mocked' } };
  };
}

async function renderTab() {
  render(<SsoSettingsTab />);
  await screen.findByText(s('status.heading'));
}

const callsTo = (method: string, path: string) => api.calls.filter((call) => call.method === method && call.path === path);

beforeEach(() => {
  api.calls.length = 0;
  window.history.replaceState(null, '', '/?settings=sso');
});
afterEach(() => cleanup());

describe('state rendering', () => {
  it('fresh install: Off badge, intro, wizard open at step 1 with later steps locked', async () => {
    serve(statusFixture());
    await renderTab();
    expect(screen.getByText(s('status.off'))).toBeTruthy();
    expect(screen.getByText(s('status.meaning.off'))).toBeTruthy();
    expect(screen.getByText(s('intro'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: s('action.disable') })).toBeNull();
    // Step 1 is open: our values with copy buttons.
    expect(screen.getByRole('button', { name: s('action.copyNamed', { name: s('step1.redirect') }) })).toBeTruthy();
    // Step 3 is locked behind step 2, with the reason as visible text.
    const step3 = screen.getByText(s('step3.title')).closest('button')!;
    expect(step3.getAttribute('aria-disabled')).toBe('true');
    expect(within(step3).getByText(s('step.locked', { n: 2 }))).toBeTruthy();
  });

  it('origin not confirmed: step 0 asks for the address and locks everything else', async () => {
    serve(statusFixture({ ourValues: { ...statusFixture().ourValues, origin: null, originConfirmed: false, redirectUri: null, backchannelLogoutUri: null } }));
    await renderTab();
    expect(screen.getByText(s('step0.missing'))).toBeTruthy();
    const step2 = screen.getByText(s('step2.title')).closest('button')!;
    expect(within(step2).getByText(s('step.locked', { n: 0 }))).toBeTruthy();
  });

  it('active: success badge, owner note, disable button, wizard collapsed behind "Change settings"', async () => {
    serve(activeStatus());
    await renderTab();
    expect(screen.getByText(s('status.active'))).toBeTruthy();
    expect(screen.getByText(s('status.ownerNote'))).toBeTruthy();
    expect(screen.getByRole('button', { name: s('action.disable') })).toBeTruthy();
    expect(screen.getByText(s('summary.title'))).toBeTruthy();
    expect(screen.queryByText(s('step0.title'))).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: s('action.change') })[0]);
    expect(screen.getByText(s('step0.title'))).toBeTruthy();
  });

  it('unavailable with a changed discovery endpoint: danger banner opens step 2', async () => {
    serve(activeStatus({ ssoState: 'unavailable', active: configView({ slot: 'active', enabled: true, runtimeFault: 'discovery_endpoint_changed' }) }));
    await renderTab();
    expect(screen.getByText(s('status.unavailable'))).toBeTruthy();
    expect(screen.getByText(s('banner.label.endpointChanged'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: s('action.recheck') }));
    expect(screen.getByLabelText(s('step2.issuer'))).toBeTruthy();
  });

  it('host force-off: info banner, no wizard and no disable button', async () => {
    serve(activeStatus({ hostDisabled: true, ssoState: 'off' }));
    await renderTab();
    expect(screen.getByText(s('banner.hostDisabled'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: s('action.disable') })).toBeNull();
    expect(screen.queryByRole('button', { name: s('action.change') })).toBeNull();
  });

  it('load failure: no status header, an alert and a retry', async () => {
    api.handler = () => ({ status: 500, body: { code: 'internal_error' } });
    render(<SsoSettingsTab />);
    expect(await screen.findByText(s('error.load'))).toBeTruthy();
    expect(screen.queryByText(s('status.heading'))).toBeNull();
  });
});

describe('error-code mapping in the wizard', () => {
  async function saveStep2WithFailure(code: string) {
    serve(statusFixture({ draft: configView() }), {
      'PUT /draft': () => ({ status: 200, body: { draft: current.draft } }),
      'POST /draft/test-discovery': () => ({ status: 200, body: {
        passed: false, failure: code, failureStage: 'discovery_unavailable', warnings: [], endpoints: null, flags: null, jwksKeyCount: 0,
        ...(code === 'fetch_address_private' ? { addressCategory: 'private', privateNetworkMayHelp: true } : {}),
      } }),
    });
    await renderTab();
    fireEvent.click(screen.getByText(s('step2.title')).closest('button')!);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: s('step2.check') })); });
  }

  it('renders a known discovery failure in plain language', async () => {
    await saveStep2WithFailure('fetch_tls_failed');
    expect(await screen.findByText(s('diag.fetch_tls_failed'))).toBeTruthy();
    expect(screen.getByText(s('discovery.failed'))).toBeTruthy();
  });

  it('offers the private-network opt-in only when the server says it would help', async () => {
    await saveStep2WithFailure('fetch_address_private');
    expect(await screen.findByText(s('diag.fetch_address_private'))).toBeTruthy();
    expect(screen.getByText('private')).toBeTruthy();
    expect(screen.getByRole('button', { name: s('step2.private') })).toBeTruthy();
  });

  it('degrades an unknown code to the generic sentence and shows the raw code', async () => {
    await saveStep2WithFailure('fetch_quantum_tunnel');
    expect(await screen.findByText(s('diag.unknown', { code: 'fetch_quantum_tunnel' }))).toBeTruthy();
    expect(screen.getByText('fetch_quantum_tunnel')).toBeTruthy();
  });

  it('refuses a user-editable role claim inline before saving (I9)', async () => {
    serve(statusFixture({ draft: configView() }));
    await renderTab();
    fireEvent.click(screen.getByText(s('step3.title')).closest('button')!);
    fireEvent.change(screen.getByLabelText(s('step3.path')), { target: { value: 'preferred_username' } });
    expect(screen.getByText(s('step3.pathEditable'))).toBeTruthy();
    expect((screen.getByRole('button', { name: s('action.save') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the exact-address warning for an email tenant path (N6)', async () => {
    serve(statusFixture({ draft: configView() }));
    await renderTab();
    fireEvent.click(screen.getByText(s('step4.title')).closest('button')!);
    fireEvent.click(screen.getByRole('radio', { name: s('step4.claim') }));
    fireEvent.change(screen.getByLabelText(s('step4.path')), { target: { value: 'email' } });
    expect(screen.getByText(s('step4.emailWarning'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(s('step4.emailValues')), { target: { value: 'example.com' } });
    expect(screen.getByText(s('step4.emailInvalid'))).toBeTruthy();
  });
});

describe('step-up and apply', () => {
  it('apply with an issuer change: typed confirmation, then step-up, then POST /apply', async () => {
    const status = readyToApply({ applyImpact: {
      issuerChanged: true, mappingChanged: true, reattestRequired: 3, orphaned: 2, jitForcedOff: true, policyEnforcedNow: false,
    } });
    serve(status, { 'POST /apply': () => ({ status: 200, body: { applied: {}, ssoState: 'active' } }) });
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: s('step7.apply') }));

    expect(screen.getByText(s('dialog.issuer.title'))).toBeTruthy();
    expect(screen.getByText(s('dialog.issuer.jitOff'))).toBeTruthy();
    expect(screen.getByText(s('dialog.impact.reattest', { count: 3 }))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(s('dialog.issuer.keep', { count: 2 })));
    const applyButton = screen.getByRole('button', { name: s('dialog.impact.apply') }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(s('dialog.issuer.typePrompt', { phrase: 'KEEP SIGNED IN' })), { target: { value: 'KEEP SIGNED' } });
    expect(applyButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(s('dialog.issuer.typePrompt', { phrase: 'KEEP SIGNED IN' })), { target: { value: 'KEEP SIGNED IN' } });
    expect(applyButton.disabled).toBe(false);
    fireEvent.click(applyButton);

    expect(await screen.findByText(s('stepUp.title'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(s('stepUp.passwordLabel')), { target: { value: 'pw' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: s('stepUp.confirm') })); });

    await waitFor(() => expect(callsTo('POST', '/apply')).toHaveLength(1));
    expect(callsTo('POST', '/apply')[0].body).toEqual({
      draftVersion: 3, configHash: 'a'.repeat(64), enable: true, keepOrphanedSessions: true,
      confirmation: 'KEEP SIGNED IN', stepUp: { method: 'password', password: 'pw' },
    });
    await waitFor(() => expect(screen.queryByText(s('stepUp.title'))).toBeNull());
  });

  it('keeps the step-up dialog open on a wrong password and retries the same write', async () => {
    let attempts = 0;
    serve(readyToApply(), { 'POST /apply': () => {
      attempts += 1;
      return attempts === 1 ? { status: 401, body: { code: 'step_up_failed' } } : { status: 200, body: { applied: {} } };
    } });
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: s('step7.apply') }));
    fireEvent.click(screen.getByRole('button', { name: s('dialog.impact.apply') }));
    fireEvent.change(await screen.findByLabelText(s('stepUp.passwordLabel')), { target: { value: 'wrong' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: s('stepUp.confirm') })); });
    expect(await screen.findByText(s('diag.step_up_failed'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(s('stepUp.passwordLabel')), { target: { value: 'right' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: s('stepUp.confirm') })); });
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(screen.queryByText(s('stepUp.title'))).toBeNull());
  });

  it('a non-step-up refusal closes the dialog and is shown under the apply button', async () => {
    serve(readyToApply(), { 'POST /apply': () => ({ status: 409, body: { code: 'sso_apply_proof_missing' } }) });
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: s('step7.apply') }));
    fireEvent.click(screen.getByRole('button', { name: s('dialog.impact.apply') }));
    fireEvent.change(await screen.findByLabelText(s('stepUp.passwordLabel')), { target: { value: 'pw' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: s('stepUp.confirm') })); });
    expect(await screen.findByText(s('diag.sso_apply_proof_missing'))).toBeTruthy();
    expect(screen.queryByText(s('stepUp.title'))).toBeNull();
  });

  it('keeps the apply button disabled until both proofs are current', async () => {
    serve(statusFixture({ draft: configView() }));
    await renderTab();
    fireEvent.click(screen.getByText(s('step7.title')).closest('button')!);
    expect((screen.getByRole('button', { name: s('step7.apply') }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('disable dialog by state', () => {
  it('while active: keep-sessions choice and step-up, both sent to POST /disable', async () => {
    serve(activeStatus(), { 'POST /disable': () => ({ status: 200, body: { ssoState: 'off' } }) });
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: s('action.disable') }));
    expect(screen.getByText(s('dialog.disable.signOut', { count: 4 }))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(s('dialog.disable.keep')));
    fireEvent.click(screen.getByRole('button', { name: s('dialog.disable.confirm') }));
    fireEvent.change(await screen.findByLabelText(s('stepUp.passwordLabel')), { target: { value: 'pw' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: s('stepUp.confirm') })); });
    await waitFor(() => expect(callsTo('POST', '/disable')).toHaveLength(1));
    expect(callsTo('POST', '/disable')[0].body).toEqual({ keepLinkedSessions: true, stepUp: { method: 'password', password: 'pw' } });
  });

  it('while unavailable: forced sign-out wording, no choice and no step-up', async () => {
    serve(activeStatus({ ssoState: 'unavailable', active: configView({ slot: 'active', enabled: true, runtimeFault: 'discovery_endpoint_changed' }) }),
      { 'POST /disable': () => ({ status: 200, body: { ssoState: 'off' } }) });
    await renderTab();
    fireEvent.click(screen.getAllByRole('button', { name: s('action.disable') })[0]);
    expect(screen.getByText(s('dialog.disable.forced', { count: 4 }))).toBeTruthy();
    expect(screen.queryByLabelText(s('dialog.disable.keep'))).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: s('dialog.disable.confirm') })); });
    await waitFor(() => expect(callsTo('POST', '/disable')).toHaveLength(1));
    expect(callsTo('POST', '/disable')[0].body).toEqual({});
    expect(screen.queryByText(s('stepUp.title'))).toBeNull();
  });
});

describe('test sign-in return', () => {
  it('reads the one-time result, shows the card, focuses its heading and strips ssoTest from the URL', async () => {
    window.history.replaceState(null, '', '/?settings=sso&ssoTest=abc_DEF-123');
    serve(readyToApply(), {
      'GET /draft/test-login/result/abc_DEF-123': () => ({ status: 200, body: { result: {
        claimNames: ['sub', 'roles'], roleClaimValue: ['nassaj-admin'], tenantClaimValue: null, mappedRole: 'admin',
        tenantOk: true, authTimePresent: true, authTimeFresh: true, diagnostics: [],
      } } }),
    });
    await renderTab();
    const heading = await screen.findByRole('heading', { name: s('result.passed') });
    expect(screen.getByText(s('result.wouldSignInAs', { role: s('step3.roleAdmin') }))).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(window.location.search).toBe('?settings=sso');
  });

  it('an already-read result is a muted note, not an error', async () => {
    window.history.replaceState(null, '', '/?settings=sso&ssoTest=gone');
    serve(readyToApply(), { 'GET /draft/test-login/result/gone': () => ({ status: 404, body: { code: 'sso_test_result_not_found' } }) });
    await renderTab();
    expect(await screen.findByText(s('step6.alreadyShown'))).toBeTruthy();
  });

  it('maps an ssoTestError code', async () => {
    window.history.replaceState(null, '', '/?settings=sso&ssoTestError=temporarily_unavailable');
    serve(readyToApply());
    await renderTab();
    expect(await screen.findByText(s('diag.temporarily_unavailable'))).toBeTruthy();
    expect(window.location.search).toBe('?settings=sso');
  });
});
