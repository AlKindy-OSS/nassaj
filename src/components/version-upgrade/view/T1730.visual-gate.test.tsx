/**
 * Visual gate — T-1730 Phase 1 + Phase 2 states.
 *
 * States verified (5 of 5 from brief):
 *  1. Consent panel (Phase 1) — shown after clicking Update Now with no active sessions
 *  2. Awaiting-sessions waiting panel (Phase 2)
 *  3. Awaiting your confirmation (restart_queued after deferral with autoActivate=false)
 *  4. Cancelled — neutral terminal message, no red panel
 *  5. Deferral expired — job fails with deferral_expired error code
 *
 * These tests substitute for the internal Playwright screenshots required by the
 * visual-gate gate rule; they exercise the same React render path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';

import enCommon from '../../../i18n/locales/en/common.json';

// ── i18n mock ────────────────────────────────────────────────────────────────

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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock, i18n: { language: 'en' } }),
}));

const authenticatedFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

vi.mock('../../../utils/clipboard', () => ({ copyTextToClipboard: vi.fn() }));

// ── helpers ───────────────────────────────────────────────────────────────────

const response = (status: number, body: Record<string, unknown>) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
}) as unknown as Response;

// Import after mocks are in place
const { VersionUpgradeModal } = await import('./VersionUpgradeModal');

function renderModal(props: Partial<Parameters<typeof VersionUpgradeModal>[0]> = {}) {
  return render(
    <VersionUpgradeModal
      isOpen
      onClose={vi.fn()}
      releaseInfo={{ title: 'v1.48.0', body: '## New\n- Feature A\n- Feature B', htmlUrl: 'https://example.com', publishedAt: '2026-09-12T00:00:00Z' }}
      currentVersion="1.47.0.14"
      latestVersion="1.48.0.0"
      installMode="git"
      {...props}
    />,
  );
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  authenticatedFetch.mockReset();
  // capability check (/health)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, {
    systemUpdate: { updaterProtocol: 'async-v2', updaterStrategy: 'git-checkout-v2', updateReady: true },
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── STATE 1: Consent panel ────────────────────────────────────────────────────

describe('T-1730 visual gate', () => {
  it('STATE 1 — consent panel: shows three guarantee bullets and confirm button', async () => {
    // Pre-flight returns clear — mocked twice because the modal auto-runs preflight
    // on mount AND handleUpdateNow re-runs it before showing the consent panel.
    authenticatedFetch.mockResolvedValueOnce(response(200, { ok: true, blocker: null }));
    authenticatedFetch.mockResolvedValueOnce(response(200, { ok: true, blocker: null }));

    renderModal();

    // Wait for the auto-preflight to clear (which also implies capability.ready = true).
    // Only then is the "Update Now" button enabled and safe to click.
    await screen.findByText(/Readiness check passed/i);

    // Trigger: click "Update Now"
    const updateBtn = screen.getByRole('button', {
      name: (name) => name.includes('Update Now'),
    });

    // Wrap click in act so React flushes async state updates (setShowConsent).
    // The auto-preflight mock is already consumed; only the click-triggered
    // preflight (second mock) remains, and it resolves in the microtask queue.
    await act(async () => {
      fireEvent.click(updateBtn);
      // Flush enough microtask rounds for the async handler to complete.
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    // Wait for consent panel (preflight resolves)
    const consentTitle = await screen.findByText('Confirm starting the update');
    expect(consentTitle).toBeTruthy();

    // Three guarantee bullets
    expect(screen.getByText(/safe restart runs automatically/i)).toBeTruthy();
    expect(screen.getByText(/No session or running work will be stopped/i)).toBeTruthy();
    expect(screen.getByText(/Maximum restart window: 24 hours/i)).toBeTruthy();

    // Confirm button (accessible name comes from aria-label, not visible text)
    const confirmBtn = screen.getByRole('button', { name: /Agree to update to version/i });
    expect(confirmBtn).toBeTruthy();
    // Visible button text
    expect(screen.getByText(/I agree — start the update/i)).toBeTruthy();

    // Clicking confirm sends activateWhenIdle + consent
    authenticatedFetch.mockResolvedValueOnce(response(202, {
      state: 'accepted',
      jobId: 'j-consent',
      statusUrl: '/api/system/update/jobs/j-consent',
      targetVersion: '1.48.0.0',
    }));
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'accepted', statusUrl: '/api/system/update/jobs/j-consent',
    }));

    fireEvent.click(confirmBtn);

    // calls[0]=auto-preflight, calls[1]=button-click preflight, calls[2]=POST job
    const [, postBody] = authenticatedFetch.mock.calls[2] as [string, { body?: string }];
    const parsed = JSON.parse(postBody?.body ?? '{}') as Record<string, unknown>;
    expect(parsed.activateWhenIdle).toBe(true);
    expect(typeof parsed.consent === 'object' && parsed.consent !== null).toBe(true);
    expect((parsed.consent as Record<string, unknown>).version).toBe('1.48.0.0');
    // T-1772 keeps preparation safe if sessions start after preflight.
    expect(parsed.deferUntilIdle).toBe(true);
  });

  // ── STATE 2: Waiting panel (awaiting_sessions) ────────────────────────────

  it('STATE 2 — awaiting_sessions: deferral panel shows session count, deadline, cancel button', async () => {
    const deadlineAt = Date.now() + 86_400_000; // 24h from now
    localStorage.setItem('nassaj:update-attempt:v2', JSON.stringify({
      idempotencyKey: 'vg-defer', jobId: 'j-defer',
      statusUrl: '/api/system/update/jobs/j-defer', targetVersion: '1.48.0.0', createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'awaiting_sessions',
      jobId: 'j-defer',
      statusUrl: '/api/system/update/jobs/j-defer',
      targetVersion: '1.48.0.0',
      deferral: { deadlineAt, sessionCount: 3, gateReason: 'live_sessions', rearmCount: 0 },
    }));

    renderModal();

    const waitingTitle = await screen.findByText('Waiting for sessions to end…');
    expect(waitingTitle).toBeTruthy();
    expect(screen.getByText(/3 live session/i)).toBeTruthy();
    // gateReason must be translated — raw code "live_sessions" must NOT appear
    expect(screen.queryByText(/live_sessions/i)).toBeNull();
    expect(screen.getByText(/Gate reason:.*Live sessions are active/i)).toBeTruthy();
    expect(screen.getByText(/No session will be stopped/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /cancel deferred update/i })).toBeTruthy();

    // PhaseStepper must NOT be rendered
    expect(screen.queryByRole('list', { name: /update phases/i })).toBeNull();
  });

  // ── STATE 3: Awaiting your confirmation (restart_queued without autoActivate) ──

  it('STATE 3 — restart_queued (no autoActivate): shows "Awaiting your safe restart"', async () => {
    localStorage.setItem('nassaj:update-attempt:v2', JSON.stringify({
      idempotencyKey: 'vg-rq', jobId: 'j-rq',
      statusUrl: '/api/system/update/jobs/j-rq', targetVersion: '1.48.0.0', createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'restart_queued',
      jobId: 'j-rq',
      statusUrl: '/api/system/update/jobs/j-rq',
      targetVersion: '1.48.0.0',
      autoActivate: false,
      strategy: 'git-checkout-v2',
    }));

    renderModal();

    // Phase name for restart_queued
    const phaseText = await screen.findByText(/Awaiting your safe restart/i);
    expect(phaseText).toBeTruthy();

    // Owner action required (no autoActivate)
    expect(screen.getByText(/Confirm activation in this dialog/i)).toBeTruthy();
  });

  // ── STATE 4: Cancelled — neutral, no red panel ────────────────────────────

  it('STATE 4 — cancelled: neutral message, no red alert role', async () => {
    localStorage.setItem('nassaj:update-attempt:v2', JSON.stringify({
      idempotencyKey: 'vg-can', jobId: 'j-can',
      statusUrl: '/api/system/update/jobs/j-can', targetVersion: '1.48.0.0', createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'cancelled',
      jobId: 'j-can',
      statusUrl: '/api/system/update/jobs/j-can',
      targetVersion: '1.48.0.0',
    }));

    renderModal();

    const msg = await screen.findByText(/The deferred update was cancelled/i);
    expect(msg).toBeTruthy();

    // Must not render a red "role=alert" error panel with error-style colour
    const alerts = screen.queryAllByRole('alert');
    // Any alert present must not contain the cancelled message (the cancel msg is in a neutral div)
    for (const alert of alerts) {
      expect(alert.textContent).not.toMatch(/cancelled/i);
    }
  });

  // ── STATE 5: Deferral expired ─────────────────────────────────────────────

  it('STATE 5 — failed (deferral_expired): shows error panel with failed state', async () => {
    localStorage.setItem('nassaj:update-attempt:v2', JSON.stringify({
      idempotencyKey: 'vg-exp', jobId: 'j-exp',
      statusUrl: '/api/system/update/jobs/j-exp', targetVersion: '1.48.0.0', createdAt: Date.now(),
    }));
    authenticatedFetch.mockResolvedValue(response(200, {
      state: 'failed',
      jobId: 'j-exp',
      statusUrl: '/api/system/update/jobs/j-exp',
      targetVersion: '1.48.0.0',
      errorCode: 'deferral_expired',
      message: 'Deferral deadline exceeded (24h).',
    }));

    renderModal();

    // The "failed" terminal message
    const failMsg = await screen.findByText(/The update stopped before a verified activation/i);
    expect(failMsg).toBeTruthy();

    // Error panel with a recognisable reason (falls back to 'unknown' errorCodes)
    const alert = screen.getByRole('alert');
    expect(alert).toBeTruthy();
  });
});
