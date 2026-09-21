/**
 * PendingActionsPanel.forceRestart.test.tsx — T-1677
 *
 * Tests for the force-restart button and confirmation dialog:
 *
 *   1. confirm_required → dialog opens with the correct session count.
 *   2. Confirming sends confirmKillSessions:true with confirmedSessionCount matching
 *      the count displayed in the dialog.
 *   3. restarting on the first request → no dialog, no confirm step.
 *
 * `t` resolves against the REAL en JSON so a missing translation key fails here
 * instead of silently rendering the key string in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import enSettings from '../../../../i18n/locales/en/settings.json';

// ── i18n stub (identical to PendingActionsPanel.raw.test.tsx) ────────────────

function lookup(bundle: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    bundle,
  );
  return typeof value === 'string' ? value : undefined;
}

function interpolate(template: string, opts?: Record<string, unknown>): string {
  if (!opts) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    opts[name] === undefined ? whole : String(opts[name]),
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const bundle = ns === 'settings' ? enSettings : enSidebar;
      return interpolate(
        lookup(bundle, key) ?? (opts?.defaultValue as string) ?? key,
        opts,
      );
    },
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// ── Collaborators ────────────────────────────────────────────────────────────

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

const CANDIDATE_BUILD_ID = 'b'.repeat(64);
const QUEUED_ROW = {
  id: 'row-queued', actionType: 'safe-restart', status: 'pending' as const, reason: null,
  sessionId: null, requestedAt: '2026-09-10T16:00:00Z',
  expectedServerBuildId: CANDIDATE_BUILD_ID, commandPreview: '',
  label: 'Safe restart', error: null,
};
let currentRole = 'owner';
vi.mock('../../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner', role: currentRole } }),
}));

const restartWatch = {
  isRestarting: false,
  isSuccess: false,
  startPolling: vi.fn(),
  reset: vi.fn(),
};
vi.mock('../../../../hooks/useRestartWatch', () => ({
  useRestartWatch: () => restartWatch,
  waitForExpectedServerBuildLoaded: vi.fn().mockResolvedValue(false),
}));

const authenticatedFetch = vi.fn();
vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

// Suppress restartSignal side-effects (localStorage not available in jsdom by default)
vi.mock('../../../../utils/restartSignal', () => ({
  publishRestartSignal: vi.fn(),
  restartCooldownRemainingMs: () => 0,
  subscribeRestartSignal: () => () => {},
}));

const PendingActionsPanel = (await import('./PendingActionsPanel')).default;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SESSION_LIST = [
  { pid: 100, provider: 'claude', ageS: 120, title: 'Test Session' },
  { pid: 101, provider: 'claude', ageS: 60 },
];

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    restartRequired: true,
    actions: [QUEUED_ROW],
    loading: false,
    execute: vi.fn(),
    dismiss: vi.fn(),
    rawCommands: [],
    onRawQueueChange: vi.fn(),
    ...overrides,
  };
}

/** Mock POST /api/system/actions/:type/run for force-restart */
function mockForceRestartRun(response: Record<string, unknown>) {
  authenticatedFetch.mockImplementation((url: string) => {
    if (url === '/api/system/actions/force-restart/run') {
      return Promise.resolve({ ok: true, json: async () => response });
    }
    // safe-restart identity check
    if (url === '/health') {
      return Promise.resolve({
        ok: false,
        json: async () => ({}),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

beforeEach(() => {
  currentRole = 'owner';
  navigate.mockReset();
  authenticatedFetch.mockReset();
  restartWatch.startPolling.mockReset();
  authenticatedFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
  // B-1023: force-restart is generation-bound — the click reads the visible
  // server candidate from the public /health (global fetch) before any POST.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      status: 'ok', restartRequired: true, serverPreviewActivationV2: true,
      serverCandidateBuildId: CANDIDATE_BUILD_ID, serverLoadedBuildId: 'a'.repeat(64),
      serverPromotedBuildId: null, serverBuildIdOnDisk: 'a'.repeat(64),
    }),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('T-1677 — force-restart button', () => {
  it('force-restart button is visible to owner when restartRequired', () => {
    render(<PendingActionsPanel {...baseProps()} />);

    const button = screen.queryByRole('button', {
      name: enSidebar.pendingActions.forceRestartButton,
    });
    expect(button).not.toBeNull();
  });

  it('confirm_required response opens confirmation dialog with correct session count', async () => {
    const SESSION_COUNT = 2;
    mockForceRestartRun({
      status: 'confirm_required',
      reasonCode: 'live_sessions',
      sessionCount: SESSION_COUNT,
      liveSessions: SESSION_LIST,
      liveCount: SESSION_COUNT,
    });

    render(<PendingActionsPanel {...baseProps()} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: enSidebar.pendingActions.forceRestartButton,
      }),
    );

    // Dialog must open
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /kill/i })).toBeTruthy();
    });

    // Dialog title must include the count
    const expectedTitle = interpolate(enSidebar.pendingActions.forceRestartConfirmTitle, {
      count: SESSION_COUNT,
    });
    expect(screen.getByText(expectedTitle)).toBeTruthy();

    // Session titles visible
    expect(screen.getByText('Test Session')).toBeTruthy();
  });

  it('confirming sends confirmKillSessions:true and confirmedSessionCount matching the dialog count', async () => {
    const SESSION_COUNT = 3;

    // First call: confirm_required
    authenticatedFetch
      .mockImplementation((url: string) => {
        if (url === '/api/system/actions/force-restart/run') {
          // Track how many times called and return different responses
          const callCount = (authenticatedFetch.mock.calls as unknown[]).filter(
            (call) => (call as [string])[0] === url,
          ).length;
          if (callCount <= 1) {
            return Promise.resolve({
              ok: true,
              json: async () => ({
                status: 'confirm_required',
                reasonCode: 'live_sessions',
                sessionCount: SESSION_COUNT,
                liveSessions: [{ pid: 100, provider: 'claude', ageS: 60 }],
              }),
            });
          }
          return Promise.resolve({ ok: true, json: async () => ({ status: 'restarting' }) });
        }
        return Promise.resolve({ ok: false, json: async () => ({}) });
      });

    render(<PendingActionsPanel {...baseProps()} />);

    // Click force restart
    fireEvent.click(
      screen.getByRole('button', {
        name: enSidebar.pendingActions.forceRestartButton,
      }),
    );

    // Wait for dialog
    await screen.findByRole('dialog', { name: /kill/i });

    // Click confirm
    fireEvent.click(
      screen.getByRole('button', {
        name: enSidebar.pendingActions.forceRestartConfirm,
      }),
    );

    await waitFor(() => {
      // Should have been called twice: first request + confirmation
      const forceCalls = (authenticatedFetch.mock.calls as [string, RequestInit][]).filter(
        ([url]) => url === '/api/system/actions/force-restart/run',
      );
      expect(forceCalls.length).toBeGreaterThanOrEqual(2);

      const [, confirmOpts] = forceCalls[1];
      const body = JSON.parse(confirmOpts.body as string) as Record<string, unknown>;
      expect(body.confirmKillSessions).toBe(true);
      expect(body.confirmedSessionCount).toBe(SESSION_COUNT);
      expect(body.expectedServerBuildId).toBe(CANDIDATE_BUILD_ID);
    });
  });

  it('restarting on first request does not open the confirmation dialog', async () => {
    mockForceRestartRun({ status: 'restarting' });

    render(<PendingActionsPanel {...baseProps()} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: enSidebar.pendingActions.forceRestartButton,
      }),
    );

    await waitFor(() => {
      expect(authenticatedFetch).toHaveBeenCalled();
    });

    // The confirmation dialog must NOT have opened
    expect(
      screen.queryByRole('dialog', { name: /kill/i }),
    ).toBeNull();

    // startPolling is called (the panel enters restarting state)
    expect(restartWatch.startPolling).toHaveBeenCalled();
  });

  it('cancel in the confirmation dialog closes it without sending a second request', async () => {
    mockForceRestartRun({
      status: 'confirm_required',
      reasonCode: 'live_sessions',
      sessionCount: 1,
      liveSessions: [{ pid: 99, provider: 'claude', ageS: 30 }],
    });

    render(<PendingActionsPanel {...baseProps()} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: enSidebar.pendingActions.forceRestartButton,
      }),
    );

    const confirmDialog = await screen.findByRole('dialog', { name: /kill/i });

    // Press cancel — scoped to the confirm dialog to avoid ambiguity with the panel footer Cancel
    fireEvent.click(
      within(confirmDialog).getByRole('button', { name: /cancel/i }),
    );

    // Dialog gone
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /kill/i })).toBeNull();
    });

    // Only one request (the initial one)
    const forceCalls = (authenticatedFetch.mock.calls as [string][]).filter(
      ([url]) => url === '/api/system/actions/force-restart/run',
    );
    expect(forceCalls.length).toBe(1);
  });

  it('live_work: confirmedSessionCount is liveCount (not sessionCount=0) to avoid confirm_required loop', async () => {
    // reasonCode:'live_work' — sessionCount=0 (no interactive sessions to list),
    // liveCount=2 (worktrees). The server compares against liveCount, so the
    // confirmation payload must carry liveCount, not the bare sessionCount.
    const LIVE_COUNT = 2;

    authenticatedFetch
      .mockImplementation((url: string) => {
        if (url === '/api/system/actions/force-restart/run') {
          const callCount = (authenticatedFetch.mock.calls as unknown[]).filter(
            (call) => (call as [string])[0] === url,
          ).length;
          if (callCount <= 1) {
            return Promise.resolve({
              ok: true,
              json: async () => ({
                status: 'confirm_required',
                reasonCode: 'live_work',
                sessionCount: 0,
                liveSessions: [],
                liveCount: LIVE_COUNT,
              }),
            });
          }
          return Promise.resolve({ ok: true, json: async () => ({ status: 'restarting' }) });
        }
        return Promise.resolve({ ok: false, json: async () => ({}) });
      });

    render(<PendingActionsPanel {...baseProps()} />);

    fireEvent.click(
      screen.getByRole('button', { name: enSidebar.pendingActions.forceRestartButton }),
    );

    // Dialog must open with live_work title containing LIVE_COUNT
    const expectedTitle = interpolate(enSidebar.pendingActions.forceRestartConfirmTitleWork, {
      count: LIVE_COUNT,
    });
    // Wait for the title to appear (the dialog is a portal; findByText waits)
    await screen.findByText(expectedTitle);

    // Click confirm — the button text is unique across both open dialogs
    fireEvent.click(
      screen.getByRole('button', {
        name: enSidebar.pendingActions.forceRestartConfirm,
      }),
    );

    await waitFor(() => {
      const forceCalls = (authenticatedFetch.mock.calls as [string, RequestInit][]).filter(
        ([url]) => url === '/api/system/actions/force-restart/run',
      );
      expect(forceCalls.length).toBeGreaterThanOrEqual(2);
      const body = JSON.parse(forceCalls[1][1].body as string) as Record<string, unknown>;
      // Must send liveCount (2), NOT sessionCount (0)
      expect(body.confirmedSessionCount).toBe(LIVE_COUNT);
      expect(body.confirmKillSessions).toBe(true);
    });
  });
});

