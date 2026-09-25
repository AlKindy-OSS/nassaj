import type { TFunction } from 'i18next';
import { UserPlus } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { getIdentityBarrierSnapshot, reconcileRevokedIdentity, subscribeIdentityBarrier } from '../auth/accountIdentityBarrier';
import { staticAssetUrl } from '../../lib/static-asset-url';
import { cn } from '../../lib/utils';
import { Button, Input } from '../../shared/view/ui';
import { Dialog, DialogContent, DialogTitle, DialogTrigger, useDialog } from '../../shared/view/ui/Dialog';
import { api } from '../../utils/api';

import { avatarColorForUser, initialForName } from './utils';

type MemberRole = 'owner' | 'member';
type Member = { userId: number; displayName: string | null; avatar: string | null; role: MemberRole; isCreator: boolean };
type Candidate = { id: number; displayName: string; avatar: string | null };
type Viewer = { isMember: boolean; adminAccess: boolean; canManageMembers: boolean; canManageOwnerRole: boolean };
type MembersPayload = { projectId: string; members: Member[]; viewer: Viewer };

type RequestFence = { generation: number; identity: string; projectId: string; controller: AbortController };
const conflictCode = (body: unknown): string | null => body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : null;
const identityKey = () => { const value = getIdentityBarrierSnapshot(); return `${value.version}:${value.phase}`; };

function parseMembersPayload(value: unknown, projectId: string): MembersPayload | null {
  if (!value || typeof value !== 'object') return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const row = data as Partial<MembersPayload>;
  const viewer = row.viewer as Partial<Viewer> | undefined;
  if (row.projectId !== projectId || !Array.isArray(row.members) || !viewer
    || typeof viewer.isMember !== 'boolean' || typeof viewer.adminAccess !== 'boolean'
    || typeof viewer.canManageMembers !== 'boolean' || typeof viewer.canManageOwnerRole !== 'boolean') return null;
  const members: Member[] = [];
  for (const item of row.members) {
    if (!item || typeof item !== 'object') return null;
    const member = item as Partial<Member>;
    if (!Number.isSafeInteger(member.userId) || member.userId! < 1
      || !(member.displayName === null || typeof member.displayName === 'string')
      || !(member.avatar === null || typeof member.avatar === 'string')
      || (member.role !== 'owner' && member.role !== 'member') || typeof member.isCreator !== 'boolean') return null;
    members.push(member as Member);
  }
  return { projectId, members, viewer: viewer as Viewer };
}

function parseCandidates(value: unknown, projectId: string): Candidate[] | null {
  if (!value || typeof value !== 'object') return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const payload = data as { projectId?: unknown; candidates?: unknown };
  if (payload.projectId !== projectId || !Array.isArray(payload.candidates)) return null;
  const rows: Candidate[] = [];
  for (const item of payload.candidates) {
    if (!item || typeof item !== 'object') return null;
    const candidate = item as Partial<Candidate>;
    if (!Number.isSafeInteger(candidate.id) || candidate.id! < 1 || typeof candidate.displayName !== 'string'
      || !(candidate.avatar === null || typeof candidate.avatar === 'string')) return null;
    rows.push(candidate as Candidate);
  }
  return rows;
}

