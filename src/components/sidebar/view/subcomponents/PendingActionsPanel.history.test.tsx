/**
 * PendingActionsPanel.history.test.tsx — T-1684
 *
 * العلّة التي يغطّيها: الطابور كان يحتفظ بكل ما جرى. أمرٌ فشل، وأمرٌ لم تُعرف
 * نتيجته، وإيصالُ نجاحٍ قديم — كلّها تبقى في القائمة وتُبقي الزرّ الأصفر مضاءً،
 * فيصير الزرّ إشعاراً دائماً لا نداءً على عملٍ ينتظر.
 *
 * ما تدافع عنه هذه الاختبارات:
 *
 *   الفصل (الميزة)
 *     - كل نتيجة settled تظهر في تبويب «العمليات السابقة»، لا في الطابور؛
 *     - الزرّ الأصفر يعدّ ما ينتظر فقط: لا failed ولا unknown ولا executing؛
 *     - العنصر يختفي محلياً عند بلوغ expiresAt، بلا انتظار كنس الخادم.
 *
 *   البوابة (لا تتحرّك)
 *     - «إعادة المحاولة» للأوامر المعلنة القابلة لإعادة التنفيذ وحدها؛
 *     - الأمر الحرّ لا يُعاد تنفيذه من التاريخ إطلاقاً (ADR-070 §16)؛
 *     - نتيجةٌ «غير مؤكدة» لا تُزال يدوياً: إزالتها تمحو الدليل الوحيد.
 *
 * `t` يُحلّ من حزمة en الحقيقية، فمفتاح ناقص يسقط هنا لا في تسع لغات.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import { countPendingServerActions, type PublicAction } from '../../../../hooks/useServerActions';

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
    opts[name] === undefined ? whole : String(opts[name]));
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

/** Frozen identity — the panel resets per-item state in an effect keyed on it. */
const restartWatch = { isRestarting: false, isSuccess: false, startPolling: vi.fn(), reset: vi.fn() };
vi.mock('../../../../hooks/useRestartWatch', () => ({
  useRestartWatch: () => restartWatch,
  waitForExpectedServerBuildLoaded: async () => false,
}));

const authenticatedFetch = vi.fn();
vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const PendingActionsPanel = (await import('./PendingActionsPanel')).default;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const RAN_AT = new Date('2026-09-10T10:00:00.000Z');

/** A settled row as the server reports it, expiring `minutes` from "now". */
function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'h-1',
    kind: 'action' as const,
    actionType: 'safe-restart',
    label: 'Restart the server',
    commandPreview: 'pm2 restart nassaj-dev',
    outcome: 'failure' as const,
    reasonCode: 'not_claimable',
    retryable: true,
    executedAt: RAN_AT.toISOString(),
    expiresAt: new Date(RAN_AT.getTime() + HOUR_MS).toISOString(),
    ...overrides,
  };
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    restartRequired: false,
    actions: [] as PublicAction[],
    history: [entry()],
    loading: false,
    execute: vi.fn().mockResolvedValue({ status: 'success' }),
    dismiss: vi.fn().mockResolvedValue({ status: 'dismissed', id: 'h-1' }),
    refreshActions: vi.fn().mockResolvedValue(undefined),
    rawCommands: [],
    onRawQueueChange: vi.fn(),
    ...overrides,
  };
}

const historyTab = () => screen.getByRole('tab', { name: new RegExp(enSidebar.pendingActions.tabHistory) });
const openHistory = () => fireEvent.click(historyTab());

beforeEach(() => {
  authState.user = { id: 1, username: 'owner', role: 'owner' };
  authenticatedFetch.mockReset();
  authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.setSystemTime(new Date(RAN_AT.getTime() + 5 * 60_000));
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

// ── THE SPLIT ────────────────────────────────────────────────────────────────

describe('T-1684 — a settled operation leaves the queue', () => {
  it('opens on the queue and keeps settled work behind the history tab', () => {
    render(<PendingActionsPanel {...baseProps()} />);
    expect(screen.getByRole('tab', { name: new RegExp(enSidebar.pendingActions.tabQueue) })
      .getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('Restart the server')).toBeNull();
    expect(historyTab().textContent).toContain('1');
    openHistory();
    expect(screen.getByText('Restart the server')).toBeTruthy();
    expect(screen.getByText(enSidebar.pendingActions.historyOutcomeFailure)).toBeTruthy();
    expect(screen.getByText(enSidebar.pendingActions.errorNotClaimable)).toBeTruthy();
  });

  it('names how long is left before the hourly sweep removes it', () => {
    render(<PendingActionsPanel {...baseProps()} />);
    openHistory();
    // 60 minutes of retention, 5 already elapsed.
    expect(screen.getByText(interpolate(enSidebar.pendingActions.historyExpiresIn, { minutes: 55 }))).toBeTruthy();
    expect(screen.getByText(interpolate(enSidebar.pendingActions.historyExecutedAgo,
      { age: interpolate(enSidebar.pendingActions.sessionAge_minute, { minutes: 5 }) }))).toBeTruthy();
  });

  it('hides an expired row on its own tick rather than waiting for the server', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(RAN_AT.getTime() + 59 * 60_000));
    render(<PendingActionsPanel {...baseProps()} />);
    openHistory();
    expect(screen.getByText('Restart the server')).toBeTruthy();
    await act(async () => {
      vi.setSystemTime(new Date(RAN_AT.getTime() + HOUR_MS + 1_000));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.queryByText('Restart the server')).toBeNull();
    expect(screen.getByText(enSidebar.pendingActions.historyEmpty)).toBeTruthy();
  });

  it('shows a raw receipt with its exit code and folded output', () => {
    render(<PendingActionsPanel {...baseProps({ history: [entry({
      id: 'raw-h', kind: 'raw', actionType: undefined, label: 'sudo usermod -aG docker jazari',
      commandPreview: 'sudo usermod -aG docker jazari', outcome: 'success', reasonCode: null,
      retryable: false, exitCode: 0, stdoutTail: 'done\n', stderrTail: 'warning: none\n',
    })] })} />);
    openHistory();
    expect(screen.getByText(enSidebar.pendingActions.historyKindRaw)).toBeTruthy();
    expect(screen.getByText(interpolate(enSidebar.pendingActions.historyExitCode, { code: 0 }))).toBeTruthy();
    expect(screen.queryByText('done')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: enSidebar.pendingActions.historyOutputShow }));
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('warning: none')).toBeTruthy();
  });
});

