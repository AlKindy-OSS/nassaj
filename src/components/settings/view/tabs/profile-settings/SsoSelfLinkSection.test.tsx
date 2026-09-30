/**
 * T-1939 slice 5: the member's own "Link your account to SSO" flow in
 * Profile → Security — hidden with SSO off, a linked state, and a password
 * prompt that hands the whole page to the IdP URL the server returns.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arSettings from '../../../../../i18n/locales/ar/settings.json';
import enSettings from '../../../../../i18n/locales/en/settings.json';

function lookup(tree: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
  return typeof value === 'string' ? value : undefined;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => lookup(enSettings, key) ?? key, i18n: { language: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  selfLinkStatus: vi.fn<() => Promise<Response>>(),
  startSelfLink: vi.fn<(password: string) => Promise<Response>>(),
  role: 'user',
}));
vi.mock('../../../../../utils/api', () => ({
  api: { auth: { oidc: { selfLinkStatus: mocks.selfLinkStatus, startSelfLink: mocks.startSelfLink } } },
}));
vi.mock('../../../../auth', () => ({
  useAuth: () => ({ user: { id: 12, username: 'member', role: mocks.role } }),
}));

import SsoSelfLinkSection from './SsoSelfLinkSection';

const sso = enSettings.profile.sso;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const assign = vi.fn();

beforeEach(() => {
  mocks.selfLinkStatus.mockReset();
  mocks.startSelfLink.mockReset();
  mocks.role = 'user';
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openPrompt() {
  fireEvent.click(await screen.findByRole('button', { name: sso.linkButton }));
  return screen.getByLabelText(sso.passwordLabel);
}

describe('SsoSelfLinkSection', () => {
  it('renders nothing when the server has SSO off (501)', async () => {
    mocks.selfLinkStatus.mockResolvedValue(json(501, { error: 'OIDC is not enabled' }));
    const { container } = render(<SsoSelfLinkSection />);
    await waitFor(() => expect(mocks.selfLinkStatus).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('shows the linked state with no link button', async () => {
    mocks.selfLinkStatus.mockResolvedValue(json(200, { linked: true }));
    render(<SsoSelfLinkSection />);
    expect((await screen.findByRole('status')).textContent).toContain(sso.linked);
    expect(screen.queryByRole('button', { name: sso.linkButton })).toBeNull();
  });

  it('password prompt → start → full-page navigation to the returned IdP URL', async () => {
    mocks.selfLinkStatus.mockResolvedValue(json(200, { linked: false }));
    const idpUrl = 'https://idp.example/authorize?state=s&prompt=login&max_age=0';
    mocks.startSelfLink.mockResolvedValue(json(200, { authorizationUrl: idpUrl }));
    render(<SsoSelfLinkSection />);
    expect(await screen.findByText(sso.memberNotice)).toBeTruthy();
    const input = await openPrompt();
    fireEvent.change(input, { target: { value: 'my-password' } });
    fireEvent.click(screen.getByRole('button', { name: sso.continue }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(idpUrl));
    expect(mocks.startSelfLink).toHaveBeenCalledWith('my-password');
  });

  it('asks for the password before calling the server', async () => {
    mocks.selfLinkStatus.mockResolvedValue(json(200, { linked: false }));
    render(<SsoSelfLinkSection />);
    await openPrompt();
    fireEvent.click(screen.getByRole('button', { name: sso.continue }));
    expect((await screen.findByRole('alert')).textContent).toContain(sso.errors.passwordRequired);
    expect(mocks.startSelfLink).not.toHaveBeenCalled();
  });

  it.each([
    [401, { code: 'current_password_incorrect' }, sso.errors.wrongPassword],
    [429, { code: 'oidc_self_link_rate_limited' }, sso.errors.rateLimited],
    [403, { code: 'password_change_required' }, sso.errors.passwordChangeRequired],
    [502, { error: 'Identity provider unavailable' }, sso.errors.failed],
    [200, { authorizationUrl: 'javascript:alert(1)' }, sso.errors.failed],
  ])('status %i shows its message and never navigates', async (status, body, message) => {
    mocks.selfLinkStatus.mockResolvedValue(json(200, { linked: false }));
    mocks.startSelfLink.mockResolvedValue(json(status, body));
    render(<SsoSelfLinkSection />);
    fireEvent.change(await openPrompt(), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: sso.continue }));
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(assign).not.toHaveBeenCalled();
  });

  it('a 409 already_linked flips to the linked state', async () => {
    mocks.selfLinkStatus.mockResolvedValue(json(200, { linked: false }));
    mocks.startSelfLink.mockResolvedValue(json(409, { code: 'already_linked' }));
    render(<SsoSelfLinkSection />);
    fireEvent.change(await openPrompt(), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: sso.continue }));
    expect((await screen.findByRole('alert')).textContent).toContain(sso.errors.alreadyLinked);
    expect(screen.getByText(sso.linked)).toBeTruthy();
  });

  it('the owner does not see the SSO-only member notice', async () => {
    mocks.role = 'owner';
    mocks.selfLinkStatus.mockResolvedValue(json(200, { linked: false }));
    render(<SsoSelfLinkSection />);
    await screen.findByRole('button', { name: sso.linkButton });
    expect(screen.queryByText(sso.memberNotice)).toBeNull();
  });

  it('ships the same keys in Arabic and English', () => {
    const keys = (tree: unknown, prefix = ''): string[] => Object.entries(tree as Record<string, unknown>)
      .flatMap(([key, value]) => (value && typeof value === 'object' ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`]));
    expect(keys(arSettings.profile.sso).sort()).toEqual(keys(enSettings.profile.sso).sort());
    expect(arSettings.users.sso.linkDisabledHint).toContain('ربط حسابك بمزوّد الهوية');
    expect(enSettings.users.sso.linkDisabledHint).toContain(sso.linkButton);
  });
});
