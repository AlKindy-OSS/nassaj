import { useEffect } from 'react';
import type { TFunction } from 'i18next';

import { cn } from '../../lib/utils';

import ParticipantAvatarStack from './ParticipantAvatarStack';
import { useProjectParticipants } from './hooks';

type ProjectParticipantsSummaryProps = {
  projectId: string;
  locale: string;
  t: TFunction;
  // Lazily fetched; the parent activates this on hover or when expanded.
  active: boolean;
  className?: string;
};

/**
 * Project-level participation line (F-3): "N users · M agents" with a small
 * avatar stack, rendered under the project name. Lazy-loaded.
 *
 * Layout stability: this line used to render `null` until first hover and
 * then pop in (skeleton → summary), which made every sidebar project row jump
 * under the cursor. The wrapper now ALWAYS occupies a fixed-height slot
 * (h-5 — the avatar-stack height, the tallest content) and the lazy content
 * fades in with an opacity transition instead of entering/leaving the flow,
 * so the row's dimensions are identical with and without hover.
 */
export default function ProjectParticipantsSummary({
  projectId,
  locale,
  t,
  active,
  className,
}: ProjectParticipantsSummaryProps) {
  const { status, users, agents, load } = useProjectParticipants(projectId);

  useEffect(() => {
    if (active) {
      load();
    }
  }, [active, load]);

  const loaded = status === 'success';
  const hasParticipants = loaded && (users.length > 0 || agents.length > 0);
  const showSkeleton = active && status !== 'error' && !loaded;

  const summary = hasParticipants
    ? t('participants.projectSummary', {
        users: users.length,
        agents: agents.length,
        defaultValue: '{{users}} users · {{agents}} agents',
      })
    : '';

  return (
    <span
      className={cn(
        // Fixed-height slot reserved unconditionally — see the layout-stability
        // note above. h-5 matches the xs avatar stack so no state changes the
        // row height; overflow-hidden guards against any taller intruder.
        'mt-0.5 flex h-5 min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground',
        className,
      )}
    >
      {showSkeleton ? (
        <span className="inline-flex items-center gap-1" aria-hidden>
          <span className="h-3.5 w-3.5 animate-pulse rounded-full bg-muted/60" />
          <span className="h-2.5 w-16 animate-pulse rounded bg-muted/40" />
        </span>
      ) : (
        <span
          className={cn(
            'flex min-w-0 items-center gap-1.5 transition-opacity duration-200',
            hasParticipants ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden={!hasParticipants}
        >
          {users.length > 0 && (
            <ParticipantAvatarStack participants={users} size="xs" max={3} locale={locale} t={t} />
          )}
          {hasParticipants && <span className="truncate">{summary}</span>}
        </span>
      )}
    </span>
  );
}
