import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch }));
vi.mock('../auth/context/AuthContext', () => ({ useOptionalAuth: () => ({ user: { id: 1, username: 'owner' } }) }));

import i18n from '../../i18n/config.js';

import InternalSessionChat from './InternalSessionChat';
import { markInternalRead } from './internalSessionChatApi';

class IdleSocket { onopen = null; onmessage = null; onclose = null; close() {} }

beforeAll(async () => { await i18n.init(); await i18n.changeLanguage('ar'); });
beforeEach(() => { vi.stubGlobal('WebSocket', IdleSocket); });
afterEach(() => { cleanup(); authenticatedFetch.mockReset(); vi.unstubAllGlobals(); });

const response = (payload: unknown, ok = true) => ({ ok, json: async () => payload });

describe('InternalSessionChat', () => {
  it('renders nothing and calls nothing while the capability is off', () => {
    const { container } = render(<InternalSessionChat sessionId="s1" enabled={false} />);
    expect(container.innerHTML).toBe('');
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('shows the server-projected author name and falls back only for a deleted author', async () => {
    const room = { members: [{ userId: 1, username: 'owner', role: 'owner' }], unreadMentionCount: 0, lastReadSequence: 0 };
    const page = [
      { id: 'm2', sequence: 2, body: 'من سارة', authorUserId: 7, authorName: 'sara', createdAt: '2026-01-01' },
      { id: 'm1', sequence: 1, body: 'قديمة', authorUserId: null, authorName: null, createdAt: '2026-01-01' },
    ];
    authenticatedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/internal-room')) return response(room);
      return response(url.endsWith('/internal-messages') ? { messages: page } : {});
    });
    render(<InternalSessionChat sessionId="s1" enabled />);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /محادثة الفريق$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'محادثة داخلية' }));
    fireEvent.focus(screen.getByLabelText('رسالة داخلية'));
    expect(await screen.findByText('sara')).toBeTruthy();
    expect(screen.getByText('عضو الفريق')).toBeTruthy();
  });

  it('sends only through the internal endpoint and derives mentions from room members', async () => {
    // Route by endpoint: refocusing the draft after a mention pick reloads messages.
    const room = { members: [{ userId: 1, username: 'owner', role: 'owner' }, { userId: 7, username: 'sara', role: 'member' }], unreadMentionCount: 0, lastReadSequence: 0 };
    const created = { id: 'm1', sequence: 1, body: '@sara مرحباً', authorUserId: 1, createdAt: '2026-01-01' };
    authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/internal-room')) return response(room);
      return response(init?.method === 'POST' ? created : []);
    });
    render(<InternalSessionChat sessionId="s1" enabled />);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith('/api/sessions/s1/internal-room', expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: /محادثة الفريق$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'محادثة داخلية' }));
    const textarea = screen.getByLabelText('رسالة داخلية');
    fireEvent.focus(textarea);
    fireEvent.change(textarea, { target: { value: '@sa' } });
    fireEvent.mouseDown(await screen.findByRole('button', { name: /sara/ }));
    fireEvent.change(textarea, { target: { value: '@sara مرحباً' } });
    fireEvent.click(screen.getByRole('button', { name: /إرسال للفريق/ }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith('/api/sessions/s1/internal-messages', expect.objectContaining({ method: 'POST' })));
    // The deferred refocus may reload messages after the send, so select the POST itself.
    const request = authenticatedFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ body: '@sara مرحباً', mentionUserIds: [7] });
    expect(authenticatedFetch.mock.calls.some(([url]) => String(url).includes('/api/providers/'))).toBe(false);
  });

  it('renders a descending server page in sequence order and acknowledges its highest sequence', async () => {
    // Route by endpoint so a slow first room read cannot shift the queued responses.
    const room = { members: [{ userId: 1, username: 'owner', role: 'owner' }], unreadMentionCount: 2, lastReadSequence: 0 };
    const page = [
      { id: 'm3', sequence: 3, body: 'الثالثة', authorUserId: 1, createdAt: '2026-01-01' },
      { id: 'm1', sequence: 1, body: 'الأولى', authorUserId: 1, createdAt: '2026-01-01' },
    ];
    authenticatedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/internal-room')) return response(room);
      return response(url.endsWith('/internal-messages') ? page : {});
    });
    render(<InternalSessionChat sessionId="s1" enabled />);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /محادثة الفريق$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'محادثة داخلية' }));
    fireEvent.focus(screen.getByLabelText('رسالة داخلية'));
    await waitFor(() => expect(screen.getByText('الأولى').compareDocumentPosition(screen.getByText('الثالثة')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
    await waitFor(() => expect(authenticatedFetch).toHaveBeenLastCalledWith('/api/sessions/s1/internal-read', expect.objectContaining({ body: JSON.stringify({ sequence: 3 }) })));
  });

  it('shows the creation failure when no room could be created', async () => {
    authenticatedFetch.mockResolvedValue(response({ error: 'Not found' }, false));
    render(<InternalSessionChat sessionId="s1" enabled />);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /محادثة الفريق$/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('لا تتوفر محادثة الفريق لهذه الجلسة.');
    expect(authenticatedFetch).toHaveBeenLastCalledWith('/api/sessions/s1/internal-room', expect.objectContaining({ method: 'POST' }));
  });

  it('does not treat a failed read acknowledgement as success', async () => {
    authenticatedFetch.mockResolvedValue(response({}, false));
    await expect(markInternalRead('s1', 3)).resolves.toBe(false);
  });
});
