import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScheduledMessage } from '../../chat/hooks/useScheduledMessages';
import type { Project } from '../../../types/app';
import { groupScheduledMessages } from '../utils/groupScheduledMessages';

import ScheduledMessagesCenter from './ScheduledMessagesCenter';

vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: Record<string, string>) => key === 'scheduled.center.rowLabel'
    ? `${options?.project}|${options?.session}|${options?.status}|${options?.time}`
    : key,
  i18n: { language: 'en' },
}) }));

function scheduled(id: string, status: ScheduledMessage['status'], scheduledFor: string): ScheduledMessage {
  return { id, sessionId: `session-${id}`, content: `private-${id}`, options: {}, scheduledFor, status, attempts: 0, maxAttempts: 3, lastErrorCode: status === 'failed' ? 'PROVIDER_BUSY' : null, sentAt: null, createdAt: '', updatedAt: '' };
}

type CenterController = Parameters<typeof ScheduledMessagesCenter>[0]['controller'];

function controller(messages: ScheduledMessage[]): CenterController {
  return { messages, loading: false, loadingMore: false, pages: { pending: { total: messages.filter((item) => item.status === 'pending').length, hasMore: false, nextOffset: null }, running: { total: messages.filter((item) => item.status === 'running').length, hasMore: false, nextOffset: null }, failed: { total: messages.filter((item) => item.status === 'failed').length, hasMore: false, nextOffset: null } }, total: messages.length, hasMore: false, busyIds: new Set<string>(), error: null, errorKind: null, stale: false, refresh: vi.fn(), loadMore: vi.fn(), update: vi.fn(), cancel: vi.fn() };
}

