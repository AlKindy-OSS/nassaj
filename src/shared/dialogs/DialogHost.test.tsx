/**
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 * T-2039: the host renders the queue head as an accessible alertdialog that is
 * operable by keyboard (Escape, Tab trap, Enter on the focused button).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DialogHost } from './DialogHost';
import { alertDialog, confirmDialog, pendingDialogCount, resetDialogsForTests } from './dialogService';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({ 'dialog.confirm': 'Confirm', 'dialog.cancel': 'Cancel', 'dialog.ok': 'OK' })[key] ?? key,
  }),
}));

afterEach(() => {
  act(() => resetDialogsForTests());
  cleanup();
});

describe('DialogHost', () => {
  it('renders an alertdialog labelled by its title and described by its message', async () => {
    render(<DialogHost />);
    act(() => { void confirmDialog({ title: 'Delete', message: 'Line one\nLine two' }); });

    const dialog = await screen.findByRole('alertdialog');
    const title = screen.getByText('Delete');
    const message = screen.getByText(/Line one/);
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(dialog.getAttribute('aria-describedby')).toBe(message.id);
    expect(message.className).toContain('whitespace-pre-line');
  });

  it('uses the message as the accessible name when there is no title', async () => {
    render(<DialogHost />);
    act(() => { void alertDialog('Saved'); });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe(screen.getByText('Saved').id);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('resolves true on Confirm and then shows the next queued dialog', async () => {
    render(<DialogHost />);
    let first!: Promise<boolean>;
    act(() => {
      first = confirmDialog('first');
      void confirmDialog('second');
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await first).toBe(true);
    expect(await screen.findByText('second')).toBeTruthy();
  });

  it('cancels on Escape', async () => {
    render(<DialogHost />);
    let answer!: Promise<boolean>;
    act(() => { answer = confirmDialog('Escape me'); });
    await screen.findByRole('alertdialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(await answer).toBe(false);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('focuses Cancel for a danger question and the primary button otherwise', async () => {
    render(<DialogHost />);
    let danger!: Promise<boolean>;
    act(() => { danger = confirmDialog({ message: 'Delete forever?', tone: 'danger' }); });
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);
    expect(await danger).toBe(false);

    act(() => { void confirmDialog('Continue?'); });
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
  });

  it('traps Tab inside the dialog and puts the primary action last (inline end)', async () => {
    render(<DialogHost />);
    act(() => { void confirmDialog({ message: 'Trap?', tone: 'danger' }); });
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    const buttons = screen.getAllByRole('button');
    expect(buttons[buttons.length - 1]).toBe(confirm);

    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('settles once when the confirm button is double-clicked', async () => {
    render(<DialogHost />);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirmDialog('one');
      second = confirmDialog('two');
    });
    const button = await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await first).toBe(true);
    expect(pendingDialogCount()).toBe(1);
    expect(await screen.findByText('two')).toBeTruthy();
    act(() => resetDialogsForTests());
    expect(await second).toBe(false);
  });
});
