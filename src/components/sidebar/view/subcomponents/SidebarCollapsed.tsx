import { Settings, Sparkles, PanelLeftOpen, RefreshCw, ServerCrash, TerminalSquare } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../../../types/app';
import { useAuth } from '../../../auth/context/AuthContext';
import { useRawExecQueue } from '../../../../hooks/useRawExecConfig';

import { SystemStatsCollapsed } from './SystemStats';
import { ClaudeUsageCollapsed } from './ClaudeUsageCollapsed';
import { PresenceCountCollapsed } from './PresenceCountCollapsed';

type SidebarCollapsedProps = {
  onExpand: () => void;
  onShowSettings: () => void;
  /** Expand into the Terminals section (T-940). */
  onOpenTerminals: () => void;
  /** Count of running terminals — shown as a small badge on the terminals icon. */
  runningTerminalsCount: number;
  updateAvailable: boolean;
  /** T-928: true when build:client ran after the server process started. */
  restartRequired?: boolean;
  /** T-1036: declared server actions waiting; summed with the raw queue below. */
  pendingActionsCount?: number;
  onShowVersionModal: () => void;
  /** Project list — used by the active-conversations popover to name projects. */
  projects?: Project[];
  /** Select a project from the active-conversations popover. */
  onProjectSelect?: (project: Project) => void;
  /** مزوّد الجلسة المفتوحة حالياً — يحجب أشرطة حصة Claude لغير جلسات claude. */
  sessionProvider?: string | null;
  t: TFunction;
};

export default function SidebarCollapsed({
  onExpand,
  onShowSettings,
  onOpenTerminals,
  runningTerminalsCount,
  updateAvailable,
  restartRequired = false,
  pendingActionsCount = 0,
  onShowVersionModal,
  projects,
  onProjectSelect,
  sessionProvider,
  t,
}: SidebarCollapsedProps) {
  const { t: tTerminals } = useTranslation('terminals');

  // B-247/T-1036: the collapsed rail renders no banner and no panel, so without
  // this entry a waiting command is invisible for as long as the sidebar stays
  // collapsed — the exact failure B-247 was raised for. It expands the sidebar
  // rather than opening settings: the board is where a command is read and run.
  // Same two queues as the expanded badge, so the two never disagree.
  const { user } = useAuth();
  const { commands: rawCommands } = useRawExecQueue(!!user);
  const rawCount = rawCommands.length;
  const boardCount = (restartRequired ? 1 : 0) + pendingActionsCount + rawCount;
  // Red the moment free shell text is queued; amber for declared actions alone.
  const boardBadgeClass = rawCount > 0 ? 'bg-red-600' : 'bg-amber-500';

  return (
    <div className="flex h-full w-12 flex-col items-center gap-1 bg-background/80 py-3 backdrop-blur-sm">
      {/* Expand button with brand logo */}
      <button
        onClick={onExpand}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('common:versionUpdate.ariaLabels.showSidebar')}
        title={t('common:versionUpdate.ariaLabels.showSidebar')}
      >
        <PanelLeftOpen className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      <div className="nav-divider my-1 w-6" />

      {/* Terminals quick access (T-940) */}
      <button
        onClick={onOpenTerminals}
        className="group relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={tTerminals('title')}
        title={tTerminals('title')}
      >
        <TerminalSquare className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
        {runningTerminalsCount > 0 && (
          <span className="absolute end-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
        )}
      </button>

      {/* Command board — expands the sidebar, where the banner and panel live */}
      {boardCount > 0 && (
        <button
          onClick={onExpand}
          className="group relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
          aria-label={t('pendingActions.boardCollapsedAria', { count: boardCount })}
          title={t('pendingActions.boardCollapsedAria', { count: boardCount })}
        >
          <ServerCrash
            className={`h-4 w-4 transition-colors ${
              rawCount > 0 ? 'text-red-500 dark:text-red-400' : 'text-amber-500 dark:text-amber-400'
            }`}
          />
          <span
            className={`absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white ${boardBadgeClass}`}
            aria-hidden="true"
          >
            {boardCount}
          </span>
        </button>
      )}

      {/* Settings */}
      <button
        onClick={onShowSettings}
        className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
        aria-label={t('actions.settings')}
        title={t('actions.settings')}
      >
        <Settings className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>

      {/* Live CPU/RAM stats */}
      <SystemStatsCollapsed t={t} />

      {/* Claude usage windows — divider rendered inside component */}
      <ClaudeUsageCollapsed sessionProvider={sessionProvider} />

      {/* Active conversations count — divider rendered inside component.
        * Hover/focus/click reveals the per-project breakdown; selecting a row
        * expands the sidebar and surfaces that project. */}
      <PresenceCountCollapsed
        projects={projects}
        onProjectSelect={onProjectSelect}
        onExpand={onExpand}
      />

      {/* Update indicator */}
      {updateAvailable && (
        <button
          onClick={onShowVersionModal}
          className="relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
          aria-label={t('common:versionUpdate.ariaLabels.updateAvailable')}
          title={t('common:versionUpdate.ariaLabels.updateAvailable')}
        >
          <Sparkles className="h-4 w-4 text-blue-500" />
          <span className="absolute end-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
        </button>
      )}

      {/* T-928: restart-required indicator (collapsed sidebar) */}
      {restartRequired && (
        <div
          className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50/80 dark:bg-amber-900/15"
          role="status"
          aria-live="polite"
          aria-label={t('version.restartRequired')}
          title={t('version.restartRequired')}
        >
          <RefreshCw className="h-4 w-4 text-amber-500 dark:text-amber-400" aria-hidden="true" />
          <span className="absolute end-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        </div>
      )}
    </div>
  );
}
