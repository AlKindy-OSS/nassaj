import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import type { CoordinationLevel } from '../../constants/providerCapabilities';

type CoordinationLevelBadgeProps = {
  level?: CoordinationLevel;
  className?: string;
};

/** A compact, immutable marker for the coordination level sealed to one turn. */
export default function CoordinationLevelBadge({ level, className }: CoordinationLevelBadgeProps) {
  const { t } = useTranslation('chat');
  if (!level) return null;

  const name = t(`coordinationLevel.levels.${level}.short`);
  return (
    <span
      className={cn(
        'inline-flex min-h-6 items-center gap-1 rounded-full border border-current/15 px-2 text-[11px] font-medium',
        level === 'direct'
          ? 'text-muted-foreground'
          : level === 'delegate'
            ? 'text-blue-700 dark:text-blue-300'
            : 'text-amber-800 dark:text-amber-300',
        className,
      )}
      aria-label={t('coordinationLevel.messageBadge', { name })}
      title={t('coordinationLevel.messageBadge', { name })}
      data-coordination-level={level}
    >
      <span className="flex h-3.5 w-3.5 flex-col-reverse items-center justify-center gap-px" aria-hidden="true">
        {[1, 2, 3].map((rank) => (
          <span
            key={rank}
            className={cn(
              'h-px rounded-full bg-current',
              rank === 1 ? 'w-1.5' : rank === 2 ? 'w-2' : 'w-3',
              rank > (level === 'direct' ? 1 : level === 'delegate' ? 2 : 3) && 'opacity-25',
            )}
          />
        ))}
      </span>
      <span>{name}</span>
    </span>
  );
}
