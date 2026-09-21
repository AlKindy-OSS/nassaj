import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import enCommon from '../../../i18n/locales/en/common.json';
import arCommon from '../../../i18n/locales/ar/common.json';
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

const { VersionUpgradeModal } = await import('./VersionUpgradeModal');

const response = (status: number, body: Record<string, unknown>) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

const PREFLIGHT_URL = '/api/system/update/preflight';
const CLEAR_PREFLIGHT = () => response(200, { ok: true, blocker: null, checks: [] });

/** Route authenticatedFetch by URL so the pre-flight call never consumes a job mock. */
function routeFetch(routes: {
  active?: () => Response;
  preflight?: () => Response;
  post?: () => Response;
  status?: () => Response;
}) {
  authenticatedFetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === '/api/system/update/jobs/active') return routes.active?.() ?? response(200, { job: null });
    if (url === PREFLIGHT_URL) return (routes.preflight ?? CLEAR_PREFLIGHT)();
    if (options?.method === 'POST') return routes.post?.() ?? response(500, {});
    return routes.status?.() ?? response(500, {});
  });
}

const postCalls = () => authenticatedFetch.mock.calls.filter(([, options]) => options?.method === 'POST');

function renderModal() {
  return render(<VersionUpgradeModal
    isOpen
    onClose={vi.fn()}
    releaseInfo={null}
    currentVersion="1.44.0.1"
    latestVersion="1.45.0.0"
    installMode="git"
  />);
}

