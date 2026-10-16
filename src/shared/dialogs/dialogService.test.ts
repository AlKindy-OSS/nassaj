/**
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 * T-2039: FIFO queue and duplicate guards of the themed dialog service.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  alertDialog,
  confirmDialog,
  getCurrentDialog,
  pendingDialogCount,
  resetDialogsForTests,
  settleDialog,
} from './dialogService';

const visibleId = () => {
  const current = getCurrentDialog();
  if (!current) throw new Error('no dialog is visible');
  return current.id;
};

afterEach(() => resetDialogsForTests());

describe('dialogService queue', () => {
  it('shows requests one at a time in FIFO order', async () => {
    const first = confirmDialog({ message: 'first' });
    const second = alertDialog('second');
    const third = confirmDialog({ message: 'third', tone: 'danger' });

    expect(pendingDialogCount()).toBe(3);
    expect(getCurrentDialog()).toMatchObject({ kind: 'confirm', message: 'first', tone: 'default' });

    settleDialog(visibleId(), true);
    expect(await first).toBe(true);
    expect(getCurrentDialog()).toMatchObject({ kind: 'alert', message: 'second' });

    settleDialog(visibleId(), false);
    await expect(second).resolves.toBeUndefined();
    expect(getCurrentDialog()).toMatchObject({ kind: 'confirm', message: 'third', tone: 'danger' });

    settleDialog(visibleId(), false);
    expect(await third).toBe(false);
    expect(getCurrentDialog()).toBeNull();
  });

  it('accepts a plain string as the message', async () => {
    const answer = confirmDialog('Delete it?');
    expect(getCurrentDialog()).toMatchObject({ message: 'Delete it?', kind: 'confirm' });
    settleDialog(visibleId(), false);
    expect(await answer).toBe(false);
  });
});

describe('dialogService guards', () => {
  it('settles a dialog once: a double click cannot settle the next one', async () => {
    const first = confirmDialog('first');
    const second = confirmDialog('second');
    const firstId = visibleId();

    settleDialog(firstId, true);
    settleDialog(firstId, true);

    expect(await first).toBe(true);
    expect(pendingDialogCount()).toBe(1);
    expect(getCurrentDialog()?.message).toBe('second');
    settleDialog(visibleId(), false);
    expect(await second).toBe(false);
  });

  it('ignores a settle for a dialog that is queued but not visible', () => {
    void confirmDialog('first');
    void confirmDialog('second');
    const hiddenId = visibleId() + 1;
    settleDialog(hiddenId, true);
    expect(getCurrentDialog()?.message).toBe('first');
    expect(pendingDialogCount()).toBe(2);
  });

  it('answers a duplicate open with "no" so the action runs once', async () => {
    const original = confirmDialog({ message: 'Delete 3 items?', tone: 'danger' });
    const duplicate = confirmDialog({ message: 'Delete 3 items?', tone: 'danger' });

    expect(await duplicate).toBe(false);
    expect(pendingDialogCount()).toBe(1);
    settleDialog(visibleId(), true);
    expect(await original).toBe(true);
  });

  it('collapses a duplicate alert without queueing a second dialog', async () => {
    const original = alertDialog('Saved');
    await expect(alertDialog('Saved')).resolves.toBeUndefined();
    expect(pendingDialogCount()).toBe(1);
    settleDialog(visibleId(), true);
    await original;
  });

  it('allows the same question again once the first one is settled', async () => {
    const first = confirmDialog('Retry?');
    settleDialog(visibleId(), true);
    await first;
    const again = confirmDialog('Retry?');
    expect(pendingDialogCount()).toBe(1);
    settleDialog(visibleId(), true);
    expect(await again).toBe(true);
  });
});
