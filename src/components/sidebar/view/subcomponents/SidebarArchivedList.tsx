import { useState } from 'react';
import { Archive, ChevronDown, ChevronRight, RotateCcw, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { ArchivedSessionListItem } from '../../types/types';
import type { BulkSelectionKind } from '../../hooks/useSidebarController';
import type { ArchivedFolder, ArchivedFolderSession } from '../../utils/archivedFolders';
import { formatCompactAge } from '../../utils/sessionAge';

type BulkProps = {
  bulkSelectionKind: BulkSelectionKind | null;
  bulkSelectedIds: Set<string>;
  onToggleBulkId: (id: string) => void;
};

type ArchivedActions = {
  onRestoreArchivedProject: (projectId: string) => void;
  onArchivedSessionClick: (session: ArchivedSessionListItem) => void;
  onRestoreArchivedSession: (sessionId: string) => void;
  onDeleteArchivedSession: (session: ArchivedSessionListItem) => void;
};

export type SidebarArchivedListProps = BulkProps & ArchivedActions & {
  folders: ArchivedFolder[];
  /** Expand every folder by default (an active search wants matches visible). */
  expandByDefault: boolean;
  t: TFunction;
};

// Shared with SidebarProjectItem/SidebarSessionItem so both lists read alike.
const MUTED_TEXT = 'text-[color:var(--project-muted-foreground,hsl(var(--muted-foreground)))]';
const HOVER_ACTION =
  'pointer-events-auto flex h-7 w-7 flex-none items-center justify-center rounded-md transition-[opacity,color] ' +
  'opacity-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-[var(--project-accent,hsl(var(--ring)))] group-focus-within:opacity-100 ' +
  'group-hover:opacity-100 [@media(hover:none)]:opacity-100 ' + MUTED_TEXT;

/** Header surface: archived projects carry the theme `warning` tint. */
function folderHeaderSurface(isProjectArchived: boolean, isExpanded: boolean): string {
  if (isProjectArchived) {
    return isExpanded ? 'rounded-t-lg bg-warning/15' : 'rounded-lg bg-warning/[0.07] hover:bg-warning/[0.12]';
  }
  return isExpanded
    ? 'rounded-t-lg bg-[var(--project-header-open,hsl(var(--primary)/0.08))]'
    : 'rounded-lg hover:bg-[var(--project-hover,hsl(var(--primary)/0.03))]';
}

type SessionRowProps = BulkProps & ArchivedActions & { session: ArchivedFolderSession; t: TFunction };

function ArchivedSessionRow({ session, bulkSelectionKind, bulkSelectedIds, onToggleBulkId, t, ...actions }: SessionRowProps) {
  const age = formatCompactAge(session.lastActivity, Date.now(), t);
  return (
    <div data-archived-session-row className="sidebar-project-session-row group relative">
      <div className="sidebar-project-session-content relative flex min-w-0 items-center gap-1 px-2 py-1.5 transition-colors duration-150 group-hover:bg-[var(--project-hover,hsl(var(--foreground)/0.04))]">
        {bulkSelectionKind === 'sessions' && (
          <input
            type="checkbox"
            aria-label={`${t('bulk.selectSession', 'Select conversation')}: ${session.sessionTitle}`}
            checked={bulkSelectedIds.has(session.sessionId)}
            onChange={() => onToggleBulkId(session.sessionId)}
            className="h-4 w-4 flex-none accent-primary"
          />
        )}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--project-accent,hsl(var(--ring)))]"
          onClick={() => actions.onArchivedSessionClick(session)}
        >
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-muted/50">
            <SessionProviderLogo provider={session.provider} className="h-3 w-3" />
          </span>
          <span dir="auto" title={session.sessionTitle} className="line-clamp-1 min-w-0 break-words text-xs font-medium text-[color:var(--project-foreground,hsl(var(--foreground)))]">
            {session.sessionTitle}
          </span>
          {age && (
            <span className={cn('ms-auto flex-shrink-0 text-[11px] tabular-nums', MUTED_TEXT, session.isSessionArchived && '[@media(hover:hover)]:group-focus-within:hidden [@media(hover:hover)]:group-hover:hidden')}>
              {age}
            </span>
          )}
        </button>
        {session.isSessionArchived && (
          <span className="hidden flex-none items-center group-focus-within:flex group-hover:flex [@media(hover:none)]:flex">
            <button type="button" className={cn(HOVER_ACTION, 'hover:text-success')} onClick={() => actions.onRestoreArchivedSession(session.sessionId)} title={t('archived.restore', 'Restore session')} aria-label={`${t('archived.restore', 'Restore session')}: ${session.sessionTitle}`}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button type="button" className={cn(HOVER_ACTION, 'hover:text-destructive')} onClick={() => actions.onDeleteArchivedSession(session)} title={t('archived.deletePermanently', 'Delete permanently')} aria-label={`${t('archived.deletePermanently', 'Delete permanently')}: ${session.sessionTitle}`}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

type FolderHeaderProps = BulkProps & {
  folder: ArchivedFolder;
  isExpanded: boolean;
  panelId: string;
  onToggle: () => void;
  onRestoreArchivedProject: (projectId: string) => void;
  t: TFunction;
};

function ArchivedFolderHeader({ folder, isExpanded, panelId, onToggle, bulkSelectionKind, bulkSelectedIds, onToggleBulkId, onRestoreArchivedProject, t }: FolderHeaderProps) {
  const selectable = bulkSelectionKind === 'projects' && folder.isProjectArchived && folder.projectId;
  const countLabel = t('projects.conversationsCount', { count: folder.sessions.length, defaultValue: '{{count}} conversations' });
  const toggleLabel = isExpanded ? t('tooltips.collapseProject', 'Collapse project') : t('tooltips.expandProject', 'Expand project');
  const Chevron = isExpanded ? ChevronDown : ChevronRight;
  return (
    <div data-project-card className={cn('relative min-h-11 px-2 py-2 transition-colors duration-150', folderHeaderSurface(folder.isProjectArchived, isExpanded))}>
      <button type="button" aria-expanded={isExpanded} aria-controls={panelId} aria-label={`${toggleLabel}: ${folder.displayName}`} title={folder.projectPath ?? undefined} className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--project-accent,hsl(var(--ring)))] focus-visible:ring-offset-1" onClick={onToggle} />
      <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-1">
        {selectable && (
          <input type="checkbox" aria-label={`${t('bulk.selectProject', 'Select project')}: ${folder.displayName}`} checked={bulkSelectedIds.has(folder.projectId!)} onChange={() => onToggleBulkId(folder.projectId!)} className="pointer-events-auto h-4 w-4 flex-none accent-primary" />
        )}
        {folder.isProjectArchived && <Archive className="h-3.5 w-3.5 flex-shrink-0 text-warning" aria-hidden="true" />}
        <span className="min-w-0 truncate text-sm font-semibold text-[color:var(--project-foreground,hsl(var(--foreground)))]">{folder.displayName}</span>
        {folder.isProjectArchived && (
          <span className="flex-shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-medium leading-4 text-warning" title={t('archived.projectArchivedLabel', 'Archived project')}>
            {t('archived.projectArchived', 'Archived')}
          </span>
        )}
        <span className={cn('ms-auto flex-shrink-0 text-[11px] tabular-nums', MUTED_TEXT)} title={countLabel}>
          {folder.sessions.length}
          <span className="sr-only"> {countLabel}</span>
        </span>
        {/* Fixed end slot, like the active list's pin slot, keeps counts aligned. */}
        <span className="h-7 w-7 flex-none">
          {folder.isProjectArchived && folder.projectId && (
            <button type="button" className={cn(HOVER_ACTION, 'hover:text-success')} onClick={() => onRestoreArchivedProject(folder.projectId!)} title={t('archived.restoreProject', 'Restore workspace')} aria-label={`${t('archived.restoreProject', 'Restore workspace')}: ${folder.displayName}`}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </span>
        <Chevron className={cn('h-4 w-4 flex-shrink-0', MUTED_TEXT, !isExpanded && 'rtl:rotate-180')} aria-hidden="true" />
      </div>
    </div>
  );
}

type FolderProps = Omit<SidebarArchivedListProps, 'folders' | 'expandByDefault'> & {
  folder: ArchivedFolder;
  isExpanded: boolean;
  onToggle: () => void;
};

function ArchivedFolderItem({ folder, isExpanded, onToggle, t, ...rest }: FolderProps) {
  const panelId = `archived-folder-${folder.key}`;
  return (
    <div
      data-project-group
      data-archived-folder={folder.isProjectArchived ? 'project' : 'sessions'}
      data-project-expanded={isExpanded || undefined}
      className={cn('sidebar-project-group relative rounded-lg', isExpanded && 'bg-[var(--project-surface,hsl(var(--card)/0.7))]')}
    >
      <div className="group">
        <ArchivedFolderHeader folder={folder} isExpanded={isExpanded} panelId={panelId} onToggle={onToggle} t={t} {...rest} />
      </div>
      {isExpanded && (
        <div id={panelId} className="sidebar-project-sessions relative">
          <div className="sidebar-project-session-surface rounded-b-lg">
            {folder.sessions.length === 0 ? (
              <p className="px-2 py-1.5 text-start text-xs text-muted-foreground">{t('archived.noSessions', 'No archived conversations')}</p>
            ) : (
              folder.sessions.map((session) => <ArchivedSessionRow key={session.sessionId} session={session} t={t} {...rest} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Archive view rendered as project folders, styled like the active list. */
export default function SidebarArchivedList({ folders, expandByDefault, ...rest }: SidebarArchivedListProps) {
  // Folders the user flipped away from the default state.
  const [toggledKeys, setToggledKeys] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) => setToggledKeys((previous) => {
    const next = new Set(previous);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  return (
    <div className="space-y-1">
      {folders.map((folder) => (
        <ArchivedFolderItem
          key={folder.key}
          folder={folder}
          isExpanded={expandByDefault !== toggledKeys.has(folder.key)}
          onToggle={() => toggle(folder.key)}
          {...rest}
        />
      ))}
    </div>
  );
}
