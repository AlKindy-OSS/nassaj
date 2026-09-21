import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import enCommon from '../../../i18n/locales/en/common.json';
import { UPDATE_ATTEMPT_STORAGE_KEY } from '../updateJobClient';

function lookup(obj: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    obj,
  );
  return typeof value === 'string' ? value : undefined;
}

const tMock = (key: string, options?: Record<string, unknown>) => {
  const template = lookup(enCommon, key) ?? (typeof options?.defaultValue === 'string' ? options.defaultValue : key);
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? `{{${name}}}`));
};

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: tMock }) }));

const authenticatedFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const copyTextToClipboard = vi.fn();
vi.mock('../../../utils/clipboard', () => ({
  copyTextToClipboard: (...args: unknown[]) => copyTextToClipboard(...args),
}));

const { UpdateTerminalLog } = await import('./UpdateTerminalLog');
const { VersionUpgradeModal } = await import('./VersionUpgradeModal');

const response = (status: number, body: Record<string, unknown>) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

const STATUS_URL = '/api/system/update/jobs/job-1';

describe('UpdateTerminalLog (T-1768)', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
    copyTextToClipboard.mockReset();
  });
  afterEach(() => cleanup());

  it('stays collapsed and silent until the owner opens it', () => {
    render(<UpdateTerminalLog statusUrl={STATUS_URL} live />);
    expect(screen.getByRole('button', { name: /show terminal output/i }).getAttribute('aria-expanded')).toBe('false');
    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('log')).toBeNull();
  });

  it('reads from offset 0, renders each line, and resumes from the returned offset', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(response(200, { offset: 30, text: '$ npm ci\nadded 12 packages\n' }))
      .mockResolvedValue(response(200, { offset: 30, text: '' }));
    render(<UpdateTerminalLog statusUrl={STATUS_URL} live={false} />);
    fireEvent.click(screen.getByRole('button', { name: /show terminal output/i }));

    await waitFor(() => expect(screen.getByText('$ npm ci')).toBeTruthy());
    expect(screen.getByText('added 12 packages')).toBeTruthy();
    expect(authenticatedFetch.mock.calls[0][0]).toBe(`${STATUS_URL}/log?offset=0`);
    await waitFor(() => expect(authenticatedFetch.mock.calls[1]?.[0]).toBe(`${STATUS_URL}/log?offset=30`));
    const log = screen.getByRole('log');
    expect(log.getAttribute('dir')).toBe('ltr');
    expect(screen.getByText('$ npm ci').className).toContain('text-sky-300');
  });

  it('copies the whole log', async () => {
    authenticatedFetch.mockResolvedValueOnce(response(200, { offset: 6, text: 'hello\n' }))
      .mockResolvedValue(response(200, { offset: 6, text: '' }));
    render(<UpdateTerminalLog statusUrl={STATUS_URL} live={false} />);
    fireEvent.click(screen.getByRole('button', { name: /show terminal output/i }));
    await waitFor(() => expect(screen.getByText('hello')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /copy log/i }));
    expect(copyTextToClipboard).toHaveBeenCalledWith('hello\n');
  });

  it('renders nothing without a status URL', () => {
    const { container } = render(<UpdateTerminalLog live />);
    expect(container.innerHTML).toBe('');
  });
});

describe('VersionUpgradeModal automatic activation (T-1751)', () => {
  beforeEach(() => {
    localStorage.clear();
    authenticatedFetch.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, {
      systemUpdate: { updateReady: true, updaterProtocol: 'async-v2', updaterStrategy: 'git-checkout-v2' },
    })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderResumed(job: Record<string, unknown>) {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: 'key-1', targetVersion: '1.47.0.17', createdAt: Date.now(),
      jobId: 'job-1', statusUrl: STATUS_URL,
    }));
    authenticatedFetch.mockImplementation(async (url: string) => (
      url === STATUS_URL ? response(200, job) : response(200, { offset: 0, text: '' })
    ));
    render(<VersionUpgradeModal isOpen onClose={vi.fn()} releaseInfo={null} currentVersion="1.47.0.16"
      latestVersion="1.47.0.17" installMode="git" />);
  }

  it('names the live sessions it waits for instead of asking for the command board', async () => {
    renderResumed({
      state: 'restart_queued', strategy: 'git-checkout-v2', autoActivate: true,
      autoActivation: { state: 'waiting_sessions', liveSessions: 2, code: 'live_sessions', deadlineAt: null },
    });
    await waitFor(() => expect(screen.getByText(/Waiting for 2 live session\(s\) to finish/)).toBeTruthy());
    expect(screen.getByText('Activating when the node is idle')).toBeTruthy();
    expect(screen.queryByText(/Confirm activation in this dialog/)).toBeNull();
  });

  it('requests confirmation in the dialog for a job started without consent', async () => {
    renderResumed({ state: 'restart_queued', strategy: 'git-checkout-v2' });
    await waitFor(() => expect(screen.getByText(/Confirm activation in this dialog/)).toBeTruthy());
  });

  it('hands back to the button once automatic activation expires', async () => {
    renderResumed({
      state: 'restart_queued', strategy: 'git-checkout-v2', autoActivate: true,
      autoActivation: { state: 'expired', liveSessions: null, code: 'auto_activate_deadline', deadlineAt: 1 },
    });
    await waitFor(() => expect(screen.getByText(/Consent expired. Confirm activation again in this dialog/)).toBeTruthy());
  });

  it('sends the owner\'s consent with the update request', async () => {
    authenticatedFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/system/update/preflight') return response(200, { ok: true, blocker: null, checks: [] });
      if (options?.method === 'POST') return response(202, { jobId: 'job-1', state: 'accepted', statusUrl: STATUS_URL });
      return response(200, { state: 'accepted' });
    });
    render(<VersionUpgradeModal isOpen onClose={vi.fn()} releaseInfo={null} currentVersion="1.47.0.16"
      latestVersion="1.47.0.17" installMode="git" />);
    const start = await screen.findByRole('button', { name: /update now/i });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    expect(await screen.findByText(/safe restart runs automatically/i)).toBeTruthy();
    expect(authenticatedFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Agree to update to version/i }));
    await waitFor(() => expect(authenticatedFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true));
    const [, post] = authenticatedFetch.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(JSON.parse(String(post.body))).toEqual({ expectedVersion: '1.47.0.17', activateWhenIdle: true, deferUntilIdle: true, consent: { version: '1.47.0.17' } });
  });
});
