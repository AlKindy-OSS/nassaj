import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  BarChart3,
  Bug,
  CalendarRange,
  Check,
  ClipboardCheck,
  Copy,
  FileText,
  KanbanSquare,
  LayoutDashboard,
  Network,
  Target,
} from 'lucide-react';

import { Pill, PillBar } from '../../../shared/view/ui';
import type { Project } from '../../../types/app';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { formatCostUsd } from '../../chat/view/subcomponents/conversationCostFormat';
import { useProjectBoard } from '../hooks/useProjectBoard';
import { useProjectStats } from '../hooks/useProjectStats';
import type { ProjectCost } from '../projectStatsHelpers';
import RunnerControlBar from '../../runner/RunnerControlBar';
import { useRunner } from '../../runner/useRunner';

import ArchitectureView from './ArchitectureView';
import BoardOverview from './BoardOverview';
import type { OverviewTarget } from './BoardOverview';
import DecisionsView from './DecisionsView';
import IssuesView from './IssuesView';
import ObjectivesView from './ObjectivesView';
import ProjectStatsTab from './ProjectStatsTab';
import ScheduleView from './ScheduleView';
import TasksView from './TasksView';
import VisualChecksView from './VisualChecksView';

type ProjectBoardPanelProps = {
  selectedProject: Project | null;
  /** Opens a project file (root-relative path) in the app's editor sidebar. */
  onFileOpen?: (filePath: string) => void;
};

/**
 * The board's tabs, DECLARED IN THE ORDER THEY ARE SHOWN.
 *
 * The order is the project's own narrative rather than the order the tabs were
 * built in: where it stands (overview) → why and by when it was planned
 * (objectives, schedule) → what is being executed (tasks, issues) → how it is
 * checked (visual) → what was settled and how it is built (decisions,
 * architecture) → what it cost (stats). Reading left to right answers the
 * questions in the order they are usually asked.
 */
type BoardSection =
  | 'overview'
  | 'objectives'
  | 'schedule'
  | 'tasks'
  | 'issues'
  | 'visual'
  | 'decisions'
  | 'architecture'
  | 'stats';

/**
 * The project's cumulative cost, shown in the board header.
 *
 * It is a LIFETIME figure, so it is labelled as such: the same panel shows
 * monthly subscription cycles elsewhere, and an unlabelled amount here would be
 * read as this month's bill. Two honesty markers ride with it (ADR-078): the
 * amount is an API-equivalent value — flat subscriptions are not metered per
 * token — and it is flagged as partial whenever a model had no official price.
 * Renders nothing at all when the server did not compute a total.
 */
function BoardCostTotal({
  cost,
  onOpen,
}: {
  cost: ProjectCost | null;
  /** Absent when there is no statistics tab to open — the chip stays inert. */
  onOpen?: () => void;
}) {
  const { t } = useTranslation('projectBoard');

  if (!cost || cost.totalUsd === null) {
    return null;
  }

  const partial = !cost.complete;
  const title = [
    t('stats.headerTotalTitle', {
      defaultValue:
        'Cumulative cost for this project since its first conversation — API-equivalent value of the usage, not a monthly bill.',
    }),
    partial
      ? t('stats.partialModels', {
          defaultValue: 'Partial total — no official price for: {{models}}',
          models: cost.unpricedModels.join(', '),
        })
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-[5px] text-[11px] text-muted-foreground transition-colors enabled:hover:bg-accent disabled:cursor-default"
    >
      <BarChart3 className="h-3.5 w-3.5" />
      <span className="whitespace-nowrap">
        {t('stats.headerTotal', { defaultValue: 'All time' })}
      </span>
      <bdi className="font-semibold tabular-nums text-foreground">{formatCostUsd(cost.totalUsd)}</bdi>
      {partial && (
        <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3" />
          <span>{t('stats.partialShort', { defaultValue: 'Partial' })}</span>
        </span>
      )}
    </button>
  );
}

