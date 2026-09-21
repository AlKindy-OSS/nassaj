/**
 * PendingActionsPanel.restartCooldown.test.tsx — T-1296
 *
 * الحارس القديم في هذا الملف كان `if (cur === 'executing' || cur === 'restarting')`
 * — حالةُ مكوّنٍ واحد. لا يرى تبويباً ثانياً، ولا مرآة جلسة لمشاهد آخر، ولا نفسه
 * بعد إعادة تحميل الصفحة. وحارس `restartInFlight` في الخادم يعيش في ذاكرة العملية،
 * وإعادة التشغيل تستبدل تلك العملية — فالضغطة الثانية بعد ثانيتين تصل عمليةً
 * وليدةً بحارس نظيف وتُنفَّذ فعلاً (ثلاث إعادات في أربع ثوانٍ، 2026-08-04 22:18).
 *
 * لذلك الاختبار الحاسم هنا ليس «ضغطتان على نفس النسخة»، بل: نسخة جديدة تماماً من
 * اللوحة — بلا أي حالة سابقة، كما هي حال تبويب آخر أو صفحة أُعيد تحميلها — لا
 * تعرض زرّ التنفيذ ولا تُصدر طلباً ثانياً.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

import { useServerActions } from '../../../../hooks/useServerActions';
import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import { __resetRestartSignalForTests } from '../../../../utils/restartSignal';

vi.mock('../../../../contexts/WebSocketContext', () => ({ useWebSocket: () => ({ latestMessage: null }) }));

// ── i18n: resolve against the real en bundle ─────────────────────────────────

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
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      interpolate(lookup(enSidebar, key) ?? (opts?.defaultValue as string) ?? key, opts),
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

const authState = vi.hoisted(() => ({ user: { id: 1, username: 'owner', role: 'owner' } }));
vi.mock('../../../auth/context/AuthContext', () => ({ useAuth: () => authState }));

/** Frozen identity — the panel resets state in an effect keyed on `reset`. */
const restartWatch = {
  isRestarting: false,
  isSuccess: false,
  startPolling: vi.fn(),
  reset: vi.fn(),
};
vi.mock('../../../../hooks/useRestartWatch', () => ({
  useRestartWatch: () => restartWatch,
  waitForExpectedServerBuildLoaded: async (expectedServerBuildId: string) => {
    const response = await fetch('/health', { cache: 'no-store' });
    if (!response.ok) return false;
    const health = await response.json() as Record<string, unknown>;
    return health.serverLoadedBuildId === expectedServerBuildId
      && health.serverBuildIdOnDisk === expectedServerBuildId;
  },
}));

const authenticatedFetch = vi.fn();
vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const PendingActionsPanel = (await import('./PendingActionsPanel')).default;

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    restartRequired: true,
    actions: [],
    loading: false,
    execute: vi.fn(),
    dismiss: vi.fn(),
    rawCommands: [],
    onRawQueueChange: vi.fn(),
    ...overrides,
  };
}

/**
 * T-1684 — a settled request (success, failure, or an outcome nobody could
 * confirm) leaves the queue for the history tab. A receipt for a click made
 * while THIS panel instance stayed open is the one exception, so the tests that
 * reopen or remount the panel must look in history for the same row.
 */
function openHistory() {
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(enSidebar.pendingActions.tabHistory) }));
}

/** Every POST to the restart endpoint, regardless of which instance sent it. */
function restartCalls(): unknown[][] {
  return authenticatedFetch.mock.calls.filter(
    call => typeof call[0] === 'string' && call[0].includes('/actions/safe-restart/run'),
  );
}

beforeEach(() => {
  authState.user = { id: 1, username: 'owner', role: 'owner' };
  __resetRestartSignalForTests();
  localStorage.clear();
  sessionStorage.clear();
  restartWatch.startPolling.mockClear();
  authenticatedFetch.mockReset();
  authenticatedFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'restarting' }),
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      status: 'ok', restartRequired: true, serverPreviewActivationV2: true,
      serverCandidateBuildId: 'b'.repeat(64), serverLoadedBuildId: 'a'.repeat(64),
      serverPromotedBuildId: null, serverBuildIdOnDisk: 'a'.repeat(64),
    }),
  }));
});

