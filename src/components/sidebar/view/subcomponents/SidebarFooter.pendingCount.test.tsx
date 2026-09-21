import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

const fetchMock = vi.hoisted(() => vi.fn());
const rawQueue = vi.hoisted(() => ({ commands: [] as Array<{ id: string }> }));
vi.mock('../../../../utils/api', () => ({ authenticatedFetch: fetchMock }));
vi.mock('../../../../contexts/WebSocketContext', () => ({ useWebSocket: () => ({ latestMessage: null }) }));
vi.mock('../../../auth/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, username: 'Owner', role: 'owner' } }) }));
vi.mock('../../../../hooks/useRawExecConfig', () => ({ useRawExecQueue: () => rawQueue, refreshRawExecConfig: vi.fn() }));
vi.mock('./SystemStats', () => ({ SystemStatsFooter: () => null, SystemStatsCollapsed: () => null }));
vi.mock('./ClaudeUsageCollapsed', () => ({ ClaudeUsageCollapsed: () => null }));
vi.mock('./PresenceCountCollapsed', () => ({ PresenceCountCollapsed: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./UpstreamReleaseNotice', () => ({ default: () => null }));
vi.mock('./PendingActionsPanel', () => ({ default: ({ isOpen, actions, onClose }: {
  isOpen: boolean; actions: Array<{ id: string }>; onClose: () => void;
}) => isOpen ? <div role="dialog"><span>{actions.map(row => row.id).join(',')}</span><button onClick={onClose}>Close</button></div> : null }));

import { countPendingServerActions, useServerActions } from '../../../../hooks/useServerActions';

import SidebarFooter from './SidebarFooter';
import SidebarCollapsed from './SidebarCollapsed';

const t = ((key: string) => key) as unknown as TFunction;
/**
 * T-1684 — the badge counts requests that still WAIT. A row is therefore
 * `pending` by default here; an executing row, and any settled outcome, are
 * covered by their own cases below.
 */
const row = { id: 'completed', actionType: 'safe-restart', label: 'Restart', status: 'pending' };
const response = (body: unknown) => ({ ok: true, json: async () => body });
const banner = () => screen.queryByRole('button', { name: 'pendingActions.bannerAriaLabel' });

function Footer({ restartRequired = false }: { restartRequired?: boolean }) {
  const queue = useServerActions(false, 'owner');
  return <SidebarFooter {...queue} restartRequired={restartRequired} updateAvailable={false}
    releaseInfo={null} latestVersion={null} currentVersion="test" refreshActions={queue.refetch}
    onShowVersionModal={vi.fn()} onShowSettings={vi.fn()} t={t} />;
}

function serve(rows: Array<typeof row>, outcomes: Record<string, string>) {
  fetchMock.mockImplementation(async (url: string) => {
    const id = url.match(/pending\/([^/]+)\/outcome$/)?.[1];
    return response(id ? { actionId: id, currentActionOutcome: {
      status: outcomes[id] ?? 'unknown', reasonCode: 'outcome_unverified', retryable: false,
    } } : { actions: rows });
  });
}

afterEach(() => { cleanup(); sessionStorage.clear(); vi.resetAllMocks(); rawQueue.commands = []; });

it('clears the banner on proved success while leaving the open receipt and storage intact', async () => {
  serve([row], { completed: 'pending' });
  render(<Footer />);
  await waitFor(() => expect(banner()?.textContent).toContain('1'));
  fireEvent.click(banner()!);
  serve([row], { completed: 'success' });
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await waitFor(() => expect(banner()).toBeNull());
  expect(within(screen.getByRole('dialog')).getByText('completed')).toBeTruthy();
  const stored = JSON.parse(sessionStorage.getItem('server-action-outcomes:owner')!);
  expect(stored[0].id).toBe('completed');
  expect(stored[0].currentActionOutcome.status).toBe('success');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

// A settled row is a receipt, not a call for attention: only the one still
// waiting adds to the count, while every row stays reachable in the panel.
it.each([['pending', '2'], ['unknown', '1'], ['failure', '1']])(
  'counts a %s request beside a completed one only while it still waits', async (status, expected) => {
    serve([row, { ...row, id: 'remaining' }], { completed: 'success', remaining: status });
    render(<Footer />);
    await waitFor(() => expect(sessionStorage.getItem('server-action-outcomes:owner')).toContain('remaining'));
    serve([row, { ...row, id: 'remaining' }, { ...row, id: 'new' }], {
      completed: 'success', remaining: status, new: 'pending',
    });
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(banner()?.textContent).toBe(`pendingActions.title${expected}`));
    fireEvent.click(banner()!);
    expect(within(screen.getByRole('dialog')).getByText('completed,remaining,new')).toBeTruthy();
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

it('leaves the banner dark for a request the server is already executing', async () => {
  serve([{ ...row, id: 'running', status: 'executing' }], { running: 'pending' });
  render(<Footer />);
  await waitFor(() => expect(sessionStorage.getItem('server-action-outcomes:owner')).toContain('running'));
  expect(banner()).toBeNull();
});

it('shows the banner again when a fresh pending request arrives after the completed one', async () => {
  serve([row], { completed: 'success' });
  render(<Footer />);
  await waitFor(() => expect(sessionStorage.getItem('server-action-outcomes:owner')).toContain('success'));
  expect(banner()).toBeNull();
  serve([{ ...row, id: 'new', status: 'pending' }], { new: 'pending' });
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await waitFor(() => expect(banner()?.textContent).toBe('pendingActions.title1'));
  fireEvent.click(banner()!);
  expect(within(screen.getByRole('dialog')).getByText('new,completed')).toBeTruthy();
});

it('keeps restart-required and raw command counts when the declared request succeeded', async () => {
  rawQueue.commands = [{ id: 'raw' }];
  serve([row], { completed: 'success' });
  render(<Footer restartRequired />);
  await waitFor(() => expect(sessionStorage.getItem('server-action-outcomes:owner')).toContain('success'));
  expect(banner()?.textContent).toBe('version.restartRequired2');
});

it('updates the collapsed command entry from the same retained receipts and pending count', async () => {
  function Collapsed() {
    const { actions } = useServerActions(false, 'owner');
    return <SidebarCollapsed pendingActionsCount={countPendingServerActions(actions)}
      onExpand={vi.fn()} onShowSettings={vi.fn()} onOpenTerminals={vi.fn()}
      runningTerminalsCount={0} terminalsActive={false} updateAvailable={false}
      onShowVersionModal={vi.fn()} scheduledMessagesCount={0} scheduledMessagesEnabled={false}
      scheduledMessagesActive={false} onOpenScheduledMessages={vi.fn()} t={t} />;
  }
  serve([row], { completed: 'success' });
  render(<Collapsed />);
  await waitFor(() => expect(sessionStorage.getItem('server-action-outcomes:owner')).toContain('success'));
  expect(screen.queryByRole('button', { name: 'pendingActions.boardCollapsedAria' })).toBeNull();
  serve([row, { ...row, id: 'new', status: 'pending' }], { completed: 'success', new: 'pending' });
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'pendingActions.boardCollapsedAria' }).textContent).toBe('1'));
});
