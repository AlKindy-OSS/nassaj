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
  return <li className="flex min-h-11 flex-wrap items-center gap-2 py-1.5 sm:flex-nowrap">
    <MemberAvatar userId={member.userId} displayName={member.displayName} avatar={member.avatar} />
    {/* qa MEDIUM (c): truncate على <bdi> block لا <p> — بدونها القصّ العربي
        RTL يقصّ الاسم اللاتيني من بدايته (يمين السطر) لا نهايته. */}
    <div className="min-w-0 flex-1"><p className="text-sm font-medium text-foreground"><bdi className="block truncate">{displayName}</bdi></p><p className="text-xs text-muted-foreground">{t(`participants.roles.${member.role === 'owner' ? 'owner' : 'user'}`, { defaultValue: member.role })}</p></div>
    {/* qa MEDIUM (c): flex-wrap على الصفّ يسمح للأزرار بالنزول سطراً ثانياً
        دون خنق الاسم على الشاشات الضيّقة، بلا قائمة ⋯ إضافية. */}
    <div className="flex shrink-0 items-center gap-1.5">
      {member.isCreator ? <span className="rounded-full bg-muted px-2 py-1 text-xs text-foreground">{t('participants.memberDialog.creator', { defaultValue: 'Creator' })}</span> : <>
        {canChangeRole && !confirming && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onRole(member.role === 'owner' ? 'member' : 'owner')}>{t(member.role === 'owner' ? 'participants.memberDialog.makeMember' : 'participants.memberDialog.makeOwner', { defaultValue: member.role === 'owner' ? 'Make member' : 'Make owner' })}</Button>}
        {canRemove && (confirming ? <><Button type="button" size="sm" variant="destructive" disabled={busy} onClick={onRemove}>{busy ? t('participants.memberDialog.removing', { defaultValue: 'Removing…' }) : t(isSelf ? 'participants.memberDialog.confirmSelfRemove' : 'participants.memberDialog.confirmRemove', { defaultValue: isSelf ? 'Confirm leaving' : 'Confirm' })}</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>{t('participants.memberDialog.cancel', { defaultValue: 'Cancel' })}</Button></> : <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>{t(isSelf ? 'participants.memberDialog.leave' : 'participants.memberDialog.remove', { defaultValue: isSelf ? 'Leave project' : 'Remove' })}</Button>)}
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
  const listRef = useRef<HTMLUListElement | null>(null);
  // qa (T-1868): the overlay used to render whenever there were candidates at
  // all, fading rows that were never clipped on a short list. Only an
  // overflowing list — and one not already scrolled to its last row — needs
  // the taper.
  const [showFade, setShowFade] = useState(false);
  const updateFade = useCallback(() => {
    const el = listRef.current;
    if (!el) { setShowFade(false); return; }
    const overflowing = el.scrollHeight > el.clientHeight + 1;
    const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    setShowFade(overflowing && !atEnd);
  }, []);

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

  useEffect(() => { updateFade(); }, [candidates, updateFade]);

  // qa round (optional #4): a viewport rotation/resize changes `max-h-52`'s
  // effective pixel height without touching `candidates` or firing a scroll
  // event, so the fade could go stale (shown on a list that no longer
  // overflows, or vice versa) until the next scroll. `ResizeObserver` isn't
  // in jsdom, so this no-ops harmlessly under the unit tests above.
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateFade);
    observer.observe(el);
    return () => observer.disconnect();
  }, [candidates, updateFade]);

  // round 3 (qa): AddMemberSearch used to `return null` here, but the comment
  // at MembersManager's call site claimed the height was reserved regardless
  // of permission — false: a viewer without canManageMembers got zero height,
  // so "Current members" still jumped once that permission resolved. Render
  // the same-height reserve as the loading skeleton (unanimated: this is a
  // resolved, final state, not "still loading") instead of nothing.
  if (!viewer.canManageMembers) return <SearchAreaHeightReserve message={t('participants.memberDialog.noAddPermission', { defaultValue: "You don't have permission to add members" }) as string} />;
  // qa MEDIUM (b): نتائج البحث كانت <ul> عادية داخل التدفّق — تدفع قائمة
  // الأعضاء تحتها حتى 160px. الآن قائمة عائمة (absolute) أسفل الحقل مباشرة،
  // فلا إزاحة لأي عنصر آخر. `relative` على الغلاف يجعلها تتموضع بالنسبة إليه.
  return <div className="relative space-y-2">
    <label htmlFor={inputId} className="block text-sm font-medium text-foreground">{t('participants.memberDialog.searchLabel', { defaultValue: 'Add a member' })}</label>
    <Input className="h-11" id={inputId} value={query} onChange={event => setQuery(event.target.value)} placeholder={t('participants.memberDialog.searchPlaceholder', { defaultValue: 'Search by username' }) as string} aria-describedby={`${inputId}-hint`} />
    <p id={`${inputId}-hint`} aria-live="polite" className="min-h-5 text-xs text-foreground">{query.length > 0 && query.trim().length < 2 ? t('participants.memberDialog.searchHint', { defaultValue: 'Type at least 2 characters' }) : status === 'loading' ? t('participants.memberDialog.searching', { defaultValue: 'Searching…' }) : status === 'error' ? t('participants.memberDialog.searchError', { defaultValue: 'Search failed' }) : status === 'success' && candidates.length === 0 ? t('participants.memberDialog.noResults', { defaultValue: 'No matching users' }) : ''}</p>
    {candidates.length > 0 && (
      // round 3 (qa): `relative` on this wrapper, not the outer <div> above,
      // so the fade overlay below positions against the dropdown itself —
      // and a stronger border/shadow (shadow-lg) than the rest of the dialog.
      <div className="absolute inset-x-0 top-full z-20 mt-1 rounded-md border border-border bg-popover shadow-lg">
        <ul ref={listRef} onScroll={updateFade} className="max-h-52 overflow-y-auto rounded-md">{candidates.map(candidate => { const role = roleById[candidate.id] ?? 'member'; return <li key={candidate.id} className="flex items-center gap-2 px-2 py-1.5"><span className="min-w-0 flex-1 text-sm text-foreground"><bdi className="block truncate">{candidate.displayName}</bdi></span>{viewer.canManageOwnerRole && <select className="h-8 rounded-md border border-input bg-background px-2 pe-7 text-sm text-foreground" value={role} disabled={mutationBusy} aria-label={t('participants.memberDialog.role', { defaultValue: 'Project role' }) as string} onChange={event => setRoleById(current => ({ ...current, [candidate.id]: event.target.value as MemberRole }))}><option value="member">{t('participants.roles.user', { defaultValue: 'Member' })}</option><option value="owner">{t('participants.roles.owner', { defaultValue: 'Owner' })}</option></select>}<Button type="button" size="sm" disabled={mutationBusy} onClick={() => onAdd(candidate.id, role)}>{t('participants.memberDialog.add', { defaultValue: 'Add' })}</Button></li>; })}</ul>
        {/* round 3 (qa): mask-image made the clipped rows semi-transparent,
            letting the members list BEHIND the dropdown show through. This is
            an opaque overlay of the popover's own surface fading to
            transparent on TOP of the list — it never reveals what's behind
            the dropdown itself, only visually tapers the last row.
            T-1868: shown only while the list actually overflows and isn't
            scrolled to its last row — a short list no longer gets a taper
            with nothing beneath it to justify one. */}
        {showFade && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-5 rounded-b-md bg-gradient-to-t from-popover to-transparent" />}
      </div>
    )}
  </div>;
}

