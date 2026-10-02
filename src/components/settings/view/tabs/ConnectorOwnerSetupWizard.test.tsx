import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arSettings from '../../../../i18n/locales/ar/settings.json';
import enSettings from '../../../../i18n/locales/en/settings.json';

const lookup = (tree: unknown, key: string): string | undefined => {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree);
  return typeof value === 'string' ? value : undefined;
};
const i18nLanguage = vi.hoisted(() => ({ current: 'en' as 'en' | 'ar' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => lookup(i18nLanguage.current === 'ar' ? arSettings : enSettings, key) ?? key,
    i18n: { language: i18nLanguage.current },
  }),
}));
const originTexts = (language: 'en' | 'ar') =>
  (language === 'ar' ? arSettings : enSettings).connectorsSettings.ownerSetup.origin;

const { loadConnectorOwnerSetup, mutateConnectorOwnerSetup, verifyConnectorOwnerProfile, requestStepUp } = vi.hoisted(() => ({
  loadConnectorOwnerSetup: vi.fn(), mutateConnectorOwnerSetup: vi.fn(), verifyConnectorOwnerProfile: vi.fn(),
  requestStepUp: vi.fn(),
}));
vi.mock('./connectorOwnerSetupClient', async importOriginal => ({
  ...await importOriginal<typeof import('./connectorOwnerSetupClient')>(),
  loadConnectorOwnerSetup, mutateConnectorOwnerSetup, verifyConnectorOwnerProfile,
}));

import ConnectorOwnerSetupWizard from './ConnectorOwnerSetupWizard';
import { ConnectorOwnerSetupRequestError } from './connectorOwnerSetupClient';
import type { ConnectorOwnerSetupStatus, OwnerSetupStep } from './connectorOwnerSetupClient';

const fixture = (
  resumableStep: OwnerSetupStep,
  overrides?: Partial<Pick<ConnectorOwnerSetupStatus, 'packExpiresAt' | 'warnings' | 'originProposal'>>,
): ConnectorOwnerSetupStatus => ({
  schemaVersion: 1 as const, readyForAccountLinking: resumableStep === 'complete', resumableStep,
  checks: [
    { id: 'substrate' as const, status: 'ok' as const, code: 'CONNECTOR_SUBSTRATE_READY' },
    { id: 'origin' as const, status: resumableStep === 'origin' ? 'required' as const : 'ok' as const, code: 'ORIGIN' },
    { id: 'trust' as const, status: resumableStep === 'trust' ? 'required' as const : 'ok' as const, code: 'TRUST' },
    { id: 'pack' as const, status: resumableStep === 'provider_pack' ? 'required' as const : 'ok' as const, code: 'PACK' },
    { id: 'activation' as const, status: resumableStep === 'complete' ? 'ok' as const : 'required' as const, code: 'ACTIVATION' },
  ],
  origin: resumableStep === 'origin' ? null : { installationId: 'install-1', canonicalOrigin: 'https://nassaj.example',
    callbackUrl: 'https://nassaj.example/connectors/oauth/callback', originRevision: 1 },
  // Origin-step fixtures carry a usable proposal unless a test overrides it (B-1461 L2).
  originProposal: overrides && 'originProposal' in overrides ? overrides.originProposal ?? null
    : resumableStep === 'origin' ? { canonicalOrigin: 'https://nassaj.example', source: 'public_origin' } : null,
  trustBundleRevision: resumableStep === 'origin' || resumableStep === 'trust' ? 0 : 1,
  activePack: ['activation', 'complete'].includes(resumableStep) ? {
    issuer: 'nassaj', channel: 'stable', sequence: 1, digest: 'a'.repeat(43), expiresAt: null,
  } : null,
  packExpiresAt: overrides?.packExpiresAt ?? null,
  warnings: overrides?.warnings ?? [],
  activationRecordRevision: resumableStep === 'complete' ? 1 : 0,
  activationCandidates: resumableStep === 'activation' ? [
    { providerId: 'google', serviceId: 'gmail', operation: 'oauth', authMethod: 'byo_app' as const,
      certification: 'certified' as const, enabled: false, profileRequired: true,
      profileState: 'ready' as const, profileRevision: 1, blockerCodes: ['CONNECTOR_ACTIVATION_REQUIRED'] },
    { providerId: 'future', serviceId: 'future', operation: 'read', authMethod: 'api_key' as const,
      certification: 'suspended' as const, enabled: false, profileRequired: false,
      profileState: 'not_required' as const, profileRevision: null, blockerCodes: ['provider_suspended'] },
  ] : [],
});

