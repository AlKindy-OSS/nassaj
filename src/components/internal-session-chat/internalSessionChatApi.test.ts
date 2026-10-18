import { afterEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch }));

import {
  addInternalMember, listProjectMemberOptions, refreshInternalRoom, removeInternalMember, revalidateInternalRoom,
} from './internalSessionChatApi';

const response = (payload: unknown, ok = true, status = ok ? 200 : 404) => ({ ok, status, json: async () => payload });
afterEach(() => authenticatedFetch.mockReset());

describe('internalSessionChatApi member management', () => {
  it('posts a member grant to the room members endpoint', async () => {
    authenticatedFetch.mockResolvedValue(response({ ok: true }));
    await expect(addInternalMember('s/1', 7, 'viewer')).resolves.toBe(true);
    const [url, init] = authenticatedFetch.mock.calls[0];
    expect(url).toBe('/api/sessions/s%2F1/internal-room/members');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(init.body)).toEqual({ userId: 7, role: 'viewer' });
  });

  it('reports a refused grant or removal as false', async () => {
    authenticatedFetch.mockResolvedValue(response({ error: 'Not found' }, false));
    await expect(addInternalMember('s1', 7, 'member')).resolves.toBe(false);
    await expect(removeInternalMember('s1', 7)).resolves.toBe(false);
  });

  it('deletes a member by id', async () => {
    authenticatedFetch.mockResolvedValue(response(null));
    await expect(removeInternalMember('s1', 7)).resolves.toBe(true);
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/sessions/s1/internal-room/members/7', expect.objectContaining({ method: 'DELETE' }));
  });

  it('revalidates with an explicit member list and returns the room or null', async () => {
    const room = { members: [], unreadMentionCount: 0, lastReadSequence: 0, role: 'owner' };
    authenticatedFetch.mockResolvedValueOnce(response(room)).mockResolvedValueOnce(response({}, false));
    await expect(revalidateInternalRoom('s1', [{ userId: 1, role: 'owner' }])).resolves.toEqual(room);
    expect(JSON.parse(authenticatedFetch.mock.calls[0][1].body)).toEqual({ members: [{ userId: 1, role: 'owner' }] });
    await expect(revalidateInternalRoom('s1', [{ userId: 1, role: 'owner' }])).resolves.toBeNull();
  });

  it('maps project members and returns null on refusal or a malformed body', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(response({ success: true, data: { members: [{ userId: 2, displayName: 'sara' }, { userId: 'x' }, { userId: 3, displayName: null }] } }))
      .mockResolvedValueOnce(response({}, false))
      .mockResolvedValueOnce(response({ data: {} }));
    await expect(listProjectMemberOptions('p1')).resolves.toEqual([{ userId: 2, displayName: 'sara' }, { userId: 3, displayName: '3' }]);
    await expect(listProjectMemberOptions('p1')).resolves.toBeNull();
    await expect(listProjectMemberOptions('p1')).resolves.toBeNull();
  });

  it('tells lost access (403/404) apart from a transient room re-read failure', async () => {
    const room = { members: [], unreadMentionCount: 0, lastReadSequence: 0, role: 'owner' };
    authenticatedFetch
      .mockResolvedValueOnce(response(room))
      .mockResolvedValueOnce(response({}, false, 404))
      .mockResolvedValueOnce(response({}, false, 403))
      .mockResolvedValueOnce(response({}, false, 502))
      .mockRejectedValueOnce(new TypeError('network'));
    await expect(refreshInternalRoom('s1')).resolves.toEqual({ kind: 'room', room });
    await expect(refreshInternalRoom('s1')).resolves.toEqual({ kind: 'gone' });
    await expect(refreshInternalRoom('s1')).resolves.toEqual({ kind: 'gone' });
    await expect(refreshInternalRoom('s1')).resolves.toEqual({ kind: 'error' });
    await expect(refreshInternalRoom('s1')).resolves.toEqual({ kind: 'error' });
  });
});
