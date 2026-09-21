import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import { AnimatedRow } from './AnimatedRow';
import { createPortal } from 'react-dom';
import { ExternalLink, Plus, Folder, GitBranch, KanbanSquare } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import { Button } from '../../../../shared/view/ui';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { ProjectToolbarProps, SessionWithProvider } from '../../types/types';
import type { BulkSelectionKind } from '../../hooks/useSidebarController';
import { announceContextMenuOpen, useDismissableContextMenu } from '../../hooks/useDismissableContextMenu';
import { useSidebarSessionExtras } from '../../context/SidebarSessionExtrasContext';

import SidebarSessionItem from './SidebarSessionItem';

type SidebarProjectSessionsProps = ProjectToolbarProps & {
  project: Project;
  participantsSummary?: ReactNode;
  contentDirection?: 'rtl' | 'ltr';
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  isSessionStarred: (session: SessionWithProvider) => boolean;
  onToggleStarSession: (session: SessionWithProvider, projectName: string) => void;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  bulkSelectionKind: BulkSelectionKind | null;
  bulkSelectedIds: Set<string>;
  onToggleBulkSelectedId: (id: string) => void;
  onStartBulkSelectionWithId: (kind: BulkSelectionKind, id: string) => void;
  t: TFunction;
};

/**
 * Builds the "new session" URL for a specific project.
 *
 * The router has no project-scoped route, so we encode the project ID as a
 * `?newSessionProject=<id>` query param on the app root. useProjectsState
 * reads this param on load, auto-selects the project, and triggers a new
 * session — then cleans the param from the URL via replaceState.
 */
const buildNewSessionUrl = (projectId: string | undefined): string => {
  const basename = (window.__ROUTER_BASENAME__ ?? '').replace(/\/+$/, '');
  const base = `${window.location.origin}${basename}/`;
  if (!projectId) return base;
  return `${base}?newSessionProject=${encodeURIComponent(projectId)}`;
};

const PROJECT_SESSION_ACTION_CLASS = 'relative h-auto min-h-[var(--sidebar-load-more-height)] w-full justify-center whitespace-normal rounded-lg px-2 py-0.5 text-xs font-medium leading-4 text-[color:var(--project-muted-foreground,hsl(var(--muted-foreground)))] hover:bg-[var(--project-hover,hsl(var(--foreground)/0.03))] hover:text-[color:var(--project-foreground,hsl(var(--foreground)))] active:bg-[var(--project-session-selected,hsl(var(--foreground)/0.06))] focus-visible:ring-[var(--project-accent,hsl(var(--ring)))] [&_svg]:size-3';

const NEW_SESSION_CTX_MENU_WIDTH = 180;
const NEW_SESSION_CTX_MENU_HEIGHT = 60;
const NEW_SESSION_CTX_MENU_PADDING = 10;

