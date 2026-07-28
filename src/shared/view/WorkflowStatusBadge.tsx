import { AlertTriangle, HelpCircle, Pause, Unplug } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import {
  deriveWorkflowUiState,
  WORKFLOW_UI_STATE_STYLES,
  type ActiveWorkflow,
  type WorkflowUiDescriptor,
  type WorkflowUiState,
} from '../../stores/workflowStatus';
import {
  useProjectWorkflowRollup,
  useSessionWorkflows,
} from '../../stores/workflowStatusStore';

/**
 * Honest background-workflow badge (B-103). A live, self-contained pill that
 * reads the global workflowStatusStore and renders one of the derived states
 * (see deriveWorkflowUiState). It stands ON ITS OWN next to the process badge —
 * it never overloads it — so "the provider turn is running" and "a background
 * workflow is running/orphaned" are two distinct, truthful signals.
 *
 * Two modes:
 *   - session:  <WorkflowStatusBadge sessionId={id} /> — the session's primary
 *               workflow, on the sidebar row and the chat header.
 *   - rollup:   <WorkflowStatusBadge sessionIds={ids} rollup /> — a compact dot
 *               next to a project name, "running" outranking "orphan".
 *
 * A11y: role="status", translated title, distinguished by SHAPE (icon) + TEXT,
 * with colour only as a secondary cue; only the live `running` state pulses.
 * Layout is gap/logical-flow only, so RTL needs no overrides; the numeric
 * progress fraction is bidi-isolated (dir="ltr") so it renders correctly in RTL.
 */

const STATE_ICON: Record<WorkflowUiState, LucideIcon | null> = {
  running: null, // rendered as a pulsing dot, not an icon
  unknown: HelpCircle,
  orphan_empty: Unplug,
  orphan_partial: AlertTriangle,
  orphan_incomplete: AlertTriangle,
  frozen: Pause,
};

// Display precedence when a session has more than one workflow: a live run is
// the headline; otherwise surface the most attention-worthy orphan; frozen and
// unknown come last.
const STATUS_PRIORITY: Record<string, number> = {
  running: 4,
  orphan: 3,
  frozen: 2,
  unknown: 1,
};

/** Picks the most salient workflow for a single badge (null when none). */
export function pickPrimaryWorkflow(
  list: readonly ActiveWorkflow[],
): ActiveWorkflow | null {
  let best: ActiveWorkflow | null = null;
  let bestPriority = -1;
  for (const w of list) {
    const priority = STATUS_PRIORITY[w.status] ?? 0;
    if (priority > bestPriority) {
      best = w;
      bestPriority = priority;
    }
  }
  return best;
}

type WorkflowStatusBadgeProps = {
  /** Session mode: the session whose primary workflow to show. */
  sessionId?: string | null;
  /** Rollup mode: the project's session ids to aggregate. */
  sessionIds?: ReadonlyArray<string | null | undefined>;
  /** Enables rollup mode (compact dot). Requires `sessionIds`. */
  rollup?: boolean;
  className?: string;
};

export default function WorkflowStatusBadge(props: WorkflowStatusBadgeProps) {
  if (props.rollup) {
    return <WorkflowRollupDot sessionIds={props.sessionIds ?? []} className={props.className} />;
  }
  return <WorkflowSessionBadge sessionId={props.sessionId} className={props.className} />;
}

function WorkflowSessionBadge({
  sessionId,
  className,
}: {
  sessionId?: string | null;
  className?: string;
}) {
  const { t } = useTranslation('common');
  const workflows = useSessionWorkflows(sessionId);
  const primary = pickPrimaryWorkflow(workflows);

  if (!primary) {
    return null; // quiet default — no active workflow for this session
  }

  const ui = deriveWorkflowUiState(primary.status, primary.agentsDone, primary.agentsTotal);
  return <WorkflowPill ui={ui} label={t(ui.labelKey)} hint={t(ui.hintKey)} className={className} />;
}

function WorkflowPill({
  ui,
  label,
  hint,
  className,
}: {
  ui: WorkflowUiDescriptor;
  label: string;
  hint: string;
  className?: string;
}) {
  const Icon = STATE_ICON[ui.state];
  return (
    <span
      role="status"
      title={hint}
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-4',
        WORKFLOW_UI_STATE_STYLES[ui.state],
        className,
      )}
    >
      {ui.pulse ? (
        <span
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500"
          aria-hidden="true"
        />
      ) : Icon ? (
        <Icon className="h-2.5 w-2.5" aria-hidden="true" />
      ) : null}
      <span>{label}</span>
      {ui.progress ? (
        <span dir="ltr" className="tabular-nums opacity-80">
          {ui.progress.done}/{ui.progress.total}
        </span>
      ) : null}
    </span>
  );
}

function WorkflowRollupDot({
  sessionIds,
  className,
}: {
  sessionIds: ReadonlyArray<string | null | undefined>;
  className?: string;
}) {
  const { t } = useTranslation('common');
  const rollup = useProjectWorkflowRollup(sessionIds);

  if (rollup === 'running') {
    return (
      <span
        role="status"
        aria-label={t('workflowStatus.projectRunningHint')}
        title={t('workflowStatus.projectRunningHint')}
        className={cn('relative inline-flex h-2 w-2 flex-shrink-0', className)}
      >
        <span
          className="absolute inset-0 animate-ping rounded-full bg-indigo-500/60"
          aria-hidden="true"
        />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" aria-hidden="true" />
      </span>
    );
  }

  if (rollup === 'orphan') {
    return (
      <span
        role="status"
        aria-label={t('workflowStatus.projectOrphanHint')}
        title={t('workflowStatus.projectOrphanHint')}
        className={cn('relative inline-flex h-2 w-2 flex-shrink-0', className)}
      >
        <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
      </span>
    );
  }

  if (rollup === 'unknown') {
    // Neutral — same slate cue as the session badge's `unknown` state (never a
    // death claim, no ping animation): consistent with, not louder than, orphan.
    return (
      <span
        role="status"
        aria-label={t('workflowStatus.projectUnknownHint')}
        title={t('workflowStatus.projectUnknownHint')}
        className={cn('relative inline-flex h-2 w-2 flex-shrink-0', className)}
      >
        <span className="relative inline-flex h-2 w-2 rounded-full bg-slate-400 dark:bg-slate-500" aria-hidden="true" />
      </span>
    );
  }

  return null;
}
