import { Check, Pause } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { useSessionProcessState } from '../../stores/sessionProcessStateStore';
import { useSessionFinishedUnopened } from '../../stores/sessionCompletionStore';

type SessionProcessBadgeProps = {
  sessionId?: string | null;
  className?: string;
};

/**
 * Tiny live badge for a session's process state, fed by the server's /proc
 * monitor through the global store:
 *
 *  - running → pulsing green dot + "Running"
 *  - frozen  → amber pause pill + "Paused (frozen)" (kill -STOP'd process)
 *  - done    → steady green check pill + "Done" while the session finished a
 *              run and was never opened (sessionCompletionStore); opening the
 *              conversation clears it, so the open-chat header never shows it
 *  - idle / unknown → renders nothing (quiet default)
 *
 * Used next to the session row in the sidebar and in the open-chat header.
 * Layout uses gap/logical flow only, so RTL needs no overrides.
 */
export default function SessionProcessBadge({ sessionId, className }: SessionProcessBadgeProps) {
  const { t } = useTranslation('common');
  const state = useSessionProcessState(sessionId);
  const finishedUnopened = useSessionFinishedUnopened(sessionId);

  if (state === 'frozen') {
    return (
      <span
        role="status"
        title={t('sessionProcessState.frozenHint')}
        className={cn(
          'inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[10px] font-medium leading-4 text-amber-600 dark:text-amber-400',
          className,
        )}
      >
        <Pause className="h-2.5 w-2.5" aria-hidden="true" />
        {t('sessionProcessState.frozen')}
      </span>
    );
  }

  if (state === 'running') {
    return (
      <span
        role="status"
        title={t('sessionProcessState.runningHint')}
        className={cn(
          'inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-green-500/30 bg-green-500/10 px-1.5 py-px text-[10px] font-medium leading-4 text-green-600 dark:text-green-400',
          className,
        )}
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" aria-hidden="true" />
        {t('sessionProcessState.running')}
      </span>
    );
  }

  if (finishedUnopened) {
    return (
      <span
        role="status"
        title={t('sessionProcessState.doneHint')}
        className={cn(
          'inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-green-500/30 bg-green-500/10 px-1.5 py-px text-[10px] font-medium leading-4 text-green-600 dark:text-green-400',
          className,
        )}
      >
        <Check className="h-2.5 w-2.5" aria-hidden="true" />
        {t('sessionProcessState.done')}
      </span>
    );
  }

  return null;
}
