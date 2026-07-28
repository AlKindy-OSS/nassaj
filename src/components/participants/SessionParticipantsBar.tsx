import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Button } from '../../shared/view/ui';
import { useConversationClosed } from '../chat/hooks/useConversationClosed';
import CloseConversationButton from '../chat/view/subcomponents/CloseConversationButton';
import ConversationCostChip from '../chat/view/subcomponents/ConversationCostChip';
import AgentChipRow from './AgentChipRow';
import ParticipantAvatarStack from './ParticipantAvatarStack';
import { useSessionParticipants } from './hooks';
import { isOwnerRole } from './utils';

type SessionParticipantsBarProps = {
  sessionId: string | null | undefined;
  className?: string;
  /**
   * Kept for API compatibility with ChatInterface — no longer used for visual
   * highlighting in the header (the flat roster shows all participants equally).
   */
  activeCoordinatorId?: number | null;
  /** Collapse the bar (inline chevron control); the host renders a matching expand chevron. */
  onHide?: () => void;
  /**
   * Streaming state of the conversation. Its falling edge (true → false) is the
   * cost chip's only refetch trigger — the transcript's token counters are
   * settled exactly then. Optional: unwired hosts simply get the on-open figure.
   */
  isLoading?: boolean;
  /** Closed flag from the session row (sidebar payload). Optimistic locally. */
  closed?: boolean;
  /** Fired on every visible flip, including a rollback after a failed request. */
  onClosedChange?: (closed: boolean) => void;
};

/** Owner-first, then by recency — same contract as the avatar stack. */
function orderForNames<T extends { role: string; last_seen: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ownerA = isOwnerRole(a.role) ? 1 : 0;
    const ownerB = isOwnerRole(b.role) ? 1 : 0;
    if (ownerA !== ownerB) return ownerB - ownerA;
    return (new Date(b.last_seen).getTime() || 0) - (new Date(a.last_seen).getTime() || 0);
  });
}

/**
 * Wider participants strip shown at the top of an open conversation (F-2).
 *
 * The strip's primary content is the agent/role row (model + subagents),
 * derived from the transcript and fully independent of identity/multi-user.
 * It renders whenever any agents are present. The human-participants block
 * (avatar stack + names) is an *optional, additive* layer that degrades
 * safely to nothing when the identity layer returns no participants — it
 * never gates the bar on its own.
 *
 * All avatars are displayed at equal size in a flat stack — there is no
 * active-speaker highlight in the header. Message attribution (which
 * coordinator sent which reply) is handled inside each message bubble via
 * coordinatorId and is unaffected by this component.
 */
export default function SessionParticipantsBar({
  sessionId,
  className,
  onHide,
  isLoading,
  closed: closedProp = false,
  onClosedChange,
}: SessionParticipantsBarProps) {
  const { t, i18n } = useTranslation('chat');
  const locale = i18n.language;
  const { status, participants, agents, load } = useSessionParticipants(sessionId);
  const conversationClosed = useConversationClosed(sessionId, {
    initialClosed: closedProp,
    onChange: onClosedChange,
  });

  useEffect(() => {
    if (sessionId) {
      load();
    }
  }, [sessionId, load]);

  if (!sessionId) {
    return null;
  }

  if (status === 'loading' || status === 'idle') {
    return (
      <div
        className={cn(
          'flex items-center gap-2 border-b border-border/60 px-3 py-2 sm:px-4',
          className,
        )}
        aria-hidden
      >
        <span className="h-6 w-6 animate-pulse rounded-full bg-muted/60" />
        <span className="h-3 w-24 animate-pulse rounded bg-muted/40" />
      </div>
    );
  }

  // Agents alone are enough to show the roster; the human-participants block is
  // additive and may be empty. The bar itself no longer disappears when both are
  // empty (or the roster request failed): it now carries conversation-level
  // controls (cost + close) that must stay reachable in a perfectly valid
  // conversation that simply has no agents parsed yet.
  const hasAgents = agents.length > 0;
  const hasParticipants = participants.length > 0;

  const namedAll = orderForNames(participants).slice(0, 3);
  const extraUsers = participants.length - namedAll.length;
  const nameSeparator = locale.startsWith('ar') ? '،' : ',';

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border/60 px-3 py-2 sm:px-4',
        className,
      )}
      role="group"
      aria-label={t('participants.barAria', { defaultValue: 'Conversation participants' })}
    >
      {/* Flat roster: all participants shown at equal weight, no active-speaker highlight. */}
      {participants.length > 0 && (
        <div className="flex items-center gap-2">
          <ParticipantAvatarStack
            participants={participants}
            size="sm"
            max={5}
            locale={locale}
            t={t}
          />
          <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
            {namedAll.map((user, index) => (
              <span key={user.userId} className="inline-flex items-center">
                {index > 0 && <span className="me-1 opacity-50">{nameSeparator}</span>}
                <span className={cn('font-medium', isOwnerRole(user.role) && 'text-foreground/90')}>
                  {user.username}
                </span>
              </span>
            ))}
            {extraUsers > 0 && (
              <span className="opacity-70">
                {t('participants.andMore', {
                  count: extraUsers,
                  defaultValue: 'and {{count}} more',
                })}
              </span>
            )}
          </span>
        </div>
      )}

      {hasParticipants && hasAgents && (
        <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
      )}

      {hasAgents && <AgentChipRow agents={agents} max={5} t={t} />}

      {/* Conversation-level controls. They carry the `ms-auto` that used to sit
          on the collapse chevron, so the chevron stays the LAST child flush at
          the inline-end padding edge: ChatInterface pins its floating button
          column to that exact geometry (end-[14px] / sm:end-[18px] — see the
          comment near ChatInterface.tsx:756-772), and appending anything after
          the chevron would silently break that alignment. */}
      <div className="ms-auto flex items-center gap-1.5">
        {conversationClosed.closed && (
          <span className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {t('closeConversation.closedBadge', { defaultValue: 'Closed' })}
          </span>
        )}
        <ConversationCostChip sessionId={sessionId} isLoading={isLoading} />
        <CloseConversationButton
          closed={conversationClosed.closed}
          pending={conversationClosed.pending}
          failed={conversationClosed.failed}
          onToggle={conversationClosed.toggle}
        />
      </div>

      {onHide && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-accent/80 hover:text-foreground"
          onClick={onHide}
          aria-label={t('participants.hide', { defaultValue: 'Hide participants bar' })}
          title={t('participants.hide', { defaultValue: 'Hide participants bar' })}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
