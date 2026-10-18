import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserMinus, UserPlus } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Button } from '../../shared/view/ui';

import {
  addInternalMember, listProjectMemberOptions, refreshInternalRoom, removeInternalMember,
  type InternalGrantRole, type InternalMember, type InternalRoom, type ProjectMemberOption,
} from './internalSessionChatApi';

type Props = {
  sessionId: string;
  projectId: string | null | undefined;
  room: InternalRoom;
  /** Receives the server's fresh room after a change; null when the caller lost access. */
  onRoomChange: (room: InternalRoom | null) => void;
};

const FIELD = 'h-[var(--control-height-compact)] rounded-md border border-input bg-background ps-2 pe-8 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
const GRANT_ROLES: InternalGrantRole[] = ['member', 'viewer'];

/** Project members not yet in the room; loaded only for a manager. */
function useCandidates(projectId: string | null | undefined, enabled: boolean, members: InternalMember[]) {
  const [options, setOptions] = useState<ProjectMemberOption[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setOptions(null); setFailed(false);
    if (!enabled || !projectId) return undefined;
    const controller = new AbortController();
    void listProjectMemberOptions(projectId, controller.signal)
      .catch(() => null)
      .then((rows) => { if (!controller.signal.aborted) { setOptions(rows ?? []); setFailed(rows === null); } });
    return () => controller.abort();
  }, [enabled, projectId]);
  const inRoom = new Set(members.map((member) => String(member.userId)));
  return { candidates: (options ?? []).filter((option) => !inRoom.has(String(option.userId))), loading: enabled && Boolean(projectId) && options === null, failed };
}

type RowProps = {
  member: InternalMember;
  canManage: boolean;
  busy: boolean;
  onRole: (role: InternalGrantRole) => void;
  onRemove: () => void;
};

/** One member; the owner row is never editable (the server refuses self-removal). */
function MemberRow({ member, canManage, busy, onRole, onRemove }: RowProps) {
  const { t } = useTranslation('chat');
  const [confirming, setConfirming] = useState(false);
  const roleId = useId();
  const editable = canManage && member.role !== 'owner';
  return (
    <li className="flex min-h-10 flex-wrap items-center gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground"><bdi>{member.username}</bdi></p>
        {!editable && <p className="text-xs text-muted-foreground">{t(`internalChat.members.roles.${member.role}`)}</p>}
      </div>
      {editable && (
        <div className="flex shrink-0 items-center gap-1.5">
          <label className="sr-only" htmlFor={roleId}>{t('internalChat.members.roleFor', { name: member.username })}</label>
          <select id={roleId} className={cn(FIELD, 'min-w-28')} value={member.role} disabled={busy} onChange={(event) => onRole(event.target.value as InternalGrantRole)}>
            {GRANT_ROLES.map((role) => <option key={role} value={role}>{t(`internalChat.members.roles.${role}`)}</option>)}
          </select>
          {confirming ? (
            <>
              <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={onRemove}>{t('internalChat.members.confirmRemove')}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>{t('internalChat.members.cancel')}</Button>
            </>
          ) : (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(true)} aria-label={t('internalChat.members.removeNamed', { name: member.username })}>
              <UserMinus aria-hidden />{t('internalChat.members.remove')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Room member list. Management controls follow the caller's room role as the
 * server projects it (`room.role === 'owner'`); every change is still decided by
 * the server, and a refusal is shown as an error without guessing why.
 */
export default function InternalRoomMembers({ sessionId, projectId, room, onRoomChange }: Props) {
  const { t } = useTranslation('chat');
  const canManage = room.role === 'owner';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [grant, setGrant] = useState<InternalGrantRole>('member');
  const pickId = useId();
  const grantId = useId();
  const controller = useRef<AbortController | null>(null);
  const { candidates, loading, failed } = useCandidates(projectId, canManage, room.members);
  useEffect(() => () => controller.current?.abort(), []);

  const mutate = async (change: (signal: AbortSignal) => Promise<boolean>) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true); setError(null);
    const ok = await change(current.signal).catch(() => false);
    const next = ok ? await refreshInternalRoom(sessionId, current.signal) : null;
    if (current.signal.aborted) return;
    setBusy(false);
    if (!next) { setError(t('internalChat.members.changeFailed')); return; }
    setPick('');
    // A transient re-read failure keeps the current room; only 403/404 mean access is gone.
    if (next.kind === 'error') { setError(t('internalChat.members.refreshFailed')); return; }
    onRoomChange(next.kind === 'room' ? next.room : null);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <h3 className="mb-1 text-sm font-semibold text-foreground">{t('internalChat.members.heading')}</h3>
      <ul className="divide-y divide-border">
        {room.members.map((member) => (
          <MemberRow
            key={String(member.userId)}
            member={member}
            canManage={canManage}
            busy={busy}
            onRole={(role) => void mutate((signal) => addInternalMember(sessionId, Number(member.userId), role, signal))}
            onRemove={() => void mutate((signal) => removeInternalMember(sessionId, Number(member.userId), signal))}
          />
        ))}
      </ul>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      {canManage && (
        <form
          className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (pick) void mutate((signal) => addInternalMember(sessionId, Number(pick), grant, signal));
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor={pickId} className="text-xs text-muted-foreground">{t('internalChat.members.addLabel')}</label>
            <select id={pickId} className={FIELD} value={pick} disabled={busy || candidates.length === 0} onChange={(event) => setPick(event.target.value)}>
              <option value="">
                {loading ? t('internalChat.members.loading') : failed ? t('internalChat.members.candidatesFailed') : candidates.length === 0 ? t('internalChat.members.noCandidates') : t('internalChat.members.choose')}
              </option>
              {candidates.map((option) => <option key={option.userId} value={option.userId}>{option.displayName}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={grantId} className="text-xs text-muted-foreground">{t('internalChat.members.roleLabel')}</label>
            <select id={grantId} className={cn(FIELD, 'min-w-28')} value={grant} disabled={busy} onChange={(event) => setGrant(event.target.value as InternalGrantRole)}>
              {GRANT_ROLES.map((role) => <option key={role} value={role}>{t(`internalChat.members.roles.${role}`)}</option>)}
            </select>
          </div>
          <Button type="submit" size="sm" disabled={busy || !pick}><UserPlus aria-hidden />{t('internalChat.members.add')}</Button>
        </form>
      )}
    </div>
  );
}