describe('ScheduledMessagesCenter', () => {
  afterEach(cleanup);
  it('groups messages using local calendar boundaries', () => {
    const groups = groupScheduledMessages([
      scheduled('failed', 'failed', '2026-08-01T12:00:00'),
      scheduled('today', 'pending', '2026-09-03T18:00:00'),
      scheduled('tomorrow', 'pending', '2026-09-04T12:00:00'),
      scheduled('later', 'pending', '2026-09-08T12:00:00'),
    ], new Date('2026-09-03T09:00:00'));
    expect(groups.today[0].id).toBe('today');
    expect(groups.failed[0].id).toBe('failed');
    expect(groups.tomorrow[0].id).toBe('tomorrow');
    expect(groups.later[0].id).toBe('later');
  });

  it('hides content by default, reveals per row, and opens its conversation', () => {
    const open = vi.fn();
    render(<ScheduledMessagesCenter controller={controller([scheduled('one', 'pending', new Date(Date.now() + 3_600_000).toISOString())])} projects={[]} onOpenSession={open} />);
    expect(screen.queryByText('private-one')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'scheduled.center.showContent' }));
    expect(screen.getByText('private-one')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'scheduled.center.unknownSession' }));
    expect(open).toHaveBeenCalledWith('session-one');
  });

  it('orders project before status and time without repeating it in the session action', () => {
    const projects = [{
      projectId: 'project-one',
      displayName: 'Alpha Project',
      fullPath: '/work/alpha',
      sessions: [{ id: 'session-one', title: 'Planning Session' }],
    }] as Project[];
    render(<ScheduledMessagesCenter controller={controller([scheduled('one', 'pending', new Date(Date.now() + 3_600_000).toISOString())])} projects={projects} onOpenSession={() => undefined} />);

    const row = screen.getByRole('listitem');
    const project = row.querySelector('[data-scheduled-project]');
    const status = row.querySelector('[data-scheduled-status]');
    const time = row.querySelector('time');
    const sessionAction = screen.getByRole('button', { name: 'Planning Session' });

    expect(project?.tagName).toBe('BDI');
    expect(project?.getAttribute('title')).toBe('Alpha Project');
    expect(project!.compareDocumentPosition(status as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(status!.compareDocumentPosition(time as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sessionAction.textContent).toBe('Planning Session');
    expect(row.getAttribute('aria-label')).toContain('Alpha Project|Planning Session|scheduled.status.pending|');
    expect(row.textContent?.match(/Alpha Project/g)).toHaveLength(1);
  });

  it('uses translated project and session fallbacks in both metadata and row label', () => {
    render(<ScheduledMessagesCenter controller={controller([scheduled('one', 'pending', new Date(Date.now() + 3_600_000).toISOString())])} projects={[]} onOpenSession={() => undefined} />);
    const row = screen.getByRole('listitem');

    expect(row.querySelector('[data-scheduled-project]')?.textContent).toBe('scheduled.center.unknownProject');
    expect(screen.getByRole('button', { name: 'scheduled.center.unknownSession' })).toBeTruthy();
    expect(row.getAttribute('aria-label')).toContain('scheduled.center.unknownProject|scheduled.center.unknownSession|');
  });

  it('keeps running rows read-only and sends failed rows through rescheduling', () => {
    render(<ScheduledMessagesCenter controller={controller([
      scheduled('running', 'running', new Date(Date.now() + 3_600_000).toISOString()),
      scheduled('failed', 'failed', new Date(Date.now() - 3_600_000).toISOString()),
    ])} projects={[]} onOpenSession={() => undefined} />);
    expect(screen.queryAllByRole('button', { name: 'scheduled.edit' })).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'scheduled.center.reschedule' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'scheduled.retry' })).toBeNull();
    const failureCode = screen.getByText('PROVIDER_BUSY');
    expect(failureCode.tagName).toBe('BDI');
    expect(failureCode.closest('[role="listitem"]')?.textContent).not.toContain('[object Object]');
  });

  it('filters to failed messages and reports stale snapshots', () => {
    const state = { ...controller([
      scheduled('pending', 'pending', new Date(Date.now() + 3_600_000).toISOString()),
      scheduled('failed', 'failed', new Date(Date.now() + 7_200_000).toISOString()),
    ]), error: 'offline', errorKind: 'load' as const, stale: true };
    render(<ScheduledMessagesCenter controller={state} projects={[]} onOpenSession={() => undefined} />);
    expect(screen.getByRole('alert').textContent).toContain('scheduled.center.stale');
    fireEvent.click(screen.getByRole('button', { name: 'scheduled.center.filters.failed' }));
    fireEvent.click(screen.getByRole('button', { name: 'scheduled.center.showContent' }));
    expect(screen.getByText('private-failed')).toBeTruthy();
    expect(screen.queryByText('private-pending')).toBeNull();
  });

  it('announces cancellation success while keeping row controls during busy state', async () => {
    const state = controller([scheduled('one', 'pending', new Date(Date.now() + 3_600_000).toISOString())]);
    state.cancel = vi.fn().mockResolvedValue(null);
    state.busyIds = new Set(['one']);
    const { rerender } = render(<ScheduledMessagesCenter controller={state} projects={[]} onOpenSession={() => undefined} />);
    const row = screen.getByRole('listitem');
    expect(row.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('button', { name: 'scheduled.cancel' }).hasAttribute('disabled')).toBe(true);

    state.busyIds = new Set();
    rerender(<ScheduledMessagesCenter controller={state} projects={[]} onOpenSession={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'scheduled.cancel' }));
    await waitFor(() => expect(screen.getByText('scheduled.center.cancelledSuccess')).toBeTruthy());
    expect(state.cancel).toHaveBeenCalledWith('one');
  });

  it('shows loaded and total counts and requests the next page', () => {
    const state = controller([scheduled('one', 'pending', new Date(Date.now() + 3_600_000).toISOString())]);
    state.pages.pending = { total: 201, hasMore: true, nextOffset: 200 };
    state.total = 201;
    state.hasMore = true;
    render(<ScheduledMessagesCenter controller={state} projects={[]} onOpenSession={() => undefined} />);

    expect(screen.getByText('scheduled.center.showingOf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'scheduled.center.loadMore' }));
    expect(state.loadMore).toHaveBeenCalledTimes(1);
  });

  it('keeps the success live region mounted and suppresses zero count during initial loading', () => {
    const state = controller([]);
    state.loading = true;
    const { container } = render(<ScheduledMessagesCenter controller={state} projects={[]} onOpenSession={() => undefined} />);
    const liveRegions = container.querySelectorAll('[role="status"]');
    expect([...liveRegions].some((region) => region.textContent === '')).toBe(true);
    expect(screen.queryByText('scheduled.center.resultCount')).toBeNull();
  });
});
