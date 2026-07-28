import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

/**
 * RunningActivityGapCard — T-836 fix. Shown ONLY while the current reply is
 * still running (`isLoading`) and every event emitted so far this turn is
 * tool_use with no assistant text yet (see `getRunningActivityGap`). Without
 * it, `hideToolCalls` (the default preference, see useUiPreferences) hides
 * every one of those tool cards and the message list can look completely
 * stalled even though the agent is actively working.
 *
 * Deliberately "خفيف" (light): a single small centred pill inline in the
 * message list — NOT a replacement for ClaudeStatus/AgentStatusCard (which
 * keep their unchanged behaviour at the composer), just a reassurance anchor
 * where the conversation itself currently reads as empty.
 *
 * RTL: purely logical layout (flex + gap, no left/right), mirrors under
 * `dir="rtl"` automatically. Colors reuse the same slate/border/emerald
 * tokens as ClaudeStatus/AgentActivityStrip so it reads as the same family
 * of status surface.
 */

type Props = {
  /** Epoch ms of the most recent tool_use event this reply. */
  lastActivityAt: number;
};

const TICK_MS = 1000;

// Mirrors ClaudeStatus's formatLocalizedDuration so "since" durations read
// identically everywhere in the chat UI (same elapsed.* i18n keys/plurals).
function formatDuration(t: TFunction, totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return mins < 1
    ? t('claudeStatus.elapsed.seconds', { count: secs, defaultValue: '{{count}}s' })
    : t('claudeStatus.elapsed.minutesSeconds', {
        minutes: mins,
        seconds: secs,
        defaultValue: '{{minutes}}m {{seconds}}s',
      });
}

export default function RunningActivityGapCard({ lastActivityAt }: Props) {
  const { t } = useTranslation('chat');
  // Forces a re-render every tick so the relative "since" label stays live;
  // the actual elapsed value is always recomputed from Date.now() (never
  // drifts, survives tab throttling better than accumulating a counter).
  const [, tick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - lastActivityAt) / 1000));
  const timeLabel = formatDuration(t, elapsedSeconds);

  return (
    <div className="flex justify-center py-1">
      <div
        className="mx-auto flex max-w-fit items-center gap-2 rounded-full border border-border/40 bg-slate-100/70 px-3 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur-sm dark:bg-slate-900/60"
        title={t('activityGap.ariaLabel', {
          time: timeLabel,
          defaultValue: 'Agent is still working, last activity {{time}} ago',
        })}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
          aria-hidden="true"
        />
        <span>
          {t('activityGap.status', {
            time: timeLabel,
            defaultValue: 'Agent is working — last activity {{time}} ago',
          })}
        </span>
      </div>
    </div>
  );
}