function calcSafeNewSessionMenuPosition(clientX: number, clientY: number) {
  const safeX =
    clientX + NEW_SESSION_CTX_MENU_WIDTH > window.innerWidth
      ? window.innerWidth - NEW_SESSION_CTX_MENU_WIDTH - NEW_SESSION_CTX_MENU_PADDING
      : clientX;
  const safeY =
    clientY + NEW_SESSION_CTX_MENU_HEIGHT > window.innerHeight
      ? window.innerHeight - NEW_SESSION_CTX_MENU_HEIGHT - NEW_SESSION_CTX_MENU_PADDING
      : clientY;
  return {
    x: Math.max(NEW_SESSION_CTX_MENU_PADDING, safeX),
    y: Math.max(NEW_SESSION_CTX_MENU_PADDING, safeY),
  };
}

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="sidebar-project-skeleton px-2 py-1.5">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export default function SidebarProjectSessions({
  project,
  activeProjectTool,
  onOpenProjectTool,
  onProjectToolbarPresence,
  isExpanded,
  sessions,
  selectedSession,
  isSessionStarred,
  onToggleStarSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  participantsSummary,
  contentDirection,
  bulkSelectionKind,
  bulkSelectedIds,
  onToggleBulkSelectedId,
  onStartBulkSelectionWithId,
  t,
}: SidebarProjectSessionsProps) {
  useEffect(() => {
    if (!isExpanded || !onOpenProjectTool || !onProjectToolbarPresence) return;
    onProjectToolbarPresence(project.projectId);
    return () => onProjectToolbarPresence(null);
  }, [isExpanded, onOpenProjectTool, onProjectToolbarPresence, project.projectId]);

  const [newSessionCtxMenu, setNewSessionCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const newSessionCtxMenuRef = useRef<HTMLDivElement>(null);
  const { hideClosedSessions } = useSidebarSessionExtras();

  // Close the context menu when the project collapses so no stale listeners remain.
  useEffect(() => {
    if (!isExpanded) {
      setNewSessionCtxMenu(null);
    }
  }, [isExpanded]);

  // إغلاق بنقرة خارجية أو Escape أو فتح قائمة أخرى — نفس خطّاف SidebarSessionItem.
  const closeNewSessionCtxMenu = useCallback(() => setNewSessionCtxMenu(null), []);
  const newSessionMenuToken = `new-session:${project.projectId}`;
  useDismissableContextMenu(
    Boolean(newSessionCtxMenu),
    newSessionCtxMenuRef,
    closeNewSessionCtxMenu,
    newSessionMenuToken,
  );

  const handleNewSessionContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    announceContextMenuOpen(newSessionMenuToken);
    setNewSessionCtxMenu(calcSafeNewSessionMenuPosition(event.clientX, event.clientY));
  };

  const openNewSessionInNewTab = () => {
    window.open(buildNewSessionUrl(project.projectId), '_blank', 'noopener');
    setNewSessionCtxMenu(null);
  };

  // -----------------------------------------------------------------------
  // Row enter/exit animation
  //
  // initialIdsRef: session IDs present when this component first mounts.
  // Those rows skip the enter animation (they're already "seen" by the user).
  // Any row added later (load-more, real-time add, hide-closed toggle) will
  // animate in. IDs are removed from initialIdsRef when the session leaves so
  // they animate in again if re-added (e.g. after un-hiding closed sessions).
  // -----------------------------------------------------------------------
  const initialIdsRef = useRef<Set<string>>(new Set(sessions.map(s => s.id)));

  // Sessions currently animating out (removed from the `sessions` prop but not
  // yet transitioned away). Keyed by session ID.
  const [exitingItems, setExitingItems] = useState<Map<string, SessionWithProvider>>(
    () => new Map(),
  );
  const prevSessionsRef = useRef<SessionWithProvider[]>(sessions);

  useEffect(() => {
    const currentIds = new Set(sessions.map(s => s.id));
    const removed = prevSessionsRef.current.filter(s => !currentIds.has(s.id));
    if (removed.length > 0) {
      // Remove departed IDs from initialIdsRef so they animate in if they return.
      removed.forEach(s => initialIdsRef.current.delete(s.id));
      setExitingItems(prev => {
        const next = new Map(prev);
        removed.forEach(s => next.set(s.id, s));
        return next;
      });
    }
    prevSessionsRef.current = sessions;
  }, [sessions]);

  const handleExited = useCallback((id: string) => {
    setExitingItems(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const hasSessions = sessions.length > 0;

  return (
    <>
      {/* Children stay connected to the header within the project surface. */}
      <div className="sidebar-project-sessions relative mx-2">
        <div data-project-toolbar dir="rtl" className="sidebar-project-action-strip flex h-8 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            dir={contentDirection}
            className={cn('sidebar-new-session', PROJECT_SESSION_ACTION_CLASS, 'h-8 min-h-8 w-auto shrink-0 whitespace-nowrap px-1')}
            onClick={() => onNewSession(project)}
            onContextMenu={handleNewSessionContextMenu}
          >
            <Plus aria-hidden="true" />
            {t('sessions.newSession')}
          </Button>
          <div dir={contentDirection} className="min-w-0 flex-1 overflow-hidden">{participantsSummary}</div>
          {onOpenProjectTool && <div className="flex shrink-0 items-center">
            {([['board', KanbanSquare], ['git', GitBranch], ['files', Folder]] as const).map(([tool, Icon]) => (
              <button key={tool} type="button" data-project-tool={tool}
                aria-pressed={activeProjectTool === tool}
                className="sidebar-project-tool" title={t(`common:tabs.${tool}`)} aria-label={t(`common:tabs.${tool}`)}
                onClick={() => onOpenProjectTool(project, tool)}>
                <Icon aria-hidden="true" className="size-3.5" />
              </button>
            ))}
          </div>}
        </div>

        <div className="sidebar-project-session-surface rounded-b-lg">
          {!initialSessionsLoaded ? (
            <SessionListSkeleton />
          ) : !hasSessions ? (
            <div className="px-2 py-1.5 text-start">
              {/* "No conversations" is only true when nothing is being withheld.
                  With the hide-closed filter on, an all-closed project empties out
                  and that line would deny the existence of conversations the user
                  can bring back with one click — so the empty state names the
                  filter instead. */}
              <p className="text-xs text-muted-foreground">
                {hideClosedSessions
                  ? t('sessions.allClosedHidden', 'Closed conversations are hidden')
                  : t('sessions.noSessions')}
              </p>
            </div>
          ) : (
            <>
              {sessions.map((session) => (
                <AnimatedRow
                  key={session.id}
                  skipAnimation={initialIdsRef.current.has(session.id)}
                >
                  <SidebarSessionItem
                    project={project}
                    session={session}
                    selectedSession={selectedSession}
                    isChatActive={activeProjectTool === 'chat'}
                    isStarred={isSessionStarred(session)}
                    onToggleStar={onToggleStarSession}
                    currentTime={currentTime}
                    editingSession={editingSession}
                    editingSessionName={editingSessionName}
                    onEditingSessionNameChange={onEditingSessionNameChange}
                    onStartEditingSession={onStartEditingSession}
                    onCancelEditingSession={onCancelEditingSession}
                    onSaveEditingSession={onSaveEditingSession}
                    onProjectSelect={onProjectSelect}
                    onSessionSelect={onSessionSelect}
                    onDeleteSession={onDeleteSession}
                    bulkSelectionKind={bulkSelectionKind}
                    isBulkSelected={bulkSelectedIds.has(session.id)}
                    onToggleBulkSelectedId={onToggleBulkSelectedId}
                    onStartBulkSelectionWithId={onStartBulkSelectionWithId}
                    t={t}
                  />
                </AnimatedRow>
              ))}

              {/* Sessions that left the array but are still playing their exit animation. */}
              {exitingItems.size > 0 && Array.from(exitingItems.values()).map((session) => (
                <AnimatedRow
                  key={`exit-${session.id}`}
                  skipAnimation
                  isExiting
                  onExited={() => handleExited(session.id)}
                >
                  {/* aria-hidden: the row is disappearing; inert keeps it out of a11y tree. */}
                  <div aria-hidden="true" style={{ pointerEvents: 'none' }}>
                    <SidebarSessionItem
                      project={project}
                      session={session}
                      selectedSession={null}
                      isChatActive={false}
                      isStarred={false}
                      onToggleStar={() => {}}
                      currentTime={currentTime}
                      editingSession={null}
                      editingSessionName=""
                      onEditingSessionNameChange={() => {}}
                      onStartEditingSession={() => {}}
                      onCancelEditingSession={() => {}}
                      onSaveEditingSession={() => {}}
                      onProjectSelect={() => {}}
                      onSessionSelect={() => {}}
                      onDeleteSession={() => {}}
                      bulkSelectionKind={null}
                      isBulkSelected={false}
                      onToggleBulkSelectedId={() => {}}
                      onStartBulkSelectionWithId={() => {}}
                      t={t}
                    />
                  </div>
                </AnimatedRow>
              ))}

              {hasMoreSessions && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={
                    `sidebar-project-load-more sidebar-project-action-strip ` +
                    PROJECT_SESSION_ACTION_CLASS
                  }
                  onClick={() => onLoadMoreSessions(project.projectId)}
                  disabled={isLoadingMoreSessions}
                >
                  {isLoadingMoreSessions
                    ? t('sessions.loadingSessions')
                    : t('sessions.loadMoreSessions', 'Load more sessions')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* B-371: بورتال إلى `document.body` — `backdrop-blur` على جذر الشريط
          يجعل الشريط containing block لكل `fixed` بداخله، فتخرج القائمة خارج
          الشاشة في RTL (الشرح الكامل في SidebarSessionItem). */}
      {newSessionCtxMenu && createPortal(
        <div
          ref={newSessionCtxMenuRef}
          role="menu"
          aria-label={t('tooltips.newSessionContextMenu')}
          // design-ok: إحداثيات المؤشر في نافذة العرض فيزيائية بطبيعتها (clientX/clientY)،
          // ولا مقابل منطقي لها — القائمة تُوضع حيث ضُغط الزرّ لا حيث يبدأ السطر.
          style={{ position: 'fixed', left: newSessionCtxMenu.x, top: newSessionCtxMenu.y, zIndex: 9999 }}
          className="animate-in fade-in-0 zoom-in-95 min-w-[180px] rounded-lg border border-border bg-popover px-1 py-1 shadow-lg"
        >
          <button
            role="menuitem"
            type="button"
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-start text-sm transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
            onClick={openNewSessionInNewTab}
          >
            <ExternalLink className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1">{t('tooltips.openInNewTab')}</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