describe('VersionUpgradeModal async updater', () => {
  beforeEach(() => {
    localStorage.clear();
    authenticatedFetch.mockReset();
    authenticatedFetch.mockResolvedValue(response(200, { job: null }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, {
      systemUpdate: {
        updaterProtocol: 'async-v2',
        updaterStrategy: 'atomic-release',
        updateReady: true,
      },
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('discovers an active job in a fresh browser without creating or confirming anything', async () => {
    routeFetch({
      active: () => response(200, { job: { jobId: 'recovery-1', state: 'restart_queued',
        targetVersion: '2.2.0.1', statusUrl: '/api/system/update/jobs/recovery-1' } }),
      status: () => response(200, { state: 'restart_queued', targetVersion: '2.2.0.1' }),
    });
    renderModal();
    await waitFor(() => expect(authenticatedFetch.mock.calls.some(([url]) => url === '/api/system/update/jobs/recovery-1')).toBe(true));
    expect(postCalls()).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(UPDATE_ATTEMPT_STORAGE_KEY)!)).toMatchObject({
      jobId: 'recovery-1', targetVersion: '2.2.0.1',
    });
  });

  it.each([401, 403])('does not resume discovery denied with %s', async (status) => {
    routeFetch({ active: () => response(status, {}) });
    renderModal();
    await screen.findByText(/permission|authorized|authorization|sign in/i);
    expect(authenticatedFetch.mock.calls.some(([url]) => url === '/api/system/update/jobs/recovery-1')).toBe(false);
    expect(postCalls()).toHaveLength(0);
  });

  it('ignores discovery after the modal has unmounted', async () => {
    let finish!: (value: Response) => void;
    authenticatedFetch.mockImplementation((url: string) => url === '/api/system/update/jobs/active'
      ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(CLEAR_PREFLIGHT()));
    const view = renderModal();
    view.unmount();
    finish(response(200, { job: { jobId: 'late', state: 'restart_queued', targetVersion: '2.2.0.1',
      statusUrl: '/api/system/update/jobs/late' } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(authenticatedFetch.mock.calls.some(([url]) => url === '/api/system/update/jobs/late')).toBe(false);
    expect(localStorage.getItem(UPDATE_ATTEMPT_STORAGE_KEY)).toBeNull();
  });

  it('clears a discovered job removed before its first status read', async () => {
    routeFetch({ active: () => response(200, { job: { jobId: 'gone', state: 'accepted',
      targetVersion: '2.2.0.1', statusUrl: '/api/system/update/jobs/gone' } }), status: () => response(404, {}) });
    renderModal();
    await waitFor(() => expect(authenticatedFetch.mock.calls.some(([url]) => url === '/api/system/update/jobs/gone')).toBe(true));
    await waitFor(() => expect(localStorage.getItem(UPDATE_ATTEMPT_STORAGE_KEY)).toBeNull());
    expect(postCalls()).toHaveLength(0);
  });

  it('keeps the POST result when an older discovery completes afterwards', async () => {
    let finish!: (value: Response) => void;
    authenticatedFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/system/update/jobs/active') return new Promise<Response>(resolve => { finish = resolve; });
      if (url === PREFLIGHT_URL) return CLEAR_PREFLIGHT();
      if (options?.method === 'POST') return response(409, { code: 'update_in_progress', jobId: 'newer',
        state: 'restart_queued', targetVersion: '2.2.0.1', statusUrl: '/api/system/update/jobs/newer' });
      return response(200, { state: 'restart_queued', targetVersion: '2.2.0.1' });
    });
    renderModal();
    await screen.findByText(/Readiness check passed/);
    fireEvent.click(screen.getByRole('button', { name: 'Update Now' }));
    fireEvent.click(await screen.findByRole('button', { name: /Agree to update/ }));
    await waitFor(() => expect(authenticatedFetch.mock.calls.some(([url]) => url === '/api/system/update/jobs/newer')).toBe(true));
    finish(response(200, { job: { jobId: 'older', state: 'accepted', targetVersion: '2.2.0.0',
      statusUrl: '/api/system/update/jobs/older' } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse(localStorage.getItem(UPDATE_ATTEMPT_STORAGE_KEY)!)).toMatchObject({ jobId: 'newer', targetVersion: '2.2.0.1' });
    expect(authenticatedFetch.mock.calls.some(([url]) => url === '/api/system/update/jobs/older')).toBe(false);
    expect(postCalls()).toHaveLength(1);
  });

  it('does not begin polling when a POST completes after unmount', async () => {
    let finish!: (value: Response) => void;
    authenticatedFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/system/update/jobs/active') return response(200, { job: null });
      if (url === PREFLIGHT_URL) return CLEAR_PREFLIGHT();
      if (options?.method === 'POST') return new Promise<Response>(resolve => { finish = resolve; });
      return response(200, {});
    });
    const view = renderModal();
    await screen.findByText(/Readiness check passed/);
    fireEvent.click(screen.getByRole('button', { name: 'Update Now' }));
    fireEvent.click(await screen.findByRole('button', { name: /Agree to update/ }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    view.unmount();
    finish(response(202, { jobId: 'late-post', state: 'accepted', statusUrl: '/api/system/update/jobs/late-post' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(authenticatedFetch.mock.calls.some(([url]) => url === '/api/system/update/jobs/late-post')).toBe(false);
  });

  it('creates a UUID idempotency key and never calls the legacy endpoint', async () => {
    routeFetch({
      post: () => response(202, {
        jobId: 'job-1', state: 'candidate_sealed', statusUrl: '/api/system/update/jobs/job-1', reused: false,
      }),
      status: () => response(200, {
        state: 'candidate_sealed', targetVersion: '1.45.0.0', strategy: 'git-checkout-v2',
      }),
    });
    renderModal();
    await screen.findByText(/Readiness check passed/);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Update Now' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Update Now' }));
    fireEvent.click(await screen.findByRole('button', { name: /Agree to update/ }));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const [url, options] = postCalls()[0];
    expect(url).toBe('/api/system/update/jobs');
    expect(options.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(authenticatedFetch.mock.calls.some(([calledUrl]) => calledUrl === '/api/system/update')).toBe(false);
    expect(JSON.parse(localStorage.getItem(UPDATE_ATTEMPT_STORAGE_KEY) || '{}').jobId).toBe('job-1');
    // Stepper shows the phase name for candidate_sealed
    expect(await screen.findByText('Sealed, ready')).not.toBeNull();
    expect(screen.queryByText(/active and the running service has been verified/)).toBeNull();
  });

  it('diagnoses readiness on opening and again on the click, before the POST', async () => {
    routeFetch({
      post: () => response(202, { jobId: 'job-p', state: 'accepted', statusUrl: '/api/system/update/jobs/job-p' }),
      status: () => response(200, { state: 'accepted', targetVersion: '1.45.0.0' }),
    });
    renderModal();
    await screen.findByText(/Readiness check passed/);
    fireEvent.click(screen.getByRole('button', { name: 'Update Now' }));
    fireEvent.click(await screen.findByRole('button', { name: /Agree to update/ }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const urls = authenticatedFetch.mock.calls.map(([calledUrl]) => calledUrl);
    const postIndex = urls.indexOf('/api/system/update/jobs');
    expect(urls.slice(0, postIndex).filter(calledUrl => calledUrl === PREFLIGHT_URL)).toHaveLength(2);
  });

  it('shows one cause and one action for a blocker, and keeps Start disabled', async () => {
    routeFetch({
      preflight: () => response(200, {
        ok: false,
        blocker: {
          code: 'dirty_worktree',
          ar: 'شجرة المصدر فيها تعديلات.',
          en: 'The source tree has local changes.',
          action: { ar: 'احفظ التعديلات.', en: 'Commit or remove the local changes.', command: 'git status --short' },
        },
      }),
    });
    renderModal();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This update cannot start yet');
    expect(alert.textContent).toContain('The source tree has local changes.');
    expect(alert.textContent).toContain('Commit or remove the local changes.');
    expect(screen.getByText('git status --short').getAttribute('dir')).toBe('ltr');
    expect((screen.getByRole('button', { name: 'Update Now' }) as HTMLButtonElement).disabled).toBe(true);
    expect(postCalls()).toHaveLength(0);
  });

  it('stops at the click when the fresh diagnosis finds a new blocker', async () => {
    let preflightCount = 0;
    routeFetch({
      preflight: () => (++preflightCount === 1
        ? CLEAR_PREFLIGHT()
        : response(200, { ok: false, blocker: { code: 'active_sessions', en: 'Sessions are active.', action: { en: 'End them.' } } })),
    });
    renderModal();
    await screen.findByText(/Readiness check passed/);
    fireEvent.click(screen.getByRole('button', { name: 'Update Now' }));
    expect(await screen.findByText('Sessions are active.')).not.toBeNull();
    expect(postCalls()).toHaveLength(0);
  });

  it('handles rate limiting explicitly and offers a re-check', async () => {
    routeFetch({
      preflight: () => ({ ...response(429, { code: 'rate_limited' }), headers: new Headers({ 'Retry-After': '30' }) }) as Response,
    });
    renderModal();
    expect(await screen.findByText(/Wait 30 seconds, then check again/)).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Update Now' }) as HTMLButtonElement).disabled).toBe(true);
    routeFetch({});
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(/Readiness check passed/)).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Update Now' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('fails closed when the diagnosis itself is unavailable', async () => {
    routeFetch({ preflight: () => response(500, { code: 'update_preflight_unavailable' }) });
    renderModal();
    expect(await screen.findByText(/Update readiness could not be checked on the server/)).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Update Now' }) as HTMLButtonElement).disabled).toBe(true);
    expect(postCalls()).toHaveLength(0);
  });

  it('shows the running version and names a differing source tree separately (M1)', async () => {
    routeFetch({});
    render(<VersionUpgradeModal
      isOpen
      onClose={vi.fn()}
      releaseInfo={null}
      currentVersion="1.44.0.1"
      sourceVersion="1.45.0.0"
      latestVersion="1.45.0.0"
      installMode="git"
    />);
    await screen.findByText(/Readiness check passed/);
    expect(screen.getByText('1.44.0.1')).not.toBeNull();
    expect(screen.getByText('Source tree (not the running build)')).not.toBeNull();
    expect(screen.getAllByText('1.45.0.0')).toHaveLength(2);
  });

  it('omits the source row when source and runtime agree', async () => {
    routeFetch({});
    renderModal();
    await screen.findByText(/Readiness check passed/);
    expect(screen.queryByText('Source tree (not the running build)')).toBeNull();
  });

  it('resumes a stored job after reload without issuing another POST', async () => {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: '8f844646-ff69-4db1-9fbc-bccb7688cccb',
      jobId: 'job-2',
      statusUrl: '/api/system/update/jobs/job-2',
      targetVersion: '1.45.0.0',
      createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'restart_queued', targetVersion: '1.45.0.0', strategy: 'git-checkout-v2',
    }));
    renderModal();
    // Phase stepper shows the restart_queued phase name
    expect(await screen.findByText('Awaiting your safe restart')).not.toBeNull();
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/system/update/jobs/job-2', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(authenticatedFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('blocks the button when health says the updater is not ready', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, {
      systemUpdate: { updaterProtocol: 'async-v2', updateReady: false, blockedReasonCode: 'release_layout_required' },
    })));
    renderModal();
    expect(await screen.findByText(/complete its governed release-layout setup/)).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Update Now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('consents to preparation and automatic activation when active sessions defer the update', async () => {
    routeFetch({
      preflight: () => response(200, { ok: false, blocker: { code: 'active_sessions', en: 'Sessions are active.', action: { en: 'Wait for them to finish.' } } }),
      post: () => response(202, { jobId: 'deferred', state: 'awaiting_sessions', statusUrl: '/api/system/update/jobs/deferred' }),
      status: () => response(200, { state: 'awaiting_sessions', targetVersion: '1.45.0.0' }),
    });
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare update when sessions end' }));
    expect(postCalls()).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /Agree to update/ }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(JSON.parse(postCalls()[0][1].body)).toMatchObject({ deferUntilIdle: true, activateWhenIdle: true });
  });

  it('renews consent only for the stored sealed target, without creating a new update', async () => {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: '8f844646-ff69-4db1-9fbc-bccb7688cccb', jobId: 'sealed',
      statusUrl: '/api/system/update/jobs/sealed', targetVersion: '1.44.0.9', createdAt: Date.now(),
    }));
    routeFetch({
      post: () => response(202, { success: true }),
      status: () => response(200, { state: 'restart_queued', targetVersion: '1.44.0.9',
        activationTargetDigest: 'a'.repeat(64), autoActivate: false }),
    });
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: enCommon.versionUpdate.local.activate }));
    expect(postCalls()).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: /Agree to update/ }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0][0]).toBe('/api/system/update/jobs/sealed/confirm');
    expect(JSON.parse(postCalls()[0][1].body)).toEqual({ expectedVersion: '1.44.0.9', targetDigest: 'a'.repeat(64) });
  });

  it('shows rollback and manual recovery without claiming installation', async () => {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: '8f844646-ff69-4db1-9fbc-bccb7688cccb',
      statusUrl: '/api/system/update/jobs/job-3',
      targetVersion: '1.45.0.0',
      createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, { state: 'manual_recovery_required', reason: 'verification_failed' }));
    renderModal();
    expect(await screen.findByText(/Operator intervention is required/)).not.toBeNull();
    expect(screen.queryByText(/active and the running service has been verified/)).toBeNull();
    expect(localStorage.getItem(UPDATE_ATTEMPT_STORAGE_KEY)).not.toBeNull();
  });

  it('shows stepper and determinate progress bar for restart_queued (git-checkout-v2 → 63%)', async () => {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: '8f844646-ff69-4db1-9fbc-bccb7688cccb',
      jobId: 'job-4',
      statusUrl: '/api/system/update/jobs/job-4',
      targetVersion: '1.45.0.0',
      createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'restart_queued', targetVersion: '1.45.0.0', strategy: 'git-checkout-v2',
    }));
    renderModal();
    await screen.findByText('Awaiting your safe restart');
    // Determinate progress bar must be present with valuenow=63 and an accessible label
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).not.toBeNull();
    expect(progressbar.getAttribute('aria-valuenow')).toBe('63');
    expect(progressbar.getAttribute('aria-valuemin')).toBe('0');
    expect(progressbar.getAttribute('aria-valuemax')).toBe('100');
    expect(progressbar.getAttribute('aria-label')).toBeTruthy();
    // Percentage text is visible in the UI
    expect(screen.getAllByText('63%').length).toBeGreaterThan(0);
    // Owner action required status is shown
    expect(screen.getByRole('status')).toBeDefined();
    // No spinning Loader2 for restart_queued (Clock is used instead)
    expect(document.querySelector('svg.animate-spin')).toBeNull();
  });

  it('hides spinner and progress bar once the job reaches the activated terminal state', async () => {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: '8f844646-ff69-4db1-9fbc-bccb7688cccb',
      jobId: 'job-5',
      statusUrl: '/api/system/update/jobs/job-5',
      targetVersion: '1.45.0.0',
      createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, { state: 'activated', targetVersion: '1.45.0.0' }));
    renderModal();
    await screen.findByText(/active and the running service has been verified/);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(document.querySelector('svg.animate-spin')).toBeNull();
  });

  it('hides spinner and progress bar for a failed terminal state', async () => {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: '8f844646-ff69-4db1-9fbc-bccb7688cccb',
      jobId: 'job-6',
      statusUrl: '/api/system/update/jobs/job-6',
      targetVersion: '1.45.0.0',
      createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, { state: 'failed', targetVersion: '1.45.0.0' }));
    renderModal();
    await screen.findByText(/The update stopped before a verified activation/);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(document.querySelector('svg.animate-spin')).toBeNull();
  });

  it('starts a distinct update job when retrying a terminal failure (B-1218)', async () => {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: '8f844646-ff69-4db1-9fbc-bccb7688cccb',
      jobId: 'failed-job',
      statusUrl: '/api/system/update/jobs/failed-job',
      targetVersion: '1.44.0.9',
      createdAt: Date.now(),
    }));
    routeFetch({
      post: () => response(202, {
        jobId: 'retry-job', state: 'candidate_sealed',
        statusUrl: '/api/system/update/jobs/retry-job', reused: false,
      }),
      status: () => postCalls().length > 0
        ? response(200, { state: 'candidate_sealed', targetVersion: '1.45.0.0', strategy: 'git-checkout-v2' })
        : response(200, { state: 'failed', targetVersion: '1.44.0.9', errorCode: 'candidate_build_failed' }),
    });
    renderModal();

    fireEvent.click(await screen.findByRole('button', { name: 'Start a New Attempt' }));
    fireEvent.click(await screen.findByRole('button', { name: /Agree to update/ }));

    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0][0]).toBe('/api/system/update/jobs');
    expect(JSON.parse(postCalls()[0][1].body)).toMatchObject({
      expectedVersion: '1.45.0.0',
      consent: { version: '1.45.0.0' },
    });
    expect(JSON.parse(localStorage.getItem(UPDATE_ATTEMPT_STORAGE_KEY) || '{}').jobId).toBe('retry-job');
  });

  it('shows phase stepper for active staging state', async () => {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: 'abc',
      jobId: 'job-7',
      statusUrl: '/api/system/update/jobs/job-7',
      targetVersion: '1.45.0.0',
      createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'staging', targetVersion: '1.45.0.0', strategy: 'git-checkout-v2',
    }));
    renderModal();
    await screen.findByText('Building candidate');
    // Phase description for current phase is shown
    expect(screen.getByText(/Fetching the release, checking tree/)).not.toBeNull();
    // Progress bar has aria-valuenow=38 (index 3 of 8 in git-checkout-v2)
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuenow')).toBe('38');
  });

  it('shows error panel with error code title and hint for failed state (flat shape)', async () => {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: 'abc',
      jobId: 'job-8',
      statusUrl: '/api/system/update/jobs/job-8',
      targetVersion: '1.45.0.0',
      createdAt: Date.now(),
    }));
    // New flat shape with errorCode and failedPhase
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'failed',
      targetVersion: '1.45.0.0',
      strategy: 'git-checkout-v2',
      errorCode: 'dirty_worktree',
      message: 'Local changes detected in src/',
      failedPhase: 'staging',
    }));
    renderModal();
    // Error title from errorCodes mapping
    expect(await screen.findByText('Uncommitted local changes')).not.toBeNull();
    // Error hint
    expect(screen.getByText(/Commit or stash all local changes/)).not.toBeNull();
    // Server message shown
    expect(screen.getByText('Local changes detected in src/')).not.toBeNull();
    // Failed state summary
    expect(screen.getByText(/The update stopped before a verified activation/)).not.toBeNull();
  });

  it('shows error panel with nested old-shape error code', async () => {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: 'abc',
      jobId: 'job-9',
      statusUrl: '/api/system/update/jobs/job-9',
      targetVersion: '1.45.0.0',
      createdAt: Date.now(),
    }));
    // Old nested shape from server
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'failed',
      expectedVersion: '1.45.0.0',
      strategy: 'git-checkout-v2',
      error: { code: 'candidate_build_failed', message: 'Build exited with code 1' },
    }));
    renderModal();
    expect(await screen.findByText('Build failed')).not.toBeNull();
    expect(screen.getByText(/release candidate build failed/)).not.toBeNull();
  });

  it('shows all 9 git-checkout-v2 phase names in the stepper', async () => {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: 'abc',
      jobId: 'job-10',
      statusUrl: '/api/system/update/jobs/job-10',
      targetVersion: '1.45.0.0',
      createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'staging', targetVersion: '1.45.0.0', strategy: 'git-checkout-v2',
    }));
    renderModal();
    await screen.findByText('Building candidate');
    const expectedPhaseNames = [
      'Queued', 'Finding release', 'Release locked', 'Building candidate',
      'Sealed, ready', 'Awaiting your safe restart', 'Activating',
      'Verifying runtime', 'Done',
    ];
    for (const name of expectedPhaseNames) {
      expect(screen.getByText(name)).not.toBeNull();
    }
  });
});

