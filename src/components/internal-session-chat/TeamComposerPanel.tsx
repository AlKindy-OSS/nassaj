import { useTranslation } from 'react-i18next';
import { AtSign, LockKeyhole, UserCog, Users } from 'lucide-react';

import { cn } from '../../lib/utils';

import type { InternalMember } from './internalSessionChatApi';
import InternalRoomMembers from './InternalRoomMembers';
import type { InternalSessionChatController } from './useInternalSessionChat';

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const ACCENT_BUTTON = 'border-[color:var(--session-internal-accent)]/40 bg-[color:var(--session-internal-accent)]/15';

type PanelProps = {
  chat: InternalSessionChatController;
  projectId?: string | null;
};

/** Room unavailable / creation refused: the creator may re-activate it. */
function UnavailableNotice({ chat }: { chat: InternalSessionChatController }) {
  const { t } = useTranslation('chat');
  return (
    <div className="mt-2 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
      <p>{t('internalChat.unavailable')}</p>
      {chat.createFailed && (
        <>
          <p className="mt-2">{t('internalChat.reactivateHint')}</p>
          <button
            type="button"
            onClick={() => void chat.reactivate()}
            className={cn(FOCUS_RING, ACCENT_BUTTON, 'mt-3 inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium text-foreground')}
          >
            {t('internalChat.reactivate')}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Team-mode header shown above the composer (outside its form, because the
 * members panel carries its own form): what the mode is, that it stays
 * internal, members management, the room's unavailable state and errors.
 */
export function TeamComposerPanel({ chat, projectId }: PanelProps) {
  const { t } = useTranslation('chat');
  const { room } = chat;
  return (
    <section
      aria-label={t('internalChat.title')}
      data-testid="composer-team-panel"
      className="border-[color:var(--session-internal-accent)]/40 bg-[color:var(--session-internal-accent)]/10 mb-2 rounded-xl border px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1 font-semibold text-foreground">
          <Users className="size-3.5 text-[color:var(--session-internal-accent)]" aria-hidden="true" />
          {t('internalChat.title')}
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <LockKeyhole className="size-3" aria-hidden="true" />
          {t('internalChat.notSentNote')}
        </span>
        <span className="ms-auto inline-flex items-center gap-1">
          {room && (
            <button
              type="button"
              aria-pressed={chat.showMembers}
              onClick={() => chat.setShowMembers((value) => !value)}
              className={cn(FOCUS_RING, 'inline-flex min-h-7 items-center gap-1 rounded-md px-1.5 font-medium text-foreground hover:bg-muted', chat.showMembers && 'bg-muted')}
            >
              <UserCog className="size-3.5" aria-hidden="true" />
              {t('internalChat.members.toggle', { count: room.members.length })}
            </button>
          )}
          <button
            type="button"
            onClick={chat.exit}
            className={cn(FOCUS_RING, 'min-h-7 rounded px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground')}
          >
            {t('internalChat.exit')} <kbd className="font-mono text-[10px]">Esc</kbd>
          </button>
        </span>
      </div>
      {chat.error && <p role="alert" className="mt-2 text-sm text-destructive">{chat.error}</p>}
      {!room && <UnavailableNotice chat={chat} />}
      {room && chat.showMembers && (
        <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-border bg-background">
          <InternalRoomMembers sessionId={chat.sessionId} projectId={projectId} room={room} onRoomChange={chat.onRoomChange} />
        </div>
      )}
    </section>
  );
}

type MentionListProps = {
  id: string;
  suggestions: InternalMember[];
  highlighted: number;
  onSelect: (member: InternalMember) => void;
};

/** `@` completion over room members, anchored above the composer textarea. */
export function TeamMentionList({ id, suggestions, highlighted, onSelect }: MentionListProps) {
  const { t } = useTranslation('chat');
  if (suggestions.length === 0) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label={t('internalChat.mentionList')}
      className="absolute bottom-full start-0 z-20 mb-1 w-full max-w-xs rounded-lg border border-border bg-popover p-1 shadow-lg"
    >
      {suggestions.map((member, index) => (
        <li
          key={String(member.userId)}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === highlighted}
          onMouseDown={(event) => { event.preventDefault(); onSelect(member); }}
          className={cn(
            'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-start text-sm text-foreground hover:bg-muted',
            index === highlighted && 'bg-muted',
          )}
        >
          <AtSign className="size-3.5" aria-hidden="true" /><bdi>{member.username}</bdi>
        </li>
      ))}
    </ul>
  );
}