afterEach(() => {
  cleanup();
  __resetRestartSignalForTests();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('T-1296 — a second press does not become a second restart', () => {
  it('fails closed without POST when health or candidate identity is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'ok', restartRequired: true,
        serverCandidateBuildId: 'b'.repeat(64), serverLoadedBuildId: 'a'.repeat(64),
        // old backend: no serverPreviewActivationV2 capability
      }),
    }));
    render(<PendingActionsPanel {...baseProps()} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));
    await waitFor(() => expect(screen.getByText(enSidebar.pendingActions.errorPreviewIdentity)).toBeTruthy());
    expect(restartCalls()).toHaveLength(0);
  });

  it('fails closed without POST when promoted and loaded identities disagree', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'ok', restartRequired: true, serverPreviewActivationV2: true,
        serverCandidateBuildId: 'b'.repeat(64), serverLoadedBuildId: 'a'.repeat(64),
        serverPromotedBuildId: 'c'.repeat(64), serverBuildIdOnDisk: 'a'.repeat(64),
      }),
    }));
    render(<PendingActionsPanel {...baseProps()} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));
    await waitFor(() => expect(screen.getByText(enSidebar.pendingActions.errorPreviewIdentity)).toBeTruthy());
    expect(restartCalls()).toHaveLength(0);
    expect(restartWatch.startPolling).not.toHaveBeenCalled();
  });

  it('explains when the server rejects a sensitive candidate', async () => {
    authenticatedFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ status: 'error', code: 'sensitive_candidate' }),
    });

    render(<PendingActionsPanel {...baseProps()} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));

    await waitFor(() => {
      expect(screen.getByText(enSidebar.pendingActions.errorSensitiveCandidate)).toBeTruthy();
    });
    expect(restartCalls()).toHaveLength(1);
    expect(restartWatch.startPolling).not.toHaveBeenCalled();
    // Only the pre-flight identity read: a policy error must not enter receipt
    // reconciliation or be hidden by a coincidentally matching generation.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('explains an unverifiable candidate instead of reporting an unexpected error', async () => {
    authenticatedFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ status: 'error', code: 'unknown_candidate' }),
    });

    render(<PendingActionsPanel {...baseProps()} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));

    await waitFor(() => {
      expect(screen.getByText(enSidebar.pendingActions.errorUnknownCandidate)).toBeTruthy();
    });
    expect(restartCalls()).toHaveLength(1);
    expect(restartWatch.startPolling).not.toHaveBeenCalled();
  });

  it('reconciles a direct restart error when the approved generation is already loaded', async () => {
    const expectedServerBuildId = 'b'.repeat(64);
    const healthFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'ok', restartRequired: true, serverPreviewActivationV2: true,
          serverCandidateBuildId: expectedServerBuildId,
          serverLoadedBuildId: 'a'.repeat(64),
          serverPromotedBuildId: null,
          serverBuildIdOnDisk: 'a'.repeat(64),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          restartRequired: false,
          serverLoadedBuildId: expectedServerBuildId,
          serverBuildIdOnDisk: expectedServerBuildId,
        }),
      });
    vi.stubGlobal('fetch', healthFetch);
    authenticatedFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ status: 'error', code: 'superseded' }),
    });

    render(<PendingActionsPanel {...baseProps()} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));

    await waitFor(() => expect(screen.getByText(enSidebar.pendingActions.loadedOutcomeUnverified)).toBeTruthy());
    expect(screen.queryByText(enSidebar.pendingActions.errorGeneric)).toBeNull();
    expect(healthFetch).toHaveBeenCalledTimes(2);
  });

  it('explains an OID activation failure on its queued action without inviting repeated clicks', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'error', code: 'oid_control_failed' });
    const action = {
      id: 'oid-activation-1',
      actionType: 'safe-restart',
      label: 'safeRestart',
      commandPreview: 'bash scripts/preview-safe-restart.sh --exec',
      reason: 'Activate reviewed stable OID',
      sessionId: null,
      status: 'pending' as const,
      error: null,
      requestedAt: '2026-09-02T10:00:00.000Z',
    };

    render(<PendingActionsPanel {...baseProps({ restartRequired: false, actions: [action], execute })} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));

    await waitFor(() => {
      expect(screen.getByText(enSidebar.pendingActions.errorOidControlFailed)).toBeTruthy();
    });
    expect(screen.queryByText(enSidebar.pendingActions.errorGeneric)).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(action.id);
    expect(restartWatch.startPolling).not.toHaveBeenCalled();
  });

  it('reports loaded build without claiming the unproven attempt succeeded', async () => {
    const expectedServerBuildId = 'b'.repeat(64);
    const execute = vi.fn().mockResolvedValue({ status: 'error', code: 'superseded' });
    const action = {
      id: 'oid-activation-loaded',
      actionType: 'safe-restart',
      label: 'safeRestart',
      commandPreview: 'bash scripts/preview-safe-restart.sh --exec',
      reason: 'Activate reviewed stable OID',
      sessionId: null,
      status: 'pending' as const,
      error: null,
      expectedServerBuildId,
      requestedAt: '2026-09-03T06:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        restartRequired: false,
        serverLoadedBuildId: expectedServerBuildId,
        serverBuildIdOnDisk: expectedServerBuildId,
      }),
    }));

    render(<PendingActionsPanel {...baseProps({ restartRequired: false, actions: [action], execute })} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));

    await waitFor(() => expect(screen.getByText(enSidebar.pendingActions.loadedOutcomeUnverified)).toBeTruthy());
    expect(screen.queryByText(enSidebar.pendingActions.errorGeneric)).toBeNull();
    expect(execute).toHaveBeenCalledWith(action.id);
  });

  it('keeps the failure when health reports a different loaded generation', async () => {
    const expectedServerBuildId = 'b'.repeat(64);
    const execute = vi.fn().mockResolvedValue({ status: 'error', code: 'oid_control_failed' });
    const action = {
      id: 'oid-activation-wrong-build',
      actionType: 'safe-restart',
      label: 'safeRestart',
      commandPreview: 'bash scripts/preview-safe-restart.sh --exec',
      reason: 'Activate reviewed stable OID',
      sessionId: null,
      status: 'pending' as const,
      error: null,
      expectedServerBuildId,
      requestedAt: '2026-09-03T06:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        restartRequired: false,
        serverLoadedBuildId: 'c'.repeat(64),
        serverBuildIdOnDisk: 'c'.repeat(64),
      }),
    }));

    render(<PendingActionsPanel {...baseProps({ restartRequired: false, actions: [action], execute })} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));

    await waitFor(() => {
      expect(screen.getByText(enSidebar.pendingActions.errorOidControlFailed)).toBeTruthy();
    });
    expect(screen.queryByText(enSidebar.restart.success)).toBeNull();
  });

  it('explains a loaded artifact mismatch instead of reporting an unexpected error', async () => {
    authenticatedFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ status: 'error', code: 'loaded_artifact_unavailable' }),
    });

    render(<PendingActionsPanel {...baseProps()} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));

    await waitFor(() => {
      expect(screen.getByText(enSidebar.pendingActions.errorLoadedArtifactUnavailable)).toBeTruthy();
    });
    expect(screen.queryByText(enSidebar.pendingActions.errorGeneric)).toBeNull();
    expect(restartCalls()).toHaveLength(1);
    expect(restartWatch.startPolling).not.toHaveBeenCalled();
  });

  it('a brand-new panel instance (another tab / a reload) refuses to trigger again', async () => {
    const first = render(<PendingActionsPanel {...baseProps()} />);

    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));
    await waitFor(() => expect(restartCalls().length).toBe(1));
    expect(restartWatch.startPolling).toHaveBeenCalledTimes(1);

    // Tear the whole component down — no local state survives this. Only a guard
    // that lives OUTSIDE the component can still hold.
    first.unmount();
    render(<PendingActionsPanel {...baseProps()} />);

    // The trigger is gone, replaced by the cooldown notice…
    expect(screen.queryByText(enSidebar.pendingActions.execute)).toBeNull();
    expect(
      screen.getByText(new RegExp(enSidebar.pendingActions.restartCooldown.split('—')[0].trim())),
    ).toBeTruthy();

    // …and nothing further reached the server.
    expect(restartCalls().length).toBe(1);
  });

  it('a deferred attempt restarts nothing, so it must stay retryable', async () => {
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'deferred', detail: 'live work', sessionCount: 2, liveSessions: [] }),
    });

    render(<PendingActionsPanel {...baseProps()} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));

    await waitFor(() => expect(screen.getByText(enSidebar.restart.retry)).toBeTruthy());
    expect(restartCalls().length).toBe(1);

    // No window was opened: the retry actually retries.
    fireEvent.click(screen.getByText(enSidebar.restart.retry));
    await waitFor(() => expect(restartCalls().length).toBe(2));
  });
});


