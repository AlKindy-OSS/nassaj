import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch }));

import i18n from '../../i18n/config.js';

import InternalRoomMembers from './InternalRoomMembers';
import type { InternalRoom } from './internalSessionChatApi';

beforeAll(async () => { await i18n.init(); await i18n.changeLanguage('ar'); });
afterEach(() => { cleanup(); authenticatedFetch.mockReset(); });

const response = (payload: unknown, ok = true, status = ok ? 200 : 404) => ({ ok, status, json: async () => payload });
const ownerRoom: InternalRoom = {
  role: 'owner', unreadMentionCount: 0, lastReadSequence: 0,
  members: [{ userId: 1, username: 'owner', role: 'owner' }, { userId: 7, username: 'sara', role: 'member' }],
};
const projectMembers = { success: true, data: { members: [{ userId: 1, displayName: 'owner' }, { userId: 7, displayName: 'sara' }, { userId: 9, displayName: 'omar' }] } };

/**
 * Routes by method + path; `refuse` makes every member mutation fail like the
 * server's 404, and `roomStatus` sets the status of the room re-read.
 */
function serve(next: InternalRoom, refuse = false, roomStatus = 200) {
  authenticatedFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/projects/')) return response(projectMembers);
    if (url.includes('/internal-room/members')) return response(refuse ? { error: 'Not found' } : { ok: true }, !refuse);
    return response(next, roomStatus < 300, roomStatus);
  });
}

describe('InternalRoomMembers', () => {
  it('adds a project member with the chosen role and hands back the fresh room', async () => {
    const after = { ...ownerRoom, members: [...ownerRoom.members, { userId: 9, username: 'omar', role: 'viewer' as const }] };
    serve(after);
    const onRoomChange = vi.fn();
    render(<InternalRoomMembers sessionId="s1" projectId="p1" room={ownerRoom} onRoomChange={onRoomChange} />);
    const picker = screen.getByLabelText('إضافة عضو من المشروع');
    // Members already in the room are not offered.
    await waitFor(() => expect(screen.getByRole('option', { name: 'omar' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'sara' })).toBeNull();
    fireEvent.change(picker, { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('الدور'), { target: { value: 'viewer' } });
    fireEvent.click(screen.getByRole('button', { name: /^إضافة$/ }));
    await waitFor(() => expect(onRoomChange).toHaveBeenCalledWith(after));
    const post = authenticatedFetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(post[0]).toBe('/api/sessions/s1/internal-room/members');
    expect(JSON.parse(post[1].body)).toEqual({ userId: 9, role: 'viewer' });
  });

  it('removes a member only after confirmation', async () => {
    const after = { ...ownerRoom, members: [ownerRoom.members[0]] };
    serve(after);
    const onRoomChange = vi.fn();
    render(<InternalRoomMembers sessionId="s1" projectId="p1" room={ownerRoom} onRoomChange={onRoomChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'إزالة sara' }));
    expect(authenticatedFetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الإزالة' }));
    await waitFor(() => expect(onRoomChange).toHaveBeenCalledWith(after));
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/sessions/s1/internal-room/members/7', expect.objectContaining({ method: 'DELETE' }));
  });

  it('shows a server refusal and keeps the room unchanged', async () => {
    serve(ownerRoom, true);
    const onRoomChange = vi.fn();
    render(<InternalRoomMembers sessionId="s1" projectId="p1" room={ownerRoom} onRoomChange={onRoomChange} />);
    fireEvent.change(screen.getByLabelText('دور sara'), { target: { value: 'viewer' } });
    expect((await screen.findByRole('alert')).textContent).toContain('رفض الخادم التغيير');
    expect(onRoomChange).not.toHaveBeenCalled();
  });

  it('renders a read-only list for a non-owner and never loads candidates', () => {
    render(<InternalRoomMembers sessionId="s1" projectId="p1" room={{ ...ownerRoom, role: 'member' }} onRoomChange={vi.fn()} />);
    expect(screen.getByText('sara')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('keeps the room and says so when the re-read after a saved change fails transiently', async () => {
    serve(ownerRoom, false, 503);
    const onRoomChange = vi.fn();
    render(<InternalRoomMembers sessionId="s1" projectId="p1" room={ownerRoom} onRoomChange={onRoomChange} />);
    fireEvent.change(screen.getByLabelText('دور sara'), { target: { value: 'viewer' } });
    expect((await screen.findByRole('alert')).textContent).toContain('تعذّر تحديث القائمة');
    expect(onRoomChange).not.toHaveBeenCalled();
    expect(screen.getByText('sara')).toBeTruthy();
  });

  it('reports lost access only when the re-read answers 404', async () => {
    serve(ownerRoom, false, 404);
    const onRoomChange = vi.fn();
    render(<InternalRoomMembers sessionId="s1" projectId="p1" room={ownerRoom} onRoomChange={onRoomChange} />);
    fireEvent.change(screen.getByLabelText('دور sara'), { target: { value: 'viewer' } });
    await waitFor(() => expect(onRoomChange).toHaveBeenCalledWith(null));
  });
});
