import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  Edit3,
  GitCommitHorizontal,
  ImageOff,
  ImagePlus,
  ListChecks,
  MoreVertical,
  Pin,
  PinOff,
  Trash2,
  X,
} from 'lucide-react';
import type { TFunction } from 'i18next';

import ProjectBusyDot from '../../../../shared/view/ProjectBusyDot';
import { Tooltip } from '../../../../shared/view/ui';
import { prefersReducedMotion } from '../../../../lib/motion';
import { cn } from '../../../../lib/utils';
import { api } from '../../../../utils/api';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { ProjectToolbarProps, SessionWithProvider } from '../../types/types';
import type { BulkSelectionKind } from '../../hooks/useSidebarController';
import { ManageProjectMembersButton, ProjectParticipantsSummary } from '../../../participants';
import { announceContextMenuOpen, useDismissableContextMenu } from '../../hooks/useDismissableContextMenu';
import { useOptionalAuth } from '../../../../contexts/AuthContext';
import { getAllSessions } from '../../utils/utils';
import { useProjectPushReminder } from '../../hooks/useProjectPushReminder';

import SidebarProjectSessions from './SidebarProjectSessions';

/* قائمة المشروع: بنودها خمسة أو ستة (تحديد، إعادة تسمية، تثبيت، شعار، إزالة الشعار
   حين يوجد، حذف). الارتفاع يُحسب من عددها لا برقم مثبَّت: رقمٌ ثابت وُضع ليوم
   ثلاثة بنود يُخرج القائمة من أسفل النافذة بمجرد أن يزيد بند. */
const PROJECT_CONTEXT_MENU_WIDTH = 175;
const PROJECT_CONTEXT_MENU_ITEM_HEIGHT = 28;
const PROJECT_CONTEXT_MENU_PADDING = 12;
const PROJECT_CONTEXT_MENU_VIEWPORT_PADDING = 10;

/** يُقدِّر ارتفاع سطر المسار بعد الالتفاف بدلاً من رقم ثابت.
 *  عرض النص المتاح = عرض القائمة − حشوة الحاوية (px-1 × 2 = 8) − حشوة المسار (px-2 × 2 = 16).
 *  حجم الخط text-xs = 12px، line-height = leading-4 = 16px، padding (py-1) = 8px. */
function estimatePathHeight(pathLength: number): number {
  const textWidth = PROJECT_CONTEXT_MENU_WIDTH - 24; // 8 container + 16 path padding
  const charsPerLine = Math.max(1, Math.floor(textWidth / 7)); // ~7px/char at 12px
  const lines = Math.max(1, Math.ceil(pathLength / charsPerLine));
  return lines * 16 + 8; // leading-4 (16px/line) + py-1 (8px padding)
}

function calcSafeContextMenuPosition(clientX: number, clientY: number, itemCount: number, pathLength: number) {
  const menuHeight = itemCount * PROJECT_CONTEXT_MENU_ITEM_HEIGHT + PROJECT_CONTEXT_MENU_PADDING + estimatePathHeight(pathLength);
  const safeX =
    clientX + PROJECT_CONTEXT_MENU_WIDTH > window.innerWidth
      ? window.innerWidth - PROJECT_CONTEXT_MENU_WIDTH - PROJECT_CONTEXT_MENU_VIEWPORT_PADDING
      : clientX;
  const safeY =
    clientY + menuHeight > window.innerHeight
      ? window.innerHeight - menuHeight - PROJECT_CONTEXT_MENU_VIEWPORT_PADDING
      : clientY;
  return {
    x: Math.max(PROJECT_CONTEXT_MENU_VIEWPORT_PADDING, safeX),
    y: Math.max(PROJECT_CONTEXT_MENU_VIEWPORT_PADDING, safeY),
  };
}

