import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, expect, it, vi } from 'vitest';

import { getIdentityBarrierSnapshot, stabilizeIdentityBarrier } from '../../../auth/accountIdentityBarrier';

import AccountSwitcher from './AccountSwitcher';

const t = ((key: string, options?: Record<string, string>) => options?.name ? `${key}:${options.name}` : key) as unknown as TFunction;
const fetchMock = vi.fn();
const wallet = {
  generation: 7, activeSlotId: 'slot-a', accounts: [
    { slotId: 'slot-a', displayName: 'Nawras', isActive: true, lastUsedAt: null },
    { slotId: 'slot-b', displayName: 'Maha', isActive: false, lastUsedAt: null },
  ],
};

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function renderSwitcher() {
  return render(<AccountSwitcher t={t} onShowSettings={vi.fn()} onLegacyLogout={vi.fn()}
    current={{ displayName: 'Nawras', secondary: 'Owner' }} />);
}

afterEach(() => {
  stabilizeIdentityBarrier(getIdentityBarrierSnapshot().version);
  cleanup(); localStorage.clear(); sessionStorage.clear();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); fetchMock.mockReset();
});

it('loads device accounts with a credentialed, token-free read', async () => {
  fetchMock.mockResolvedValue(response(wallet));
  vi.stubGlobal('fetch', fetchMock);
  renderSwitcher();
  fireEvent.click(screen.getByRole('button', { name: 'account.switcherLabel:Nawras' }));
  await screen.findByRole('menuitem', { name: /Maha/ });
  expect(fetchMock).toHaveBeenCalledWith('/api/auth/accounts', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
  expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
});

it('mints operation-scoped CSRF and switches without setting Origin', async () => {
  fetchMock
    .mockResolvedValueOnce(response(wallet))
    .mockResolvedValueOnce(response({ csrfToken: 'csrf-switch' }))
    .mockResolvedValueOnce(response({ generation: 8, activeSlotId: 'slot-b', account: wallet.accounts[1] }));
  vi.stubGlobal('fetch', fetchMock);
  renderSwitcher();
  fireEvent.click(screen.getByRole('button', { name: 'account.switcherLabel:Nawras' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Maha/ }));

  await waitFor(() => expect(getIdentityBarrierSnapshot().phase).toBe('committed'));
  expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/accounts/csrf?action=switch');
  expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-switch' },
  }));
  expect((fetchMock.mock.calls[2][1].headers as Record<string, string>).Origin).toBeUndefined();
  expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ slotId: 'slot-b', expectedGeneration: 7 });
});

it('adds a local account without retaining credentials or changing active identity', async () => {
  localStorage.setItem('draft_input_project-a', 'keep this draft');
  localStorage.setItem('nassaj_outbox_owner', '[{"id":"queued"}]');
  const added = { slotId: 'slot-c', displayName: 'Sara', isActive: false, lastUsedAt: null };
  fetchMock
    .mockResolvedValueOnce(response(wallet))
    .mockResolvedValueOnce(response({ csrfToken: 'csrf-add' }))
    .mockResolvedValueOnce(response({ ...wallet, generation: 8, accounts: [...wallet.accounts, added] }));
  vi.stubGlobal('fetch', fetchMock);
  renderSwitcher();
  fireEvent.click(screen.getByRole('button', { name: 'account.switcherLabel:Nawras' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'account.add' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'account.email' }), { target: { value: 'sara@example.com' } });
  const password = document.querySelector('input[type="password"]') as HTMLInputElement;
  fireEvent.change(password, { target: { value: 'local-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'account.add' }));

  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'account.email' })).toBeNull());
  expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/accounts/csrf?action=add');
  expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
    email: 'sara@example.com', password: 'local-secret', expectedGeneration: 7,
  });
  expect(localStorage.getItem('sara@example.com')).toBeNull();
  expect(localStorage.getItem('local-secret')).toBeNull();
  expect(localStorage.getItem('draft_input_project-a')).toBe('keep this draft');
  expect(localStorage.getItem('nassaj_outbox_owner')).toContain('queued');
  expect(getIdentityBarrierSnapshot().reason).toBe('wallet_generation_changed');
});