/**
 * qa MEDIUM (a): يحتلّ ارتفاع `AddMemberSearch` نفسه (لصيقة + حقل h-11 +
 * سطر تلميح) — سواء أثناء التحميل (‏`viewer` لم يُحسم) أو بعده لعارضٍ بلا
 * صلاحية الإضافة — فلا ينزل عنوان «الأعضاء الحاليون» في أي من الحالتين.
 * ‏`pulse` هو الفارق الوحيد بين الحالتين: تحميلٌ حيّ أو نتيجةٌ نهائية.
 */
function SearchAreaHeightReserve({ pulse = false, message }: { pulse?: boolean; message?: string }) {
  const box = pulse ? 'animate-pulse rounded bg-muted' : '';
  // qa (T-1868): a resolved non-manager used to see a silent blank box here —
  // indistinguishable from a rendering glitch. `message` names the reason
  // (no add permission) without disturbing the reserved height any state uses.
  // qa round: كان النصّ محصوراً بمنتصف صندوق الحقل (h-11) وحده لا منتصف
  // المساحة المحجوزة كلها (لصيقة + حقل + تلميح). الهيكل الأصلي يبقى كما هو
  // (فارتفاعه هو الضمان عبر الحالات الثلاث)، والرسالة تعلوه بتموضعٍ مطلق
  // يتمركز عبر `inset-0`/`items-center` على المساحة الكاملة.
  return <div aria-hidden={!message} className="relative space-y-2">
    <div className={`h-5 w-24 ${box}`} />
    <div className={`h-11 ${pulse ? 'animate-pulse rounded-md bg-muted' : ''}`} />
    <div className="h-5" />
    {message && <p className="absolute inset-0 flex items-center text-sm text-muted-foreground">{message}</p>}
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
  return <DialogContent aria-labelledby={titleId} className="flex h-[min(90dvh,38rem)] w-[calc(100vw-1rem)] max-w-xl flex-col overflow-hidden p-4 text-start sm:p-6">
    <div className="flex flex-wrap items-center gap-2"><DialogTitle id={titleId} className="not-sr-only text-xl font-semibold text-foreground">{t('participants.memberDialog.title', { defaultValue: 'Manage project members' })}</DialogTitle>{viewer?.adminAccess && <span className="rounded-full bg-warning/15 px-2 py-1 text-xs font-medium text-warning">{t('participants.memberDialog.adminAccess', { defaultValue: 'Admin access' })}</span>}</div>
    {/* qa MEDIUM (b): overflow-hidden — لا يُمرَّر الغلاف كلّه؛ التمرير الوحيد
        الآن على قائمة الأعضاء نفسها (min-h-0 flex-1 overflow-y-auto) فتملأ
        الفراغ المتبقّي فعلاً بلا الفجوة الفارغة ~100px التي تركها ارتفاعٌ ثابت. */}
    <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      {/* qa MEDIUM (a): ارتفاع محجوز دائماً — سواء أثناء التحميل (هيكل)، أو
          بعد التحميل بلا صلاحية إضافة (فراغ بالارتفاع نفسه)، أو بالصلاحية
          (الحقل الحقيقي) — فلا ينزل عنوان «الأعضاء الحاليون» في أي حالة. */}
      {viewer
        ? <AddMemberSearch projectId={projectId} viewer={viewer} existingIds={existingIds} mutationBusy={busyUserId !== null} generation={generation} t={t} onAdd={(userId, role) => void mutate('add', userId, role)} />
        : <SearchAreaHeightReserve pulse />}
      {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
      <h3 className="text-sm font-semibold text-foreground">{t('participants.memberDialog.existing', { defaultValue: 'Current members' })}</h3>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === 'loading' && <p role="status" className="py-2 text-sm text-foreground">{t('participants.memberDialog.loading', { defaultValue: 'Loading…' })}</p>}
        {status === 'error' && <div className="space-y-2 py-2"><p role="alert" className="text-sm text-danger">{t('participants.memberDialog.loadError', { defaultValue: 'Could not load members' })}</p><Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('participants.memberDialog.retry', { defaultValue: 'Retry' })}</Button></div>}
        {status === 'ready' && members.length === 0 && <p className="py-2 text-sm text-foreground">{t('participants.memberDialog.none', { defaultValue: 'No members yet' })}</p>}
        {status === 'ready' && members.length > 0 && viewer && <ul className="divide-y divide-border">{members.map(member => <MemberRow key={member.userId} member={member} viewer={viewer} currentUserId={currentUserId} busy={busyUserId === member.userId} t={t} onRole={role => void mutate('add', member.userId, role)} onRemove={() => void mutate('remove', member.userId)} />)}</ul>}
      </div>
      <div aria-live="polite" className="sr-only">{busyUserId !== null ? t('participants.memberDialog.saving', { defaultValue: 'Saving membership change' }) : actionError}</div>
    </div>
    <Button type="button" variant="outline" size="lg" className="mt-3 w-full shrink-0" onClick={() => onOpenChange(false)}>{t('participants.memberDialog.close', { defaultValue: 'Close' })}</Button>
  </DialogContent>;
}

export type ManageProjectMembersButtonProps = { projectId: string; t: TFunction; currentUserId?: number | null; className?: string };

export default function ManageProjectMembersButton({ projectId, t, currentUserId = null, className }: ManageProjectMembersButtonProps) {
  const [open, setOpen] = useState(false); const trigger = useRef<HTMLButtonElement>(null);
  const label = t('participants.memberDialog.trigger', { defaultValue: 'Project members' }) as string;
  return <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) requestAnimationFrame(() => trigger.current?.focus()); }}><DialogTrigger ref={trigger} className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)} title={label} aria-label={label}><UserPlus className="h-4 w-4" aria-hidden /></DialogTrigger>{open && <MembersManager key={projectId} projectId={projectId} t={t} currentUserId={currentUserId} />}</Dialog>;
}
