import { useEffect } from 'react';
import type { TFunction } from 'i18next';

import { cn } from '../../lib/utils';

import AgentChipRow from './AgentChipRow';
import ParticipantAvatarStack from './ParticipantAvatarStack';
import { useSessionParticipants } from './hooks';

type SessionParticipantsRowProps = {
  sessionId: string;
  locale: string;
  t: TFunction;
  // Trigger the lazy fetch. The parent flips this on hover or when the row's
  // session is opened so we never fetch for every session up front.
  active: boolean;
  className?: string;
};

/**
 * Compact participants line for a sidebar session row (F-1): a small user
 * avatar stack, a thin divider, then agent chips. Deliberately lightweight
 * (text-xs, reduced opacity) so it never disrupts the existing row layout.
 */
export default function SessionParticipantsRow({
  sessionId,
  locale,
  t,
  active,
  className,
}: SessionParticipantsRowProps) {
  const { status, participants, agents, load } = useSessionParticipants(sessionId);

  useEffect(() => {
    if (active) {
      load();
    }
  }, [active, load]);

  if (!active) {
    return null;
  }

  if (status === 'loading' || status === 'idle') {
    return (
      <div
        className={cn('mt-1 flex items-center gap-1', className)}
        aria-hidden
      >
        <span className="h-4 w-4 animate-pulse rounded-full bg-muted/60" />
        <span className="h-4 w-4 -ms-1.5 animate-pulse rounded-full bg-muted/40" />
      </div>
    );
  }

  if (status === 'error' || (participants.length === 0 && agents.length === 0)) {
    return null;
  }

  return (
    <div
      className={cn('mt-1 flex items-center gap-1.5 opacity-80', className)}
      onClick={(event) => event.stopPropagation()}
    >
      <ParticipantAvatarStack
        participants={participants}
        size="sm"
        max={3}
        locale={locale}
        t={t}
      />
      {participants.length > 0 && agents.length > 0 && (
        <span aria-hidden className="h-3.5 w-px bg-border" />
      )}
      <AgentChipRow agents={agents} max={2} t={t} />
    </div>
  );
}
