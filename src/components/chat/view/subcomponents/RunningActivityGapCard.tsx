import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatWorkDuration } from '../../../../utils/workDurationFormat';

type RunningActivityGapCardProps = {
  lastActivityAt: number;
};

/** A quiet live status shown where hidden tool-only activity would leave a gap. */
export default function RunningActivityGapCard({ lastActivityAt }: RunningActivityGapCardProps) {
  const { t, i18n } = useTranslation('chat');
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsedMs = Math.max(0, Date.now() - lastActivityAt);
  const time = formatWorkDuration(Math.floor(elapsedMs / 1_000) * 1_000, i18n.language.startsWith('ar') ? 'ar' : 'en');

  return (
    <div className="flex justify-center py-1">
      <div
        role="status"
        aria-live="polite"
        aria-label={t('activityGap.ariaLabel', { time })}
        className="mx-auto flex max-w-full items-center gap-2 rounded-full border border-border/60 bg-muted/70 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm"
      >
        <span
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span className="min-w-0 whitespace-normal text-center">
          {t('activityGap.status', { time })}
        </span>
      </div>
    </div>
  );
}