function MemberAvatar({ userId, displayName, avatar }: Pick<Member, 'userId' | 'displayName' | 'avatar'>) {
  const name = displayName ?? String(userId);
  return avatar ? <img src={staticAssetUrl(avatar)} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : (
    <span aria-hidden className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white', avatarColorForUser(userId))}>{initialForName(name)}</span>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setDebounced(value), delayMs); return () => clearTimeout(timer); }, [delayMs, value]);
  return debounced;
}

function MemberRow({ member, viewer, currentUserId, busy, t, onRole, onRemove }: {
  member: Member; viewer: Viewer; currentUserId: number | null; busy: boolean; t: TFunction;
  onRole: (role: MemberRole) => void; onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const displayName = member.displayName ?? t('participants.memberDialog.unknownMember', { defaultValue: 'Unknown user' }) as string;
  const canRemove = !member.isCreator && (member.role === 'owner' ? viewer.canManageOwnerRole : viewer.canManageMembers);
  const canChangeRole = !member.isCreator && viewer.canManageOwnerRole;
  const isSelf = currentUserId === member.userId;
  return <li className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
    <div className="flex min-w-0 items-center gap-2">
      <MemberAvatar userId={member.userId} displayName={member.displayName} avatar={member.avatar} />
      <div className="min-w-0"><p className="truncate text-sm font-medium text-foreground"><bdi>{displayName}</bdi></p><p className="text-xs text-muted-foreground">{t(`participants.roles.${member.role === 'owner' ? 'owner' : 'user'}`, { defaultValue: member.role })}</p></div>
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
      {member.isCreator ? <span className="rounded-full bg-muted px-2 py-1 text-xs text-foreground">{t('participants.memberDialog.creator', { defaultValue: 'Creator' })}</span> : <>
        {canChangeRole && <Button type="button" size="lg" variant="outline" disabled={busy} onClick={() => onRole(member.role === 'owner' ? 'member' : 'owner')}>{t(member.role === 'owner' ? 'participants.memberDialog.makeMember' : 'participants.memberDialog.makeOwner', { defaultValue: member.role === 'owner' ? 'Make member' : 'Make owner' })}</Button>}
        {canRemove && (confirming ? <div className="flex w-full gap-2 sm:w-auto"><Button type="button" size="lg" variant="destructive" className="flex-1" disabled={busy} onClick={onRemove}>{busy ? t('participants.memberDialog.removing', { defaultValue: 'Removing…' }) : t(isSelf ? 'participants.memberDialog.confirmSelfRemove' : 'participants.memberDialog.confirmRemove', { defaultValue: isSelf ? 'Confirm leaving' : 'Confirm' })}</Button><Button type="button" size="lg" variant="outline" className="flex-1" disabled={busy} onClick={() => setConfirming(false)}>{t('participants.memberDialog.cancel', { defaultValue: 'Cancel' })}</Button></div> : <Button type="button" size="lg" variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>{t(isSelf ? 'participants.memberDialog.leave' : 'participants.memberDialog.remove', { defaultValue: isSelf ? 'Leave project' : 'Remove' })}</Button>)}
      </>}
    </div>
  </li>;
}

function AddMemberSearch({ projectId, viewer, existingIds, mutationBusy, generation, t, onAdd }: {
  projectId: string; viewer: Viewer; existingIds: Set<number>; mutationBusy: boolean; generation: number; t: TFunction;
  onAdd: (userId: number, role: MemberRole) => void;
}) {
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query.trim(), 300);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'success'>('idle');
  const [roleById, setRoleById] = useState<Record<number, MemberRole>>({});
  const epoch = useRef(0);
  const inputId = useId();

  useEffect(() => {
    const request = ++epoch.current;
    if (debounced.length < 2 || !viewer.canManageMembers) { setCandidates([]); setStatus('idle'); return; }
    const identity = identityKey(); const controller = new AbortController(); setStatus('loading');
    void (async () => {
      try {
        const response = await api.searchProjectMemberCandidates(projectId, debounced, { signal: controller.signal });
        if (request !== epoch.current || identity !== identityKey() || controller.signal.aborted) return;
        if (!response.ok) { setStatus('error'); return; }
        const body = await response.json();
        if (request !== epoch.current || identity !== identityKey() || controller.signal.aborted) return;
        const parsed = parseCandidates(body, projectId);
        if (!parsed) { setStatus('error'); return; }
        setCandidates(parsed.filter(candidate => !existingIds.has(candidate.id))); setStatus('success');
      } catch (error) { if (!controller.signal.aborted && (error as Error).name !== 'AbortError') setStatus('error'); }
    })();
    return () => controller.abort();
  }, [debounced, existingIds, generation, projectId, viewer.canManageMembers]);

  if (!viewer.canManageMembers) return null;
  return <div className="space-y-2">
    <label htmlFor={inputId} className="block text-sm font-medium text-foreground">{t('participants.memberDialog.searchLabel', { defaultValue: 'Add a member' })}</label>
    <Input className="h-11" id={inputId} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('participants.memberDialog.searchPlaceholder', { defaultValue: 'Search by username' }) as string} aria-describedby={`${inputId}-hint`} />
    <p id={`${inputId}-hint`} aria-live="polite" className="min-h-5 text-xs text-foreground">{query.length > 0 && query.trim().length < 2 ? t('participants.memberDialog.searchHint', { defaultValue: 'Type at least 2 characters' }) : status === 'loading' ? t('participants.memberDialog.searching', { defaultValue: 'Searching…' }) : status === 'error' ? t('participants.memberDialog.searchError', { defaultValue: 'Search failed' }) : status === 'success' && candidates.length === 0 ? t('participants.memberDialog.noResults', { defaultValue: 'No matching users' }) : ''}</p>
    {candidates.length > 0 && <ul className="space-y-2">{candidates.map(candidate => { const role = roleById[candidate.id] ?? 'member'; return <li key={candidate.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center"><span className="min-w-0 flex-1 truncate text-sm text-foreground"><bdi>{candidate.displayName}</bdi></span>{viewer.canManageOwnerRole && <select className="h-11 rounded-md border border-input bg-background px-3 text-sm text-foreground" value={role} disabled={mutationBusy} aria-label={t('participants.memberDialog.role', { defaultValue: 'Project role' }) as string} onChange={event => setRoleById(current => ({ ...current, [candidate.id]: event.target.value as MemberRole }))}><option value="member">{t('participants.roles.user', { defaultValue: 'Member' })}</option><option value="owner">{t('participants.roles.owner', { defaultValue: 'Owner' })}</option></select>}<Button type="button" size="lg" disabled={mutationBusy} onClick={() => onAdd(candidate.id, role)}>{t('participants.memberDialog.add', { defaultValue: 'Add' })}</Button></li>; })}</ul>}
  </div>;
}

function MembersManager({ projectId, t, currentUserId }: { projectId: string; t: TFunction; currentUserId: number | null }) {
  const { onOpenChange } = useDialog();
  const [members, setMembers] = useState<Member[]>([]);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [busyUserId, setBusyUserId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const [generation, setGeneration] = useState(0);
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const titleId = useId();

  const begin = useCallback((): RequestFence => {
    activeController.current?.abort();
    const controller = new AbortController(); activeController.current = controller;
    return { generation: ++requestGeneration.current, identity: identityKey(), projectId, controller };
  }, [projectId]);
  const valid = useCallback((fence: RequestFence) => fence.generation === requestGeneration.current && fence.identity === identityKey() && fence.projectId === projectId && !fence.controller.signal.aborted, [projectId]);

  const load = useCallback(async () => {
    const fence = begin(); setStatus('loading'); setMembers([]); setViewer(null);
    try {
      let response = await api.getProjectMembers(projectId, { signal: fence.controller.signal });
      if (!valid(fence)) return;
      if (response.status === 409) {
        const body = await response.json().catch(() => null); if (!valid(fence)) return;
        if (conflictCode(body) === 'identity_changed') { reconcileRevokedIdentity(); return; }
        if (conflictCode(body) !== 'project_access_changed' || getIdentityBarrierSnapshot().phase !== 'stable') throw new Error('load_conflict');
        response = await api.getProjectMembers(projectId, { signal: fence.controller.signal });
        if (!valid(fence)) return;
        if (response.status === 409) {
          const retryBody = await response.json().catch(() => null); if (!valid(fence)) return;
          if (conflictCode(retryBody) === 'identity_changed') { reconcileRevokedIdentity(); return; }
        }
      }
      if (response.status === 404) { onOpenChange(false); return; }
      if (!response.ok) throw new Error('load_failed');
      const body = await response.json(); if (!valid(fence)) return;
      const parsed = parseMembersPayload(body, projectId); if (!parsed) throw new Error('invalid_members');
      setMembers(parsed.members); setViewer(parsed.viewer); setStatus('ready'); setGeneration(value => value + 1);
    } catch (error) { if (valid(fence) && (error as Error).name !== 'AbortError') setStatus('error'); }
  }, [begin, onOpenChange, projectId, valid]);

  useEffect(() => { void load(); return () => { requestGeneration.current += 1; activeController.current?.abort(); }; }, [load]);
  useEffect(() => subscribeIdentityBarrier(() => {
    requestGeneration.current += 1; activeController.current?.abort(); setMembers([]); setViewer(null);
    if (getIdentityBarrierSnapshot().phase !== 'stable') onOpenChange(false);
  }), [onOpenChange]);
  useEffect(() => {
    const revoked = (event: Event) => { const detail = (event as CustomEvent<{ projectId?: string }>).detail; if (detail?.projectId === projectId) onOpenChange(false); };
    window.addEventListener('project:membership-revoked', revoked); return () => window.removeEventListener('project:membership-revoked', revoked);
  }, [onOpenChange, projectId]);

  const mutate = useCallback(async (kind: 'add' | 'remove', userId: number, role: MemberRole = 'member') => {
    if (!viewer || (role === 'owner' && !viewer.canManageOwnerRole)) return;
    setBusyUserId(userId); setActionError(''); const fence = begin();
    try {
      const response = kind === 'remove'
        ? await api.removeProjectMember(projectId, userId, { signal: fence.controller.signal })
        : await api.addProjectMember(projectId, userId, role, { signal: fence.controller.signal });
      if (!valid(fence)) return;
      if (response.status === 403) { setActionError(t('participants.memberDialog.forbidden', { defaultValue: 'Your permissions changed. The list will be refreshed.' }) as string); await load(); return; }
      if (response.status === 409) {
        const body = await response.json().catch(() => null); if (!valid(fence)) return;
        const code = conflictCode(body);
        if (code === 'identity_changed') { setMembers([]); setViewer(null); reconcileRevokedIdentity(); return; }
        const creatorProtected = code === 'cannot_remove_creator' || code === 'cannot_change_creator_role';
        setActionError(t(creatorProtected ? 'participants.memberDialog.creatorProtected' : 'participants.memberDialog.changeUnconfirmed', {
          defaultValue: creatorProtected ? 'The project creator cannot be changed or removed.' : 'The result of the change could not be confirmed. Check the refreshed list before making another change.',
        }) as string);
        await load(); return;
      }
      if (!response.ok) throw new Error('mutation_failed');
      await response.json().catch(() => null); if (!valid(fence)) return;
      await load();
    } catch (error) { if (valid(fence) && (error as Error).name !== 'AbortError') setActionError(t(kind === 'remove' ? 'participants.memberDialog.removeError' : 'participants.memberDialog.addError', { defaultValue: 'The change could not be saved.' }) as string); }
    finally { if (fence.identity === identityKey()) setBusyUserId(null); }
  }, [begin, load, projectId, t, valid, viewer]);

  const existingIds = useMemo(() => new Set(members.map(member => member.userId)), [members]);
  return <DialogContent aria-labelledby={titleId} className="max-h-[min(90dvh,44rem)] w-[calc(100vw-1rem)] max-w-xl overflow-y-auto p-4 text-start sm:p-6">
    <div className="flex flex-wrap items-center gap-2"><DialogTitle id={titleId} className="not-sr-only text-xl font-semibold text-foreground">{t('participants.memberDialog.title', { defaultValue: 'Manage project members' })}</DialogTitle>{viewer?.adminAccess && <span className="rounded-full bg-warning/15 px-2 py-1 text-xs font-medium text-warning">{t('participants.memberDialog.adminAccess', { defaultValue: 'Admin access' })}</span>}</div>
    <div className="mt-4 space-y-4">
      {viewer && <AddMemberSearch projectId={projectId} viewer={viewer} existingIds={existingIds} mutationBusy={busyUserId !== null} generation={generation} t={t} onAdd={(userId, role) => void mutate('add', userId, role)} />}
      {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
      <h3 className="border-t border-border pt-4 text-base font-semibold text-foreground">{t('participants.memberDialog.existing', { defaultValue: 'Current members' })}</h3>
      {status === 'loading' && <p role="status" className="text-sm text-foreground">{t('participants.memberDialog.loading', { defaultValue: 'Loading…' })}</p>}
      {status === 'error' && <div className="space-y-2"><p role="alert" className="text-sm text-danger">{t('participants.memberDialog.loadError', { defaultValue: 'Could not load members' })}</p><Button type="button" variant="outline" size="lg" onClick={() => void load()}>{t('participants.memberDialog.retry', { defaultValue: 'Retry' })}</Button></div>}
      {status === 'ready' && members.length === 0 && <p className="text-sm text-foreground">{t('participants.memberDialog.none', { defaultValue: 'No members yet' })}</p>}
      {status === 'ready' && members.length > 0 && viewer && <ul className="space-y-2">{members.map(member => <MemberRow key={member.userId} member={member} viewer={viewer} currentUserId={currentUserId} busy={busyUserId === member.userId} t={t} onRole={role => void mutate('add', member.userId, role)} onRemove={() => void mutate('remove', member.userId)} />)}</ul>}
      <div aria-live="polite" className="sr-only">{busyUserId !== null ? t('participants.memberDialog.saving', { defaultValue: 'Saving membership change' }) : actionError}</div>
      <Button type="button" variant="outline" size="lg" className="w-full" onClick={() => onOpenChange(false)}>{t('participants.memberDialog.close', { defaultValue: 'Close' })}</Button>
    </div>
  </DialogContent>;
}

export type ManageProjectMembersButtonProps = { projectId: string; t: TFunction; currentUserId?: number | null; className?: string };

export default function ManageProjectMembersButton({ projectId, t, currentUserId = null, className }: ManageProjectMembersButtonProps) {
  const [open, setOpen] = useState(false); const trigger = useRef<HTMLButtonElement>(null);
  const label = t('participants.memberDialog.trigger', { defaultValue: 'Project members' }) as string;
  return <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) requestAnimationFrame(() => trigger.current?.focus()); }}><DialogTrigger ref={trigger} className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)} title={label} aria-label={label}><UserPlus className="h-4 w-4" aria-hidden /></DialogTrigger>{open && <MembersManager key={projectId} projectId={projectId} t={t} currentUserId={currentUserId} />}</Dialog>;
}
