import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScheduleMessageDialog, ScheduledMessagesPanel } from './ScheduledMessages';

let testLanguage = 'en';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values?.value ? `${key}:${values.value}` : key,
    i18n: { language: testLanguage },
  }),
}));

describe('scheduled messages UI', () => {
  beforeEach(() => {
    vi.useRealTimers();
    testLanguage = 'en';
  });
  afterEach(cleanup);

  it('creates a local preset as an ISO timestamp and keeps the message text', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(<ScheduleMessageDialog open message={null} initialContent="Follow up" busy={false} onOpenChange={onOpenChange} onSave={onSave} />);

    expect(screen.getByRole('dialog', { name: 'scheduled.title' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'scheduled.presets.1h' }));
    fireEvent.click(screen.getByRole('button', { name: 'scheduled.schedule' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toBe('Follow up');
    expect(new Date(onSave.mock.calls[0][1]).toISOString()).toBe(onSave.mock.calls[0][1]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows pending and failed rows with accessible edit, retry, and cancel actions', () => {
    const onEdit = vi.fn();
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    render(<ScheduledMessagesPanel messages={[
      { id: 'pending-1', sessionId: 's1', content: 'First', options: {}, scheduledFor: new Date(Date.now() + 3_600_000).toISOString(), status: 'pending', attempts: 0, maxAttempts: 3, lastErrorCode: null, sentAt: null, createdAt: '', updatedAt: '' },
      { id: 'failed-1', sessionId: 's1', content: 'Second', options: {}, scheduledFor: new Date(Date.now() + 7_200_000).toISOString(), status: 'failed', attempts: 3, maxAttempts: 3, lastErrorCode: 'PROVIDER_BUSY', sentAt: null, createdAt: '', updatedAt: '' },
    ]} loading={false} busyId={null} error={null} onEdit={onEdit} onRetry={onRetry} onCancel={onCancel} onRefresh={() => undefined} />);

    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
    expect(screen.getByText('PROVIDER_BUSY').tagName).toBe('BDI');
    expect(screen.getByText('PROVIDER_BUSY').parentElement?.textContent).not.toContain('[object Object]');
    fireEvent.click(screen.getAllByRole('button', { name: 'scheduled.edit' })[0]);
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'pending-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'scheduled.retry' }));
    expect(onRetry).toHaveBeenCalledWith('failed-1');
    fireEvent.click(screen.getAllByRole('button', { name: 'scheduled.cancel' })[0]);
    expect(onCancel).toHaveBeenCalledWith('pending-1');
  });

  it('explains an invalid time inline while the save action is disabled', () => {
    render(<ScheduleMessageDialog open message={null} initialContent="Follow up" busy={false} onOpenChange={() => undefined} onSave={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('scheduled.date'), { target: { value: '2000-01-01' } });

    expect(screen.getByRole('alert').textContent).toContain('scheduled.errors.tooSoon');
    expect(screen.getByRole('button', { name: 'scheduled.schedule' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('scheduled.date').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('scheduled.date').getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  });

  it('associates the dialog description and empty-content error with their controls', () => {
    render(<ScheduleMessageDialog open message={null} initialContent="" busy={false} onOpenChange={() => undefined} onSave={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent).toBe('scheduled.description');
    fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('scheduled.message'), { target: { value: '' } });
    const message = screen.getByLabelText('scheduled.message');
    expect(message.getAttribute('aria-invalid')).toBe('true');
    expect(message.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  });

  it('keeps the dialog open and announces a save failure', async () => {
    const onOpenChange = vi.fn();
    render(<ScheduleMessageDialog open message={null} initialContent="Follow up" busy={false} onOpenChange={onOpenChange} onSave={vi.fn().mockRejectedValue(new Error('offline'))} />);

    fireEvent.click(screen.getByRole('button', { name: 'scheduled.presets.15m' }));
    fireEvent.click(screen.getByRole('button', { name: 'scheduled.schedule' }));

    expect((await screen.findByRole('alert')).textContent).toContain('scheduled.errors.save');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('uses RTL dialog direction for Arabic while preserving the narrow-screen layout', () => {
    testLanguage = 'ar-SA';
    render(<ScheduleMessageDialog open message={null} initialContent="تابع المهمة" busy={false} onOpenChange={() => undefined} onSave={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('dir')).toBe('rtl');
    expect(dialog.className).toContain('w-[calc(100vw-1rem)]');
    expect(screen.getByLabelText('scheduled.message').getAttribute('dir')).toBe('auto');
  });

  it('describes an action failure as an action failure rather than a load failure', () => {
    render(<ScheduledMessagesPanel messages={[]} loading={false} busyId={null} error="request_failed" errorKind="action" onEdit={() => undefined} onRetry={() => undefined} onCancel={() => undefined} onRefresh={() => undefined} />);

    expect(screen.getByRole('alert').textContent).toContain('scheduled.errors.save');
  });
});