describe('durable action evidence', () => {
  const action = { id: 'durable', actionType: 'safe-restart', label: 'safeRestart',
    commandPreview: null, reason: null, sessionId: null, status: 'pending' as const,
    error: null, expectedServerBuildId: null, requestedAt: '2026-09-05T00:00:00Z' };

  it('does not create another POST for a not_claimable row', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'error', code: 'not_claimable' });
    render(<PendingActionsPanel {...baseProps({ restartRequired: false, actions: [action], execute })} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));
    await waitFor(() => expect(screen.getByText(enSidebar.pendingActions.errorNotClaimable)).toBeTruthy());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(restartCalls()).toHaveLength(0);
  });

  it.each(['live_work', 'live_sessions'])('preserves %s explanation after remount', (reasonCode) => {
    const props = baseProps({ restartRequired: false, actions: [{ ...action, reasonCode, retryable: true }] });
    const first = render(<PendingActionsPanel {...props} />);
    expect(screen.getByText(enSidebar.pendingActions.deferredLiveWork)).toBeTruthy();
    first.unmount();
    render(<PendingActionsPanel {...props} />);
    expect(screen.getByText(enSidebar.pendingActions.deferredLiveWork)).toBeTruthy();
    expect(screen.getByText(enSidebar.restart.retry)).toBeTruthy();
  });

  it.each(['executing', 'unresolved'])('blocks execute and dismiss for %s server evidence', (kind) => {
    const row = { ...action, ...(kind === 'executing' ? { status: 'executing' } : { reasonCode: 'execution_unresolved', retryable: false }) };
    render(<PendingActionsPanel {...baseProps({ restartRequired: false, actions: [row] })} />);
    expect(screen.queryByText(enSidebar.pendingActions.execute)).toBeNull();
    expect(screen.queryByText(enSidebar.restart.retry)).toBeNull();
    expect((screen.getByText(enSidebar.pendingActions.dismiss).closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not poll, report success, or offer retry after losing the direct POST response', async () => {
    authenticatedFetch.mockRejectedValue(new TypeError('network failure'));
    render(<PendingActionsPanel {...baseProps()} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));
    await waitFor(() => expect(screen.getByText(enSidebar.pendingActions.outcomeUnverified)).toBeTruthy());
    expect(screen.getByText(enSidebar.pendingActions.outcomeUnverified).className).not.toContain('text-destructive');
    expect(screen.queryByText(enSidebar.restart.success)).toBeNull();
    expect(restartWatch.startPolling).not.toHaveBeenCalled();
    expect(screen.queryByText(enSidebar.restart.retry)).toBeNull();
    expect(restartCalls()).toHaveLength(1);
  });
});


