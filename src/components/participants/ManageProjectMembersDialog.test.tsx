import type { TFunction } from 'i18next';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileRevokedIdentity = vi.fn();
const getProjectMembers = vi.fn();
const searchProjectMemberCandidates = vi.fn();
const addProjectMember = vi.fn();
const removeProjectMember = vi.fn();
let identity = { version: '1', phase: 'stable' };
let identityListener: (() => void) | null = null;
vi.mock('../../utils/api', () => ({ api: {
  getProjectMembers: (...args: unknown[]) => getProjectMembers(...args),
  searchProjectMemberCandidates: (...args: unknown[]) => searchProjectMemberCandidates(...args),
  addProjectMember: (...args: unknown[]) => addProjectMember(...args),
  removeProjectMember: (...args: unknown[]) => removeProjectMember(...args),
} }));
vi.mock('../auth/accountIdentityBarrier', () => ({
  reconcileRevokedIdentity: () => reconcileRevokedIdentity(),
  getIdentityBarrierSnapshot: () => identity,
  subscribeIdentityBarrier: (listener: () => void) => { identityListener = listener; return () => { identityListener = null; }; },
}));

import ManageProjectMembersButton from './ManageProjectMembersDialog';

const t = ((key: string, options?: Record<string, unknown>) => options?.defaultValue as string ?? key) as unknown as TFunction;
const member = (userId: number, role: 'owner' | 'member', isCreator = false, displayName = `User ${userId}`) => ({ userId, displayName, avatar: null, role, isCreator });
const viewer = (over: Partial<{ isMember: boolean; adminAccess: boolean; canManageMembers: boolean; canManageOwnerRole: boolean }> = {}) => ({ isMember: true, adminAccess: false, canManageMembers: true, canManageOwnerRole: false, ...over });
const payload = (projectId: string, members: ReturnType<typeof member>[], access = viewer()) => ({ projectId, members, viewer: access });
const response = (data: unknown, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => ({ data }) } as Response);

async function open(projectId = 'proj-1', currentUserId = 99) {
  const rendered = render(<ManageProjectMembersButton projectId={projectId} currentUserId={currentUserId} t={t} />);
  fireEvent.click(screen.getByRole('button', { name: 'Project members' }));
  await screen.findByText('Manage project members');
  return rendered;
}

beforeEach(() => { identity = { version: '1', phase: 'stable' }; identityListener = null; vi.clearAllMocks(); reconcileRevokedIdentity.mockImplementation(() => { identity = { version: '2', phase: 'committed' }; identityListener?.(); }); });
afterEach(() => cleanup());

