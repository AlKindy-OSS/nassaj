/**
 * T-2091 — the dsh staged-update pipeline status at the harness update control:
 * checking, held (plain reason; the current version keeps working), switched to
 * <v>, rolled back. RUNNER: vitest (jsdom).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ar from '../../../../../../i18n/locales/ar/settings.json';
import en from '../../../../../../i18n/locales/en/settings.json';
import { mapVersionStatus } from '../../../../../../hooks/harnessVersionMapping';

import HarnessIntegrationUpdateLine, { INTEGRATION_UPDATE_CODES } from './HarnessIntegrationUpdateLine';

const lookup = (bundle: unknown, key: string): string | undefined => key.split('.')
  .reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), bundle) as
  string | undefined;

const fetchMock = vi.fn();
vi.mock('../../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = lookup(en, key) ?? (opts?.defaultValue as string) ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));

const CODES = [
  'dsh_update_held_disk', 'dsh_update_busy', 'dsh_update_version_not_pinned', 'dsh_update_channel_mismatch',
  'dsh_update_install_failed', 'dsh_update_contract_failed', 'dsh_update_registry_unavailable',
  'dsh_plugin_engines_incompatible', 'dsh_tool_lost', 'dsh_tool_schema_changed', 'dsh_cap_security_rows',
  'dsh_contract_conformance_failed', 'dsh_contract_test_layer_invalid',
  'dsh_update_too_new', 'dsh_update_signature_failed', 'dsh_update_interrupted',
];
const base = {
  provider: 'dsh', state: 'updatable', installedVersion: '0.2.2-rc.1', latestVersion: '0.2.3', upToDate: false,
  updatable: true, reason: null, checkedAt: '2026-11-08T00:00:00Z', updating: false, activeJobId: null,
};

afterEach(cleanup);

describe('integration update status', () => {
  it('the wire field reaches the client state', () => {
    const state = mapVersionStatus({ ...base, integrationUpdate: { state: 'held', code: 'dsh_tool_lost', candidateVersion: '0.2.3' } } as never);
    expect(state.integrationUpdate).toEqual({ state: 'held', code: 'dsh_tool_lost', candidateVersion: '0.2.3' });
  });

  it.each(CODES)('%s has plain ar and en copy', (code) => {
    expect(INTEGRATION_UPDATE_CODES.has(code)).toBe(true);
    expect(lookup(en, `harnessVersion.integrationUpdate.code.${code}`)).toMatch(/\w/);
    expect(lookup(ar, `harnessVersion.integrationUpdate.code.${code}`)).toMatch(/[؀-ۿ]/);
  });

  it('installed or absent shows nothing', () => {
    const { container } = render(<HarnessIntegrationUpdateLine update={{ state: 'installed', code: null, candidateVersion: null, clearable: false }} />);
    expect(container.textContent).toBe('');
    const absent = render(<HarnessIntegrationUpdateLine update={undefined} />);
    expect(absent.container.textContent).toBe('');
  });

  it('checking names the candidate', () => {
    render(<HarnessIntegrationUpdateLine update={{ state: 'checking', code: null, candidateVersion: '0.2.3', clearable: false }} />);
    const line = screen.getByTestId('harness-integration-update');
    expect(line.textContent).toMatch(/Checking/);
    expect(line.querySelector('bdi')?.textContent).toBe('0.2.3');
  });

  it('held gives the plain reason and says the current version keeps working', () => {
    render(<HarnessIntegrationUpdateLine update={{ state: 'held', code: 'dsh_update_held_disk', candidateVersion: '0.2.3', clearable: false }} />);
    const text = screen.getByTestId('harness-integration-update').textContent ?? '';
    expect(text).toContain(en.harnessVersion.integrationUpdate.code.dsh_update_held_disk);
    expect(text).toMatch(/current version keeps working/i);
    expect(text).not.toContain('dsh_update_held_disk');
  });

  it('held with an unknown code still reads plainly', () => {
    render(<HarnessIntegrationUpdateLine update={{ state: 'held', code: 'dsh_new_check', candidateVersion: null, clearable: false }} />);
    const text = screen.getByTestId('harness-integration-update').textContent ?? '';
    expect(text).toContain(en.harnessVersion.integrationUpdate.codeUnknown);
    expect(text).not.toContain('dsh_new_check');
  });

  it('switched names the new version; rolled back says the previous version is back', () => {
    render(<HarnessIntegrationUpdateLine update={{ state: 'switched', code: null, candidateVersion: '0.2.3', clearable: false }} />);
    expect(screen.getByTestId('harness-integration-update').textContent).toMatch(/Switched to 0\.2\.3/);
    cleanup();
    render(<HarnessIntegrationUpdateLine update={{ state: 'rolled_back', code: 'dsh_cap_gate', candidateVersion: '0.2.3', clearable: false }} />);
    expect(screen.getByTestId('harness-integration-update').textContent).toMatch(/Rolled back to the previous version/);
  });
});

describe('retry a held update (owner only)', () => {
  const held = { state: 'held', code: 'dsh_update_too_new', candidateVersion: '0.2.3', clearable: true } as const;
  const button = () => screen.queryByRole('button', { name: en.harnessVersion.integrationUpdate.retry });

  it('is offered to the owner only, and only when the hold is clearable', () => {
    render(<HarnessIntegrationUpdateLine update={held} isOwner={false} />);
    expect(button()).toBeNull();
    cleanup();
    render(<HarnessIntegrationUpdateLine update={{ ...held, clearable: false }} isOwner />);
    expect(button()).toBeNull();
    cleanup();
    render(<HarnessIntegrationUpdateLine update={held} isOwner />);
    expect(button()).toBeTruthy();
  });

  it('posts the clear for the held version, disables while pending, then reports and refreshes', async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockReset().mockReturnValue(new Promise((r) => { resolve = r; }));
    const onCleared = vi.fn();
    render(<HarnessIntegrationUpdateLine update={held} isOwner onCleared={onCleared} />);
    fireEvent.click(button()!);
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/dsh/integration-hold/clear', {
      method: 'POST', body: JSON.stringify({ version: '0.2.3' }),
    });
    expect(button()!.hasAttribute('disabled')).toBe(true);
    await act(async () => { resolve({ ok: true, json: async () => ({ cleared: true }) }); });
    expect(screen.getByRole('status').textContent).toBe(en.harnessVersion.integrationUpdate.retryCleared);
    expect(onCleared).toHaveBeenCalled();
  });

  it('a refused clear says so plainly', async () => {
    fetchMock.mockReset().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    render(<HarnessIntegrationUpdateLine update={held} isOwner />);
    await act(async () => { fireEvent.click(button()!); });
    expect(screen.getByRole('status').textContent).toBe(en.harnessVersion.integrationUpdate.retryFailed);
    expect(button()!.hasAttribute('disabled')).toBe(false);
  });
});