it('does not let the static restart row bypass an executing durable request', () => {
  const action = { id: 'active', actionType: 'safe-restart', label: 'safeRestart', status: 'executing', reasonCode: 'execution_unresolved', retryable: false };
  render(<PendingActionsPanel {...baseProps({ actions: [action] })} />);
  expect(screen.queryByText(enSidebar.pendingActions.execute)).toBeNull();
  expect(screen.queryByText(enSidebar.restart.retry)).toBeNull();
});

it.each(['static', 'queue'])('locks an unresolved %s execution response before a queue refresh', async (kind) => {
  const execute = vi.fn().mockResolvedValue({ status: 'error', code: 'execution_unresolved' });
  authenticatedFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ code: 'execution_unresolved' }) });
  const action = { id: 'stale', actionType: 'safe-restart', label: 'safeRestart', status: 'pending', reasonCode: null, retryable: true };
  render(<PendingActionsPanel {...baseProps({ restartRequired: kind === 'static', actions: kind === 'queue' ? [action] : [], execute })} />);
  fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));
  await waitFor(() => expect(screen.getByText(enSidebar.pendingActions.outcomeUnverified)).toBeTruthy());
  expect(screen.queryByText(enSidebar.restart.retry)).toBeNull();
  expect(screen.queryByText(enSidebar.pendingActions.execute)).toBeNull();
  expect(restartWatch.startPolling).not.toHaveBeenCalled();
});


describe('safe restart preparation refusals', () => {
  const row = { id: 'preparation', actionType: 'safe-restart', label: 'safeRestart', commandPreview: null,
    reason: null, sessionId: null, status: 'failed' as const, error: null,
    expectedServerBuildId: 'b'.repeat(64), requestedAt: '2026-09-05T00:00:00Z', retryable: true };

  it.each(['unknown_candidate', 'sensitive_candidate'])('blocks persisted %s despite legacy retryability and survives remount', (code) => {
    const props = baseProps({ restartRequired: false, actions: [{ ...row, error: code }] });
    const first = render(<PendingActionsPanel {...props} />);
    expect(screen.queryByText(enSidebar.restart.retry)).toBeNull();
    expect((screen.getByText(enSidebar.pendingActions.dismiss).closest('button') as HTMLButtonElement).disabled).toBe(false);
    first.unmount();
    render(<PendingActionsPanel {...props} />);
    expect(screen.queryByText(enSidebar.restart.retry)).toBeNull();
    expect(screen.getByText(code === 'unknown_candidate' ? enSidebar.pendingActions.errorUnknownCandidate : enSidebar.pendingActions.errorSensitiveCandidate)).toBeTruthy();
  });

  it.each(['unknown_candidate', 'sensitive_candidate'])('blocks local %s while preserving dismiss', async (code) => {
    const execute = vi.fn().mockResolvedValue({ status: 'error', code });
    render(<PendingActionsPanel {...baseProps({ restartRequired: false, actions: [{ ...row, status: 'pending' }], execute })} />);
    fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));
    await waitFor(() => expect(screen.getByText(code === 'unknown_candidate' ? enSidebar.pendingActions.errorUnknownCandidate : enSidebar.pendingActions.errorSensitiveCandidate)).toBeTruthy());
    expect(screen.queryByText(enSidebar.restart.retry)).toBeNull();
    expect((screen.getByText(enSidebar.pendingActions.dismiss).closest('button') as HTMLButtonElement).disabled).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not block another symbolic command carrying the same error code', () => {
    render(<PendingActionsPanel {...baseProps({ restartRequired: false, actions: [{ ...row, actionType: 'custom-check', error: 'unknown_candidate' }] })} />);
    expect(screen.getByText(enSidebar.restart.retry)).toBeTruthy();
  });
});