// ─── i18n coverage ────────────────────────────────────────────────────────────

describe('i18n coverage — all mapped error codes have ar+en keys', () => {
  const ERROR_CODES = [
    'dirty_worktree', 'wrong_branch', 'detached_head', 'non_fast_forward',
    'remote_mismatch', 'remote_unavailable', 'ambiguous_remote', 'unsafe_remote',
    'release_fetch_failed', 'release_identity_mismatch', 'gitlink_change_unsupported',
    'activation_gitlink_unsupported', 'exchange_capability', 'activation_filesystem_mismatch',
    'candidate_build_failed', 'candidate_manifest_invalid', 'restart_queue_failed',
    'tmpfs_candidate_root', 'tmpfs_build_tmpdir', 'tmpfs_database_root',
    'insufficient_disk', 'storage_probe_failed', 'update_database_state_unknown',
    'runtime_verification_failed', 'release_layout_retired', 'sealed_release_identity_mismatch',
    'unsupported_install_mode', 'update_source_state_degraded', 'unknown',
  ];

  for (const code of ERROR_CODES) {
    it(`has en title+hint for "${code}"`, () => {
      expect(lookup(enCommon, `versionUpdate.errorCodes.${code}.title`)).toBeTruthy();
      expect(lookup(enCommon, `versionUpdate.errorCodes.${code}.hint`)).toBeTruthy();
    });

    it(`has ar title+hint for "${code}"`, () => {
      expect(lookup(arCommon, `versionUpdate.errorCodes.${code}.title`)).toBeTruthy();
      expect(lookup(arCommon, `versionUpdate.errorCodes.${code}.hint`)).toBeTruthy();
    });
  }

  const BLOCKED_REASON_CODES = [
    'protocol_unavailable', 'capability_unavailable', 'release_layout_required',
    'release_layout_configuration_absent', 'release_layout_retired',
    'unsupported_deployment', 'update_job_active', 'update_source_state_degraded',
  ];

  for (const code of BLOCKED_REASON_CODES) {
    it(`has en blockedReason for "${code}"`, () => {
      expect(lookup(enCommon, `versionUpdate.blockedReasons.${code}`)).toBeTruthy();
    });

    it(`has ar blockedReason for "${code}"`, () => {
      expect(lookup(arCommon, `versionUpdate.blockedReasons.${code}`)).toBeTruthy();
    });
  }

  it('has en + ar phase names and descriptions for all git-checkout-v2 phases', () => {
    const phases = [
      'accepted', 'resolving', 'resolved', 'staging', 'candidate_sealed',
      'restart_queued', 'activating', 'runtime_verifying', 'activated',
    ];
    for (const phase of phases) {
      expect(lookup(enCommon, `versionUpdate.phases.${phase}.name`)).toBeTruthy();
      expect(lookup(enCommon, `versionUpdate.phases.${phase}.description`)).toBeTruthy();
      expect(lookup(arCommon, `versionUpdate.phases.${phase}.name`)).toBeTruthy();
      expect(lookup(arCommon, `versionUpdate.phases.${phase}.description`)).toBeTruthy();
    }
  });

  it('has en + ar phase names and descriptions for release-layout-v2-exclusive phases', () => {
    const phases = ['downloading', 'archive_verified', 'extracting'];
    for (const phase of phases) {
      expect(lookup(enCommon, `versionUpdate.phases.${phase}.name`)).toBeTruthy();
      expect(lookup(enCommon, `versionUpdate.phases.${phase}.description`)).toBeTruthy();
      expect(lookup(arCommon, `versionUpdate.phases.${phase}.name`)).toBeTruthy();
      expect(lookup(arCommon, `versionUpdate.phases.${phase}.description`)).toBeTruthy();
    }
  });
});