it('removing a non-active account preserves drafts and outbox', async () => {
  localStorage.setItem('draft_input_project-a', 'keep this draft');
  localStorage.setItem('nassaj_outbox_owner', '[{"id":"queued"}]');
  const nextWallet = { ...wallet, generation: 8, accounts: [wallet.accounts[0]] };
  fetchMock
    .mockResolvedValueOnce(response(wallet))
    .mockResolvedValueOnce(response({ csrfToken: 'csrf-remove' }))
    .mockResolvedValueOnce(response(nextWallet));
  vi.stubGlobal('fetch', fetchMock);
  renderSwitcher();
  fireEvent.click(screen.getByRole('button', { name: 'account.switcherLabel:Nawras' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'account.manage' }));
  fireEvent.click(screen.getByRole('button', { name: 'account.remove' }));
  const removeButtons = await screen.findAllByRole('button', { name: 'account.remove' });
  fireEvent.click(removeButtons[removeButtons.length - 1]!);
  await waitFor(() => expect(getIdentityBarrierSnapshot().reason).toBe('wallet_generation_changed'));
  expect(localStorage.getItem('draft_input_project-a')).toBe('keep this draft');
  expect(localStorage.getItem('nassaj_outbox_owner')).toContain('queued');
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/accounts/slot-b')).toHaveLength(1);
});

it('refreshes the wallet after a generation conflict without replaying the mutation', async () => {
  fetchMock
    .mockResolvedValueOnce(response(wallet))
    .mockResolvedValueOnce(response({ csrfToken: 'csrf-switch' }))
    .mockResolvedValueOnce(response({ code: 'wallet_generation_conflict' }, 409))
    .mockResolvedValueOnce(response({ ...wallet, generation: 8, activeSlotId: 'slot-b', accounts: wallet.accounts.map((account) => ({ ...account, isActive: account.slotId === 'slot-b' })) }));
  vi.stubGlobal('fetch', fetchMock);
  renderSwitcher();
  fireEvent.click(screen.getByRole('button', { name: 'account.switcherLabel:Nawras' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Maha/ }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/accounts/switch')).toHaveLength(1);
  expect(getIdentityBarrierSnapshot().reason).toBe('active_identity_conflict');
  expect(await screen.findByRole('alert')).toBeTruthy();
});

it('releases the barrier after a rejected pre-commit mutation', async () => {
  fetchMock
    .mockResolvedValueOnce(response(wallet))
    .mockResolvedValueOnce(response({ csrfToken: 'csrf-add' }))
    .mockResolvedValueOnce(response({ code: 'add_account_failed' }, 401));
  vi.stubGlobal('fetch', fetchMock);
  renderSwitcher();
  fireEvent.click(screen.getByRole('button', { name: 'account.switcherLabel:Nawras' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'account.add' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'account.email' }), { target: { value: 'missing@example.com' } });
  fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'wrong-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'account.add' }));
  await waitFor(() => expect(getIdentityBarrierSnapshot().phase).toBe('stable'));
  expect(await screen.findByRole('alert')).toBeTruthy();
});

it('reconciles instead of unlocking when the mutation outcome is unknown', async () => {
  fetchMock
    .mockResolvedValueOnce(response(wallet))
    .mockResolvedValueOnce(response({ csrfToken: 'csrf-switch' }))
    .mockRejectedValueOnce(new TypeError('network lost after send'))
    .mockResolvedValueOnce(response({
      ...wallet, generation: 8, activeSlotId: 'slot-b',
      accounts: wallet.accounts.map((account) => ({ ...account, isActive: account.slotId === 'slot-b' })),
    }));
  vi.stubGlobal('fetch', fetchMock);
  renderSwitcher();
  fireEvent.click(screen.getByRole('button', { name: 'account.switcherLabel:Nawras' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Maha/ }));
  await waitFor(() => expect(getIdentityBarrierSnapshot().phase).toBe('committed'));
  expect(getIdentityBarrierSnapshot().reason).toBe('active_identity_conflict');
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it('asks before switching when the current account has an unsent draft', async () => {
  localStorage.setItem('draft_input_project-a', 'private draft');
  fetchMock
    .mockResolvedValueOnce(response(wallet))
    .mockResolvedValueOnce(response({ csrfToken: 'csrf-switch' }))
    .mockResolvedValueOnce(response({ generation: 8, activeSlotId: 'slot-b', account: wallet.accounts[1] }));
  vi.stubGlobal('fetch', fetchMock);
  renderSwitcher();
  fireEvent.click(screen.getByRole('button', { name: 'account.switcherLabel:Nawras' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Maha/ }));
  expect(await screen.findByRole('button', { name: 'account.switchConfirm' })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'account.switchConfirm' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
});

it('supports Escape and directional keyboard navigation without a focus trap', async () => {
  fetchMock.mockResolvedValue(response({ ...wallet, accounts: [wallet.accounts[0]] }));
  vi.stubGlobal('fetch', fetchMock);
  renderSwitcher();
  const trigger = screen.getByRole('button', { name: 'account.switcherLabel:Nawras' });
  fireEvent.click(trigger);
  const menu = await screen.findByRole('menu');
  fireEvent.keyDown(menu, { key: 'End' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'actions.logout' }));
  fireEvent.keyDown(menu, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
