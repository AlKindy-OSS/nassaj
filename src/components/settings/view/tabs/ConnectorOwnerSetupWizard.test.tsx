import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConnectorOwnerSetup, mutateConnectorOwnerSetup, verifyConnectorOwnerProfile } = vi.hoisted(() => ({
  loadConnectorOwnerSetup: vi.fn(), mutateConnectorOwnerSetup: vi.fn(), verifyConnectorOwnerProfile: vi.fn(),
}));
vi.mock('./connectorOwnerSetupClient', async importOriginal => ({
  ...await importOriginal<typeof import('./connectorOwnerSetupClient')>(),
  loadConnectorOwnerSetup, mutateConnectorOwnerSetup, verifyConnectorOwnerProfile,
}));

import ConnectorOwnerSetupWizard from './ConnectorOwnerSetupWizard';
import type { ConnectorOwnerSetupStatus, OwnerSetupStep } from './connectorOwnerSetupClient';

const fixture = (
  resumableStep: OwnerSetupStep,
  overrides?: Partial<Pick<ConnectorOwnerSetupStatus, 'packExpiresAt' | 'warnings'>>,
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

beforeEach(() => { loadConnectorOwnerSetup.mockReset(); mutateConnectorOwnerSetup.mockReset();
  verifyConnectorOwnerProfile.mockReset(); });
afterEach(cleanup);

describe('owner setup wizard', () => {
  it('does not request or render owner setup for a member', () => {
    const { container } = render(<ConnectorOwnerSetupWizard owner={false} csrfToken={null} language="en"/>);
    expect(container.innerHTML).toBe('');
    expect(loadConnectorOwnerSetup).not.toHaveBeenCalled();
  });

  it('resumes at the durable server step and renders Arabic without secrets', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('trust'));
    const { container } = render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="ar"/>);
    expect(await screen.findByText('استيراد حزمة ثقة التثبيت')).toBeTruthy();
    expect(screen.getByText('حزمة الثقة', { selector: 'li' }).getAttribute('aria-current')).toBe('step');
    expect(container.innerHTML.toLowerCase()).not.toContain('client secret');
  });

  it('aborts and ignores a late owner response after role downgrade', async () => {
    let resolve!: (value: ReturnType<typeof fixture>) => void;
    loadConnectorOwnerSetup.mockReturnValue(new Promise(value => { resolve = value; }));
    const view = render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="en"/>);
    expect(loadConnectorOwnerSetup).toHaveBeenCalledTimes(1);
    view.rerender(<ConnectorOwnerSetupWizard owner={false} csrfToken={null} language="en"/>);
    resolve(fixture('activation'));
    await Promise.resolve();
    expect(view.container.innerHTML).toBe('');
    expect(screen.queryByText('Review certified operations')).toBeNull();
  });

  it('offers controls only for certified candidates and keeps pending entries read-only', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('activation'));
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="en"/>);
    expect(await screen.findByRole('checkbox', { name: 'gmail: oauth' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'future: read' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'gmail: oauth' }));
    expect((screen.getByRole('button', { name: 'Apply reviewed changes' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('submits revision zero when saving the first installation origin', async () => {
    loadConnectorOwnerSetup.mockResolvedValue(fixture('origin'));
    mutateConnectorOwnerSetup.mockResolvedValue({});
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="en"/>);
    fireEvent.change(await screen.findByLabelText('Canonical HTTPS origin'),
      { target: { value: 'https://fresh.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(mutateConnectorOwnerSetup).toHaveBeenCalledWith(expect.objectContaining({
      route: 'origin', expectedRevision: 0,
      body: { canonicalOrigin: 'https://fresh.example', expectedOriginRevision: 0 },
    })));
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
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="en"/>);
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
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="en"/>);
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
    const view = render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="en"/>);
    fireEvent.change(await screen.findByLabelText('Client ID'), { target: { value: 'id' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify provider app' }));
    view.rerender(<ConnectorOwnerSetupWizard owner={false} csrfToken={null} language="en"/>);
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
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="en"/>);
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
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="en"/>);
    expect((await screen.findByRole('alert')).textContent).toContain('Unsupported shared profile type');
    expect(screen.queryByRole('button', { name: 'Prepare sign-in' })).toBeNull();
    expect(screen.queryByLabelText('Client secret')).toBeNull();
  });

  it('shows a stable error and retry control for headless API failures', async () => {
    loadConnectorOwnerSetup.mockRejectedValue(Object.assign(new Error('failed'), {
      code: 'CONNECTOR_SETUP_UNAVAILABLE', status: 503,
    }));
    render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="en"/>);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  describe('pack expiry warnings (T-1532)', () => {
    it('shows no warning banner when warnings is empty', async () => {
      loadConnectorOwnerSetup.mockResolvedValue(fixture('complete', { packExpiresAt: null, warnings: [] }));
      render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="en"/>);
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
      render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="en"/>);
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
      render(<ConnectorOwnerSetupWizard owner csrfToken={'c'.repeat(64)} language="ar"/>);
      const alert = await screen.findByRole('alert', { });
      expect(alert.textContent).toContain('انتهت الحزمة');
      expect(alert.textContent).toContain('docs/connectors-operator-setup_AR.md');
      expect(alert.className).toContain('danger');
    });
  });
});
