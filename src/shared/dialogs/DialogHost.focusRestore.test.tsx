/**
 * RUNNER: vitest — jsdom.
 * T-2039 qa: DialogHost unmounts each ConfirmDialog on settle, so focus must be
 * handed back to the opener on unmount — also across queued dialogs.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DialogHost } from './DialogHost';
import { confirmDialog, resetDialogsForTests } from './dialogService';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({ 'dialog.confirm': 'Confirm', 'dialog.cancel': 'Cancel', 'dialog.ok': 'OK' })[key] ?? key,
  }),
}));

afterEach(() => {
  act(() => resetDialogsForTests());
  cleanup();
});

function Opener({ onOpen }: { onOpen: () => void }) {
  return <button type="button" onClick={onOpen}>Open</button>;
}

describe('DialogHost focus restore', () => {
  it('returns focus to the opener after the dialog closes', async () => {
    render(<><Opener onOpen={() => { void confirmDialog('Sure?'); }} /><DialogHost /></>);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    act(() => { fireEvent.click(opener); });
    await screen.findByRole('alertdialog');
    act(() => { screen.getByRole('button', { name: 'Cancel' }).focus(); });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('returns focus to the opener after two queued dialogs', async () => {
    render(<><Opener onOpen={() => { void confirmDialog('First?'); void confirmDialog('Second?'); }} /><DialogHost /></>);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    act(() => { fireEvent.click(opener); });
    await screen.findByText('First?');
    act(() => { screen.getByRole('button', { name: 'Confirm' }).focus(); });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });
    await screen.findByText('Second?');
    act(() => { screen.getByRole('button', { name: 'Cancel' }).focus(); });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.activeElement).not.toBe(document.body);
  });
});