type SidebarProjectItemProps = ProjectToolbarProps & {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  bulkSelectionKind?: BulkSelectionKind | null;
  bulkSelectedIds?: Set<string>;
  onToggleBulkSelectedId?: (id: string) => void;
  onStartBulkSelectionWithId?: (kind: BulkSelectionKind, id: string) => void;
  isStarred: boolean;
  isSessionStarred: (session: SessionWithProvider) => boolean;
  onToggleStarSession: (session: SessionWithProvider, projectName: string) => void;
  editingProject: string | null;
  editingName: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingNameChange: (name: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectName: string) => void;
  onDeleteProject: (project: Project) => void;
  onArchiveProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

export default function SidebarProjectItem({
  project,
  activeProjectTool,
  onOpenProjectTool,
  onProjectToolbarPresence,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  bulkSelectionKind = null,
  bulkSelectedIds = new Set(),
  onToggleBulkSelectedId = () => {},
  onStartBulkSelectionWithId = () => {},
  isStarred,
  isSessionStarred,
  onToggleStarSession,
  editingProject,
  editingName,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingNameChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onArchiveProject,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectItemProps) {
  // Project identity is tracked by the DB-assigned `projectId` everywhere
  // after the projectName → projectId migration.
  const { i18n } = useTranslation();
  const isSelected = selectedProject?.projectId === project.projectId;
  const isEditing = editingProject === project.projectId;
  const isBulkProjectSelection = bulkSelectionKind === 'projects';
  const isBulkSelected = bulkSelectedIds.has(project.projectId);
  const { visibilityRef: pushReminderVisibilityRef, ahead: commitsAhead } = useProjectPushReminder(project.projectId);

  // Project rosters are secondary data. Only rows that enter the viewport (or
  // receive explicit hover/focus/details intent) may fetch, preventing a large
  // sidebar from fanning out one request per project during first paint.
  const participantVisibilityRef = useRef<HTMLDivElement | null>(null);
  const [participantsRequested, setParticipantsRequested] = useState(false);
  useEffect(() => {
    const element = participantVisibilityRef.current;
    if (!element || participantsRequested || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setParticipantsRequested(true);
        observer.disconnect();
      }
    }, { rootMargin: '80px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [participantsRequested]);
  // `isExpanded` is persisted UI state, not current intent. Treating every
  // restored expanded project as active recreated the mount-time fan-out for
  // off-screen rows. Visibility/hover/focus (or the selected project) is the
  // only trigger; scrolling an expanded row into view still loads it normally.
  const participantsActive = participantsRequested || isSelected;

  /* الصور نفسها محكومة بعدد حسابات النظام، تماماً كصفوف الجلسات: على تنصيب
     بحساب واحد لا أحد يُنسب إليه شيء، فيبقى العدّ النصّي وتختفي الصور. */
  const auth = useOptionalAuth();
  const showParticipantAvatars = Boolean(auth?.isMultiUser);
  const currentUserId = typeof auth?.user?.id === 'number' ? auth.user.id : null;
  const canOpenProjectMembers = project.canAccess === true;
  // Busy dot: ids of the project's loaded sessions, matched against the live
  // process-state store (see ProjectBusyDot).
  const sessionIds = sessions.map((session) => session.id);
  const totalSessionCount = Number(project.sessionMeta?.total ?? sessions.length);
  // كان النصّ إنجليزياً مثبَّتاً في الكود (`N sessions`) فظهر كذلك في واجهة
  // عربية. الآن من ملفّ الترجمة بصيغ الجمع العربية الستّ.
  const sessionCountLabel = t('projects.conversationsCount', {
    count: totalSessionCount,
    defaultValue: '{{count}} conversations',
  });
  const projectSessionsId = `project-sessions-${project.projectId}`;
  const projectMenuLabel = `${t('tooltips.projectContextMenu', { defaultValue: 'Project options' })}: ${project.displayName}`;
  const projectPinLabel = `${isStarred
    ? t('tooltips.unpinProject', { defaultValue: 'Unpin project' })
    : t('tooltips.pinProject', { defaultValue: 'Pin project' })}: ${project.displayName}`;

  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  /* اسم المشروع وشعاره يعرضان الآن Tooltip المخصَّص بدل title الأصلي (نفس نمط
     b449ad002)، فلا تظهر فقاعتان معاً. الاسم/الشعار يقعان داخل صفّ
     `pointer-events-none` (زر التوسيع المطلق تحته يستقبل الأحداث فعلياً)، لذا
     يفعّلان `pointer-events-auto` صراحةً ليصل التحويم إليهما، وبالتبعية
     يلتقطان النقر بدل تمريره للزرّ أسفلهما — فيُعاد تنفيذ toggleProject هنا
     كي لا يفقد النقر على الاسم أثر توسيع/طيّ البطاقة. في وضع التحديد الجماعي
     النقر يُترك يصعد إلى صفّ البطاقة الذي يتولّى التبديل بدلاً منه. */
  const projectPathTooltip = (
    <div className="flex flex-col gap-0.5">
      <span className="font-semibold">{project.displayName}</span>
      <span dir="ltr" className="block text-start opacity-80">{project.fullPath}</span>
    </div>
  );
  const handleProjectIdentityClick = () => {
    if (!isBulkProjectSelection) toggleProject();
  };

  /* أفعال المشروع (تسمية/مفضّلة/حذف) انتقلت من أيقونات على الصفّ إلى قائمة
     تُفتح بزرّ الفأرة الأيمن على اسم المشروع — وبزرّ ⋮ على اللمس، إذ لا زرّ
     أيمن هناك. الصفّ نفسه يبقى للاسم والحالة وحدهما. */
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  useDismissableContextMenu(
    Boolean(contextMenu),
    contextMenuRef,
    closeContextMenu,
    `project:${project.projectId}`,
  );

  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    announceContextMenuOpen(`project:${project.projectId}`);
    setContextMenu(calcSafeContextMenuPosition(event.clientX, event.clientY, contextMenuItemCount, project.fullPath.length));
  };

  const openMenuFromButton = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    announceContextMenuOpen(`project:${project.projectId}`);
    setContextMenu(
      calcSafeContextMenuPosition(
        rect.right - PROJECT_CONTEXT_MENU_WIDTH,
        rect.bottom,
        contextMenuItemCount,
        project.fullPath.length,
      ),
    );
  };

  const renameFromMenu = () => {
    onStartEditingProject(project);
    setContextMenu(null);
  };

  const toggleStarFromMenu = () => {
    toggleStarProject();
    setContextMenu(null);
  };

  /* شعار المشروع (‏T-1403): الحقيقة عند الخادم في `project.logoUrl`، وهذه
     نسخةٌ متفائلة تُعرض فور نجاح الرفع حتى تصل قائمة المشاريع المحدَّثة —
     تحديث القائمة كلها يمرّ بجلبٍ كامل قد يتأخّر ثوانٍ، وبين اللحظتين يرى
     الرافعُ صورته القديمة فيظنّ أن الرفع فشل ويكرّره. تُمسح النسخة المحلية
     حالما يتغيّر ما يأتي من الخادم، فلا تُظلّله إلى الأبد. */
  const [logoOverride, setLogoOverride] = useState<string | null | undefined>(undefined);
  const [isLogoBusy, setIsLogoBusy] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setLogoOverride(undefined);
  }, [project.logoUrl]);
  const logoUrl = logoOverride !== undefined ? logoOverride : (project.logoUrl ?? null);

  // -----------------------------------------------------------------------
  // Collapsed-project perf: unmount SidebarProjectSessions after the close
  // animation ends so a large number of collapsed projects costs nothing.
  //
  // sessionsRendered: whether to render SidebarProjectSessions in the DOM.
  //   true  → project is expanded, OR close animation is still in progress.
  //   false → project is collapsed and animation has settled.
  //
  // expandedCSS: drives the grid-template-rows CSS class (separate from the
  //   render flag so we can mount content at 0fr before transitioning to 1fr).
  // -----------------------------------------------------------------------
  const [sessionsRendered, setSessionsRendered] = useState(isExpanded);
  const [expandedCSS, setExpandedCSS] = useState(isExpanded);
  const sessionsWrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isExpanded) {
      // 1. Mount content (renders at 0fr because expandedCSS is still false).
      setSessionsRendered(true);
      // 2. On the next paint, switch CSS to 1fr so the transition plays.
      const rafId = requestAnimationFrame(() => setExpandedCSS(true));
      return () => cancelAnimationFrame(rafId);
    }
    // Collapsing: start CSS transition immediately.
    setExpandedCSS(false);
    // With reduced-motion there is no transitionend — unmount straight away.
    if (prefersReducedMotion()) {
      setSessionsRendered(false);
    }
    return undefined;
  }, [isExpanded]);

  const handleSessionsWrapperTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      // Ignore events that bubble from children.
      if (event.target !== sessionsWrapperRef.current) return;
      if (!isExpanded) setSessionsRendered(false);
    },
    [isExpanded],
  );

  const pickLogoFromMenu = () => {
    setContextMenu(null);
    logoInputRef.current?.click();
  };

  const handleLogoFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The input keeps its value after a pick, so re-choosing the SAME file would
    // fire no change event at all. Clearing it here makes every pick a real one.
    event.target.value = '';
    if (!file) {
      return;
    }
    // 2 MB — the same ceiling multer enforces server-side. Checked here too so
    // an oversized file is refused instantly instead of after a full upload.
    if (file.size > 2 * 1024 * 1024) {
      alert(t('tooltips.projectLogoTooLarge', { defaultValue: 'Image exceeds the 2MB size limit' }));
      return;
    }

    setIsLogoBusy(true);
    try {
      const response = await api.uploadProjectLogo(project.projectId, file);
      if (!response.ok) {
        throw new Error(`Upload failed with ${response.status}`);
      }
      const payload = (await response.json()) as { data?: { logoUrl?: string | null } };
      setLogoOverride(payload.data?.logoUrl ?? null);
    } catch (error) {
      console.error('[Sidebar] Failed to upload project logo:', error);
      alert(t('tooltips.projectLogoFailed', { defaultValue: 'Failed to save the project logo' }));
    } finally {
      setIsLogoBusy(false);
    }
  };

  const removeLogoFromMenu = async () => {
    setContextMenu(null);
    setIsLogoBusy(true);
    try {
      const response = await api.deleteProjectLogo(project.projectId);
      if (!response.ok) {
        throw new Error(`Delete failed with ${response.status}`);
      }
      setLogoOverride(null);
    } catch (error) {
      console.error('[Sidebar] Failed to remove project logo:', error);
      alert(t('tooltips.projectLogoFailed', { defaultValue: 'Failed to save the project logo' }));
    } finally {
      setIsLogoBusy(false);
    }
  };

  // إزالة الشعار بندٌ لا يظهر إلا حين يوجد شعار — والارتفاع يُحسب من العدد.
  // +1 for the archive button that is always present.
  const contextMenuItemCount = logoUrl ? 7 : 6;

  const startProjectBulkSelectionFromMenu = () => {
    onStartBulkSelectionWithId('projects', project.projectId);
    closeContextMenu();
  };

  const archiveFromMenu = () => {
    onArchiveProject(project);
    setContextMenu(null);
  };

  const deleteFromMenu = () => {
    onDeleteProject(project);
    setContextMenu(null);
  };

  // ADR-089: project visibility (public/private) is retired — every project is
  // shared with every team member, so there is no privacy badge and no toggle.

  const saveProjectName = () => {
    onSaveProjectName(project.projectId);
  };

  return (
    <div
      data-project-group
      data-project-expanded={isExpanded || undefined}
      className={cn(
        'sidebar-project-group relative rounded-lg',
        isExpanded && 'bg-[var(--project-surface,hsl(var(--card)/0.7))]',
        isBulkProjectSelection && isBulkSelected && 'ring-1 ring-primary/20',
        isDeleting && 'opacity-50 pointer-events-none',
      )}
    >
      <div className="group">
        {/* غلاف غير تفاعلي للبطاقة. زر التوسيع المطلق والأفعال فروع متجاورة،
            فلا يحتوي زرٌ زرًا آخر، وتبقى دلالة aria-expanded على الفعل نفسه. */}
        <div
          ref={(element) => {
            participantVisibilityRef.current = element;
            pushReminderVisibilityRef.current = element;
          }}
          data-sidebar-rename={isEditing ? "project" : undefined}
          data-project-card
          className={cn(
            // One 44px row; the list owns spacing between folder groups.
            'relative min-h-11 bg-transparent px-2 transition-colors duration-150',
            isEditing ? 'py-1.5' : 'py-2',
            isExpanded ? 'rounded-t-lg bg-[var(--project-header-open,hsl(var(--primary)/0.08))]' : 'rounded-lg hover:bg-[var(--project-hover,hsl(var(--primary)/0.03))]',
            isBulkProjectSelection && 'cursor-pointer select-none',
            isBulkProjectSelection && isBulkSelected && 'bg-[var(--project-session-selected,hsl(var(--primary)/0.1))]',
          )}
          onClick={() => {
            if (isBulkProjectSelection) onToggleBulkSelectedId(project.projectId);
          }}
          onPointerDown={(event) => {
            if (event.pointerType !== 'touch' || bulkSelectionKind) return;
            const target = event.currentTarget;
            const timer = window.setTimeout(() => {
              target.dataset.longPressSelection = 'true';
              onStartBulkSelectionWithId('projects', project.projectId);
            }, 480);
            target.dataset.longPressTimer = String(timer);
          }}
          onPointerUp={(event) => {
            const timer = Number(event.currentTarget.dataset.longPressTimer);
            if (timer) window.clearTimeout(timer);
            delete event.currentTarget.dataset.longPressTimer;
          }}
          onPointerCancel={(event) => {
            const timer = Number(event.currentTarget.dataset.longPressTimer);
            if (timer) window.clearTimeout(timer);
            delete event.currentTarget.dataset.longPressTimer;
          }}
          onPointerMove={(event) => {
            const timer = Number(event.currentTarget.dataset.longPressTimer);
            if (timer) window.clearTimeout(timer);
            delete event.currentTarget.dataset.longPressTimer;
          }}
          onClickCapture={(event) => {
            if (event.currentTarget.dataset.longPressSelection !== 'true') return;
            delete event.currentTarget.dataset.longPressSelection;
            event.preventDefault();
            event.stopPropagation();
          }}
          onMouseEnter={() => setParticipantsRequested(true)}
          onFocusCapture={() => setParticipantsRequested(true)}
        >
          {!isEditing && !bulkSelectionKind && (
            <button
              type="button"
              aria-describedby={`project-path-${project.projectId}`}
              aria-expanded={isExpanded}
              aria-controls={projectSessionsId}
              aria-label={`${isExpanded
                ? t('tooltips.collapseProject', { defaultValue: 'Collapse project' })
                : t('tooltips.expandProject', { defaultValue: 'Expand project' })}: ${project.displayName}`}
              className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--project-accent,hsl(var(--ring)))] focus-visible:ring-offset-1 active:scale-[0.98]"
              onClick={toggleProject}
              onContextMenu={handleContextMenu}
            />
          )}
          <span id={`project-path-${project.projectId}`} dir="ltr" className="sr-only">{project.fullPath}</span>
          <div
            data-project-row-main
            className={cn(
              'pointer-events-none relative z-10 grid min-w-0 items-center gap-1',
              isBulkProjectSelection
                ? 'grid-cols-[1rem_minmax(0,1fr)_auto]'
                : 'grid-cols-[minmax(0,1fr)_auto]',
            )}
          >
            {isBulkProjectSelection && (
              <div data-project-selection-rail className="flex h-4 w-4 flex-none items-center justify-center">
                <input
                  type="checkbox"
                  aria-label={`${t('bulk.selectProject', 'Select project')}: ${project.displayName}`}
                  checked={isBulkSelected}
                  onChange={() => onToggleBulkSelectedId(project.projectId)}
                  onClick={(event) => event.stopPropagation()}
                  className="pointer-events-auto h-4 w-4 flex-shrink-0 accent-primary"
                />
              </div>
            )}
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {/* شعار المشروع (‏T-1403) حين رُفع له شعار: مربّع صغير في مبدأ
                  الصفّ. الحرف الأول بديلٌ ضمني — لا نرسم مربّعاً فارغاً
                  للمشاريع بلا شعار كي لا يدفع كل صفّ عرضاً لا يحمل معلومة. */}
              {logoUrl && (
                <Tooltip
                  content={projectPathTooltip}
                  position="bottom"
                  multiline
                  wrapperClassName="pointer-events-auto flex-shrink-0"
                >
                  <img
                    src={logoUrl}
                    alt=""
                    aria-hidden="true"
                    className="h-6 w-6 flex-shrink-0 cursor-pointer object-contain"
                    onClick={handleProjectIdentityClick}
                  />
                </Tooltip>
              )}

              <div className="min-w-0 flex-1">
                {isEditing ? (
                  // dir="auto": الاسم قد يكون عربياً أو لاتينياً؛ first-strong
                  // يضبط الاتجاه بدقة لأن هذه قيمة ثابتة لا مُبثَّثة.
                  <input
                    type="text"
                    dir="auto"
                    value={editingName}
                    onChange={(event) => onEditingNameChange(event.target.value)}
                    className="sidebar-rename-input"
                    aria-label={t("projects.projectNamePlaceholder")}
                    placeholder={t('projects.projectNamePlaceholder')}
                    autoFocus
                    autoComplete="off"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        saveProjectName();
                      }
                      if (event.key === 'Escape') {
                        onCancelEditingProject();
                      }
                    }}
                  />
                ) : (
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
                      {/* يسبق الزر الاسم في اتجاه RTL، فيظهر مباشرةً على يمين
                          العنوان. يبقى في هذا السطر كي لا يهبط إلى المسار. */}
                      <Tooltip
                        content={projectPathTooltip}
                        position="bottom"
                        multiline
                        wrapperClassName="min-w-0 pointer-events-auto"
                      >
                        <div
                          className="min-w-0 cursor-pointer truncate whitespace-nowrap text-sm font-semibold text-[color:var(--project-foreground,hsl(var(--foreground)))]"
                          onClick={handleProjectIdentityClick}
                        >
                          {project.displayName}
                        </div>
                      </Tooltip>
                      <ProjectBusyDot sessionIds={sessionIds} className="ms-1 flex-shrink-0" />
                      {/* الرقم وحده: العبارة الكاملة في `title` وفي نصّ مخفيّ
                          لقارئ الشاشة، فلا يفقد أحدٌ المعنى ولا يدفع السطر ثمن
                          كلمةٍ تتكرّر في كل صفّ. */}
                      <span
                        className={cn('ms-auto flex-shrink-0 text-[11px] tabular-nums', isExpanded ? 'text-[color:var(--project-foreground,hsl(var(--foreground)))]' : 'text-[color:var(--project-muted-foreground,hsl(var(--muted-foreground)))]')}
                        title={sessionCountLabel}
                      >
                        {totalSessionCount}
                        <span className="sr-only"> {sessionCountLabel}</span>
                      </span>
                      {commitsAhead !== null && (() => {
                        const pushReminderLabel = t('projects.pushReminder', {
                          count: commitsAhead,
                          defaultValue: '{{count}} commits ready to push',
                        });
                        return (
                          <Tooltip
                            content={pushReminderLabel}
                            position="bottom"
                            tapToToggle
                            keyboard
                            wrapperClassName="pointer-events-auto flex-shrink-0 [@media(max-width:259px)]:hidden"
                          >
                            <span
                              data-project-push-reminder
                              role="img"
                              aria-label={pushReminderLabel}
                              className="flex items-center text-[color:var(--success)]"
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <GitCommitHorizontal aria-hidden="true" className="h-3 w-3" />
                            </span>
                          </Tooltip>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div data-project-end-rail className="relative z-10 flex flex-none items-center gap-1 ps-1">
              {isEditing ? (
                <>
                  <button
                    type="button"
                    className="sidebar-rename-action sidebar-rename-save"
                    title={t("tooltips.save")} aria-label={t("tooltips.save")}
                    onClick={(event) => {
                      event.stopPropagation();
                      saveProjectName();
                    }}
                  >
                    <Check aria-hidden="true" className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className="sidebar-rename-action"
                    title={t("tooltips.cancel")} aria-label={t("tooltips.cancel")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCancelEditingProject();
                    }}
                  >
                    <X aria-hidden="true" className="size-3.5" />
                  </button>
                </>
              ) : !bulkSelectionKind && (
                <>
                  <div data-project-pin-slot className="h-7 w-6 flex-none">
                    <button
                      type="button"
                      data-project-row-action
                      aria-pressed={isStarred}
                      aria-label={projectPinLabel}
                      title={projectPinLabel}
                      className={cn(
                        'pointer-events-auto flex h-7 w-6 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--project-accent,hsl(var(--ring)))] active:scale-90',
                        isStarred
                          ? 'text-[color:var(--project-accent,hsl(var(--primary)))] hover:text-[color:var(--project-accent,hsl(var(--primary)/0.8))]'
                          : 'text-muted-foreground/25 hover:text-muted-foreground/60',
                      )}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleStarProject();
                      }}
                    >
                      <Bookmark className="h-3.5 w-3.5 fill-current" strokeWidth={0} aria-hidden="true" />
                    </button>
                  </div>
                  {/* على اللمس تظهر قائمة ⋮ وحدها؛ لا نزاحمها بشيفرون في الحيّز
                      الطرفي نفسه. الفأرة ترى الشيفرون كحالة بصرية فقط. */}
                  <button
                    type="button"
                    data-project-menu-trigger
                    aria-label={projectMenuLabel}
                    title={projectMenuLabel}
                    className="pointer-events-auto hidden h-7 w-7 items-center justify-center rounded-md text-[color:var(--project-muted-foreground,hsl(var(--muted-foreground)))] transition-colors active:scale-90 active:bg-accent [@media(hover:none)]:flex"
                    onPointerDown={(event) => event.stopPropagation()}
                    onTouchStart={(event) => event.stopPropagation()}
                    onClick={openMenuFromButton}
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>
                  <span className="[@media(hover:none)]:hidden">
                    {/* B-374: ChevronRight اتجاهي (ينقلب في RTL)، ChevronDown لا يُعكس. */}
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-[color:var(--project-muted-foreground,hsl(var(--muted-foreground)))]" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-[color:var(--project-muted-foreground,hsl(var(--muted-foreground)))] rtl:rotate-180" />
                    )}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* منتقي ملف الشعار: مخفيّ ويُفتح ببند القائمة وحده. `accept` تلميحٌ
          للمتصفّح لا حاجز — الحاجز الفعلي فحص البايتات على الخادم. */}
      <input
        ref={logoInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="hidden"
        onChange={handleLogoFileChange}
      />

      {/* انتقال ناعم للفتح/الإغلاق عبر grid-template-rows (0fr↔1fr).
          overflow-hidden على الغلاف الداخلي يمنع إظهار المحتوى أثناء الانتقال.
          motion-reduce:transition-none يحترم تفضيل المستخدم في تقليل الحركة.
          SidebarProjectSessions تُركَّب فقط حين يكون المشروع مفتوحاً أو أثناء
          انتقال الإغلاق، وتُفكَّك بعد انتهائه لتوفير الذاكرة والمعالج. */}
      <div
        ref={sessionsWrapperRef}
        id={projectSessionsId}
        {...(!isExpanded ? { inert: '' } : {})}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-300 ease-in-out',
          'motion-reduce:transition-none',
          expandedCSS
            ? '[grid-template-rows:1fr] opacity-100'
            : '[grid-template-rows:0fr] opacity-0',
        )}
        onTransitionEnd={handleSessionsWrapperTransitionEnd}
      >
        <div className="overflow-hidden">
        {sessionsRendered && <SidebarProjectSessions
          activeProjectTool={isSelected ? activeProjectTool : undefined}
          onOpenProjectTool={onOpenProjectTool}
          onProjectToolbarPresence={isSelected ? onProjectToolbarPresence : undefined}
          contentDirection={i18n.dir()}
          participantsSummary={isExpanded && showParticipantAvatars ? (
            <span className="flex min-w-0 items-center gap-1">
              <ProjectParticipantsSummary
                projectId={project.projectId}
                loadedSessions={getAllSessions(project)}
                locale={i18n.language}
                t={t}
                active={participantsActive}
                showAvatars={showParticipantAvatars}
                compact
                maxAvatars={2}
                className="mt-0 min-w-0 justify-end"
              />
              {canOpenProjectMembers && (
                <ManageProjectMembersButton projectId={project.projectId} t={t} currentUserId={currentUserId} />
              )}
            </span>
          ) : null}
          project={project}
          isExpanded={isExpanded}
          sessions={sessions}
          selectedSession={selectedSession}
          isSessionStarred={isSessionStarred}
          onToggleStarSession={onToggleStarSession}
          initialSessionsLoaded={initialSessionsLoaded}
          hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
          isLoadingMoreSessions={isLoadingMoreSessions}
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
          onLoadMoreSessions={onLoadMoreSessions}
          onNewSession={onNewSession}
          bulkSelectionKind={bulkSelectionKind}
          bulkSelectedIds={bulkSelectedIds}
          onToggleBulkSelectedId={onToggleBulkSelectedId}
          onStartBulkSelectionWithId={onStartBulkSelectionWithId}
          t={t}
        />}
        </div>
      </div>

      {/* B-371: القائمة تُسقَط في `document.body` لا في مكانها من شجرة الشريط —
          جذر الشريط يحمل `backdrop-blur-sm`، وأي `backdrop-filter` يجعل
          `position: fixed` منسوباً إلى صندوق الشريط لا إلى نافذة العرض، فتخرج
          القائمة خارج الحافة تماماً في RTL. (نفس بورتال قائمة الجلسة.) */}
      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          role="menu"
          aria-label={projectMenuLabel}
          // design-ok: إحداثيات المؤشر في نافذة العرض فيزيائية بطبيعتها.
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 9999, width: PROJECT_CONTEXT_MENU_WIDTH, maxWidth: 'calc(100vw - 20px)', maxHeight: 'calc(100dvh - 20px)' }}
          className="animate-menu-enter overflow-auto rounded-lg border border-border bg-popover px-1 py-1 text-popover-foreground shadow-lg"
        >
          <div
            data-project-menu-path
            dir="ltr"
            tabIndex={0}
            aria-label={project.fullPath}
            style={{ overflowWrap: 'anywhere' }}
            className="break-all rounded px-2 py-1 text-start text-xs leading-4 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* <wbr> بعد كل / يتيح للمتصفّح كسر السطر عند الفاصلة الطبيعية */}
            {project.fullPath.split('/').reduce<React.ReactNode[]>((acc, seg, i) => {
              if (i > 0) { acc.push('/', <wbr key={i} />); }
              acc.push(seg);
              return acc;
            }, [])}
          </div>
          <button
            role="menuitem"
            type="button"
            className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-9"
            onClick={startProjectBulkSelectionFromMenu}
          >
            <ListChecks className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span className="flex-1 whitespace-nowrap">
              {t('tooltips.selectProject', { defaultValue: 'Select project' })}
            </span>
          </button>
          <button
            role="menuitem"
            type="button"
            className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-9"
            onClick={renameFromMenu}
            title={t('tooltips.renameProject')}
          >
            <Edit3 className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="flex-1 whitespace-nowrap">
              {t('tooltips.renameSession', { defaultValue: 'Rename' })}
            </span>
          </button>
          <button
            role="menuitem"
            type="button"
            aria-pressed={isStarred}
            aria-label={projectPinLabel}
            className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-9"
            onClick={toggleStarFromMenu}
          >
            {isStarred ? (
              <PinOff className="h-3.5 w-3.5 flex-shrink-0" />
            ) : (
              <Pin className="h-3.5 w-3.5 flex-shrink-0" />
            )}
            <span className="flex-1 whitespace-nowrap">
              {isStarred
                ? t('tooltips.unpinProject', { defaultValue: 'Unpin project' })
                : t('tooltips.pinProject', { defaultValue: 'Pin project' })}
            </span>
          </button>
          {/* شعار المشروع: اختيار ملف من الجهاز، وإزالته بندٌ لا يظهر إلا حين
              يكون هناك شعار فعلاً. */}
          <button
            role="menuitem"
            type="button"
            disabled={isLogoBusy}
            className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-9 disabled:opacity-50"
            onClick={pickLogoFromMenu}
          >
            <ImagePlus className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="flex-1 whitespace-nowrap">
              {t('tooltips.changeProjectLogo', { defaultValue: 'Change project logo' })}
            </span>
          </button>
          {logoUrl && (
            <button
              role="menuitem"
              type="button"
              disabled={isLogoBusy}
              className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-9 disabled:opacity-50"
              onClick={removeLogoFromMenu}
            >
              <ImageOff className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="flex-1 whitespace-nowrap">
                {t('tooltips.removeProjectLogo', { defaultValue: 'Remove logo' })}
              </span>
            </button>
          )}
          {/* الأرشفة: بند مستقل قبل الحذف — لا ينقل التحديد ولا يبحر. */}
          <button
            role="menuitem"
            type="button"
            className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-1 text-start text-xs text-foreground transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-9"
            onClick={archiveFromMenu}
            title={t('tooltips.archiveProject')}
          >
            <Archive className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="flex-1 whitespace-nowrap">
              {t('tooltips.archiveProject')}
            </span>
          </button>
          {/* الحذف آخر بند وبلونه: نافذة التأكيد خلفه كما كانت خلف الأيقونة. */}
          <div role="separator" className="mx-1 my-0.5 border-t border-border" />
          <button
            role="menuitem"
            type="button"
            className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-1 text-start text-xs text-red-600 transition-colors hover:bg-red-50 focus:bg-red-50 focus:outline-none dark:text-red-400 dark:hover:bg-red-900/20 dark:focus:bg-red-900/20 [@media(pointer:coarse)]:min-h-9"
            onClick={deleteFromMenu}
            title={t('tooltips.deleteProject')}
          >
            <Trash2 className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="flex-1 whitespace-nowrap">
              {t('tooltips.deleteSessionShort', { defaultValue: 'Delete' })}
            </span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
