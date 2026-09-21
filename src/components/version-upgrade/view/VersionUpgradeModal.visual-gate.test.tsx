/**
 * Visual gate: renders 3 required modal states and checks their DOM structure
 * against the approved brief (T-1748/T-1750).
 *
 * States checked:
 *  1. active staging  — stepper at phase 4, 38%, spinning loader
 *  2. restart_queued  — stepper at phase 6, 63%, Clock icon, owner action status
 *  3. failed/staging + dirty_worktree — red failed phase, error panel
 *
 * These DOM assertions complement the required rendered browser inspection;
 * they do not replace a screenshot-based visual check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import enCommon from '../../../i18n/locales/en/common.json';

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

describe('Visual gate — 3 required modal states', () => {
  beforeEach(() => {
    localStorage.clear();
    authenticatedFetch.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, {
      systemUpdate: { updaterProtocol: 'async-v2', updaterStrategy: 'git-checkout-v2', updateReady: true },
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // ── State 1: active staging ──────────────────────────────────────────────

  it('STATE 1 — staging (38%): stepper shows all 9 phases, highlights "Building candidate"', async () => {
    localStorage.setItem('nassaj:update-attempt:v2', JSON.stringify({
      idempotencyKey: 'vg-1', jobId: 'vg-j1',
      statusUrl: '/api/system/update/jobs/vg-j1', targetVersion: '1.45.0.0', createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'staging', targetVersion: '1.45.0.0', strategy: 'git-checkout-v2',
    }));
    renderModal();

    // All 9 phase names are present in the stepper
    const expectedNames = [
      'Queued', 'Finding release', 'Release locked', 'Building candidate',
      'Sealed, ready', 'Awaiting your safe restart', 'Activating', 'Verifying runtime', 'Done',
    ];
    for (const name of expectedNames) {
      expect(screen.getByText(name), `Phase "${name}" must be visible`).not.toBeNull();
    }

    // Current phase description is shown
    await screen.findByText(/Fetching the release, checking tree and branch cleanliness/);

    // Progress bar is determinate at 38%
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuenow')).toBe('38');
    expect(progressbar.getAttribute('aria-valuemin')).toBe('0');
    expect(progressbar.getAttribute('aria-valuemax')).toBe('100');

    // Step counter line shows "Step 4 of 9 · 38%"
    expect(screen.getByText('Step 4 of 9 · 38%')).not.toBeNull();
    // Percent text also visible separately
    expect(screen.getAllByText('38%').length).toBeGreaterThan(0);

    // Loader spinner present (not restart_queued, not activated)
    expect(document.querySelector('svg.animate-spin')).not.toBeNull();

    // No error panel
    expect(screen.queryByRole('alert')).toBeNull();

    // Stepper is an ordered list with correct aria-label
    const ol = document.querySelector('ol[aria-label="Update phases"]');
    expect(ol).not.toBeNull();
    expect(ol!.querySelectorAll('li').length).toBe(9);

    // staging phase has aria-current="step"
    const currentStep = document.querySelector('li[aria-current="step"]');
    expect(currentStep).not.toBeNull();
    expect(currentStep!.textContent).toContain('Building candidate');
  });

  // ── State 2: restart_queued ─────────────────────────────────────────────

  it('STATE 2 — restart_queued (63%): Clock icon, amber bar, owner action status', async () => {
    localStorage.setItem('nassaj:update-attempt:v2', JSON.stringify({
      idempotencyKey: 'vg-2', jobId: 'vg-j2',
      statusUrl: '/api/system/update/jobs/vg-j2', targetVersion: '1.45.0.0', createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'restart_queued', targetVersion: '1.45.0.0', strategy: 'git-checkout-v2',
    }));
    renderModal();

    // Phase name highlighted
    await screen.findByText('Awaiting your safe restart');

    // Phase description visible
    expect(screen.getByText(/will not advance until you press the safe restart button/)).not.toBeNull();

    // Progress bar is present at 63% (determinate)
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuenow')).toBe('63');

    // Step counter shows step 6 of 9 · 63%
    expect(screen.getByText('Step 6 of 9 · 63%')).not.toBeNull();

    // No spinning Loader2 (Clock is used for restart_queued)
    expect(document.querySelector('svg.animate-spin')).toBeNull();

    // Owner action status element is present
    const statusEl = screen.getByRole('status');
    expect(statusEl.textContent).toContain('Confirm activation in this dialog');

    // No error panel shown
    expect(screen.queryByRole('alert')).toBeNull();

    // aria-current="step" on restart_queued phase
    const currentStep = document.querySelector('li[aria-current="step"]');
    expect(currentStep).not.toBeNull();
    expect(currentStep!.textContent).toContain('Awaiting your safe restart');
  });

  // ── State 3: failed at staging with dirty_worktree ──────────────────────

  it('STATE 3 — failed/staging+dirty_worktree: red phase marker + error panel', async () => {
    localStorage.setItem('nassaj:update-attempt:v2', JSON.stringify({
      idempotencyKey: 'vg-3', jobId: 'vg-j3',
      statusUrl: '/api/system/update/jobs/vg-j3', targetVersion: '1.45.0.0', createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'failed',
      targetVersion: '1.45.0.0',
      strategy: 'git-checkout-v2',
      errorCode: 'dirty_worktree',
      message: 'Uncommitted change detected at src/app.ts',
      failedPhase: 'staging',
    }));
    renderModal();

    // Terminal summary still shows jobStatus.failed text
    await screen.findByText(/The update stopped before a verified activation/);

    // Error panel is present with correct content
    const errorPanel = screen.getByRole('alert');
    expect(errorPanel).not.toBeNull();
    expect(errorPanel.textContent).toContain('Uncommitted local changes');
    expect(errorPanel.textContent).toContain('Commit or stash all local changes');
    expect(errorPanel.textContent).toContain('Uncommitted change detected at src/app.ts');

    // Phase stepper still shows all 9 phases
    const ol = document.querySelector('ol[aria-label="Update phases"]');
    expect(ol).not.toBeNull();
    expect(ol!.querySelectorAll('li').length).toBe(9);

    // No progress bar (failed state has no bar)
    expect(screen.queryByRole('progressbar')).toBeNull();

    // No spinning loader
    expect(document.querySelector('svg.animate-spin')).toBeNull();

    // "staging" phase should be highlighted as the failed phase
    // (it appears in the stepper and has the error description)
    const allLis = Array.from(ol!.querySelectorAll('li'));
    const stagingLi = allLis.find(li => li.textContent?.includes('Building candidate'));
    expect(stagingLi).not.toBeNull();

    // No aria-current="step" on any item (failed state)
    expect(document.querySelector('li[aria-current="step"]')).toBeNull();
  });
});
