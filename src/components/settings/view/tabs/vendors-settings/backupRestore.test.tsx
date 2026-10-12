/**
 * backupRestore.test.tsx — ADR-200 §3 rollback in the Vendors tab (S9, brief §4).
 *
 * Keys-only is the default and sends an empty body; a full restore is a danger
 * dialog whose confirm stays disabled until the acknowledgement is ticked.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom. `NODE_ENV=test` is required.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import BackupRestoreSection from './BackupRestoreSection';
import { ar, appError, installFetch, plain, renderAr, type Route } from './vendorUiTestKit';

const restoreRoute = (reply: (harness: string) => ReturnType<Route>): Route => (url, method) => {
  const harness = /backups\/([^/]+)\/restore$/.exec(url)?.[1];
  return method === 'POST' && harness ? reply(harness) : undefined;
};

const ok = (skipped: unknown[] = []) => ({ body: { success: true, data: { restored: true, skipped } } });

function open() {
  renderAr(<BackupRestoreSection />);
  fireEvent.click(screen.getByText(ar('vendors.restore.title')));
}

const rowOf = (harness: string) => screen.getByText(harness).closest('li')!;

beforeEach(() => { fetchMock.mockReset(); });
afterEach(cleanup);

describe('backup restore', () => {
  it('lists the three harnesses, collapsed under the section title', () => {
    installFetch(fetchMock, []);
    open();
    for (const name of ['Claude Code', 'Codex', 'OpenCode']) expect(screen.getByText(name)).toBeTruthy();
  });

  it('defaults to keys: an empty body, after a confirm that names the scope', async () => {
    const writes = installFetch(fetchMock, [restoreRoute(() => ok())]);
    open();
    fireEvent.click(within(rowOf('Codex')).getByRole('button', { name: ar('vendors.restore.button') }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(ar('vendors.restore.keysBody'));
    expect(dialog.textContent).not.toContain(ar('vendors.restore.claudeBilling'));
    expect(writes).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: ar('vendors.restore.confirm') }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].url).toMatch(/backups\/codex\/restore$/);
    expect(writes[0].body).toEqual({});
    await waitFor(() => expect(within(rowOf('Codex')).getByText(ar('vendors.restore.done'))).toBeTruthy());
  });

  it('warns about billing for Claude only', async () => {
    installFetch(fetchMock, []);
    open();
    fireEvent.click(within(rowOf('Claude Code')).getByRole('button', { name: ar('vendors.restore.button') }));
    expect((await screen.findByRole('dialog')).textContent).toContain(ar('vendors.restore.claudeBilling'));
  });

  it('keeps the full restore disabled until the acknowledgement is ticked, then sends mode full', async () => {
    const writes = installFetch(fetchMock, [restoreRoute(() => ok())]);
    open();
    fireEvent.click(within(rowOf('OpenCode')).getByRole('button', { name: ar('vendors.restore.fullLink') }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(ar('vendors.restore.fullBody'));
    const confirm = within(dialog).getByRole('button', { name: ar('vendors.restore.confirm') }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({ mode: 'full', confirm: true });
  });

  it('lists a skipped login_present target', async () => {
    installFetch(fetchMock, [restoreRoute(() => ok([{ target: 'anthropic', outcome: 'login_present' }]))]);
    open();
    fireEvent.click(within(rowOf('OpenCode')).getByRole('button', { name: ar('vendors.restore.button') }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: ar('vendors.restore.confirm') }));
    await waitFor(() => expect(plain(rowOf('OpenCode').textContent)).toContain(
      plain(ar('vendors.restore.skippedLogin', { target: 'anthropic' })),
    ));
  });

  it('disables a row whose backup is unavailable and says so', async () => {
    installFetch(fetchMock, [restoreRoute(() => appError(409, 'VENDOR_BACKUP_UNAVAILABLE'))]);
    open();
    const button = () => within(rowOf('Claude Code')).getByRole('button', { name: ar('vendors.restore.button') });
    fireEvent.click(button());
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: ar('vendors.restore.confirm') }));
    await waitFor(() => expect(within(rowOf('Claude Code')).getByText(ar('vendors.restore.unavailable'))).toBeTruthy());
    expect((button() as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the files are shared on VENDOR_BACKUP_SHARED_SCOPE', async () => {
    installFetch(fetchMock, [restoreRoute(() => appError(409, 'VENDOR_BACKUP_SHARED_SCOPE'))]);
    open();
    fireEvent.click(within(rowOf('Codex')).getByRole('button', { name: ar('vendors.restore.button') }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: ar('vendors.restore.confirm') }));
    await waitFor(() => expect(within(rowOf('Codex')).getByText(ar('vendors.restore.sharedScope'))).toBeTruthy());
  });
});