/** Minimal valid docs/project-state.json (schema v1, spec: ~/.claude/wiki/project-board.md). */
function buildStarterTemplate(projectName: string): string {
  return `${JSON.stringify(
    {
      $version: 1,
      project: projectName,
      updated: new Date().toISOString().slice(0, 10),
      phases: [],
      tasks: [],
      issues: [],
      decisions: [],
    },
    null,
    2
  )}\n`;
}

/**
 * Guidance shown when the project has no docs/project-state.json: explains the
 * missing file and offers a one-click copy of a valid starter template.
 */
function BoardEmptyState({ projectName }: { projectName: string }) {
  const { t } = useTranslation('projectBoard');
  const [copied, setCopied] = useState(false);

  const handleCopyTemplate = async () => {
    const ok = await copyTextToClipboard(buildStarterTemplate(projectName));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md text-center">
        <KanbanSquare className="mx-auto mb-3 h-10 w-10 text-muted-foreground/60" />
        <h3 className="mb-2 text-sm font-semibold text-foreground">{t('empty.title')}</h3>
        <p className="mb-3 text-sm text-muted-foreground">{t('empty.description')}</p>
        <code className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs text-foreground" dir="ltr">
          docs/project-state.json
        </code>
        <div className="mt-4">
          <button
            type="button"
            onClick={() => void handleCopyTemplate()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            <span>{copied ? t('empty.copied') : t('empty.copyTemplate')}</span>
          </button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t('empty.hint')}</p>
      </div>
    </div>
  );
}

/**
 * "Project Board" tab — a zero-LLM live view of the project's own files
 * (docs/project-state.json + ARCHITECTURE*.md). See ~/.claude/wiki/project-board.md.
 */
