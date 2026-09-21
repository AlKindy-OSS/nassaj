import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { useConversationClosed } from '../chat/hooks/useConversationClosed';
import CloseConversationButton from '../chat/view/subcomponents/CloseConversationButton';
import ConversationCostChip from '../chat/view/subcomponents/ConversationCostChip';
import ConversationResourceChip from '../chat/view/subcomponents/ConversationResourceChip';

import ParticipantAvatarStack from './ParticipantAvatarStack';
import SessionAgentsChip from './SessionAgentsChip';
import type { SessionSkillsState } from './useSessionSkills';
import { useSessionParticipants } from './hooks';

type SessionParticipantsBarProps = {
  sessionId: string | null | undefined;
  className?: string;
  /**
   * Streaming state of the conversation. Its falling edge (true → false) is the
   * cost chip's only refetch trigger — the transcript's token counters are
   * settled exactly then. Optional: unwired hosts simply get the on-open figure.
   */
  isLoading?: boolean;
  /** Sum of attested completed turns currently represented by this session view. */
  workDurationMs?: number | null;
  /** Closed flag from the session row (sidebar payload). Optimistic locally. */
  closed?: boolean;
  /** Fired on every visible flip, including a rollback after a failed request. */
  onClosedChange?: (closed: boolean) => void;
  /** Secondary roster reads start only after the first message payload paints. */
  historyReady?: boolean;
  skills?: SessionSkillsState;
};

/** Owner-first, then by recency — same contract as the avatar stack. */
function SessionIdChip({ sessionId, t }: { sessionId: string; t: ReturnType<typeof useTranslation>['t'] }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // The initial UUID segment is enough to orient the header without making it
  // compete with the participant controls. The copy action still preserves the
  // complete identifier.
  const displayId = sessionId.split('-', 1)[0];
  const copyLabel = `${t('participants.copySessionId', { defaultValue: 'Copy session ID' })} ${displayId}`;

  const copySessionId = async () => {
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <span className="inline-flex items-center gap-1" dir="ltr">
      <button
        type="button"
        onClick={copySessionId}
        aria-label={copyLabel}
        title={copyLabel}
        className="inline-flex min-h-7 max-w-32 items-center gap-1 rounded-md px-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <bdi dir="ltr" className="truncate">{displayId}</bdi>
        {copyState === 'copied' ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      </button>
      <span className="sr-only" role="status" dir="auto">
        {copyState === 'copied' && t('participants.sessionIdCopied', { defaultValue: 'Session ID copied' })}
      </span>
      {copyState === 'failed' && (
        <span className="inline-flex max-w-52 items-center gap-1 text-xs text-destructive" role="status" dir="auto">
          <span>{t('participants.sessionIdCopyFailed', { defaultValue: 'Copy failed. Select the session ID to copy it manually.' })}</span>
          <bdi dir="ltr" className="select-text break-all font-mono text-foreground">{sessionId}</bdi>
        </span>
      )}
    </span>
  );
}

/** Conversation controls rendered inline in the shared header portal. */
export default function SessionParticipantsBar({
  sessionId,
  className,
  isLoading,
  workDurationMs,
  closed: closedProp = false,
  onClosedChange,
  historyReady = true,
  skills,
}: SessionParticipantsBarProps) {
  const { t, i18n } = useTranslation('chat');
  const locale = i18n.language;
  const { status, participants, agents, harness } = useSessionParticipants(sessionId, historyReady);
  const conversationClosed = useConversationClosed(sessionId, {
    initialClosed: closedProp,
    onChange: onClosedChange,
  });

  if (!sessionId) {
    return null;
  }

  if (!historyReady || status === 'loading' || status === 'idle') {
    return (
      <div className={cn('flex shrink-0 items-center gap-2', className)}>
        <span className="inline-flex items-center gap-2" role="status" aria-label={t('participants.loading', { defaultValue: 'Loading participants' })}>
          <span aria-hidden className="h-6 w-6 animate-pulse rounded-full bg-muted/60 motion-reduce:animate-none" />
          <span aria-hidden className="h-3 w-24 animate-pulse rounded bg-muted/40 motion-reduce:animate-none" />
        </span>
        <SessionIdChip sessionId={sessionId} t={t} />
      </div>
    );
  }

  const hasAgents = agents.length > 0;
  const hasParticipants = participants.length > 0;

  return (
    <>
      <div className={cn('flex shrink-0 items-center gap-2', className)}>
        {/* Portraits are the persistent identity surface; names and roles are
            available from each avatar's accessible detail card. */}
        {participants.length > 0 && (
          <div className="flex items-center">
            <ParticipantAvatarStack
              participants={participants}
              size="sm"
              max={5}
              locale={locale}
              t={t}
            />
          </div>
        )}

        {hasParticipants && hasAgents && (
          <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
        )}

        <SessionIdChip sessionId={sessionId} t={t} />

        {sessionId && (
          <SessionAgentsChip
            key={sessionId}
            agents={agents}
            skills={skills}
            harness={harness}
            t={t}
            dir={locale.startsWith('ar') ? 'rtl' : 'ltr'}
          />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <ConversationCostChip workDurationMs={workDurationMs} />
        <ConversationResourceChip sessionId={sessionId} isLoading={isLoading} />
        <CloseConversationButton
          closed={conversationClosed.closed}
          pending={conversationClosed.pending}
          failed={conversationClosed.failed}
          onToggle={conversationClosed.toggle}
        />
      </div>

    </>
  );
}
