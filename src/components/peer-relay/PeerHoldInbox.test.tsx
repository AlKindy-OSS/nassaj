import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import i18n from '../../i18n/config.js';

import PeerHoldInbox from './PeerHoldInbox';
import { applyPeerHold, resetPeerHolds, type PeerHoldView } from './peerHoldStore';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/api', () => ({ authenticatedFetch: fetchMock }));

const hold = (over: Partial<PeerHoldView> = {}): PeerHoldView => ({
  id: 'h-1', state: 'held', holdVersion: 1, cause: null, fromUserId: 2, fromMemberName: 'Basma',
  fromSessionId: 'b1', fromName: 'Billing fix', toUserId: 1, toSessionId: 'a1', toName: 'Main repo',
  body: 'hello', bodyVisible: 'hello', bodySha256: 'sha', summary: null, targetMode: 'default',
  rejectReason: null, messageId: null, expiresAt: Date.now() + 3_600_000, createdAt: 1_000, updatedAt: 1_000, ...over,
});
const list = (holds: PeerHoldView[]) => ({ ok: true, status: 200, json: async () => ({ holds, count: holds.length, nextCursor: null }) });

beforeAll(async () => { await i18n.init(); });
beforeEach(() => { fetchMock.mockReset(); resetPeerHolds(); });
afterEach(async () => { cleanup(); await i18n.changeLanguage('en'); });

describe('PeerHoldInbox', () => {
  it('stays hidden while nothing waits', async () => {
    fetchMock.mockResolvedValue(list([]));
    const { container } = render(<PeerHoldInbox userId={1} />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledWith('/api/peer-relay/holds?limit=50');
    expect(container.querySelector('[data-peer-hold-inbox]')).toBeNull();
  });

  it('shows the count and opens the approval cards', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockResolvedValue(list([hold(), hold({ id: 'h-2', createdAt: 2_000 })]));
    render(<PeerHoldInbox userId={1} />);
    const entry = await screen.findByRole('button', { name: 'Messages awaiting your approval: 2' });
    fireEvent.click(entry);
    expect(screen.getByText('Messages awaiting your approval', { selector: 'h2' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Deliver' })).toHaveLength(2);
  });

  it('the dialog is named by its title and described by its description', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockResolvedValue(list([hold()]));
    render(<PeerHoldInbox userId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Messages awaiting your approval: 1' }));
    const dialog = screen.getByRole('dialog', { name: 'Messages awaiting your approval' });
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent)
      .toMatch(/^Messages other members' sessions sent to your sessions\./);
  });

  it('Escape in a reject step leaves the step first; a second Escape closes the dialog', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockResolvedValue(list([hold()]));
    render(<PeerHoldInbox userId={1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Messages awaiting your approval: 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const reason = screen.getByRole('textbox');
    expect(document.activeElement).toBe(reason);
    fireEvent.keyDown(reason, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(document.activeElement).toBe(reject);
    fireEvent.keyDown(reject, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('after the last decision, closing keeps the entry (focused) and announces none waiting', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockResolvedValueOnce(list([hold()]));
    render(<PeerHoldInbox userId={1} />);
    const entry = await screen.findByRole('button', { name: 'Messages awaiting your approval: 1' });
    entry.focus();
    fireEvent.click(entry);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ hold: hold({ state: 'rejected', holdVersion: 2, updatedAt: Date.now() }) }) });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' })); });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    const stays = screen.getByRole('button', { name: 'No messages are waiting for you.' });
    expect(document.activeElement).toBe(stays);
    expect(screen.getByRole('status').textContent).toBe('No messages are waiting for your approval.');
    act(() => { stays.blur(); });
    expect(screen.queryByRole('button', { name: 'No messages are waiting for you.' })).toBeNull();
  });

  it('a held row the server no longer returns drops out (decided on another device)', async () => {
    applyPeerHold(hold({ id: 'stale' }));
    fetchMock.mockResolvedValue(list([hold({ id: 'fresh' })]));
    render(<PeerHoldInbox userId={1} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /: 1$/ })).toBeTruthy());
  });

  it('renders nothing without a signed-in member', () => {
    const { container } = render(<PeerHoldInbox userId={null} />);
    expect(container.innerHTML).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Arabic entry label', async () => {
    await i18n.changeLanguage('ar');
    fetchMock.mockResolvedValue(list([hold()]));
    render(<PeerHoldInbox userId={1} />);
    expect(await screen.findByText('رسائل تنتظر موافقتك')).toBeTruthy();
  });
});