// ── THE BADGE ────────────────────────────────────────────────────────────────

describe('T-1684 — the amber button counts only what still waits', () => {
  const row = (overrides: Record<string, unknown>) => ({
    id: 'a', actionType: 'safe-restart', label: 'Restart', commandPreview: null, reason: null,
    sessionId: null, error: null, expectedServerBuildId: null, requestedAt: RAN_AT.toISOString(),
    ...overrides,
  }) as unknown as PublicAction;

  it.each([
    ['a fresh pending request', { status: 'pending' }, 1],
    ['a request already executing', { status: 'executing' }, 0],
    ['a failed request', { status: 'failed' }, 0],
    ['a settled success', { status: 'pending', currentActionOutcome: { status: 'success', reasonCode: 'oid_loaded', retryable: false } }, 0],
    ['a settled failure', { status: 'pending', currentActionOutcome: { status: 'failure', reasonCode: 'not_claimable', retryable: true } }, 0],
    ['an unconfirmed outcome', { status: 'pending', currentActionOutcome: { status: 'unknown', reasonCode: 'outcome_unverified', retryable: false } }, 0],
  ])('does not count %s beyond what waits', (_name, overrides, expected) => {
    expect(countPendingServerActions([row(overrides)])).toBe(expected);
  });
});

// ── THE GATE ─────────────────────────────────────────────────────────────────

describe('T-1684 — history does not open a second execution door', () => {
  it('retries a retryable declared action through the same execute path', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'success' });
    render(<PendingActionsPanel {...baseProps({ execute })} />);
    openHistory();
    fireEvent.click(screen.getByRole('button', { name: enSidebar.restart.retry }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith('h-1'));
  });

  it('offers no retry for a raw receipt, whatever its outcome', () => {
    render(<PendingActionsPanel {...baseProps({ history: [entry({
      id: 'raw-h', kind: 'raw', actionType: undefined, retryable: true, outcome: 'failure',
    })] })} />);
    openHistory();
    expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
    expect(screen.getByRole('button', { name: enSidebar.pendingActions.historyRemove })).toBeTruthy();
  });

  it('offers neither retry nor removal for an outcome nobody could confirm', () => {
    render(<PendingActionsPanel {...baseProps({ history: [entry({
      outcome: 'unknown', reasonCode: 'outcome_unverified', retryable: true,
    })] })} />);
    openHistory();
    expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
    expect(screen.queryByRole('button', { name: enSidebar.pendingActions.historyRemove })).toBeNull();
  });

  it('removes a declared receipt through dismiss and a raw one through its own route', async () => {
    const dismiss = vi.fn().mockResolvedValue({ status: 'dismissed', id: 'h-1' });
    const panel = render(<PendingActionsPanel {...baseProps({ dismiss })} />);
    openHistory();
    fireEvent.click(screen.getByRole('button', { name: enSidebar.pendingActions.historyRemove }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('h-1'));
    expect(authenticatedFetch).not.toHaveBeenCalled();

    panel.rerender(<PendingActionsPanel {...baseProps({ dismiss, history: [entry({ id: 'raw-h', kind: 'raw' })] })} />);
    openHistory();
    fireEvent.click(screen.getByRole('button', { name: enSidebar.pendingActions.historyRemove }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(
      '/api/system/command-board-raw/history/raw-h', { method: 'DELETE' }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('shows a non-owner the receipts without any control over them', () => {
    authState.user = { id: 2, username: 'reader', role: 'viewer' };
    render(<PendingActionsPanel {...baseProps()} />);
    openHistory();
    expect(screen.getByText('Restart the server')).toBeTruthy();
    expect(screen.queryByRole('button', { name: enSidebar.restart.retry })).toBeNull();
    expect(screen.queryByRole('button', { name: enSidebar.pendingActions.historyRemove })).toBeNull();
  });
});
