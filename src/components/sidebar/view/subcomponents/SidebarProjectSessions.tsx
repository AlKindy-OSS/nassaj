import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { ExternalLink, Plus } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '../../../../shared/view/ui';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';

import SidebarSessionItem from './SidebarSessionItem';

type SidebarProjectSessionsProps = {
  project: Project;
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
        <div key={index} className="rounded-md p-2">
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
  t,
}: SidebarProjectSessionsProps) {
  const [newSessionCtxMenu, setNewSessionCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const newSessionCtxMenuRef = useRef<HTMLDivElement>(null);

  // Close the context menu when the project collapses so no stale listeners remain.
  useEffect(() => {
    if (!isExpanded) {
      setNewSessionCtxMenu(null);
    }
  }, [isExpanded]);

  // Close on outside click or ESC — mirrors SidebarSessionItem's pattern.
  useEffect(() => {
    if (!newSessionCtxMenu) {
      return;
    }

    const handleOutsideMouseDown = (event: MouseEvent) => {
      if (newSessionCtxMenuRef.current && !newSessionCtxMenuRef.current.contains(event.target as Node)) {
        setNewSessionCtxMenu(null);
      }
    };

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNewSessionCtxMenu(null);
      }
    };

    document.addEventListener('mousedown', handleOutsideMouseDown);
    document.addEventListener('keydown', handleEscapeKey);
    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      document.removeEventListener('keydown', handleEscapeKey);
    };
  }, [newSessionCtxMenu]);

  const handleNewSessionContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setNewSessionCtxMenu(calcSafeNewSessionMenuPosition(event.clientX, event.clientY));
  };

  const openNewSessionInNewTab = () => {
    window.open(buildNewSessionUrl(project.projectId), '_blank', 'noopener');
    setNewSessionCtxMenu(null);
  };

  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0;

  return (
    <>
      <div className="ms-3 space-y-1 border-s border-border ps-3">
        <div className="px-3 pb-1 pt-1 md:hidden">
          <button
            className="flex h-8 w-full items-center justify-center gap-2 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
            onClick={() => {
              onProjectSelect(project);
              onNewSession(project);
            }}
            onContextMenu={handleNewSessionContextMenu}
          >
            <Plus className="h-3 w-3" />
            {t('sessions.newSession')}
          </button>
        </div>

        <Button
          variant="default"
          size="sm"
          className="hidden h-8 w-full justify-start gap-2 bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 md:flex"
          onClick={() => onNewSession(project)}
          onContextMenu={handleNewSessionContextMenu}
        >
          <Plus className="h-3 w-3" />
          {t('sessions.newSession')}
        </Button>

        {!initialSessionsLoaded ? (
          <SessionListSkeleton />
        ) : !hasSessions ? (
          <div className="px-3 py-2 text-left">
            <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
          </div>
        ) : (
          <>
            {sessions.map((session) => (
              <SidebarSessionItem
                key={session.id}
                project={project}
                session={session}
                selectedSession={selectedSession}
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
                t={t}
              />
            ))}

            {hasMoreSessions && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-full justify-center text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onLoadMoreSessions(project.projectId)}
                disabled={isLoadingMoreSessions}
              >
                {isLoadingMoreSessions ? t('sessions.loadingSessions') : 'Load more sessions'}
              </Button>
            )}
          </>
        )}
      </div>

      {newSessionCtxMenu && (
        <div
          ref={newSessionCtxMenuRef}
          role="menu"
          aria-label={t('tooltips.newSessionContextMenu')}
          style={{ position: 'fixed', left: newSessionCtxMenu.x, top: newSessionCtxMenu.y, zIndex: 9999 }}
          className="min-w-[180px] py-1 px-1 bg-popover border border-border rounded-lg shadow-lg animate-in fade-in-0 zoom-in-95"
        >
          <button
            role="menuitem"
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-start rounded-md transition-colors hover:bg-accent focus:outline-none focus:bg-accent"
            onClick={openNewSessionInNewTab}
          >
            <ExternalLink className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1">{t('tooltips.openInNewTab')}</span>
          </button>
        </div>
      )}
    </>
  );
}