it('keeps a real POST refusal across failed GET and panel remount without a second POST', async () => {
  const row = { id: 'real-refusal', actionType: 'safe-restart', label: 'Restart', status: 'pending',
    error: null, expectedServerBuildId: null, requestedAt: '2026-09-05T00:00:00Z' };
  authenticatedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ actions: [row] }) });
  const queue = renderHook(() => useServerActions(false));
  await waitFor(() => expect(queue.result.current.actions).toHaveLength(1));
  authenticatedFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ code: 'unknown_candidate' }) });
  const panel = render(<PendingActionsPanel {...baseProps({ restartRequired: false, ...queue.result.current })} />);
  fireEvent.click(screen.getByText(enSidebar.pendingActions.execute));
  await waitFor(() => expect(screen.getByText(enSidebar.pendingActions.errorUnknownCandidate)).toBeTruthy());
  authenticatedFetch.mockRejectedValueOnce(new Error('GET unavailable'));
  await act(async () => { await queue.result.current.refetch(); });
  panel.unmount();
  render(<PendingActionsPanel {...baseProps({ restartRequired: false, ...queue.result.current })} />);
  // The refusal is durable, so on a fresh instance the row is a receipt: no
  // execution control anywhere, and removal offered only from history.
  expect(screen.queryByText(enSidebar.restart.retry)).toBeNull();
  expect(screen.queryByText(enSidebar.pendingActions.execute)).toBeNull();
  openHistory();
  expect(screen.getByText(enSidebar.pendingActions.errorUnknownCandidate)).toBeTruthy();
  expect((screen.getByRole('button', { name: enSidebar.pendingActions.historyRemove }) as HTMLButtonElement).disabled).toBe(false);
  expect(authenticatedFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});


it.each(['failed', 'executing'])('keeps dismiss correct for a %s classifier refusal marked nonretryable by the server', (status) => {
  const row = { id: 'server-refusal', actionType: 'safe-restart', label: 'Restart', status,
    error: 'unknown_candidate', reasonCode: 'unknown_candidate', retryable: false };
  render(<PendingActionsPanel {...baseProps({ restartRequired: false, actions: [row] })} />);
  expect(screen.queryByText(enSidebar.restart.retry)).toBeNull();
  expect((screen.getByText(enSidebar.pendingActions.dismiss).closest('button') as HTMLButtonElement).disabled).toBe(status === 'executing');
});

it.each(['success', 'unknown'])('renders durable %s on reopening without a new execution button', async status => {
  const refreshActions = vi.fn().mockResolvedValue(undefined);
  const execute = vi.fn();
  render(<PendingActionsPanel {...baseProps({ restartRequired: false, execute, refreshActions,
    actions: [{ id: 'receipt-action', actionType: 'safe-restart', label: 'Restart', status: 'executing',
      reasonCode: 'execution_unresolved', retryable: false,
      currentActionOutcome: { status, reasonCode: status === 'success' ? 'oid_loaded' : 'outcome_unverified', retryable: false } }],
  })} />);
  await waitFor(() => expect(refreshActions).toHaveBeenCalledTimes(1));
  openHistory();
  expect(screen.getByText(status === 'success'
    ? enSidebar.pendingActions.historyOutcomeSuccess
    : enSidebar.pendingActions.historyOutcomeUnknown)).toBeTruthy();
  expect(screen.queryByRole('button', { name: enSidebar.pendingActions.execute })).toBeNull();
  expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
  expect(execute).not.toHaveBeenCalled();
});

it('ignores a late execution acknowledgement after the panel account changes', async () => {
  let finish!: (value: { status: 'success' }) => void;
  const execute = vi.fn(() => new Promise<{ status: 'success' }>(resolve => { finish = resolve; }));
  const props = baseProps({ restartRequired: false, execute,
    actions: [{ id: 'same-action', actionType: 'safe-restart', label: 'Restart', status: 'pending' }] });
  const panel = render(<PendingActionsPanel {...props} />);
  fireEvent.click(screen.getByRole('button', { name: enSidebar.pendingActions.execute }));
  authState.user = { id: 2, username: 'reader', role: 'viewer' };
  panel.rerender(<PendingActionsPanel {...props} />);
  await act(async () => { finish({ status: 'success' }); });
  expect(screen.queryByText(enSidebar.restart.success)).toBeNull();
  expect(execute).toHaveBeenCalledTimes(1);
});

it('allows the legacy-server first click, then forbids another click after response loss and reload', async () => {
  authenticatedFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (opts?.method === 'POST') throw new TypeError('response lost');
    return url.endsWith('/outcome') ? { ok: false, status: 404 } : { ok: true, json: async () => ({ actions: [
      { id: 'legacy-action', actionType: 'safe-restart', label: 'Restart', status: 'pending', retryable: true },
    ] }) };
  });
  function LegacyPanel() {
    const queue = useServerActions(false, '1');
    return <PendingActionsPanel {...baseProps({ restartRequired: false, ...queue, refreshActions: queue.refetch })} />;
  }
  const panel = render(<LegacyPanel />);
  fireEvent.click(await screen.findByRole('button', { name: enSidebar.pendingActions.execute }));
  await waitFor(() => expect(authenticatedFetch.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull());
  panel.unmount();
  render(<LegacyPanel />);
  // A reload has no local receipt, so the unconfirmed attempt is history now.
  await waitFor(() => expect(screen.getByRole('tab', { name: new RegExp(enSidebar.pendingActions.tabHistory) }).textContent).toContain('1'));
  openHistory();
  expect(screen.getByText(enSidebar.pendingActions.outcomeUnverified)).toBeTruthy();
  expect(screen.queryByRole('button', { name: enSidebar.pendingActions.execute })).toBeNull();
  expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
  expect(authenticatedFetch.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1);
});

