import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Check, CircleCheck, Copy, Edit2, ExternalLink, Star, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { Badge } from '../../../../shared/view/ui';
import SessionProcessBadge from '../../../../shared/view/SessionProcessBadge';
import WorkflowStatusBadge from '../../../../shared/view/WorkflowStatusBadge';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, LLMProvider, SessionOwner } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import { createSessionViewModel } from '../../utils/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { ParticipantAvatar } from '../../../participants';
import type { SessionParticipant } from '../../../participants';

/**
 * Builds the absolute, openable session URL on the current origin, honoring any
 * router basename. Mirrors the in-app route `/session/:sessionId`, so opening it
 * in a new tab loads the same conversation directly.
 */
const buildSessionUrl = (sessionId: string): string => {
  const basename = window.__ROUTER_BASENAME__ || '';
  return `${window.location.origin}${basename}/session/${encodeURIComponent(sessionId)}`;
};

const SESSION_CONTEXT_MENU_WIDTH = 180;
const SESSION_CONTEXT_MENU_HEIGHT = 110;
const SESSION_CONTEXT_MENU_VIEWPORT_PADDING = 10;

function calcSafeContextMenuPosition(clientX: number, clientY: number) {
  const safeX =
    clientX + SESSION_CONTEXT_MENU_WIDTH > window.innerWidth
      ? window.innerWidth - SESSION_CONTEXT_MENU_WIDTH - SESSION_CONTEXT_MENU_VIEWPORT_PADDING
      : clientX;
  const safeY =
    clientY + SESSION_CONTEXT_MENU_HEIGHT > window.innerHeight
      ? window.innerHeight - SESSION_CONTEXT_MENU_HEIGHT - SESSION_CONTEXT_MENU_VIEWPORT_PADDING
      : clientY;
  return {
    x: Math.max(SESSION_CONTEXT_MENU_VIEWPORT_PADDING, safeX),
    y: Math.max(SESSION_CONTEXT_MENU_VIEWPORT_PADDING, safeY),
  };
}

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  isStarred: boolean;
  onToggleStar: (session: SessionWithProvider, projectName: string) => void;
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
  t: TFunction;
};

/**
 * Adapts a session `owner` ({userId, username, avatarUrl}) into the
 * SessionParticipant shape ParticipantAvatar consumes. The avatar reads
 * userId/username/role (plus the optional picture), so the time fields are
 * placeholders.
 */
const ownerToParticipant = (owner: SessionOwner): SessionParticipant => ({
  userId: owner.userId,
  username: owner.username,
  role: 'owner',
  first_seen: '',
  last_seen: '',
  message_count: 0,
  avatarUrl: owner.avatarUrl ?? null,
});

/**
 * Compact relative time for sidebar rows:
 * <1m, Xm, Xhr, Xd.
 */
const formatCompactSessionAge = (dateString: string, currentTime: Date): string => {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }

  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  return `${diffInDays}d`;
};