export default function ProjectBoardPanel({ selectedProject, onFileOpen }: ProjectBoardPanelProps) {
  const { t } = useTranslation('projectBoard');
  const [section, setSection] = useState<BoardSection>('overview');
  // The bug-task → issue link now crosses a tab boundary: the click switches to
  // the issues tab and names the row, and IssuesView scrolls to it once mounted
  // (the rows do not exist in the document at click time). Cleared on a timer so
  // the ring is a flash, not a permanent selection.
  const [highlightedIssue, setHighlightedIssue] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleIssueClick = useCallback((issueId: string) => {
    setSection('issues');
    setHighlightedIssue(issueId);
    if (highlightTimer.current) {
      clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = setTimeout(() => setHighlightedIssue(null), 2200);
  }, []);

  useEffect(
    () => () => {
      if (highlightTimer.current) {
        clearTimeout(highlightTimer.current);
      }
    },
    [],
  );

  const { board, isLoading, loadError } = useProjectBoard(selectedProject?.projectId);
  // Cost + statistics (ADR-078): one scan per project, independent of the board
  // file watcher. Both stay null on a server without the endpoints, and every
  // consumer below renders nothing in that case rather than an empty shell.
  const { cost: projectCost, stats: projectStats } = useProjectStats(selectedProject?.projectId);
  // Live runner overlay (ADR-RUNNER-BRIDGE-001). Lifted once here and passed down
  // to RunnerControlBar as props — a single fetch + WS subscription per project,
  // one shared snapshot for both the control bar and the per-task/phase dots. All
  // values are null/false when the project is not registered with the runner, so
  // the board is unchanged.
  const {
    runner,
    registered,
    actionPending,
    start,
    stop,
    pause,
    resume,
    approve,
    forceStop,
    approveApproval,
    rejectApproval,
  } = useRunner(selectedProject?.projectId);
  // v2: liveness derived from supervisor heartbeat; active task/phase from checkpoint.pointer
  const supervisorHeartbeat = runner?.supervisor?.session?.heartbeat ?? null;
  const supervisorExitReason = runner?.supervisor?.session?.exit_reason ?? null;
  const runnerRunning = (() => {
    if (!supervisorHeartbeat || supervisorExitReason) return false;
    const ageSec = (Date.now() - new Date(supervisorHeartbeat).getTime()) / 1000;
    return ageSec < 1200; // 20 min threshold (mirrors §2 of minwal-v2-design.md)
  })();
  const runnerActiveTaskId = runnerRunning ? runner?.checkpoint?.pointer?.active_task_id ?? null : null;
  const runnerActivePhaseId = runnerRunning ? runner?.checkpoint?.pointer?.phase ?? null : null;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (loadError || !board) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {t('error')}
      </div>
    );
  }

  const hasArchitecture = Boolean(board.architecture.technical || board.architecture.simplified);
  const projectName = selectedProject?.displayName || board.projectId;

  // Guidance empty state: the project has no docs/project-state.json (yet).
  if (!board.available && !board.state && !hasArchitecture) {
    return <BoardEmptyState projectName={projectName} />;
  }

  // Schema 1.2 conditional tabs: a non-empty section is what shows its tab
  // (spec: ~/.claude/wiki/project-board.md). Agile-only files are unaffected.
  const hasSchedule = Boolean(board.state?.schedule?.length);
  const hasObjectives = Boolean(board.state?.objectives?.length || board.state?.kpis?.length);
  // Phase ب: the "Visual Checks" pill doubles as the owner-review surface, so it
  // also appears when the auto-mode runner has pending approvals — even with no
  // visual_checks authored. The tab body renders both sections.
  const pendingApprovals = runner?.pendingApprovals ?? [];
  const hasVisualChecks = Boolean(board.state?.visual_checks?.length) || pendingApprovals.length > 0;

  // The statistics tab exists only when the server actually measured something
  // for this project — an empty statistics page reads as "no activity".
  const hasStats = Boolean(projectStats);

  // Tasks / issues / decisions each get a tab only when the file has any, on the
  // same rule as the tabs above: an always-present tab that is always empty
  // teaches the reader to skip it. Their counts stay visible on the overview
  // regardless, so a board with none still shows that it has none.
  const hasTasks = Boolean(board.state?.tasks?.length);
  const hasIssues = Boolean(board.state?.issues?.length);
  const hasDecisions = Boolean(board.state?.decisions?.length);

  // The selection can outlive its tab (project switch, file edit) — fall back.
  const activeSection =
    (section === 'schedule' && !hasSchedule) ||
    (section === 'objectives' && !hasObjectives) ||
    (section === 'visual' && !hasVisualChecks) ||
    (section === 'tasks' && !hasTasks) ||
    (section === 'issues' && !hasIssues) ||
    (section === 'decisions' && !hasDecisions) ||
    (section === 'stats' && !hasStats)
      ? 'overview'
      : section;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 py-2">
        {/* data-testid, not a role: these are pills, and calling them a tablist
            without tab/aria-selected semantics would mislead a screen reader. */}
        <PillBar data-testid="board-tabs">
          {/* Order = the BoardSection union above. Keep the two in step. */}
          <Pill
            isActive={activeSection === 'overview'}
            onClick={() => setSection('overview')}
            className="px-2.5 py-[5px]"
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            <span>{t('sections.overview')}</span>
          </Pill>
          {hasObjectives && (
            <Pill
              isActive={activeSection === 'objectives'}
              onClick={() => setSection('objectives')}
              className="px-2.5 py-[5px]"
            >
              <Target className="h-3.5 w-3.5" />
              <span>{t('sections.objectives')}</span>
            </Pill>
          )}
          {hasSchedule && (
            <Pill
              isActive={activeSection === 'schedule'}
              onClick={() => setSection('schedule')}
              className="px-2.5 py-[5px]"
            >
              <CalendarRange className="h-3.5 w-3.5" />
              <span>{t('sections.schedule')}</span>
            </Pill>
          )}
          {hasTasks && (
            <Pill
              isActive={activeSection === 'tasks'}
              onClick={() => setSection('tasks')}
              className="px-2.5 py-[5px]"
            >
              <KanbanSquare className="h-3.5 w-3.5" />
              <span>{t('sections.tasks', { defaultValue: 'Tasks' })}</span>
            </Pill>
          )}
          {hasIssues && (
            <Pill
              isActive={activeSection === 'issues'}
              onClick={() => setSection('issues')}
              className="px-2.5 py-[5px]"
            >
              <Bug className="h-3.5 w-3.5" />
              <span>{t('sections.issues', { defaultValue: 'Issues' })}</span>
            </Pill>
          )}
          {hasVisualChecks && (
            <Pill
              isActive={activeSection === 'visual'}
              onClick={() => setSection('visual')}
              className="px-2.5 py-[5px]"
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              <span>{t('sections.visual')}</span>
            </Pill>
          )}
          {hasDecisions && (
            <Pill
              isActive={activeSection === 'decisions'}
              onClick={() => setSection('decisions')}
              className="px-2.5 py-[5px]"
            >
              <FileText className="h-3.5 w-3.5" />
              <span>{t('sections.decisions', { defaultValue: 'Decisions' })}</span>
            </Pill>
          )}
          <Pill
            isActive={activeSection === 'architecture'}
            onClick={() => setSection('architecture')}
            className="px-2.5 py-[5px]"
          >
            <Network className="h-3.5 w-3.5" />
            <span>{t('sections.architecture')}</span>
          </Pill>
          {hasStats && (
            <Pill
              isActive={activeSection === 'stats'}
              onClick={() => setSection('stats')}
              className="px-2.5 py-[5px]"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              <span>{t('stats.tab', { defaultValue: 'Statistics' })}</span>
            </Pill>
          )}
        </PillBar>
        {/* Cumulative project cost — clicking it opens the statistics tab. */}
        <div className="ms-auto flex items-center gap-2">
          <BoardCostTotal
            cost={projectCost}
            onOpen={hasStats ? () => setSection('stats') : undefined}
          />
          <RunnerControlBar
            runner={runner}
            registered={registered}
            actionPending={actionPending}
            start={start}
            stop={stop}
            pause={pause}
            resume={resume}
            approve={approve}
            forceStop={forceStop}
          />
        </div>
      </div>

      {board.stateError && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{t('stateError')}</span>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {activeSection === 'overview' &&
          (board.state ? (
            <BoardOverview
              state={board.state}
              onNavigate={(target: OverviewTarget) => setSection(target)}
              runnerActivePhaseId={runnerActivePhaseId}
              runnerRunning={runnerRunning}
              runnerHistory={runner?.history ?? null}
              runnerRegistered={registered}
              runnerSessionExitReason={supervisorExitReason}
            />
          ) : (
            <BoardEmptyState projectName={projectName} />
          ))}
        {activeSection === 'objectives' && board.state && <ObjectivesView state={board.state} />}
        {activeSection === 'schedule' && board.state && <ScheduleView state={board.state} />}
        {activeSection === 'tasks' && board.state && (
          <TasksView
            state={board.state}
            onIssueClick={handleIssueClick}
            runnerActiveTaskId={runnerActiveTaskId}
          />
        )}
        {activeSection === 'issues' && board.state && (
          <IssuesView state={board.state} highlightedIssue={highlightedIssue} />
        )}
        {activeSection === 'decisions' && board.state && (
          <DecisionsView state={board.state} onFileOpen={onFileOpen} />
        )}
        {activeSection === 'visual' && board.state && (
          <VisualChecksView
            state={board.state}
            pendingApprovals={pendingApprovals}
            onApprove={approveApproval}
            onReject={rejectApproval}
          />
        )}
        {activeSection === 'stats' && <ProjectStatsTab stats={projectStats} cost={projectCost} />}
        {activeSection === 'architecture' && (
          <ArchitectureView
            technical={board.architecture.technical}
            simplified={board.architecture.simplified}
          />
        )}
      </div>
    </div>
  );
}