it('restores a manual retry in the open panel only after a verified pending outcome', async () => {
  let reasonCode = 'action_pending';
  let attempted = false;
  authenticatedFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (opts?.method === 'POST') { attempted = true; throw new TypeError('response lost'); }
    return { ok: true, json: async () => url.endsWith('/outcome')
      ? { actionId: 'deferred-action', currentActionOutcome: {
        status: attempted && reasonCode === 'action_pending' ? 'unknown' : 'pending',
        reasonCode: attempted && reasonCode === 'action_pending' ? 'outcome_unverified' : reasonCode,
        retryable: !attempted || reasonCode === 'live_sessions',
      } }
      : { actions: [{ id: 'deferred-action', actionType: 'safe-restart', label: 'Restart',
        status: attempted ? 'executing' : 'pending', reasonCode: attempted ? 'execution_unresolved' : null,
        retryable: !attempted }] } };
  });
  function DeferredPanel() {
    const queue = useServerActions(false, '1');
    return <PendingActionsPanel {...baseProps({ restartRequired: false, ...queue, refreshActions: queue.refetch })} />;
  }
  render(<DeferredPanel />);
  fireEvent.click(await screen.findByRole('button', { name: enSidebar.pendingActions.execute }));
  await screen.findByText(enSidebar.pendingActions.outcomeUnverified);
  expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
  reasonCode = 'live_sessions';
  await act(async () => { window.dispatchEvent(new Event('online')); });
  const retry = await screen.findByRole('button', { name: enSidebar.restart.retry });
  expect(authenticatedFetch.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1);
  fireEvent.click(retry);
  await waitFor(() => expect(authenticatedFetch.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(2));
});

it.each([false, true])('revokes old retry proof before a lost POST while the next GET waits (late earlier GET: %s)', async lateEarlierGet => {
  let phase: 'initial' | 'earlier-get' | 'after-post' = 'initial';
  let releaseEarlier!: (value: unknown) => void;
  let releaseFresh!: (value: unknown) => void;
  const proof = { ok: true, json: async () => ({ actionId: 'proof-action', currentActionOutcome: {
    status: 'pending', reasonCode: 'live_sessions', retryable: true,
  } }) };
  authenticatedFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (opts?.method === 'POST') { phase = 'after-post'; throw new TypeError('response lost'); }
    if (url.endsWith('/outcome')) {
      if (phase === 'earlier-get') return new Promise(resolve => { releaseEarlier = resolve; });
      if (phase === 'after-post') return new Promise(resolve => { releaseFresh = resolve; });
      return proof;
    }
    return { ok: true, json: async () => ({ actions: [{ id: 'proof-action', actionType: 'safe-restart',
      label: 'Restart', status: 'pending', reasonCode: 'live_sessions', retryable: true }] }) };
  });
  function ProofPanel() {
    const queue = useServerActions(false, '1');
    return <PendingActionsPanel {...baseProps({ restartRequired: false, ...queue, refreshActions: queue.refetch })} />;
  }
  render(<ProofPanel />);
  const retry = await screen.findByRole('button', { name: enSidebar.restart.retry });
  if (lateEarlierGet) {
    phase = 'earlier-get';
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(releaseEarlier).toBeTypeOf('function'));
  }
  fireEvent.click(retry);
  await screen.findByText(enSidebar.pendingActions.outcomeUnverified);
  await waitFor(() => expect(releaseFresh).toBeTypeOf('function'));
  expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
  expect(screen.queryByRole('button', { name: enSidebar.pendingActions.execute })).toBeNull();
  if (lateEarlierGet) {
    await act(async () => { releaseEarlier(proof); });
    expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
  }
  expect(authenticatedFetch.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1);
  await act(async () => { releaseFresh(proof); });
  expect(await screen.findByRole('button', { name: enSidebar.restart.retry })).toBeTruthy();
  expect(authenticatedFetch.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1);
});

it('labels an authoritatively superseded request and offers only local reference removal', async () => {
  const dismiss = vi.fn().mockResolvedValue({ status: 'dismissed', id: 'old' });
  render(<PendingActionsPanel {...baseProps({ restartRequired: false, dismiss, actions: [{
    id: 'old', actionType: 'safe-restart', label: 'Old restart', status: 'pending', retryable: false,
    currentActionOutcome: { status: 'failure', reasonCode: 'superseded', retryable: false },
  }] })} />);
  openHistory();
  expect(screen.getByText(enSidebar.pendingActions.superseded)).toBeTruthy();
  expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
  expect(screen.queryByRole('button', { name: enSidebar.pendingActions.execute })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: enSidebar.pendingActions.historyRemove }));
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith('old'));
});

