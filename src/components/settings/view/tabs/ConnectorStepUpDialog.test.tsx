/**
 * T-1939 slice 6C: the inline connector step-up dialog — methods per account
 * kind, every refusal mapped to a message, and accessible dialog semantics.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arSettings from '../../../../i18n/locales/ar/settings.json';
import enSettings from '../../../../i18n/locales/en/settings.json';

function lookup(tree: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
  return typeof value === 'string' ? value : undefined;
}

let language: 'en' | 'ar' = 'en';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const text = lookup(language === 'ar' ? arSettings : enSettings, key) ?? key;
      return text.replace('{{seconds}}', String(options?.seconds ?? ''));
    },
    i18n: { language },
  }),
}));

const selfLinkStatus = vi.hoisted(() => vi.fn());
vi.mock('../../../../utils/api', () => ({
  api: { auth: { oidc: { selfLinkStatus } } },
  authenticatedFetch: vi.fn(),
}));

const client = vi.hoisted(() => ({
  loadStepUpMethod: vi.fn<(role: string | null) => Promise<'local' | 'sso' | null>>(),
  passkeysSupported: vi.fn(() => true),
  submitConnectorStepUp: vi.fn(),
  submitConnectorPasskeyStepUp: vi.fn(),
  startConnectorOidcStepUp: vi.fn(),
}));
vi.mock('./connectorStepUpClient', async importOriginal => ({
  ...await importOriginal<typeof import('./connectorStepUpClient')>(),
  ...client,
}));

import ConnectorStepUpDialog from './ConnectorStepUpDialog';
import * as realClient from './connectorStepUpClient';
import { CONNECTOR_RECENT_AUTH_CODES, connectorStepUpErrorKey } from './connectorStepUpClient';

const actualClient = await vi.importActual<typeof realClient>('./connectorStepUpClient');

const onClose = vi.fn();
const onVerified = vi.fn();
const stepUp = enSettings.connectorsSettings.stepUp;

function renderDialog(props: Partial<Parameters<typeof ConnectorStepUpDialog>[0]> = {}) {
  return render(<ConnectorStepUpDialog open returnView="accounts" onClose={onClose} onVerified={onVerified} {...props} />);
}

beforeEach(() => {
  language = 'en';
  Object.values(client).forEach(fn => fn.mockReset());
  client.passkeysSupported.mockReturnValue(true);
  client.loadStepUpMethod.mockResolvedValue('local');
  selfLinkStatus.mockReset();
  onClose.mockReset();
  onVerified.mockReset();
});
afterEach(cleanup);

describe('ConnectorStepUpDialog', () => {
  it('is a labelled modal dialog with password and passkey for a local account', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe(stepUp.title);
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe(stepUp.description);
    const password = await within(dialog).findByLabelText(stepUp.passwordLabel) as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(password.autocomplete).toBe('current-password');
    expect(within(dialog).getByRole('button', { name: stepUp.usePasskey })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: stepUp.confirmWithSso })).toBeNull();
  });

  it('hides the passkey option when the browser cannot run one', async () => {
    client.passkeysSupported.mockReturnValue(false);
    renderDialog();
    await screen.findByLabelText(stepUp.passwordLabel);
    expect(screen.queryByRole('button', { name: stepUp.usePasskey })).toBeNull();
  });

  it('submits the password and reports success', async () => {
    client.submitConnectorStepUp.mockResolvedValue({ ok: true });
    renderDialog();
    fireEvent.change(await screen.findByLabelText(stepUp.passwordLabel), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: stepUp.confirm }));
    await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
    expect(client.submitConnectorStepUp).toHaveBeenCalledWith({ method: 'password', password: 'secret' });
  });

  it('runs the passkey step-up and stays silent when the prompt is cancelled', async () => {
    client.submitConnectorPasskeyStepUp.mockResolvedValue({ ok: false, code: 'passkey_cancelled' });
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: stepUp.usePasskey }));
    await waitFor(() => expect(client.submitConnectorPasskeyStepUp).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByRole('button', { name: stepUp.usePasskey }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('shows the wait time on a rate limit', async () => {
    client.submitConnectorStepUp.mockResolvedValue({ ok: false, code: 'step_up_rate_limited', retryAfterSeconds: 42 });
    renderDialog();
    fireEvent.change(await screen.findByLabelText(stepUp.passwordLabel), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: stepUp.confirm }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(stepUp.errors.rateLimited);
    expect(alert.textContent).toContain('42 seconds');
  });

  it('explains an unconfigured public origin without a password form', () => {
    renderDialog({ initialErrorCode: 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED' });
    expect(screen.getByRole('alert').textContent).toContain(stepUp.errors.originUnconfigured);
    expect(screen.queryByLabelText(stepUp.passwordLabel)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: stepUp.close }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('starts SSO for an SSO-linked member; Cancel and Escape stay live while leaving', async () => {
    client.loadStepUpMethod.mockResolvedValue('sso');
    client.startConnectorOidcStepUp.mockResolvedValue({ ok: true, outcome: 'redirected' });
    renderDialog({ returnView: 'installation' });
    fireEvent.click(await screen.findByRole('button', { name: stepUp.confirmWithSso }));
    await waitFor(() => expect(client.startConnectorOidcStepUp)
      .toHaveBeenCalledWith('installation', { signal: expect.any(AbortSignal) }));
    expect((await screen.findByRole('button', { name: stepUp.redirecting }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: stepUp.cancel }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Cancel aborts a pending SSO start so it can never navigate', async () => {
    client.loadStepUpMethod.mockResolvedValue('sso');
    let signal: AbortSignal | undefined;
    client.startConnectorOidcStepUp.mockImplementation((_view: string, deps: { signal: AbortSignal }) => {
      signal = deps.signal;
      return new Promise(() => {});
    });
    const view = renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: stepUp.confirmWithSso }));
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: stepUp.cancel }));
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<ConnectorStepUpDialog open={false} returnView="accounts" onClose={onClose} onVerified={onVerified} />);
    expect(signal?.aborted).toBe(true);
  });

  it('keeps a success that lands after the dialog closed: readiness is refetched silently', async () => {
    let finish: (result: { ok: true }) => void = () => {};
    client.submitConnectorStepUp.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onVerifiedAfterClose = vi.fn();
    const props = { returnView: 'accounts' as const, onClose, onVerified, onVerifiedAfterClose };
    const view = render(<ConnectorStepUpDialog open {...props} />);
    fireEvent.change(await screen.findByLabelText(stepUp.passwordLabel), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: stepUp.confirm }));
    await waitFor(() => expect(client.submitConnectorStepUp).toHaveBeenCalled());
    view.rerender(<ConnectorStepUpDialog open={false} {...props} />);
    finish({ ok: true });
    await waitFor(() => expect(onVerifiedAfterClose).toHaveBeenCalledOnce());
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('marks the password invalid only for a password refusal, not a passkey one', async () => {
    client.submitConnectorPasskeyStepUp.mockResolvedValueOnce({ ok: false, code: 'step_up_failed' });
    renderDialog();
    const input = await screen.findByLabelText(stepUp.passwordLabel) as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: stepUp.usePasskey }));
    await screen.findByRole('alert');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    client.submitConnectorStepUp.mockResolvedValueOnce({ ok: false, code: 'step_up_failed' });
    fireEvent.change(input, { target: { value: 'typo' } });
    fireEvent.click(screen.getByRole('button', { name: stepUp.confirm }));
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
  });

  it('tells an SSO member the confirmation failed, not to check a password', () => {
    renderDialog({ initialErrorCode: 'sso_grant_failed' });
    expect(screen.getByRole('alert').textContent).toContain(stepUp.errors.ssoGrantFailed);
    expect(screen.getByRole('alert').textContent).not.toContain(stepUp.errors.failed);
  });

  it('never strands the dialog when another SSO navigation is already in flight', async () => {
    client.loadStepUpMethod.mockResolvedValue('sso');
    client.startConnectorOidcStepUp.mockResolvedValue({ ok: true, outcome: 'in_flight' });
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: stepUp.confirmWithSso }));
    expect((await screen.findByRole('status')).textContent).toContain(stepUp.redirecting);
    fireEvent.click(screen.getByRole('button', { name: stepUp.cancel }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('frees the SSO button when the page returns from the back/forward cache', async () => {
    client.loadStepUpMethod.mockResolvedValue('sso');
    client.startConnectorOidcStepUp.mockResolvedValue({ ok: true, outcome: 'redirected' });
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: stepUp.confirmWithSso }));
    await screen.findByRole('button', { name: stepUp.redirecting });
    const restored = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    const button = await screen.findByRole('button', { name: stepUp.confirmWithSso }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('offers a linked owner the password, never SSO (owner stays local)', async () => {
    client.loadStepUpMethod.mockImplementation(actualClient.loadStepUpMethod);
    selfLinkStatus.mockResolvedValue(new Response(JSON.stringify({ linked: true }), { status: 200 }));
    renderDialog({ owner: true });
    expect(await screen.findByLabelText(stepUp.passwordLabel)).toBeTruthy();
    expect(screen.queryByRole('button', { name: stepUp.confirmWithSso })).toBeNull();
    expect(client.startConnectorOidcStepUp).not.toHaveBeenCalled();
  });

  it('sends a linked member (not the owner) to SSO', async () => {
    client.loadStepUpMethod.mockImplementation(actualClient.loadStepUpMethod);
    selfLinkStatus.mockResolvedValue(new Response(JSON.stringify({ linked: true }), { status: 200 }));
    renderDialog();
    expect(await screen.findByRole('button', { name: stepUp.confirmWithSso })).toBeTruthy();
    expect(screen.queryByLabelText(stepUp.passwordLabel)).toBeNull();
  });

  it('keeps a wrong password for correction but drops it after any other refusal', async () => {
    client.submitConnectorStepUp.mockResolvedValueOnce({ ok: false, code: 'step_up_failed' });
    renderDialog();
    const input = await screen.findByLabelText(stepUp.passwordLabel) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'typo' } });
    fireEvent.click(screen.getByRole('button', { name: stepUp.confirm }));
    await screen.findByRole('alert');
    expect(input.value).toBe('typo');
    client.submitConnectorStepUp.mockResolvedValueOnce({ ok: false, code: 'network' });
    fireEvent.click(screen.getByRole('button', { name: stepUp.confirm }));
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('holds the submit buttons until Retry-After passes', async () => {
    client.submitConnectorStepUp.mockResolvedValue({ ok: false, code: 'step_up_rate_limited', retryAfterSeconds: 1 });
    renderDialog();
    fireEvent.change(await screen.findByLabelText(stepUp.passwordLabel), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: stepUp.confirm }));
    await screen.findByRole('alert');
    const passkey = screen.getByRole('button', { name: stepUp.usePasskey }) as HTMLButtonElement;
    expect(passkey.disabled).toBe(true);
    await waitFor(() => expect(passkey.disabled).toBe(false), { timeout: 2500 });
  });

  it('tells the owner how to set an unconfigured origin, and a member to ask the owner', () => {
    const view = renderDialog({ owner: true, initialErrorCode: 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED' });
    expect(screen.getByRole('alert').textContent).toContain(stepUp.errors.originUnconfiguredOwner);
    expect(screen.getByRole('alert').textContent).toContain('NASSAJ_PUBLIC_ORIGIN');
    // B-1461: both languages name every trusted variable that can supply the origin.
    for (const text of [stepUp.errors.originUnconfiguredOwner,
      arSettings.connectorsSettings.stepUp.errors.originUnconfiguredOwner]) {
      for (const variable of ['NASSAJ_PUBLIC_ORIGIN', 'OIDC_REDIRECT_URI', 'WEBAUTHN_ORIGIN']) {
        expect(text).toContain(variable);
      }
    }
    view.unmount();
    renderDialog({ initialErrorCode: 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED' });
    expect(screen.getByRole('alert').textContent).toContain(stepUp.errors.originUnconfigured);
    expect(screen.getByRole('alert').textContent).not.toContain('NASSAJ_PUBLIC_ORIGIN');
  });

  it('falls back to the local methods when the server says SSO does not apply', async () => {
    client.loadStepUpMethod.mockResolvedValue('sso');
    client.startConnectorOidcStepUp.mockResolvedValue({ ok: false, code: 'sso_step_up_not_applicable' });
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: stepUp.confirmWithSso }));
    expect(await screen.findByLabelText(stepUp.passwordLabel)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(stepUp.errors.ssoNotApplicable);
  });

  it('closes on Escape when idle', async () => {
    renderDialog();
    await screen.findByLabelText(stepUp.passwordLabel);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders Arabic copy', async () => {
    language = 'ar';
    renderDialog({ initialErrorCode: 'step_up_failed' });
    const ar = arSettings.connectorsSettings.stepUp;
    expect(screen.getByRole('heading', { name: ar.title })).toBeTruthy();
    expect(await screen.findByLabelText(ar.passwordLabel)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(ar.errors.failed);
  });
});

describe('step-up error copy', () => {
  const contractCodes = [
    'AUTH_REQUIRED', 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED', 'CONNECTOR_ORIGIN_REJECTED',
    'step_up_failed', 'sso_step_up_not_applicable', 'step_up_rate_limited',
    'CONNECTOR_RECENT_AUTH_UNAVAILABLE', 'step_up_unavailable', 'sso_step_up_required',
    'step_up_invalid_request', 'password_change_required', 'no_eligible_passkey',
    'oidc_reauth_required', 'oidc_step_up_identity_mismatch', 'oidc_duplicate_links',
    'oidc_not_authorized', 'account_unavailable', 'temporarily_unavailable', 'network',
    'step_up_timeout', 'provider_denied',
  ];

  it.each(contractCodes)('maps %s to a specific English and Arabic message', code => {
    const key = `connectorsSettings.stepUp.${connectorStepUpErrorKey(code)}`;
    expect(key).not.toMatch(/generic$/u);
    expect(lookup(enSettings, key)).toBeTruthy();
    expect(lookup(arSettings, key)).toBeTruthy();
  });

  it('falls back to a generic message for unknown codes', () => {
    expect(connectorStepUpErrorKey('SOMETHING_NEW')).toBe('errors.generic');
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'treats the inherited name %s as an unknown code', code => {
      expect(connectorStepUpErrorKey(code)).toBe('errors.generic');
    },
  );

  it('never claims the account is unlinked when SSO does not apply', () => {
    expect(stepUp.errors.ssoNotApplicable).not.toMatch(/linked/iu);
    expect(arSettings.connectorsSettings.stepUp.errors.ssoNotApplicable).not.toContain('غير مرتبط');
  });

  it('never treats the origin rejection as a recent-auth prompt', () => {
    expect(CONNECTOR_RECENT_AUTH_CODES.has('CONNECTOR_ORIGIN_REJECTED')).toBe(false);
  });
});
