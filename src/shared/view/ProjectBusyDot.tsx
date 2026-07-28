import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { useAnySessionProcessing } from '../../stores/sessionProcessStateStore';
import { useAnySessionFinishedUnopened } from '../../stores/sessionCompletionStore';

type ProjectBusyDotProps = {
  /** Ids of the project's (loaded) sessions — the dot aggregates their states. */
  sessionIds: ReadonlyArray<string | null | undefined>;
  className?: string;
};

/**
 * Three-state activity dot next to a project's name in the sidebar:
 *
 *  - running  → pulsing primary dot while ANY session has a live provider run
 *               (same data source as SessionProcessBadge — the global
 *               sessionProcessStateStore fed by the server's /proc monitor
 *               `process_state` broadcasts).
 *  - finished → steady green dot when no run is live but at least one session
 *               finished and was never opened (sessionCompletionStore,
 *               persisted client-side). Opening the conversation clears it.
 *  - idle     → renders nothing.
 *
 * Running outranks finished. Color alone is never the only cue: each state
 * carries its own role/title/aria-label. Layout is flex/gap-based so RTL
 * needs no overrides.
 */
export default function ProjectBusyDot({ sessionIds, className }: ProjectBusyDotProps) {
  const { t } = useTranslation('common');
  const busy = useAnySessionProcessing(sessionIds);
  const finishedUnopened = useAnySessionFinishedUnopened(sessionIds);

  if (busy) {
    return (
      <span
        role="status"
        aria-label={t('sessionProcessState.projectBusyHint')}
        title={t('sessionProcessState.projectBusyHint')}
        className={cn('relative inline-flex h-2 w-2 flex-shrink-0', className)}
      >
        <span className="absolute inset-0 animate-ping rounded-full bg-primary/60" aria-hidden="true" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
      </span>
    );
  }

  if (finishedUnopened) {
    return (
      <span
        role="status"
        aria-label={t('sessionProcessState.projectDoneHint')}
        title={t('sessionProcessState.projectDoneHint')}
        className={cn('relative inline-flex h-2 w-2 flex-shrink-0', className)}
      >
        <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" aria-hidden="true" />
      </span>
    );
  }

  return null;
}