describe('ManageProjectMembersButton', () => {
  it('uses viewer flags exactly: admin badge and member controls without owner-role controls', async () => {
    getProjectMembers.mockReturnValue(response(payload('proj-1', [member(1, 'owner', true), member(2, 'owner'), member(3, 'member')], viewer({ isMember: false, adminAccess: true }))));
    await open();
    await screen.findByText('Admin access');
    expect(screen.getByLabelText('Add a member')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make member' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make owner' })).toBeNull();
    const ordinary = screen.getByText('User 3').closest('li')!;
    expect(within(ordinary).getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(within(screen.getByText('User 2').closest('li')!).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('canManageOwnerRole exposes promote/demote while creator stays immutable', async () => {
    getProjectMembers.mockReturnValue(response(payload('proj-1', [member(1, 'owner', true), member(2, 'owner'), member(3, 'member')], viewer({ canManageOwnerRole: true }))));
    addProjectMember.mockReturnValue(response({}));
    await open();
    await screen.findByText('Creator');
    expect(within(screen.getByText('User 1').closest('li')!).queryByRole('button')).toBeNull();
    fireEvent.click(within(screen.getByText('User 2').closest('li')!).getByRole('button', { name: 'Make member' }));
    await waitFor(() => expect(addProjectMember).toHaveBeenCalledWith('proj-1', 2, 'member', expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it('does not update optimistically and trusts the GET after an add mutation', async () => {
    let resolveMutation!: (value: Response) => void;
    getProjectMembers
      .mockReturnValueOnce(response(payload('proj-1', [member(1, 'owner', true)], viewer())))
      .mockReturnValueOnce(response(payload('proj-1', [member(1, 'owner', true), member(9, 'member', false, 'Nadia')], viewer())));
    searchProjectMemberCandidates.mockReturnValue(response({ projectId: 'proj-1', candidates: [{ id: 9, displayName: 'Nadia', avatar: null }] }));
    addProjectMember.mockReturnValue(new Promise(resolve => { resolveMutation = resolve; }));
    await open();
    const input = await screen.findByLabelText('Add a member');
    fireEvent.change(input, { target: { value: 'na' } });
    const add = await screen.findByRole('button', { name: 'Add' });
    fireEvent.click(add);
    expect(screen.getAllByText('Nadia')).toHaveLength(1);
    await act(async () => resolveMutation({ ok: true, status: 200, json: async () => ({ data: {} }) } as Response));
    await waitFor(() => expect(getProjectMembers).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('Nadia')).toHaveLength(1);
  });

  it('rejects delayed member JSON from an old project id', async () => {
    let resolveOld!: (value: unknown) => void;
    getProjectMembers
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise(resolve => { resolveOld = resolve; }) } as Response)
      .mockReturnValueOnce(response(payload('proj-2', [member(8, 'member', false, 'Fresh')], viewer())));
    const rendered = await open('proj-1');
    rendered.rerender(<ManageProjectMembersButton projectId="proj-2" currentUserId={99} t={t} />);
    await act(async () => resolveOld({ data: payload('proj-1', [member(7, 'member', false, 'Stale')], viewer()) }));
    expect(screen.queryByText('Stale')).toBeNull();
  });

  it('self-removal confirms, refetches, closes on lost access, and restores trigger focus', async () => {
    let resolveOldSearch!: (value: unknown) => void;
    getProjectMembers.mockReturnValueOnce(response(payload('proj-1', [member(5, 'member', false, 'Me')], viewer()))).mockReturnValueOnce(response({}, 404));
    searchProjectMemberCandidates.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(resolve => { resolveOldSearch = resolve; }) } as Response);
    removeProjectMember.mockReturnValue(response({}));
    await open('proj-1', 5);
    fireEvent.change(await screen.findByLabelText('Add a member'), { target: { value: 'ol' } });
    await waitFor(() => expect(searchProjectMemberCandidates).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Leave project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm leaving' }));
    await waitFor(() => expect(screen.queryByText('Manage project members')).toBeNull());
    await act(async () => resolveOldSearch({ data: { projectId: 'proj-1', candidates: [{ id: 8, displayName: 'Old result', avatar: null }] } }));
    expect(screen.queryByText('Old result')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Project members' })));
    expect(getProjectMembers).toHaveBeenCalledTimes(2);
  });

  it('does not replay a forbidden mutation and replaces stale controls from the authoritative GET', async () => {
    getProjectMembers
      .mockReturnValueOnce(response(payload('proj-1', [member(3, 'member')], viewer())))
      .mockReturnValueOnce(response(payload('proj-1', [member(3, 'member')], viewer({ canManageMembers: false }))));
    removeProjectMember.mockReturnValue(response({}, 403));
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Your permissions changed. The list will be refreshed.');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull());
    expect(screen.queryByLabelText('Add a member')).toBeNull();
    expect(removeProjectMember).toHaveBeenCalledTimes(1);
  });

  it('clears and closes on identity transition before delayed JSON can repopulate', async () => {
    let resolveJson!: (value: unknown) => void;
    getProjectMembers.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(resolve => { resolveJson = resolve; }) } as Response);
    await open();
    await waitFor(() => expect(resolveJson).toBeTypeOf('function'));
    await act(async () => { identity = { version: '2', phase: 'committed' }; identityListener?.(); });
    await act(async () => resolveJson({ data: payload('proj-1', [member(4, 'member', false, 'Old identity')], viewer()) }));
    expect(screen.queryByText('Old identity')).toBeNull();
    expect(screen.queryByText('Manage project members')).toBeNull();
  });
  it.each(['cannot_remove_creator', 'cannot_change_creator_role', 'project_access_changed', 'other_conflict'])('classifies %s precisely and reconciles without replay', async code => {
    getProjectMembers.mockReturnValueOnce(response(payload('proj-1', [member(3, 'member')]))).mockReturnValueOnce(response(payload('proj-1', [member(3, 'member')], viewer({ canManageMembers: false }))));
    removeProjectMember.mockResolvedValue({ ok: false, status: 409, json: async () => ({ code, notStarted: false, effectState: 'outcome_unknown' }) });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const creator = code.startsWith('cannot_');
    await screen.findByText(creator ? 'The project creator cannot be changed or removed.' : 'The result of the change could not be confirmed. Check the refreshed list before making another change.');
    await waitFor(() => expect(screen.queryByLabelText('Add a member')).toBeNull());
    expect(getProjectMembers).toHaveBeenCalledTimes(2);
    expect(removeProjectMember).toHaveBeenCalledTimes(1);
    expect(addProjectMember).not.toHaveBeenCalled();
  });

  it('reconciles identity globally on its exact conflict code without replay', async () => {
    getProjectMembers.mockReturnValue(response(payload('proj-1', [member(3, 'member')])));
    removeProjectMember.mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: 'identity_changed' }) });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(reconcileRevokedIdentity).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Manage project members')).toBeNull();
    expect(getProjectMembers).toHaveBeenCalledTimes(1);
    expect(removeProjectMember).toHaveBeenCalledTimes(1);
  });

  it('bounds a conflicting GET to one stable retry', async () => {
    getProjectMembers.mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: 'project_access_changed' }) });
    await open();
    await screen.findByText('Could not load members');
    expect(getProjectMembers).toHaveBeenCalledTimes(2);
    expect(removeProjectMember).not.toHaveBeenCalled();
    expect(addProjectMember).not.toHaveBeenCalled();
  });

  it('closes and restores focus after self-removal conflicts then GET returns 404', async () => {
    getProjectMembers.mockReturnValueOnce(response(payload('proj-1', [member(5, 'member')]))).mockReturnValueOnce(response({}, 404));
    removeProjectMember.mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: 'project_access_changed', notStarted: false }) });
    await open('proj-1', 5);
    fireEvent.click(await screen.findByRole('button', { name: 'Leave project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm leaving' }));
    await waitFor(() => expect(screen.queryByText('Manage project members')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Project members' })));
    expect(removeProjectMember).toHaveBeenCalledTimes(1);
    expect(getProjectMembers).toHaveBeenCalledTimes(2);
  });

  it.each(['fetch', 'json'])('discards a delayed conflict %s after identity changes', async boundary => {
    let resolveLate!: (value: unknown) => void;
    const pending = new Promise(resolve => { resolveLate = resolve; });
    getProjectMembers.mockReturnValue(response(payload('proj-1', [member(3, 'member')])));
    removeProjectMember.mockReturnValue(boundary === 'fetch' ? pending : Promise.resolve({ ok: false, status: 409, json: () => pending }));
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await act(async () => { identity = { version: '3', phase: 'committed' }; identityListener?.(); });
    await act(async () => resolveLate(boundary === 'fetch' ? { ok: false, status: 409, json: async () => ({ code: 'identity_changed' }) } : { code: 'identity_changed' }));
    expect(reconcileRevokedIdentity).not.toHaveBeenCalled();
    expect(getProjectMembers).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Manage project members')).toBeNull();
  });

  it('drops delayed conflict JSON after project selection changes', async () => {
    let resolveJson!: (value: unknown) => void;
    getProjectMembers.mockReturnValueOnce(response(payload('proj-1', [member(3, 'member')]))).mockReturnValueOnce(response(payload('proj-2', [member(8, 'member', false, 'Fresh project')])));
    removeProjectMember.mockResolvedValue({ ok: false, status: 409, json: () => new Promise(resolve => { resolveJson = resolve; }) });
    const rendered = await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(resolveJson).toBeTypeOf('function'));
    rendered.rerender(<ManageProjectMembersButton projectId="proj-2" currentUserId={99} t={t} />);
    await screen.findByText('Fresh project');
    await act(async () => resolveJson({ code: 'identity_changed' }));
    expect(reconcileRevokedIdentity).not.toHaveBeenCalled();
    expect(getProjectMembers).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Fresh project')).toBeTruthy();
  });

  it('discards delayed reconciliation JSON when identity changes', async () => {
    let resolveJson!: (value: unknown) => void;
    getProjectMembers.mockReturnValueOnce(response(payload('proj-1', [member(3, 'member')]))).mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise(resolve => { resolveJson = resolve; }) });
    removeProjectMember.mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: 'project_access_changed' }) });
    await open();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(resolveJson).toBeTypeOf('function'));
    expect(screen.queryByLabelText('Add a member')).toBeNull();
    await act(async () => { identity = { version: '3', phase: 'committed' }; identityListener?.(); });
    await act(async () => resolveJson({ data: payload('proj-1', [member(4, 'member', false, 'Stale reconciliation')]) }));
    expect(screen.queryByText('Stale reconciliation')).toBeNull();
    expect(removeProjectMember).toHaveBeenCalledTimes(1);
    expect(getProjectMembers).toHaveBeenCalledTimes(2);
  });

});