it('keeps unknown requests protected without offering local removal', () => {
  render(<PendingActionsPanel {...baseProps({ restartRequired: false, actions: [{
    id: 'unknown', actionType: 'safe-restart', label: 'Unverified restart', status: 'pending', retryable: false,
    currentActionOutcome: { status: 'unknown', reasonCode: 'superseded', retryable: false },
  }] })} />);
  openHistory();
  // Removing an unconfirmed attempt would erase the only proof it ever ran.
  expect(screen.getByText(enSidebar.pendingActions.historyOutcomeUnknown)).toBeTruthy();
  expect(screen.queryByRole('button', { name: enSidebar.pendingActions.historyRemove })).toBeNull();
  expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
});

/** حقول مطلوبة في PublicAction أُضيفت لاحقاً — تُملأ بقيم آمنة فارغة هنا. */
const _reqFields = { commandPreview: null, reason: null, sessionId: null, error: null, expectedServerBuildId: null, requestedAt: '' } as const;

describe('terminal restart success takes precedence over a stale queue status', () => {
  const action = { ..._reqFields, id: 'terminal', actionType: 'safe-restart', label: 'Restart', status: 'executing' as const, retryable: false };

  it.each(['executing', 'failed', 'pending'])('renders durable success without a stale %s badge or spinner', status => {
    render(<PendingActionsPanel {...baseProps({ restartRequired: false, actions: [{
      ...action, status,
      currentActionOutcome: { status: 'success', reasonCode: 'activated', retryable: false },
    }] })} />);
    openHistory();
    expect(screen.getByText(enSidebar.pendingActions.historyOutcomeSuccess)).toBeTruthy();
    expect(screen.queryByText(enSidebar.pendingActions.statusExecuting)).toBeNull();
    expect(screen.queryByText(enSidebar.pendingActions.statusFailed)).toBeNull();
    expect(screen.queryByText(enSidebar.pendingActions.statusPending)).toBeNull();
    expect(screen.queryByRole('button', { name: enSidebar.pendingActions.execute })).toBeNull();
    expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
  });

  it.each([undefined, 'pending'])('keeps direct success consistent after a stale executing queue refresh (outcome: %s)', async durableStatus => {
    const execute = vi.fn().mockResolvedValue({ status: 'success' });
    const props = baseProps({ restartRequired: false, execute, actions: [{ ...action, status: 'pending', retryable: true }] });
    const panel = render(<PendingActionsPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: enSidebar.pendingActions.execute }));
    await waitFor(() => expect(screen.getAllByText(enSidebar.restart.success)).toHaveLength(2));
    panel.rerender(<PendingActionsPanel {...props} actions={[{
      ...action, status: 'executing',
      ...(durableStatus ? { currentActionOutcome: { status: 'pending', reasonCode: 'execution_unresolved', retryable: false } } : {}),
    }]} />);
    expect(screen.getAllByText(enSidebar.restart.success)).toHaveLength(2);
    expect(screen.queryByText(enSidebar.pendingActions.statusExecuting)).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown', 'failure'])('replaces earlier local success with a later durable %s outcome', async status => {
    const execute = vi.fn().mockResolvedValue({ status: 'success' });
    const props = baseProps({ restartRequired: false, execute, actions: [{ ...action, status: 'pending', retryable: true }] });
    const panel = render(<PendingActionsPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: enSidebar.pendingActions.execute }));
    await waitFor(() => expect(screen.getAllByText(enSidebar.restart.success)).toHaveLength(2));
    panel.rerender(<PendingActionsPanel {...props} actions={[{
      ...action, status: 'executing',
      currentActionOutcome: { status: status as 'unknown' | 'failure', reasonCode: 'execution_unresolved', retryable: false },
    }]} />);
    expect(screen.queryByText(enSidebar.restart.success)).toBeNull();
    expect(screen.queryByRole('button', { name: enSidebar.pendingActions.execute })).toBeNull();
    expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
    expect((screen.getByRole('button', { name: enSidebar.pendingActions.dismiss }) as HTMLButtonElement).disabled).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown', 'failure'])('does not convert a durable %s outcome into success', status => {
    render(<PendingActionsPanel {...baseProps({ restartRequired: false, actions: [{
      ...action, currentActionOutcome: { status, reasonCode: 'execution_unresolved', retryable: false },
    }] })} />);
    openHistory();
    expect(screen.queryByText(enSidebar.pendingActions.historyOutcomeSuccess)).toBeNull();
    expect(screen.getByText(status === 'unknown'
      ? enSidebar.pendingActions.historyOutcomeUnknown
      : enSidebar.pendingActions.historyOutcomeFailure)).toBeTruthy();
    expect(screen.queryByRole('button', { name: enSidebar.pendingActions.execute })).toBeNull();
    expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
  });
});