export default function SidebarSessionItem({
  project,
  session,
  selectedSession,
  isStarred,
  onToggleStar,
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
  t,
}: SidebarSessionItemProps) {
  const { i18n } = useTranslation();
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const isEditing = editingSession === session.id;
  const compactSessionAge = formatCompactSessionAge(sessionView.sessionTime, currentTime);
  const editingContainerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Session owner badge (C-MU-UX-OWNER-BADGE): a single coloured avatar that
  // attributes the session to one human. `owner` is null for legacy sessions
  // (no recorded participant) — we render no badge then rather than crash.
  const owner = session.owner ?? null;
  const ownerParticipant = owner ? ownerToParticipant(owner) : null;

  // The rename panel sits inside a group-hover opacity wrapper, so leaving the row
  // would visually hide it. While editing, dismiss only when the user clicks outside
  // the panel (matches Escape / cancel-button behaviour).
  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const container = editingContainerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onCancelEditingSession();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isEditing, onCancelEditingSession]);

  // Close context menu on outside click or ESC key.
  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handleOutsideMouseDown = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };

    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };

    document.addEventListener('mousedown', handleOutsideMouseDown);
    document.addEventListener('keydown', handleEscapeKey);
    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      document.removeEventListener('keydown', handleEscapeKey);
    };
  }, [contextMenu]);

  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(calcSafeContextMenuPosition(event.clientX, event.clientY));
  };

  const openInNewTab = () => {
    window.open(buildSessionUrl(session.id), '_blank', 'noopener');
    setContextMenu(null);
  };

  const copySessionLink = () => {
    navigator.clipboard.writeText(buildSessionUrl(session.id)).catch(() => {});
    setContextMenu(null);
  };

  // Sessions are owned by a project identified by `projectId` (DB primary key)
  // after the projectName → projectId migration.
  const selectMobileSession = () => {
    onProjectSelect(project);
    onSessionSelect(session, project.projectId);
  };

  const saveEditedSession = () => {
    onSaveEditingSession(project.projectId, session.id, editingSessionName, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(project.projectId, session.id, sessionView.sessionName, session.__provider);
  };

  // The star toggles a per-user favourite. stopPropagation/preventDefault keep
  // the click from opening the conversation (the row is a link / clickable card).
  const handleToggleStar = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onToggleStar(session, project.projectId);
  };

  const starLabel = isStarred ? t('tooltips.unstarSession') : t('tooltips.starSession');

  /* ── A closed conversation: reduced emphasis, never a strikethrough ────────
   * The choice was "line through the title, or fade it". Faded, and here is why
   * so it is not re-argued: `line-through` is painted across the middle of the
   * em box — precisely where Arabic joins its letters and hangs its dots — so
   * it shreds the word instead of marking it, while Latin survives because the
   * line mostly crosses counters. Most titles in this sidebar are Arabic. It
   * also says the wrong thing: a strike reads "deleted/invalid", but the row is
   * DONE and still openable, and deletion already owns the red button beside
   * it. And titles are `truncate`d — a strike over an ellipsis reads as corrupt
   * text.
   *
   * The fade is `text-foreground/70`, NOT `text-muted-foreground`: muted falls
   * to 4.34:1 over `bg-accent` (a selected row) in the light theme — under AA
   * for 12px — whereas foreground/70 holds ≥7.4:1 on every surface of both
   * themes (measured: 7.48 light/accent, 7.59 dark/accent, 7.79 light/card,
   * 9.34 dark/background). It tints the title's colour only, never the row, so
   * the selected / hover background cannot wash the marker out.
   *
   * ── Why the pill alone was not enough (the owner could not scan the list) ──
   * The pill sits on the metadata line, and that line is where every other
   * badge lives (message count, process, workflow). At ~250px of sidebar with
   * long Arabic titles it is a 10px chip among chips: readable if you stop on
   * the row, invisible while scrolling 30 of them. And a 30% title fade is a
   * difference you can only see next to its own opposite — not down a column.
   *
   * So the marker is now STRUCTURAL, in three parts that fail independently:
   *   1. A rail: a 4px bar down the row's inline-start edge, as the FIRST flex
   *      child. It is an element and not a `border-s`, so direction comes from
   *      flex order alone — no logical-property plugin can mirror it wrong —
   *      and `bg-muted-foreground` at full opacity holds ≥4.34:1 against every
   *      surface (a 60% tint measured 2.21:1, under the 3:1 non-text floor, so
   *      it is deliberately NOT tinted). This is what makes a column scannable.
   *      `self-stretch` gives it the row's full height even under `items-start`
   *      (measured in Chromium at 250px: 4×38px, and 4×37px on a selected row).
   *   2. A leading check icon inside the title row, before the title and
   *      `flex-shrink-0`. `truncate` clips its own box's trailing edge, so a
   *      marker placed BEFORE the title can never be the part that is cut;
   *      the hover action cluster is absolute at the `end` edge, so it cannot
   *      cover it either.
   *   3. The pill, kept for its word and its accessible phrase — now the only
   *      one of the three that may be crowded on a busy metadata line. On the
   *      one SELECTED row its `bg-muted` equals `bg-accent`, so it flattens to
   *      its border; that row is already unmistakable by its own background,
   *      and the rail and icon are unaffected.
   * The icon lives in the pill no longer: two check marks a centimetre apart
   * read as two states, not one.
   *
   * Verified in Chromium at 250px with a long Arabic title: the title really
   * does truncate there (scrollWidth 250 > clientWidth 146), which is why no
   * marker was left to depend on the space after it.
   */
  const isClosed = sessionView.isClosed;
  const closedTitleTooltip = t('session.closedTitle', { defaultValue: 'This conversation is closed' });

  /* The unclippable part: first flex child, stretched to the row's height. */
  const closedRail = isClosed ? (
    <span
      aria-hidden="true"
      className="w-1 flex-shrink-0 self-stretch rounded-full bg-muted-foreground"
    />
  ) : null;

  /* Leading marker: sibling of the truncating title, so truncation cannot eat
     it. aria-hidden — the pill below already announces the row once. */
  const closedLeadIcon = isClosed ? (
    <span
      title={closedTitleTooltip}
      aria-hidden="true"
      className="inline-flex flex-shrink-0 items-center text-foreground/70"
    >
      <CircleCheck className="h-3 w-3" />
    </span>
  ) : null;

  const closedPill = isClosed ? (
    <span
      title={closedTitleTooltip}
      className="inline-flex flex-shrink-0 items-center rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-medium leading-4 text-foreground/70"
    >
      {/* The short visible word is hidden from AT so the row is announced once,
          with the fuller phrase rather than a bare "Closed". */}
      <span aria-hidden="true">{t('session.closedBadge', { defaultValue: 'Closed' })}</span>
      <span className="sr-only">{t('session.closedAria', { defaultValue: 'Closed conversation' })}</span>
    </span>
  ) : null;

  // The row is a real anchor so the browser's native context menu offers
  // "Open in new tab/window". A plain left-click stays an in-app SPA
  // navigation (no full reload); modified clicks and middle-clicks are left
  // to the browser so they open the session URL in a new tab/window.
  const handleSessionLinkClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onSessionSelect(session, project.projectId);
  };

  return (
    <>
    <div className="group relative">
      <div className="md:hidden">
        <div
          className={cn(
            'p-2 mx-3 my-0.5 rounded-md bg-card border active:scale-[0.98] transition-all duration-150 relative',
            isSelected ? 'bg-primary/5 border-primary/20' : 'border-border/30',
          )}
          onClick={selectMobileSession}
          onContextMenu={handleContextMenu}
        >
          <div className="flex items-center gap-2">
            {closedRail}
            <div
              className={cn(
                'w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0',
                isSelected ? 'bg-primary/10' : 'bg-muted/50',
              )}
            >
              <SessionProviderLogo
                provider={session.__provider}
                className={cn('h-3 w-3', isClosed && 'opacity-60')}
              />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {closedLeadIcon}
                {/* dir="auto" — 8% of real session titles are all-Latin. This is
                    a static, non-streamed label, so first-strong is exact here
                    and keeps `truncate` clipping the trailing edge. */}
                <div
                  dir="auto"
                  className={cn(
                    'truncate text-xs font-medium',
                    isClosed ? 'text-foreground/70' : 'text-foreground',
                  )}
                >
                  {sessionView.sessionName}
                </div>
                {ownerParticipant && (
                  <ParticipantAvatar
                    participant={ownerParticipant}
                    size="xs"
                    locale={i18n.language}
                    t={t}
                    stacked={false}
                    avatarUrl={ownerParticipant.avatarUrl ?? undefined}
                  />
                )}
                {compactSessionAge && (
                  <span className="ms-auto flex-shrink-0 text-[11px] text-muted-foreground">{compactSessionAge}</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                {closedPill}
                {sessionView.messageCount > 0 && (
                  <Badge variant="secondary" className="px-1 py-0 text-xs">
                    {sessionView.messageCount}
                  </Badge>
                )}
                <SessionProcessBadge sessionId={session.id} />
                <WorkflowStatusBadge sessionId={session.id} />
              </div>
            </div>

            <div className="flex flex-shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label={starLabel}
                aria-pressed={isStarred}
                title={starLabel}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-md transition-transform active:scale-95',
                  isStarred
                    ? 'text-amber-500'
                    : 'text-muted-foreground/60 hover:text-amber-500',
                )}
                onClick={handleToggleStar}
              >
                <Star className={cn('h-3.5 w-3.5', isStarred && 'fill-current')} />
              </button>

              {!sessionView.isCursorSession && (
                <button
                  className="flex h-6 w-6 items-center justify-center rounded-md bg-red-50 opacity-70 transition-transform active:scale-95 dark:bg-red-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    requestDeleteSession();
                  }}
                >
                  <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="hidden md:block">
        <a
          href={buildSessionUrl(session.id)}
          onClick={handleSessionLinkClick}
          onContextMenu={handleContextMenu}
          className={cn(
            'no-underline flex w-full items-center justify-start rounded-md p-2 h-auto text-sm font-normal text-start text-foreground hover:bg-accent/50 transition-colors duration-200',
            isSelected && 'bg-accent text-accent-foreground',
          )}
        >
          <div className="flex w-full min-w-0 items-start gap-2">
            {closedRail}
            <SessionProviderLogo
              provider={session.__provider}
              className={cn('mt-0.5 h-3.5 w-3.5 flex-shrink-0', isClosed && 'opacity-60')}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {closedLeadIcon}
                {/* dir="auto": see the compact branch above — static title, so
                    the first-strong heuristic is the right tool here. */}
                <div
                  dir="auto"
                  className={cn(
                    'min-w-0 flex-1 truncate text-xs font-medium',
                    isClosed ? 'text-foreground/70' : 'text-foreground',
                  )}
                >
                  {sessionView.sessionName}
                </div>
                {ownerParticipant && (
                  <ParticipantAvatar
                    participant={ownerParticipant}
                    size="xs"
                    locale={i18n.language}
                    t={t}
                    stacked={false}
                    avatarUrl={ownerParticipant.avatarUrl ?? undefined}
                  />
                )}
                {/* Resting trailing indicator (fixed width so it never shifts
                    the title): shows the amber star when starred, else the
                    compact age. Fades out on hover, when the action cluster
                    (which carries its own star toggle) slides in. */}
                <div
                  className={cn(
                    'flex h-4 w-8 flex-shrink-0 items-center justify-end transition-opacity duration-200',
                    isEditing ? 'opacity-0' : 'group-hover:opacity-0',
                  )}
                  aria-hidden="true"
                >
                  {isStarred ? (
                    <Star className="h-3.5 w-3.5 fill-current text-amber-500" />
                  ) : (
                    compactSessionAge && (
                      <span className="text-[11px] text-muted-foreground">{compactSessionAge}</span>
                    )
                  )}
                </div>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                {closedPill}
                {sessionView.messageCount > 0 && <Badge variant="secondary" className="px-1 py-0 text-xs">{sessionView.messageCount}</Badge>}
                <SessionProcessBadge sessionId={session.id} />
                <WorkflowStatusBadge sessionId={session.id} />
              </div>
            </div>
          </div>
        </a>

        <div
          ref={editingContainerRef}
          className={cn(
            'absolute end-2 top-1/2 flex -translate-y-1/2 transform items-center gap-1 transition-all duration-200',
            isEditing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
            {isEditing ? (
              <>
                <input
                  type="text"
                  dir="auto"
                  value={editingSessionName}
                  onChange={(event) => onEditingSessionNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveEditedSession();
                    } else if (event.key === 'Escape') {
                      onCancelEditingSession();
                    }
                  }}
                  onClick={(event) => event.stopPropagation()}
                  className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus
                />
                <button
                  className="flex h-6 w-6 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveEditedSession();
                  }}
                  title={t('tooltips.save')}
                >
                  <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
                </button>
                <button
                  className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingSession();
                  }}
                  title={t('tooltips.cancel')}
                >
                  <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  aria-label={starLabel}
                  aria-pressed={isStarred}
                  title={starLabel}
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded transition-colors',
                    isStarred
                      ? 'bg-amber-50 text-amber-500 hover:bg-amber-100 dark:bg-amber-900/20 dark:hover:bg-amber-900/40'
                      : 'bg-gray-50 text-muted-foreground hover:bg-amber-50 hover:text-amber-500 dark:bg-gray-900/20 dark:hover:bg-amber-900/20',
                  )}
                  onClick={handleToggleStar}
                >
                  <Star className={cn('h-3 w-3', isStarred && 'fill-current')} />
                </button>
                <button
                  className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartEditingSession(session.id, sessionView.sessionName);
                  }}
                  title={t('tooltips.editSessionName')}
                >
                  <Edit2 className="h-3 w-3 text-gray-600 dark:text-gray-400" />
                </button>
                {!sessionView.isCursorSession && (
                  <button
                    className="flex h-6 w-6 items-center justify-center rounded bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40"
                    onClick={(event) => {
                      event.stopPropagation();
                      requestDeleteSession();
                    }}
                    title={t('tooltips.deleteSessionOptions', 'Archive or permanently delete this session')}
                  >
                    <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
                  </button>
                )}
              </>
            )}
          </div>
      </div>
    </div>

    {contextMenu && (
      <div
        ref={contextMenuRef}
        role="menu"
        aria-label={t('tooltips.sessionContextMenu')}
        style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 9999 }}
        className="min-w-[180px] py-1 px-1 bg-popover border border-border rounded-lg shadow-lg animate-in fade-in-0 zoom-in-95"
      >
        <button
          role="menuitem"
          type="button"
          className="w-full flex items-center gap-3 px-3 py-2 text-sm text-start rounded-md transition-colors hover:bg-accent focus:outline-none focus:bg-accent"
          onClick={openInNewTab}
        >
          <ExternalLink className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{t('tooltips.openInNewTab')}</span>
        </button>
        <button
          role="menuitem"
          type="button"
          className="w-full flex items-center gap-3 px-3 py-2 text-sm text-start rounded-md transition-colors hover:bg-accent focus:outline-none focus:bg-accent"
          onClick={copySessionLink}
        >
          <Copy className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1">{t('tooltips.copyLink')}</span>
        </button>
      </div>
    )}
    </>
  );
}