describe('B-1023 — force-restart is bound to the visible server candidate', () => {
  it('fails closed without POST when the candidate identity is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    // A legacy queued row without a bound candidate: the strict identity is the only source.
    render(<PendingActionsPanel {...baseProps({ actions: [{ ...QUEUED_ROW, expectedServerBuildId: null }] })} />);
    fireEvent.click(screen.getByRole('button', { name: enSidebar.pendingActions.forceRestartButton }));
    await waitFor(() => expect(screen.getByText(enSidebar.pendingActions.errorPreviewIdentity)).toBeTruthy());
    const forceCalls = authenticatedFetch.mock.calls.filter(
      (c: unknown[]) => c[0] === '/api/system/actions/force-restart/run',
    );
    expect(forceCalls).toHaveLength(0);
  });
});

describe('B-1026 — a queued candidate wins over the strict preview identity', () => {
  it('uses the queued row expectedServerBuildId even when /health identity is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    const QUEUED = 'd'.repeat(64);
    mockForceRestartRun({ status: 'restarting' });
    render(<PendingActionsPanel {...baseProps({
      actions: [{
        id: 'row-1', actionType: 'safe-restart', status: 'pending' as const, reason: null,
        sessionId: null, requestedAt: '2026-09-10T16:00:00Z',
        expectedServerBuildId: QUEUED, commandPreview: '',
        label: 'Safe restart', error: null,
      }],
    })} />);
    fireEvent.click(screen.getByRole('button', { name: enSidebar.pendingActions.forceRestartButton }));
    await waitFor(() => {
      const forceCalls = authenticatedFetch.mock.calls.filter(
        (c: unknown[]) => c[0] === '/api/system/actions/force-restart/run',
      );
      expect(forceCalls).toHaveLength(1);
      const body = JSON.parse(forceCalls[0][1].body as string) as Record<string, unknown>;
      expect(body.expectedServerBuildId).toBe(QUEUED);
    });
  });
});

describe('owner decision 2026-09-10 — the force button needs a queued command', () => {
  it('is hidden when the queue is empty even if restartRequired', () => {
    render(<PendingActionsPanel {...baseProps({ actions: [] })} />);
    expect(screen.queryByRole('button', { name: enSidebar.pendingActions.forceRestartButton })).toBeNull();
  });
});

describe('owner decision 2026-09-10 — force button is independent of restartRequired', () => {
  it('is visible with a queued command even when restartRequired is false', () => {
    render(<PendingActionsPanel {...baseProps({ restartRequired: false })} />);
    expect(screen.queryByRole('button', { name: enSidebar.pendingActions.forceRestartButton })).not.toBeNull();
  });
});