describe('unified local update dialog', () => {
  beforeEach(() => {
    localStorage.clear(); authenticatedFetch.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { updateMode: 'local-main' })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('prepares from the displayed main revision and confirms the sealed pair only after a second click', async () => {
    const oid = 'a'.repeat(40), digest = 'b'.repeat(64);
    let update: Record<string, unknown> | null = null;
    authenticatedFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/prepare')) { update = { sequence: 1, revision: 2, oid, phase: 'prepared', targetDigest: digest }; return response(202, { update }); }
      if (url.endsWith('/confirm')) { update = { ...update, phase: 'awaiting_sessions' }; return response(202, {}); }
      return response(200, { mode: 'local-main', oid, available: true, activationReady: true, update });
    });
    renderModal();
    await screen.findByText(/Uncommitted changes are excluded/);
    fireEvent.click(await screen.findByRole('button', { name: 'Update Now' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Activate update' }));
    expect(postCalls()).toHaveLength(1);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm update' }));
    await screen.findByText(/Waiting for sessions to finish/);
    expect(postCalls().map(([url]) => url)).toEqual(['/api/system/update/local/prepare', '/api/system/update/local/1/confirm']);
    expect(JSON.parse(postCalls()[0][1].body)).toEqual({ expectedOid: oid });
    expect(JSON.parse(postCalls()[1][1].body)).toEqual({ expectedRevision: 2, targetDigest: digest });
  });

  it('never offers a server-only fallback when the pair protocol is unavailable', async () => {
    authenticatedFetch.mockResolvedValue(response(200, { mode: 'local-main', oid: 'a'.repeat(40), available: true,
      activationReady: false, update: { sequence: 2, revision: 3, oid: 'a'.repeat(40), phase: 'prepared', targetDigest: 'b'.repeat(64) } }));
    renderModal();
    const button = await screen.findByRole('button', { name: 'Activate update' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button); expect(postCalls()).toHaveLength(0);
    expect(await screen.findByText(/Local activation is not ready/)).not.toBeNull();
  });
  it('enables development policy explicitly and keeps actual loaded commit distinct', async () => {
    let policy = { mode: 'disabled', revision: 0, available: true };
    authenticatedFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === 'PUT') {
        expect(url).toBe('/api/system/update/local/policy');
        expect(JSON.parse(options.body as string)).toEqual({ mode: 'dev-full-auto', expectedRevision: 0 });
        policy = { ...policy, mode: 'dev-full-auto', revision: 1 };
        return response(200, policy);
      }
      return response(200, { mode: 'local-main', oid: 'a'.repeat(40), serverLoadedOid: 'b'.repeat(40),
        available: true, activationReady: true, policy, update: null });
    });
    renderModal();
    const enable = await screen.findByRole('button', { name: 'Enable automatic main updates' });
    expect(authenticatedFetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT')).toHaveLength(0);
    expect(screen.getByText('bbbbbbbbbbbb')).not.toBeNull();
    fireEvent.click(enable);
    await screen.findByRole('button', { name: 'Disable automatic updates' });
    expect(authenticatedFetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT')).toHaveLength(1);
  });

  it('allows disabling an enabled policy when loaded capability is unavailable', async () => {
    authenticatedFetch.mockResolvedValue(response(200, { mode: 'local-main', oid: 'a'.repeat(40), available: false,
      activationReady: false, policy: { mode: 'dev-full-auto', revision: 1, available: false },
      update: { sequence: 1, revision: 3, oid: 'a'.repeat(40), phase: 'awaiting_sessions', authorityKind: 'policy' } }));
    renderModal();
    const disable = await screen.findByRole('button', { name: 'Disable automatic updates' });
    expect((disable as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Activate update' })).toBeNull();
  });

});
