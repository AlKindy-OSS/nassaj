/**
 * T-1939 slice 6C: the SSO return page hands a connector step-up return to
 * OidcStepUpReturn — the grant is scrubbed, redeemed once, never stored, and
 * the member lands back on the connectors tab. Plain sign-in returns are
 * untouched.
 */
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const loginWithOidcCode = vi.fn();
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ loginWithOidcCode }) }));

const submitConnectorStepUp = vi.fn();
vi.mock('../../settings/view/tabs/connectorStepUpClient', async importOriginal => ({
  ...await importOriginal<typeof import('../../settings/view/tabs/connectorStepUpClient')>(),
  submitConnectorStepUp: (...args: unknown[]) => submitConnectorStepUp(...args),
}));

vi.mock('./AuthScreenLayout', () => ({
  default: ({ title, children }: { title: string; children: ReactNode }) => (
    <main><h1>{title}</h1>{children}</main>
  ),
}));

import OidcReturnPage from './OidcReturnPage';

const locations: string[] = [];
function LocationProbe() {
  const location = useLocation();
  locations.push(`${location.pathname}${location.search}`);
  return null;
}

function renderAt(url: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[url]}>
        <LocationProbe />
        <Routes>
          <Route path="/auth/oidc/return" element={<OidcReturnPage />} />
          <Route path="/" element={<p>app-home</p>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
}

const outcome = () => {
  const stored = JSON.parse(window.sessionStorage.getItem('nassaj:connector-step-up-outcome') ?? 'null');
  if (!stored) return stored;
  const { at, ...rest } = stored;
  expect(typeof at).toBe('number');
  return rest;
};

beforeEach(() => {
  submitConnectorStepUp.mockReset();
  loginWithOidcCode.mockReset();
  locations.length = 0;
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe('OIDC step-up return', () => {
  it('redeems the grant once and returns to the connectors tab', async () => {
    window.sessionStorage.setItem('nassaj:connector-step-up-pending', JSON.stringify({ view: 'installation', at: Date.now() }));
    submitConnectorStepUp.mockResolvedValue({ ok: true });
    renderAt('/auth/oidc/return?oidc_step_up=one-time-grant');

    expect(screen.getByRole('status').textContent).toContain('connectorsSettings.stepUp.returning');
    await screen.findByText('app-home');
    expect(submitConnectorStepUp).toHaveBeenCalledOnce();
    expect(submitConnectorStepUp).toHaveBeenCalledWith({ method: 'oidc_grant', grant: 'one-time-grant' });
    expect(locations.at(-1)).toBe('/?settings=connectors');
    expect(outcome()).toEqual({ verified: true, view: 'installation' });
    expect(JSON.stringify(window.sessionStorage)).not.toContain('one-time-grant');
    expect(loginWithOidcCode).not.toHaveBeenCalled();
  });

  it('scrubs the grant from the address before redeeming it', async () => {
    let resolve: (value: unknown) => void = () => {};
    submitConnectorStepUp.mockReturnValue(new Promise(done => { resolve = done; }));
    renderAt('/auth/oidc/return?oidc_step_up=secret-grant');
    await waitFor(() => expect(locations.at(-1)).toBe('/auth/oidc/return'));
    resolve({ ok: false, code: 'step_up_failed' });
    await screen.findByText('app-home');
    expect(outcome()).toEqual({ verified: false, code: 'sso_grant_failed', view: 'accounts' });
  });

  it('passes an IdP refusal to the connectors tab without a request', async () => {
    renderAt('/auth/oidc/return?oidc_step_up_error=oidc_step_up_identity_mismatch');
    await screen.findByText('app-home');
    expect(submitConnectorStepUp).not.toHaveBeenCalled();
    expect(outcome()).toEqual({ verified: false, code: 'oidc_step_up_identity_mismatch', view: 'accounts' });
  });

  it('routes a plain IdP error to the connectors tab only while a step-up is pending', async () => {
    window.sessionStorage.setItem('nassaj:connector-step-up-pending', JSON.stringify({ view: 'accounts', at: Date.now() }));
    renderAt('/auth/oidc/return?error=access_denied');
    await screen.findByText('app-home');
    expect(outcome()).toEqual({ verified: false, code: 'provider_denied', view: 'accounts' });
  });

  it('cannot be tricked into "verified" by a crafted error link', async () => {
    renderAt('/auth/oidc/return?oidc_step_up_error=ok');
    await screen.findByText('app-home');
    expect(submitConnectorStepUp).not.toHaveBeenCalled();
    expect(outcome()).toEqual({ verified: false, code: 'step_up_unavailable', view: 'accounts' });
  });

  it('maps an inherited-name error code to the generic refusal', async () => {
    renderAt('/auth/oidc/return?oidc_step_up_error=constructor');
    await screen.findByText('app-home');
    expect(outcome()).toEqual({ verified: false, code: 'step_up_unavailable', view: 'accounts' });
  });

  it('forgets a stale pending step-up on an ordinary sign-in return', async () => {
    window.sessionStorage.setItem('nassaj:connector-step-up-pending', JSON.stringify({ view: 'accounts', at: Date.now() }));
    loginWithOidcCode.mockResolvedValue({ success: true });
    renderAt('/auth/oidc/return?oidc_code=abc');
    await screen.findByText('app-home');
    expect(window.sessionStorage.getItem('nassaj:connector-step-up-pending')).toBeNull();
  });

  it('leaves an ordinary sign-in return to the login flow', async () => {
    loginWithOidcCode.mockResolvedValue({ success: true });
    renderAt('/auth/oidc/return?oidc_code=abc');
    await screen.findByText('app-home');
    expect(loginWithOidcCode).toHaveBeenCalledWith('abc');
    expect(submitConnectorStepUp).not.toHaveBeenCalled();
    expect(outcome()).toBeNull();
  });
});
