import { useTranslation } from 'react-i18next';

/**
 * Tiny additive overlay elements for the Project Board, driven by the runner's
 * activity.json. Each renders NULL unless the runner is actively working on the
 * given task / phase, so the board is unchanged when the runner is idle/absent.
 * ADR-RUNNER-BRIDGE-001.
 */

/** 2px pulsing amber dot for the task the running session currently targets. */
export function RunnerTaskDot({
  taskId,
  activeTaskId,
}: {
  taskId: string;
  activeTaskId: string | null | undefined;
}) {
  if (!activeTaskId || taskId !== activeTaskId) {
    return null;
  }
  return (
    <span
      className="inline-block h-[6px] w-[6px] flex-shrink-0 animate-pulse rounded-full bg-amber-500"
      aria-hidden="true"
    />
  );
}

/** "active now" pulsing badge for the phase the running stage targets. */
export function RunnerPhaseBadge({
  phaseId,
  activePhaseId,
  running,
}: {
  phaseId: string;
  activePhaseId: string | null | undefined;
  running: boolean;
}) {
  const { t } = useTranslation('projectBoard');
  if (!running || !activePhaseId || phaseId !== activePhaseId) {
    return null;
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
      {t('runner.status.running', { defaultValue: 'Running' })}
    </span>
  );
}
