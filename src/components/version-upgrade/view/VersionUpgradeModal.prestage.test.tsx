/**
 * ADR-207 (T-2024 S5): the background-prestage line in the update dialog and
 * the "prepared in advance" mark on the job's build stage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import arCommon from '../../../i18n/locales/ar/common.json';
import { UPDATE_ATTEMPT_STORAGE_KEY } from '../updateJobClient';
import type { PrestageStatus } from '../prestageStatus';

function lookup(obj: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    obj,
  );
  return typeof value === 'string' ? value : undefined;
}
const tMock = (key: string, options?: Record<string, unknown>) => {
  const template = lookup(arCommon, key) ?? (typeof options?.defaultValue === 'string' ? options.defaultValue : key);
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? `{{${name}}}`));
};
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: tMock, i18n: { language: 'ar' } }) }));

const authenticatedFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));
vi.mock('../../auth/context/AuthContext', () => ({
  useOptionalAuth: () => ({ user: { id: 1, username: 'owner', role: 'owner' } }),
}));

const { VersionUpgradeModal } = await import('./VersionUpgradeModal');

const response = (status: number, body: Record<string, unknown>) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
}) as Response;

const LATEST = '2.4.0.1';
const P = (patch: Partial<PrestageStatus>): PrestageStatus => ({
  state: 'none', version: null, quarantineUntil: null, notPrestagedReason: null, readySince: null, ...patch,
});

function renderModal(prestage: PrestageStatus | null | undefined) {
  return render(<VersionUpgradeModal
    isOpen onClose={vi.fn()} releaseInfo={null} currentVersion="2.4.0.0"
    latestVersion={LATEST} installMode="git" prestage={prestage}
  />);
}

beforeEach(() => {
  localStorage.clear();
  authenticatedFetch.mockReset();
  authenticatedFetch.mockImplementation(async (url: string) => url === '/api/system/update/preflight'
    ? response(200, { ok: true, blocker: null, checks: [] })
    : response(200, { job: null }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, {
    systemUpdate: { updaterProtocol: 'async-v2', updateReady: true },
  })));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const updateButton = () => screen.getByRole('button', { name: arCommon.versionUpdate.buttons.updateNow });

describe('prestage line before the click', () => {
  it('ready for the offered release: success line, button still enabled', async () => {
    renderModal(P({ state: 'ready', version: LATEST }));
    const line = screen.getByText('محضَّر مسبقاً — التحديث سيكون أسرع');
    expect(line.closest('[data-prestage-tone]')?.getAttribute('data-prestage-tone')).toBe('ready');
    await waitFor(() => expect((updateButton() as HTMLButtonElement).disabled).toBe(false));
  });

  it('building', () => {
    renderModal(P({ state: 'building', version: LATEST }));
    expect(screen.getByText('يُحضَّر في الخلفية…')).not.toBeNull();
  });

  it('quarantine names a local time, never the raw ISO', () => {
    renderModal(P({ state: 'quarantine', quarantineUntil: '2026-10-15T12:00:00Z' }));
    const line = screen.getByText(/^سيُحضَّر بعد /);
    expect(line.textContent).not.toContain('2026-10-15T');
  });

  it.each([
    ['low_memory', 'لم يُحضَّر: الذاكرة غير كافية'],
    ['low_disk', 'لم يُحضَّر: المساحة غير كافية'],
    ['policy_off', 'التحضير المسبق متوقف'],
    ['kill_switch', 'التحضير المسبق متوقف'],
    ['backoff', 'لم يُحضَّر بعد'],
  ])('reason %s reads as plain words, never the code', async (reason, text) => {
    renderModal(P({ state: 'waiting', notPrestagedReason: reason }));
    expect(screen.getByText(text)).not.toBeNull();
    expect(screen.queryByText(new RegExp(reason))).toBeNull();
    await waitFor(() => expect((updateButton() as HTMLButtonElement).disabled).toBe(false));
  });

  it('renders nothing for a non-owner (prestage absent)', () => {
    const { container } = renderModal(undefined);
    expect(container.querySelector('[data-prestage-tone]')).toBeNull();
  });

  it('a ready build for an older release is not "ready" for this one', () => {
    renderModal(P({ state: 'ready', version: '2.4.0.0' }));
    expect(screen.queryByText(/التحديث سيكون أسرع/)).toBeNull();
    expect(screen.getByText('لم يُحضَّر بعد')).not.toBeNull();
  });
});

describe('prestaged job', () => {
  function resumeJob(body: Record<string, unknown>) {
    localStorage.setItem(UPDATE_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: 'k', jobId: 'job-p', statusUrl: '/api/system/update/jobs/job-p',
      targetVersion: LATEST, createdAt: Date.now(),
    }));
    authenticatedFetch.mockImplementation(async (url: string) => url === '/api/system/update/jobs/job-p'
      ? response(200, { targetVersion: LATEST, strategy: 'git-checkout-v2', ...body })
      : response(200, { job: null }));
  }

  it('marks the build stage as prepared in advance and hides the pre-click line', async () => {
    resumeJob({ state: 'candidate_sealed', prestaged: true, prestageRejectedReason: null });
    renderModal(P({ state: 'adopted', version: LATEST }));
    const badge = await screen.findByText('محضَّر مسبقاً');
    expect(badge.closest('li')?.textContent).toContain(arCommon.versionUpdate.phases.staging.name);
    expect(document.querySelector('[data-prestage-tone]')).toBeNull();
  });

  it('a rejected prestage shows only the subtle rebuilt note, no alert', async () => {
    resumeJob({ state: 'staging', prestaged: false, prestageRejectedReason: 'identity_mismatch' });
    renderModal(null);
    const note = await screen.findByText('أُعيد التحضير');
    expect(note.closest('[role="alert"]')).toBeNull();
    expect(screen.queryByText(/identity_mismatch/)).toBeNull();
    expect(screen.queryByText('محضَّر مسبقاً')).toBeNull();
  });

  it('a normal job shows neither mark', async () => {
    resumeJob({ state: 'staging' });
    renderModal(null);
    await screen.findByText(arCommon.versionUpdate.phases.staging.name);
    expect(screen.queryByText('محضَّر مسبقاً')).toBeNull();
    expect(screen.queryByText('أُعيد التحضير')).toBeNull();
  });
});