beforeEach(() => { i18nLanguage.current = 'en'; loadConnectorOwnerSetup.mockReset(); mutateConnectorOwnerSetup.mockReset();
  verifyConnectorOwnerProfile.mockReset(); requestStepUp.mockReset(); });
afterEach(cleanup);

describe('owner setup wizard', () => {
  it('offers the inline step-up, not a sign-out, when recentAuthRequired is true', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('origin'));
    render(<ConnectorOwnerSetupWizard owner csrfToken={null} recentAuthRequired onRequestStepUp={requestStepUp} language="en"/>);
    const button = await screen.findByRole('button', { name: "Confirm it's you" });
    expect(screen.getByText(/identity check/u).textContent).toContain('10 minutes');
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    fireEvent.click(button);
    expect(requestStepUp).toHaveBeenCalledOnce();
  });

  it('shows the Arabic step-up prompt', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('origin'));
    render(<ConnectorOwnerSetupWizard owner csrfToken={null} recentAuthRequired onRequestStepUp={requestStepUp} language="ar"/>);
    expect(await screen.findByText(/تحققاً سريعاً من هويتك/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'تأكيد هويتك' })).toBeTruthy();
  });

  it('opens the step-up instead of a setup error when a write needs recent auth', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('origin'));
    mutateConnectorOwnerSetup.mockRejectedValue(
      new ConnectorOwnerSetupRequestError('CONNECTOR_SETUP_RECENT_AUTH_OR_CSRF_REQUIRED', 403));
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} onRequestStepUp={requestStepUp} language="en"/>);
    fireEvent.change(await screen.findByLabelText('Canonical HTTPS origin'), { target: { value: 'https://oss.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(requestStepUp).toHaveBeenCalledOnce());
    // The refusal code travels so the tab can tell a stale CSRF token apart.
    expect(requestStepUp).toHaveBeenCalledWith('CONNECTOR_SETUP_RECENT_AUTH_OR_CSRF_REQUIRED');
    expect(screen.queryByText('Setup could not continue')).toBeNull();
  });

  // B-1405 follow-up: a null csrfToken during the initial load or a structural
  // readiness error is NOT a session problem — only recentAuthRequired is.
  it('hides the reauth prompt while csrfToken is merely not loaded yet', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('origin'));
    render(<ConnectorOwnerSetupWizard owner csrfToken={null} recentAuthRequired={false} language="en"/>);
    await screen.findByLabelText('Canonical HTTPS origin');
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });

  // B-1405 follow-up: normalization must not run on every keystroke, or typing
  // a real path character ("/") gets silently eaten mid-type.
  it('never normalizes while typing, so a real "/" in a path is not eaten', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('origin'));
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    const input = await screen.findByLabelText('Canonical HTTPS origin') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://fresh.example/' } });
    expect(input.value).toBe('https://fresh.example/');
    fireEvent.change(input, { target: { value: 'https://fresh.example/x' } });
    expect(input.value).toBe('https://fresh.example/x');
  });

  it('normalizes a single trailing slash on blur and enables Save and continue', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('origin'));
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    const input = await screen.findByLabelText('Canonical HTTPS origin') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://fresh.example/' } });
    expect((screen.getByRole('button', { name: 'Save and continue' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.blur(input);
    expect(input.value).toBe('https://fresh.example');
  });

  it('normalizes a single trailing slash on paste', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('origin'));
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    const input = await screen.findByLabelText('Canonical HTTPS origin') as HTMLInputElement;
    input.setSelectionRange(0, input.value.length);
    fireEvent.paste(input, { clipboardData: { getData: () => 'https://fresh.example/' } });
    expect(input.value).toBe('https://fresh.example');
  });

  it('normalizes on submit even without a prior blur or paste', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('origin'));
    mutateConnectorOwnerSetup.mockResolvedValue({});
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    const input = await screen.findByLabelText('Canonical HTTPS origin') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://fresh.example/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(mutateConnectorOwnerSetup).toHaveBeenCalledWith(expect.objectContaining({
      route: 'origin', expectedRevision: 0,
      body: { canonicalOrigin: 'https://fresh.example', expectedOriginRevision: 0 },
    })));
  });

  it('does not request or render owner setup for a member', () => {
    const { container } = render(<ConnectorOwnerSetupWizard owner={false} csrfToken={null} recentAuthRequired={false} language="en"/>);
    expect(container.innerHTML).toBe('');
    expect(loadConnectorOwnerSetup).not.toHaveBeenCalled();
  });

  it('resumes at the durable server step and renders Arabic without secrets', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('trust'));
    const { container } = render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="ar"/>);
    expect(await screen.findByText('استيراد حزمة ثقة التثبيت')).toBeTruthy();
    expect(screen.getByText('حزمة الثقة', { selector: 'li' }).getAttribute('aria-current')).toBe('step');
    expect(container.innerHTML.toLowerCase()).not.toContain('client secret');
  });

  it('aborts and ignores a late owner response after role downgrade', async () => {
    let resolve!: (value: ReturnType<typeof fixture>) => void;
    loadConnectorOwnerSetup.mockReturnValue(new Promise(value => { resolve = value; }));
    const view = render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    expect(loadConnectorOwnerSetup).toHaveBeenCalledTimes(1);
    view.rerender(<ConnectorOwnerSetupWizard owner={false} csrfToken={null} recentAuthRequired={false} language="en"/>);
    resolve(fixture('activation'));
    await Promise.resolve();
    expect(view.container.innerHTML).toBe('');
    expect(screen.queryByText('Review certified operations')).toBeNull();
  });

  it('offers controls only for certified candidates and keeps pending entries read-only', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('activation'));
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    expect(await screen.findByRole('checkbox', { name: 'gmail: oauth' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'future: read' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'gmail: oauth' }));
    expect((screen.getByRole('button', { name: 'Apply reviewed changes' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('submits revision zero when saving the first installation origin', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('origin'));
    mutateConnectorOwnerSetup.mockResolvedValue({});
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    fireEvent.change(await screen.findByLabelText('Canonical HTTPS origin'),
      { target: { value: 'https://fresh.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(mutateConnectorOwnerSetup).toHaveBeenCalledWith(expect.objectContaining({
      route: 'origin', expectedRevision: 0,
      body: { canonicalOrigin: 'https://fresh.example', expectedOriginRevision: 0 },
    })));
  });

  it('B-1461: pre-fills the server origin proposal and names its source, without saving', async () => {
    for (const language of ['en', 'ar'] as const) {
      i18nLanguage.current = language;
      loadConnectorOwnerSetup.mockResolvedValue(fixture('origin', {
        originProposal: { canonicalOrigin: 'https://sso-node.example', source: 'oidc_redirect_uri' } }));
      render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language={language}/>);
      await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value)
        .toBe('https://sso-node.example'));
      expect(screen.getByText(originTexts(language).proposalSource.oidc_redirect_uri)).toBeTruthy();
      expect(mutateConnectorOwnerSetup).not.toHaveBeenCalled();
      cleanup();
    }
    expect(originTexts('ar').proposalSource.oidc_redirect_uri).toContain('عنوان الرجوع لدخول المؤسسة');
  });

  it('B-1461 L2: without a usable proposal nothing is pre-filled and Save stays disabled', async () => {
    const cases = [
      [{ canonicalOrigin: null, source: 'invalid_public_origin' } as const, originTexts('en').invalidPublicOrigin],
      [null, enSettings.connectorsSettings.stepUp.errors.originUnconfiguredOwner],
    ] as const;
    for (const [originProposal, text] of cases) {
      loadConnectorOwnerSetup.mockResolvedValue(fixture('origin', { originProposal }));
      render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
      expect((await screen.findByRole('alert')).textContent).toContain(text);
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://fresh.example' } });
      expect((screen.getByRole('button', { name: 'Save and continue' }) as HTMLButtonElement).disabled).toBe(true);
      expect(mutateConnectorOwnerSetup).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('B-1461: explains the proposal mismatch and each bootstrap refusal in both languages', async () => {
    const cases = [
      [new ConnectorOwnerSetupRequestError('CONNECTOR_ORIGIN_PROPOSAL_MISMATCH', 403), 'proposalMismatch'],
      [new ConnectorOwnerSetupRequestError('CONNECTOR_ORIGIN_BOOTSTRAP_REFUSED', 409, 'startup_profile'),
        'bootstrapStartupProfile'],
      [new ConnectorOwnerSetupRequestError('CONNECTOR_ORIGIN_BOOTSTRAP_REFUSED', 409,
        'existing_installation_effects'), 'bootstrapExistingEffects'],
      [new ConnectorOwnerSetupRequestError('CONNECTOR_ORIGIN_BOOTSTRAP_REFUSED', 409), 'bootstrapRefused'],
    ] as const;
    for (const language of ['en', 'ar'] as const) {
      for (const [refusal, key] of cases) {
        i18nLanguage.current = language;
        loadConnectorOwnerSetup.mockResolvedValue(fixture('origin'));
        mutateConnectorOwnerSetup.mockRejectedValueOnce(refusal);
        render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language={language}/>);
        fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'https://fresh.example' } });
        fireEvent.click(screen.getByRole('button', { name: language === 'ar' ? 'حفظ ومتابعة' : 'Save and continue' }));
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain(originTexts(language).errors[key]);
        expect(alert.textContent).toContain(refusal.code);
        cleanup();
      }
    }
  });

  it('deduplicates DCR profile setup by provider and sends no secret', async () => {
    const setup = fixture('activation');
    setup.activationCandidates = [
      { providerId: 'notion', serviceId: 'pages', operation: 'read', authMethod: 'dcr_pkce',
        certification: 'certified', enabled: false, profileRequired: true,
        profileState: 'missing', profileRevision: null, blockerCodes: ['CONNECTOR_PROFILE_REQUIRED'] },
      { providerId: 'notion', serviceId: 'pages', operation: 'write', authMethod: 'dcr_pkce',
        certification: 'certified', enabled: false, profileRequired: true,
        profileState: 'missing', profileRevision: null, blockerCodes: ['CONNECTOR_PROFILE_REQUIRED'] },
    ];
    loadConnectorOwnerSetup.mockResolvedValue(setup);
    verifyConnectorOwnerProfile.mockResolvedValue({ providerId: 'notion', profileState: 'ready',
      profileRevision: 1, setupRevision: 1 });
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    const buttons = await screen.findAllByRole('button', { name: 'Prepare sign-in' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(verifyConnectorOwnerProfile).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'notion', expectedRevision: 0, body: { method: 'dcr_pkce' },
    })));
    expect(JSON.stringify(verifyConnectorOwnerProfile.mock.calls[0])).not.toContain('clientSecret');
  });

  it('submits BYO app credentials exactly and clears them after success', async () => {
    const setup = fixture('activation');
    setup.activationCandidates = [{ providerId: 'google', serviceId: 'gmail', operation: 'oauth',
      authMethod: 'byo_app', certification: 'certified', enabled: false, profileRequired: true,
      profileState: 'stale', profileRevision: 4, blockerCodes: ['CONNECTOR_PROFILE_STALE'] }];
    loadConnectorOwnerSetup.mockResolvedValue(setup);
    verifyConnectorOwnerProfile.mockResolvedValue({ providerId: 'google', profileState: 'ready',
      profileRevision: 5, setupRevision: 2 });
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    fireEvent.change(await screen.findByLabelText('Client ID'), { target: { value: ' client-id ' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'top-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Renew provider app' }));
    await waitFor(() => expect(verifyConnectorOwnerProfile).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'google', expectedRevision: 4,
      body: { method: 'byo_app', clientId: 'client-id', clientSecret: 'top-secret' },
    })));
    await waitFor(() => expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe(''));
  });

  it('removes owner profile inputs and ignores a late verification after role downgrade', async () => {
    const setup = fixture('activation');
    setup.activationCandidates = [{ providerId: 'google', serviceId: 'gmail', operation: 'oauth',
      authMethod: 'byo_app', certification: 'certified', enabled: false, profileRequired: true,
      profileState: 'missing', profileRevision: null, blockerCodes: ['CONNECTOR_PROFILE_REQUIRED'] }];
    loadConnectorOwnerSetup.mockResolvedValue(setup);
    let resolve!: (value: unknown) => void;
    verifyConnectorOwnerProfile.mockReturnValue(new Promise(value => { resolve = value; }));
    const view = render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    fireEvent.change(await screen.findByLabelText('Client ID'), { target: { value: 'id' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify provider app' }));
    view.rerender(<ConnectorOwnerSetupWizard owner={false} csrfToken={null} recentAuthRequired={false} language="en"/>);
    resolve({ providerId: 'google', profileState: 'ready', profileRevision: 1, setupRevision: 1 });
    await Promise.resolve();
    expect(view.container.innerHTML).toBe('');
    expect(loadConnectorOwnerSetup).toHaveBeenCalledTimes(1);
  });

  it('does not offer profile setup for suspended or personal API-key candidates', async () => {
    const setup = fixture('activation');
    setup.activationCandidates = [
      { providerId: 'salla', serviceId: 'salla', operation: 'read', authMethod: 'api_key',
        certification: 'certified', enabled: false, profileRequired: false, profileState: 'not_required',
        profileRevision: null, blockerCodes: ['CONNECTOR_ACTIVATION_REQUIRED'] },
      { providerId: 'paused', serviceId: 'paused', operation: 'read', authMethod: 'byo_app',
        certification: 'suspended', enabled: false, profileRequired: true, profileState: 'missing',
        profileRevision: null, blockerCodes: ['CONNECTOR_CERTIFICATION_SUSPENDED'] },
    ];
    loadConnectorOwnerSetup.mockResolvedValue(setup);
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    await screen.findByText('Review certified operations');
    expect(screen.queryByText('Prepare shared sign-in')).toBeNull();
    expect(screen.queryByLabelText('Client secret')).toBeNull();
  });

  it('fails closed for an unsupported installation-shared profile type', async () => {
    const setup = fixture('activation');
    setup.activationCandidates = [{ providerId: 'future', serviceId: 'future', operation: 'read',
      authMethod: 'future_shared', certification: 'certified', enabled: false, profileRequired: true,
      profileState: 'missing', profileRevision: null, blockerCodes: ['CONNECTOR_PROFILE_REQUIRED'] }];
    loadConnectorOwnerSetup.mockResolvedValue(setup);
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    expect((await screen.findByRole('alert')).textContent).toContain('Unsupported shared profile type');
    expect(screen.queryByRole('button', { name: 'Prepare sign-in' })).toBeNull();
    expect(screen.queryByLabelText('Client secret')).toBeNull();
  });

  it('shows a stable error and retry control for headless API failures', async () => {
    loadConnectorOwnerSetup.mockRejectedValue(Object.assign(new Error('failed'), {
      code: 'CONNECTOR_SETUP_UNAVAILABLE', status: 503,
    }));
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  describe('pack expiry warnings (T-1532)', () => {
    it('shows no warning banner when warnings is empty', async () => {
      loadConnectorOwnerSetup.mockResolvedValue(fixture('complete', { packExpiresAt: null, warnings: [] }));
      render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
      await screen.findByText('Installation setup is complete');
      const alerts = screen.queryAllByRole('alert');
      expect(alerts.every(alert => !alert.textContent?.includes('Pack'))).toBe(true);
    });

    it('shows a yellow warning with days remaining when pack_expiring_soon', async () => {
      const expiresAt = new Date(Date.now() + 4 * 24 * 60 * 60 * 1_000).toISOString();
      loadConnectorOwnerSetup.mockResolvedValue(fixture('complete', {
        packExpiresAt: expiresAt,
        warnings: ['pack_expiring_soon'],
      }));
      render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="en"/>);
      const alert = await screen.findByRole('alert', { });
      expect(alert.textContent).toContain('Pack expires in 4 day');
      expect(alert.textContent).toContain('docs/connectors-operator-setup_AR.md');
      expect(alert.className).toContain('warning');
    });

    it('shows a red error when pack_expired and Arabic text when language is ar', async () => {
      const expiresAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
      loadConnectorOwnerSetup.mockResolvedValue(fixture('complete', {
        packExpiresAt: expiresAt,
        warnings: ['pack_expired'],
      }));
      render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} recentAuthRequired={false} language="ar"/>);
      const alert = await screen.findByRole('alert', { });
      expect(alert.textContent).toContain('انتهت الحزمة');
      expect(alert.textContent).toContain('docs/connectors-operator-setup_AR.md');
      expect(alert.className).toContain('danger');
    });
  });
});