it('counts only pending work in the panel header while keeping the completed receipt visible', () => {
  const completed = { ..._reqFields, id: 'completed', actionType: 'safe-restart', label: 'Completed request', status: 'executing' as const,
    currentActionOutcome: { status: 'success' as const, reasonCode: 'oid_loaded', retryable: false } };
  const props = baseProps({ restartRequired: false, actions: [completed] });
  const panel = render(<PendingActionsPanel {...props} />);
  const heading = screen.getByRole('heading', { name: enSidebar.pendingActions.title });
  expect(heading.parentElement?.querySelector('span')).toBeNull();
  expect(screen.queryByText('Completed request')).toBeNull();
  panel.rerender(<PendingActionsPanel {...baseProps({ restartRequired: false, actions: [completed,
    { ..._reqFields, id: 'new', actionType: 'safe-restart', label: 'New request', status: 'pending' as const },
    { ..._reqFields, id: 'unknown', actionType: 'safe-restart', label: 'Unknown request', status: 'executing' as const,
      currentActionOutcome: { status: 'unknown' as const, reasonCode: 'outcome_unverified', retryable: false } },
  ] })} />);
  // Only the row still waiting is counted; both settled ones sit in history.
  expect(heading.parentElement?.querySelector('span')?.textContent).toBe('1');
  expect(screen.queryByText('Completed request')).toBeNull();
  expect(screen.getByText('New request')).toBeTruthy();
  expect(screen.queryByText('Unknown request')).toBeNull();
  openHistory();
  expect(screen.getByText('Completed request')).toBeTruthy();
  expect(screen.getByText('Unknown request')).toBeTruthy();
});

it('keeps unknown neutral, reconciles within a bounded window, then shows a neutral delayed notice', async () => {
  vi.useFakeTimers();
  const refreshActions = vi.fn().mockResolvedValue(undefined);
  const row = { ..._reqFields, id: 'unverified-bound', actionType: 'safe-restart', label: 'Waiting request', status: 'pending' as const, retryable: false,
    currentActionOutcome: { status: 'unknown' as const, reasonCode: 'outcome_unverified', retryable: false } };
  const props = baseProps({ restartRequired: false, refreshActions, actions: [row] });
  const panel = render(<PendingActionsPanel {...props} />);
  // The row is unconfirmed, so it reads as history — neutral, never a failure —
  // while the panel keeps polling it from `actions` behind the tab.
  openHistory();
  expect(screen.getByText(enSidebar.pendingActions.outcomeUnverified).className).not.toContain('text-destructive');
  expect(screen.queryByText(enSidebar.pendingActions.statusFailed)).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  panel.rerender(<PendingActionsPanel {...props} actions={[{ ...row }]} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  const calls = refreshActions.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(refreshActions).toHaveBeenCalledTimes(calls);
  expect(screen.queryByRole('button', { name: enSidebar.pendingActions.execute })).toBeNull();
  expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
  vi.useRealTimers();
});

it('keeps current success until closing, folds it on reopening, and preserves old pending work', async () => {
  const row = { ..._reqFields, id: 'current', actionType: 'safe-restart', label: 'Current action', status: 'pending' as const };
  const old = { ..._reqFields, id: 'old', actionType: 'safe-restart', label: 'Old pending', status: 'pending' as const };
  const execute = vi.fn().mockResolvedValue({ status: 'error', code: 'outcome_unverified' });
  const props = baseProps({ restartRequired: false, execute, actions: [row, old] });
  const panel = render(<PendingActionsPanel {...props} />);
  fireEvent.click(screen.getAllByRole('button', { name: enSidebar.pendingActions.execute })[0]);
  await screen.findByText(enSidebar.pendingActions.outcomeUnverified);
  const completed = { ...row, currentActionOutcome: { status: 'success', reasonCode: 'activated', retryable: false } };
  panel.rerender(<PendingActionsPanel {...props} actions={[completed, old]} />);
  expect(screen.getByText('Current action')).toBeTruthy();
  expect(screen.getAllByText(enSidebar.restart.success)).toHaveLength(2);
  panel.rerender(<PendingActionsPanel {...props} isOpen={false} actions={[completed, old]} />);
  panel.rerender(<PendingActionsPanel {...props} actions={[completed, old]} />);
  expect(screen.queryByText('Current action')).toBeNull();
  expect(screen.getByText('Old pending')).toBeTruthy();
  openHistory();
  expect(screen.getByText('Current action')).toBeTruthy();
  expect(execute).toHaveBeenCalledTimes(1);
});

it('polls a locally unverified POST without a durable outcome, absorbs GET rejection, and stops on closing', async () => {
  vi.useFakeTimers();
  const refreshActions = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('offline'));
  const execute = vi.fn().mockResolvedValue({ status: 'error', code: 'outcome_unverified' });
  const props = baseProps({ restartRequired: false, execute, refreshActions,
    actions: [{ id: 'local-only', actionType: 'safe-restart', label: 'Local attempt', status: 'pending' }] });
  const panel = render(<PendingActionsPanel {...props} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: enSidebar.pendingActions.execute })); });
  expect(screen.getByText(enSidebar.pendingActions.outcomeUnverified)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(refreshActions).toHaveBeenCalledTimes(2);
  panel.rerender(<PendingActionsPanel {...props} isOpen={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(refreshActions).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
