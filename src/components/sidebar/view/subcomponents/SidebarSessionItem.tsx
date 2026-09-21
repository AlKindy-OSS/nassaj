import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  Bookmark,
  Check,
  CircleCheck,
  CircleDashed,
  Copy,
  Edit2,
  ExternalLink,
  Hash,
  MailOpen,
  ListChecks,
  MoreVertical,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type {
  Project,
  ProjectSession,
  LLMProvider,
  SessionOwner,
  SessionRowParticipant,
} from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import type { BulkSelectionKind } from '../../hooks/useSidebarController';
import { createSessionViewModel } from '../../utils/utils';
import {
  markOutcomeUnread,
  useCanMarkOutcomeUnread,
  useSessionOutcome,
} from '../../../../stores/sessionCompletionStore';
import {
  useSessionProcessState,
  useSessionProcessStateAuthority,
} from '../../../../stores/sessionProcessStateStore';
import { useSessionWorkflows } from '../../../../stores/workflowStatusStore';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { useConversationClosed } from '../../../chat/hooks/useConversationClosed';
import { announceContextMenuOpen, useDismissableContextMenu } from '../../hooks/useDismissableContextMenu';
import { useSidebarSessionExtras } from '../../context/SidebarSessionExtrasContext';
import { ParticipantAvatarStack } from '../../../participants';
import { useOptionalAuth } from '../../../../contexts/AuthContext';
import type { SessionParticipant } from '../../../participants';

import SessionRowStatusIndicator from './SessionRowStatusIndicator';
import { deriveSessionRowIndicatorState } from './sessionRowIndicatorState';

/**
 * Builds the absolute, openable session URL on the current origin, honoring any
 * router basename. Mirrors the in-app route `/session/:sessionId`, so opening it
 * in a new tab loads the same conversation directly.
 */
const buildSessionUrl = (sessionId: string): string => {
  const basename = (window.__ROUTER_BASENAME__ ?? '').replace(/\/+$/, '');
  return `${window.location.origin}${basename}/session/${encodeURIComponent(sessionId)}`;
};

const SESSION_CONTEXT_MENU_WIDTH = 156;
const SESSION_CONTEXT_MENU_VIEWPORT_PADDING = 10;

function calcSafeContextMenuPosition(clientX: number, clientY: number) {
  const safeX =
    clientX + SESSION_CONTEXT_MENU_WIDTH > window.innerWidth
      ? window.innerWidth - SESSION_CONTEXT_MENU_WIDTH - SESSION_CONTEXT_MENU_VIEWPORT_PADDING
      : clientX;
  return {
    x: Math.max(SESSION_CONTEXT_MENU_VIEWPORT_PADDING, safeX),
    y: Math.max(SESSION_CONTEXT_MENU_VIEWPORT_PADDING, clientY),
  };
}

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  isChatActive?: boolean;
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
  bulkSelectionKind?: BulkSelectionKind | null;
  isBulkSelected?: boolean;
  onToggleBulkSelectedId?: (id: string) => void;
  onStartBulkSelectionWithId?: (kind: BulkSelectionKind, id: string) => void;
  t: TFunction;
};

/**
 * Adapts the session row's participants into the SessionParticipant shape the
 * avatar stack consumes. The avatars read userId/username/role/last_seen (plus
 * the optional picture), so the remaining fields are placeholders.
 *
 * Falls back to the single `owner` field when a server that predates the
 * per-row `participants` payload answers — one face is still better than none,
 * and it is exactly what this row used to show.
 */
const toStackParticipants = (
  participants: SessionRowParticipant[] | undefined,
  owner: SessionOwner | null,
): SessionParticipant[] => {
  const rows: SessionRowParticipant[] =
    participants && participants.length > 0
      ? participants
      : owner
        ? [{ userId: owner.userId, username: owner.username, avatarUrl: owner.avatarUrl ?? null, role: 'owner' }]
        : [];

  return rows.map((row) => ({
    userId: row.userId,
    username: row.username,
    role: row.role,
    first_seen: '',
    last_seen: row.lastSeen ?? '',
    message_count: 0,
    avatarUrl: row.avatarUrl ?? null,
  }));
};

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
  isChatActive = true,
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
  bulkSelectionKind = null,
  isBulkSelected = false,
  onToggleBulkSelectedId = () => {},
  onStartBulkSelectionWithId = () => {},
  t,
}: SidebarSessionItemProps) {
  const { i18n } = useTranslation();
  const sessionExtras = useSidebarSessionExtras();
  const sessionView = createSessionViewModel(session, t);
  // Snippet of the matching message while a conversation search is active.
  const messageSnippet = sessionExtras.messageSnippets.get(session.id) ?? null;
  const isSelected = isChatActive && selectedSession?.id === session.id;
  const isEditing = editingSession === session.id;
  const isBulkSessionSelection = bulkSelectionKind === 'sessions';
  const hasSelectedSurface = isSelected || (isBulkSessionSelection && isBulkSelected);
  const compactSessionAge = formatCompactSessionAge(sessionView.sessionTime, currentTime);
  const visibleProcessState = useSessionProcessState(session.id);
  const processStateAuthoritative = useSessionProcessStateAuthority(session.id);
  const visibleOutcome = useSessionOutcome(session.id);
  const sessionWorkflows = useSessionWorkflows(session.id);
  const hasRunningWorkflow = sessionWorkflows.some(
    (workflow) => workflow.status === 'running',
  );
  const hasOrphanWorkflow = sessionWorkflows.some(
    (workflow) => workflow.status === 'orphan',
  );
  const rowIndicatorState = deriveSessionRowIndicatorState(
    processStateAuthoritative ? visibleProcessState : null,
    visibleOutcome,
    hasRunningWorkflow,
    hasOrphanWorkflow,
  );
  const editingContainerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const endRailRef = useRef<HTMLDivElement>(null);
  /* B-touch: علامة تتبّع أن اللمسة الحالية كانت كشفاً للطبقة (لا فعلاً). نُعيّنها في
     onTouchStart ونصطادها في onClickCapture لنبتلع النقرة المُركَّبة قبل وصولها
     إلى أي زرّ. مرجع (لا حالة) حتى لا يُؤدي التغيير إلى إعادة رسم. */
  const touchRevealedRef = useRef(false);
  const [sessionIdCopyFailed, setSessionIdCopyFailed] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    maxHeight: number;
  } | null>(null);
  /**
   * ‏B-585 — إبرازٌ لحظيّ بعد «تحديد كغير مقروء»: الشارة تعود، والصفّ يومض
   * مرّةً ليقول إن الفعل وقع. بلا هذا يبدو الزرّ بلا أثر — وهو ما يربك.
   */
  const [justMarkedUnread, setJustMarkedUnread] = useState(false);
  // Mouse-clicking the absolute session link leaves it focused, but that is not
  // keyboard navigation. Keep the end actions visible only after a visible
  // keyboard focus; the action rail itself then owns focus-within persistence.
  const [keyboardActionsVisible, setKeyboardActionsVisible] = useState(false);
  /* B-touch: مسار اللمس للجوّال — اللمس على الزاوية الإنهائية للصفّ يُظهر طبقة
     الإجراءات بدلاً من فتح المحادثة. يُخفَى تلقائياً عند بداية تمرير أو لمس خارج. */
  const [touchActionsVisible, setTouchActionsVisible] = useState(false);
  useEffect(() => {
    if (!justMarkedUnread) return undefined;
    const timer = window.setTimeout(() => setJustMarkedUnread(false), 1600);
    return () => window.clearTimeout(timer);
  }, [justMarkedUnread]);

  /* B-touch: إخفاء طبقة اللمس عند لمس أي مكان خارج سكة الأفعال أو بدء التمرير. */
  useEffect(() => {
    if (!touchActionsVisible) return undefined;
    const dismiss = (e: TouchEvent) => {
      if (endRailRef.current?.contains(e.target as Node)) return;
      setTouchActionsVisible(false);
    };
    const dismissScroll = () => setTouchActionsVisible(false);
    document.addEventListener('touchstart', dismiss, { passive: true });
    document.addEventListener('scroll', dismissScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('touchstart', dismiss);
      document.removeEventListener('scroll', dismissScroll, true);
    };
  }, [touchActionsVisible]);
  /* العنوان الكامل يُعرض بتلميحة المتصفّح الأصلية (خاصية `title` على العنوان)
     وحدها. كانت هنا طبقة مرسومة بيدنا تفعل الشيء نفسه، فظهر الاسم مرّتين على
     سطح المكتب — أُزيلت وبقيت التلميحة الأصلية. */

  /* Attribution on the row (T-1194): EVERY human who took part in this
     conversation, not just its owner — a shared conversation is not the work of
     one person and the row used to say it was.

     Gated on `isMultiUser`: on a single-account install every conversation
     belongs to the only human, so an avatar on every row is pure noise and the
     stack is not rendered at all. The gate is the SYSTEM's account count, not
     this row's participant count — otherwise a team install would hide the face
     of a conversation only one teammate has touched, which is exactly the case
     where knowing whose it is matters most. */
  const auth = useOptionalAuth();
  const rowParticipants = auth?.isMultiUser
    ? toStackParticipants(session.participants, session.owner ?? null)
    : [];

  // Keep the inline editor visible when the pointer leaves the row. Clicking
  // outside the editor cancels without saving, matching Escape and Cancel.
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
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  useDismissableContextMenu(Boolean(contextMenu), contextMenuRef, closeContextMenu, `session:${session.id}`);

  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    announceContextMenuOpen(`session:${session.id}`);
    setSessionIdCopyFailed(false);
    const position = calcSafeContextMenuPosition(event.clientX, event.clientY);
    setContextMenu({
      x: position.x,
      y: position.y,
      maxHeight: Math.max(0, window.innerHeight - position.y - SESSION_CONTEXT_MENU_VIEWPORT_PADDING),
    });
  };

  /* القائمة تبدأ دائماً أسفل زرّ اللمس نفسه. كان قلبها إلى أعلى النافذة قرب
     حافتها يجعلها تبدو كأنها قفزت بعيداً عن الزر؛ الحيّز المحدود يُعالج بتمرير
     القائمة لا بنقلها. */
  const openMenuFromButton = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setSessionIdCopyFailed(false);
    announceContextMenuOpen(`session:${session.id}`);
    // محاذاة حافة القائمة مع حافة زر ⋮ اليمنى تُبقيها داخل الشريط في الواجهة
    // العريضة على الجوال؛ البدء من `rect.left` كان يمددها فوق مساحة المحادثة.
    const x = calcSafeContextMenuPosition(rect.right - SESSION_CONTEXT_MENU_WIDTH, rect.bottom).x;
    setContextMenu({
      x,
      y: rect.bottom,
      maxHeight: Math.max(0, window.innerHeight - rect.bottom - SESSION_CONTEXT_MENU_VIEWPORT_PADDING),
    });
  };

  const openInNewTab = () => {
    window.open(buildSessionUrl(session.id), '_blank', 'noopener');
    setContextMenu(null);
  };

  const copySessionLink = () => {
    navigator.clipboard.writeText(buildSessionUrl(session.id)).catch(() => {});
    setContextMenu(null);
  };

  const copySessionId = async () => {
    setSessionIdCopyFailed(false);
    try {
      await navigator.clipboard.writeText(session.id);
      setContextMenu(null);
    } catch {
      setSessionIdCopyFailed(true);
    }
  };

  /* إغلاق/إعادة فتح المحادثة من الصفّ نفسه دون فتحها. الحالة في نفس الخطّاف
     الذي يستعمله زرّ شريط المحادثة، فالتبديل متفائل ويتراجع عند فشل الطلب،
     ومصدر الحقيقة الأوّلي يبقى حمولة الجلسة (`session.closed`). */
  const conversationClosed = useConversationClosed(session.id, {
    initialClosed: sessionView.isClosed,
  });

  const closeToggleLabel = conversationClosed.closed
    ? t('tooltips.reopenConversation', { defaultValue: 'Reopen' })
    : t('tooltips.closeConversation', { defaultValue: 'Close' });

  const toggleConversationClosed = () => {
    conversationClosed.toggle();
    setContextMenu(null);
  };

  /* الأرشفة فعل عكوس (تُستعاد من عارض الأرشيف)، فلا نافذة تأكيد لها — على عكس
     الحذف النهائي الذي يبقى خلف نافذته. الطلب نفسه هو soft delete الذي تنفّذه
     تلك النافذة. */
  const archiveSession = () => {
    sessionExtras.onArchiveSession(session.id);
    setContextMenu(null);
  };

  // Sessions are owned by a project identified by `projectId` (DB primary key)
  // after the projectName → projectId migration.

  const saveEditedSession = () => {
    onSaveEditingSession(project.projectId, session.id, editingSessionName, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(project.projectId, session.id, sessionView.sessionName, session.__provider);
  };

  /* أفعال القائمة: كلٌّ منها يُغلقها بعده — القائمة نقطة الدخول الوحيدة لهذه
     الأفعال بعد إفراغ الصفّ من أزراره. */
  const startRenameSession = () => {
    onStartEditingSession(session.id, sessionView.sessionName);
    setContextMenu(null);
  };

  const toggleStarFromMenu = () => {
    onToggleStar(session, project.projectId);
    setContextMenu(null);
  };

  /**
   * ‏T-1340 — «تحديد كغير مقروء» يُعيد شارة المحادثة لكل الأعضاء.
   */
  const markUnreadFromMenu = () => {
    closeContextMenu();
    void markOutcomeUnread(session.id).then((restored) => {
      // أثرٌ مرئيّ لا فعلٌ صامت: الشارة تعود في الصفّ، ويُبرَز الصفّ لحظاتٍ كي
      // تُرى العودة. وفعلٌ بلا أثرٍ ظاهر يربك المستخدم أكثر ممّا يخدمه.
      if (restored) setJustMarkedUnread(true);
    });
  };

  const deleteSessionFromMenu = () => {
    requestDeleteSession();
    setContextMenu(null);
  };

  const startSessionBulkSelectionFromMenu = () => {
    onStartBulkSelectionWithId('sessions', session.id);
    closeContextMenu();
  };

  /* A closed conversation fades rather than striking through its title: a
     strikethrough damages Arabic letterforms and suggests deletion. The
     accessible close/reopen button is the single explicit state indicator. */
  const isClosed = conversationClosed.closed;
  /**
   * ‏T-1340 — هل لـ«تحديد كغير مقروء» أثرٌ على هذا الصفّ؟
   *
   * الانتهاء/الخطأ المقروء عالمياً = شارةٌ يمكن إعادتها. أمّا السؤال فشارته لا تُقرأ بالفتح،
   * والحكم الظاهر لا يحتاج «إعادة» أصلاً.
   */
  const canMarkUnread = useCanMarkOutcomeUnread(
    session.id,
    session.outcome,
    session.outcomeSeen,
  );
  // The row is a real anchor so the browser's native context menu offers
  // "Open in new tab/window". A plain left-click stays an in-app SPA
  // navigation (no full reload); modified clicks and middle-clicks are left
  // to the browser so they open the session URL in a new tab/window.
  const handleSessionLinkClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onProjectSelect(project);
    onSessionSelect(session, project.projectId);
  };

  const toggleStarFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onToggleStar(session, project.projectId);
  };

  return (
    <>
    <div
      data-session-card
      data-session-selected={isSelected || (isBulkSessionSelection && isBulkSelected) || undefined}
      className={cn('sidebar-project-session-row group relative', isBulkSessionSelection && 'cursor-pointer select-none')}
      onFocusCapture={(event) => {
        const target = event.target as HTMLElement;
        if (target.dataset.sessionLink === 'true' && target.matches(':focus-visible')) {
          setKeyboardActionsVisible(true);
        }
      }}
      onBlurCapture={(event) => {
        const nextFocus = event.relatedTarget as Node | null;
        if (!nextFocus || !event.currentTarget.contains(nextFocus)) {
          setKeyboardActionsVisible(false);
        }
      }}
      onClick={() => {
        if (isBulkSessionSelection) onToggleBulkSelectedId(session.id);
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== 'touch') setKeyboardActionsVisible(false);
        if (event.pointerType !== 'touch' || bulkSelectionKind) return;
        const target = event.currentTarget;
        const timer = window.setTimeout(() => {
          target.dataset.longPressSelection = 'true';
          onStartBulkSelectionWithId('sessions', session.id);
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
    >
      {/* صف متصل بسطح المشروع على كل المقاسات.
          الأنكور يمنح «فتح في تبويب» والزرّ الأوسط مجاناً. */}
      {!bulkSelectionKind && <a
        href={buildSessionUrl(session.id)}
        data-session-link="true"
        onClick={handleSessionLinkClick}
        onContextMenu={handleContextMenu}
        aria-label={sessionView.sessionName}
        aria-current={isSelected ? 'page' : undefined}
        className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--project-accent,hsl(var(--ring)))]"
      >
        <span className="sr-only">{sessionView.sessionName}</span>
      </a>}
      <div
        className={cn(
          'sidebar-project-session-content relative z-10 block px-2 pointer-events-none transition-colors duration-150',
          isEditing ? 'py-1' : 'py-1.5',
          justMarkedUnread && 'ring-2 ring-primary/60',
          hasSelectedSurface
            ? 'bg-[var(--project-session-selected,hsl(var(--primary)/0.12))] text-[color:var(--project-foreground,hsl(var(--foreground)))]'
            : 'bg-transparent group-hover:bg-[var(--project-hover,hsl(var(--foreground)/0.04))]',
          isBulkSessionSelection && isBulkSelected && 'ring-1 ring-inset ring-primary/20',
        )}
      >
        <div
          data-session-row-main
          className={cn(
            'grid min-w-0 items-center gap-1',
            isEditing
              ? (isBulkSessionSelection ? 'grid-cols-[1rem_auto_minmax(0,1fr)]' : 'grid-cols-[auto_minmax(0,1fr)]')
              : (isBulkSessionSelection ? 'grid-cols-[1rem_auto_minmax(0,1fr)_auto]' : 'grid-cols-[auto_minmax(0,1fr)_auto]'),
          )}
        >
          {isBulkSessionSelection && (
            <div data-session-selection-rail className="flex h-4 w-4 flex-none items-center justify-center">
              <input
                type="checkbox"
                aria-label={`${t('bulk.selectSession', 'Select conversation')}: ${sessionView.sessionName}`}
                checked={isBulkSelected}
                onChange={() => onToggleBulkSelectedId(session.id)}
                onClick={(event) => event.stopPropagation()}
                className="pointer-events-auto h-4 w-4 flex-none accent-primary"
              />
            </div>
          )}
          {/* صندوق الشعار */}
          <div
            data-session-provider-logo
            className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-visible rounded-md bg-muted/50"
          >
            <SessionProviderLogo
              provider={session.__provider}
              className={cn('h-3 w-3', isClosed && 'opacity-40')}
            />
            {/* B-824 — الحالة تسكن الشعارَ دائماً، لا الأفاتار أحياناً. كانت
                تنتقل إلى رصّة المشاركين متى وُجد مشارك، وتلك الرصّة تذوب إلى
                `opacity-0` عند التحويم: فعلى كل تثبيتٍ متعدّد المستخدمين تختفي
                حالةُ الصفّ في اللحظة التي يشير إليه المستخدم فيها. وإشارةٌ
                واحدة تقفز بين طرفَي الصفّ حسب بياناتٍ لا صلة لها بها ليست
                إشارة يُعتمد عليها في مسحٍ سريع لعمودٍ طويل. */}
            {rowIndicatorState && <SessionRowStatusIndicator state={rowIndicatorState} />}
          </div>

          {isEditing ? (
            <div
              ref={editingContainerRef}
              data-sidebar-rename="session"
              className="relative z-20 flex min-w-0 flex-1 items-center gap-1"
            >
              <input
                type="text"
                dir="auto"
                value={editingSessionName}
                onChange={(event) => onEditingSessionNameChange(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    saveEditedSession();
                  } else if (event.key === 'Escape') {
                    onCancelEditingSession();
                  }
                }}
                onClick={(event) => event.stopPropagation()}
                className="sidebar-rename-input"
                aria-label={t("tooltips.renameSession")}
                autoFocus
              />
              <button
                type="button" className="sidebar-rename-action sidebar-rename-save"
                aria-label={t("tooltips.save")}
                onClick={(event) => {
                  event.stopPropagation();
                  saveEditedSession();
                }}
                title={t('tooltips.save')}
              >
                <Check aria-hidden="true" className="size-3.5" />
              </button>
              <button
                type="button" className="sidebar-rename-action"
                aria-label={t("tooltips.cancel")}
                onClick={(event) => {
                  event.stopPropagation();
                  onCancelEditingSession();
                }}
                title={t('tooltips.cancel')}
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </div>
          ) : (
            <>
              {/* المحتوى */}
              <div data-session-content className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-0.5">
                  {/* يسبق الزر الاسم في اتجاه RTL، فلا يختلط بالشعار أو بالأفعال
                      المطلقة عند طرف الصف، ولا يمكنه النزول إلى السطر التالي. */}
                  {/* dir="auto" — 8% of real session titles are all-Latin. This is
                      a static, non-streamed label, so first-strong is exact here
                      and keeps the clamp clipping the trailing edge.
                      العنوان الكامل في خاصية `title` — تلميحة المتصفّح الأصلية. */}
                  <div
                    dir="auto"
                    title={sessionView.sessionName}
                    className={cn(
                      'truncate min-w-0 text-xs font-medium',
                      isClosed ? 'text-foreground/60' : 'text-[color:var(--project-foreground,hsl(var(--foreground)))]',
                    )}
                  >
                    {sessionView.sessionName}
                  </div>
                  {/* عدّاد الرسائل: كان شارةً على سطرٍ خاصّ به تحت العنوان، فكلّف
                      كل صفٍّ فيه رسالةٌ واحدة 18px من الارتفاع مقابل رقم. هنا رقمٌ
                      مجرّد بجوار العنوان: يقرأ أسرع، ويُعيد السطر الثاني إلى مَن
                      يستحقّه — شارة عمليةٍ تعمل أو حالة ورشة. */}
                  {sessionView.messageCount > 0 && (
                    <span
                      className={cn(
                        'flex-shrink-0 text-[11px] tabular-nums',
                        isClosed ? 'text-muted-foreground/60' : hasSelectedSurface ? 'text-[color:var(--project-foreground,hsl(var(--foreground)))]' : 'text-[color:var(--project-muted-foreground,hsl(var(--muted-foreground)/0.8))]',
                      )}
                      title={t('sessions.messageCount', {
                        count: sessionView.messageCount,
                        defaultValue: '{{count}} messages',
                      })}
                    >
                      {sessionView.messageCount}
                    </span>
                  )}
                  {/* مؤشّر النهاية: العمر. مخصَّص للفأرة فقط — على اللمس
                      تشغل أزرار الأفعال المطلقة هذه المنطقة، فلا ازدحام.
                      يذوب بالتحويم ليُخلي مكان زرّ الإغلاق. */}
                  {rowParticipants.length === 0 && (
                    <span
                      className={cn(
                        'ms-auto flex h-4 w-8 flex-shrink-0 items-center justify-end transition-opacity duration-200 [@media(hover:none)]:hidden',
                        isEditing ? 'opacity-0' : '[@media(hover:hover)]:group-hover:opacity-0',
                      )}
                      aria-hidden="true"
                    >
                      {compactSessionAge && (
                        <span
                          className={cn(
                            'text-[11px]',
                            isClosed ? 'text-muted-foreground/70' : hasSelectedSurface ? 'text-[color:var(--project-foreground,hsl(var(--foreground)))]' : 'text-[color:var(--project-muted-foreground,hsl(var(--muted-foreground)))]',
                          )}
                        >
                          {compactSessionAge}
                        </span>
                      )}
                    </span>
                  )}
                </div>
                {messageSnippet && (
                  <p
                    dir="auto"
                    className={cn(
                      'mt-0.5 truncate text-[11px]',
                      isClosed ? 'text-muted-foreground/70' : hasSelectedSurface ? 'text-[color:var(--project-foreground,hsl(var(--foreground)))]' : 'text-[color:var(--project-muted-foreground,hsl(var(--muted-foreground)))]',
                    )}
                  >
                    {messageSnippet}
                  </p>
                )}
              </div>
              {/* سكة النهاية: التثبيت (w-7) ثم فتحة المشاركين بعرض محتواها (w-0 بلا مشاركين)،
                  ملاصقتان لحافة النهاية. التحويم على الصور وحده يُظهر طبقة تغطّي التثبيت
                  بزرّ الإغلاق والصور بـ⋮؛ الطبقة مطلقة فلا يقفز العنوان ولا يتحرّك التثبيت.
                  pointer-events: sidebar-project-session-content يحمل pointer-events-none
                  لإتاحة النقر على رابط الجلسة المطلق؛ نعوّض بـpointer-events-auto هنا. */}
              <div
                data-session-end-rail
                aria-hidden={isBulkSessionSelection || undefined}
                className="pointer-events-auto relative z-20 flex h-7 w-auto flex-none items-center justify-end"
              >
                {/* التثبيت: دائم الظهور، لا يتحرّك، لا طبقة تغطيه */}
                {!isBulkSessionSelection && (
                  <div data-session-pin-slot className="h-7 w-7 flex-none">
                    <button
                      type="button"
                      aria-pressed={isStarred}
                      aria-label={`${isStarred
                        ? t('tooltips.unfavoriteSession', { defaultValue: 'Unpin' })
                        : t('tooltips.favoriteSession', { defaultValue: 'Pin' })
                      }: ${sessionView.sessionName}`}
                      className={cn(
                        'pointer-events-auto flex h-7 w-7 items-center justify-center rounded',
                        'transition-colors focus-visible:outline-none focus-visible:ring-2',
                        'focus-visible:ring-[var(--project-accent,hsl(var(--ring)))]',
                        isStarred
                          ? 'text-[color:var(--project-accent,hsl(var(--primary)))]'
                            + ' hover:text-[color:var(--project-accent,hsl(var(--primary)/0.8))]'
                          : 'text-muted-foreground/25 hover:text-muted-foreground/60',
                      )}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={toggleStarFromTitle}
                    >
                      <Bookmark className="h-3.5 w-3.5 fill-current" strokeWidth={0} aria-hidden="true" />
                    </button>
                  </div>
                )}
                {/* فتحة المشاركين/الأفعال: عرض ثابت 48px (2×24px) — نفس العرض في
                    حالتَي السكون والتحويم فلا يقفز التثبيت ولا العنوان.
                    group/avatar-slot يُؤطِّر التحويم داخل الفتحة فقط لا على الـrail كله.
                    ref={endRailRef} يُحدِّد نطاق إخفاء طبقة اللمس عند اللمس الخارجي. */}
                {!isBulkSessionSelection && !isEditing && (
                  <div
                    ref={endRailRef}
                    data-session-avatar-slot
                    className={cn(
                      // الفتحة تتقلّص إلى حجم محتواها:
                      // – حين توجد صور: w-auto مع حدّ أدنى min-w-6 (24px) يكفي زرّ ⋮ داخل الطبقة.
                      // – بلا مشاركين: w-0 فيلتصق التثبيت بالحافة ولا يبقى فراغ.
                      // overflow-visible يُبقي الطبقة المطلقة مرئية حتى من w-0.
                      // flex+items-center: الفتحة حاوية مرنة فتتوسّط الصور بلا غلاف مطلق إضافي.
                      'relative flex h-7 flex-none items-center overflow-visible',
                      rowParticipants.length > 0
                        ? 'w-auto min-w-6 group/avatar-slot'
                        : 'w-0',
                    )}
                    onTouchStart={(event) => {
                      if (isBulkSessionSelection || isEditing) return;
                      if (touchActionsVisible) return;
                      event.stopPropagation();
                      touchRevealedRef.current = true;
                      setTouchActionsVisible(true);
                    }}
                    onClickCapture={(event) => {
                      if (!touchRevealedRef.current) return;
                      touchRevealedRef.current = false;
                      event.stopPropagation();
                      event.preventDefault();
                    }}
                  >
                    {/* رصّة المشاركين في حالة السكون — في التدفّق الطبيعي (لا غلاف مطلق).
                        عرض الفتحة = عرض الرصّة الطبيعي ≤ max-w-12.
                        الغلاف المطلق inset-0 أُزيل: الفتحة الآن flex+items-center تُحقّق المحاذاة. */}
                    {!touchActionsVisible && rowParticipants.length > 0 && (
                      <ParticipantAvatarStack
                        participants={rowParticipants}
                        size="xs"
                        max={3}
                        locale={i18n.language}
                        t={t}
                        className="flex max-w-12"
                      />
                    )}
                    {/* طبقة الأفعال: تمتدّ إلى خانة التثبيت عبر -start-7 (= inset-inline-start: -1.75rem).
                        الزرّ الأوّل (الإغلاق) يشغل w-7 = 28px فيتوسّط خانة التثبيت بالضبط.
                        الزرّ الثاني (⋮) يلي مباشرةً عند بداية خانة الصور — justify-start يرصّهما
                        من الطرف الداخلي (inline-start) دون فجوة.
                        الطبقة تبقى ابنة data-session-avatar-slot في شجرة DOM (لا تلمس pin-slot
                        قط) ولا تتحرّك لا التثبيت ولا الصور خارجها. */}
                    <div
                      data-session-actions-overlay
                      className={cn(
                        'pointer-events-auto absolute inset-y-0 end-0 -start-7 z-20 hidden',
                        'items-center justify-start bg-background/90',
                        '[@media(hover:hover)]:group-hover/avatar-slot:flex',
                        '[@media(hover:hover)]:group-focus-within/avatar-slot:flex',
                        keyboardActionsVisible && 'flex',
                        touchActionsVisible && 'flex',
                      )}
                    >
                      {/* الإغلاق: w-7 flex-none — يتوسّط خانة التثبيت (28px) تماماً */}
                      <button
                        type="button"
                        disabled={conversationClosed.pending}
                        aria-pressed={isClosed}
                        aria-label={closeToggleLabel}
                        title={closeToggleLabel}
                        className={cn(
                          'flex h-7 w-7 flex-none items-center justify-center rounded',
                          'text-[color:var(--project-muted-foreground,hsl(var(--muted-foreground)))]',
                          'transition-[color,transform] hover:scale-105',
                          'hover:text-[color:var(--project-foreground,hsl(var(--foreground)))]',
                          'disabled:opacity-60',
                        )}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setTouchActionsVisible(false);
                          conversationClosed.toggle();
                        }}
                      >
                        {isClosed ? <CircleDashed className="h-3 w-3" /> : <CircleCheck className="h-3 w-3" />}
                      </button>
                      {/* ⋮: flex-none — يقع عند بداية خانة الصور، ملاصقاً للتثبيت */}
                      <button
                        type="button"
                        data-session-menu-trigger
                        aria-label={t('tooltips.sessionContextMenu')}
                        title={t('tooltips.sessionContextMenu')}
                        className={cn(
                          'flex h-6 w-6 flex-none items-center justify-center rounded',
                          'text-[color:var(--project-muted-foreground,hsl(var(--muted-foreground)))]',
                          'transition-colors',
                          'hover:text-[color:var(--project-foreground,hsl(var(--foreground)))]',
                        )}
                        onClick={(event) => { setTouchActionsVisible(false); openMenuFromButton(event); }}
                      >
                        <MoreVertical className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>


    </div>

    {/* B-371: القائمة تُسقَط في `document.body` لا في مكانها من شجرة الشريط.
        جذر الشريط يحمل `backdrop-blur-sm`، وأي `backdrop-filter` يُنشئ containing
        block لكل `position: fixed` بداخله — فتصير `left` منسوبة إلى صندوق الشريط
        لا إلى نافذة العرض. في LTR حافة الشريط اليسرى = 0 فيبدو الأمر سليماً
        بالمصادفة؛ وفي RTL الشريط على اليمين فتُزاح القائمة بعرض الشاشة ناقص
        عرض الشريط وتخرج خارج الحافة تماماً — فتبدو كأنها «لا تفتح».
        (نفس نمط البورتال المعتمد أصلاً في SidebarModals وPendingActionsPanel.) */}
    {contextMenu && createPortal(
      <div
        ref={contextMenuRef}
        role="menu"
        aria-label={t('tooltips.sessionContextMenu')}
        // design-ok: إحداثيات المؤشر في نافذة العرض فيزيائية بطبيعتها (clientX/clientY)،
        // ولا مقابل منطقي لها — القائمة تُوضع حيث ضُغط الزرّ لا حيث يبدأ السطر.
        style={{
          position: 'fixed',
          left: contextMenu.x,
          top: contextMenu.y,
          maxHeight: contextMenu.maxHeight,
          zIndex: 9999,
        }}
        className="min-w-[156px] animate-menu-enter overflow-y-auto rounded-lg border border-border bg-popover px-1 py-1 text-popover-foreground shadow-lg"
      >
        <button
          role="menuitem"
          type="button"
          className="flex min-h-7 w-full items-center gap-1 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-8"
          onClick={startSessionBulkSelectionFromMenu}
        >
          <ListChecks className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span className="flex-1 whitespace-nowrap">
            {t('tooltips.selectSession', { defaultValue: 'Select conversation' })}
          </span>
        </button>
        <button
          role="menuitem"
          type="button"
          className="flex min-h-7 w-full items-center gap-1 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-8"
          onClick={openInNewTab}
        >
          <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1">{t('tooltips.openInNewTab')}</span>
        </button>
        <button
          role="menuitem"
          type="button"
          className="flex min-h-7 w-full items-center gap-1 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-8"
          onClick={copySessionLink}
        >
          <Copy className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1">{t('tooltips.copyLink')}</span>
        </button>
        <button
          role="menuitem"
          type="button"
          className="flex min-h-7 w-full items-center gap-1 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-8"
          onClick={copySessionId}
        >
          <Hash className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span className="flex-1">{t('tooltips.copySessionId', { defaultValue: 'Copy session ID' })}</span>
        </button>
        {sessionIdCopyFailed && (
          <p role="alert" className="max-w-56 px-2 py-1 text-xs text-destructive">
            {t('tooltips.copySessionIdFailed', { defaultValue: 'Could not copy the session ID. Allow clipboard access and try again.' })}
          </p>
        )}
        {/* إعادة التسمية: تفتح لوحة التحرير على الصفّ نفسه (لم يعد لها زرّ ظاهر
            عند التحويم — الصفّ نظيف والأفعال كلّها هنا). */}
        <button
          role="menuitem"
          type="button"
          className="flex min-h-7 w-full items-center gap-1 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-8"
          onClick={startRenameSession}
        >
          <Edit2 className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1 whitespace-nowrap">
            {t('tooltips.renameSession', { defaultValue: 'Rename' })}
          </span>
        </button>
        {/* لا يظهر إلا إن كان له أثر: نتيجة مقروءة عالمياً. بلا ذلك
            لا شيء يُعاد، وفعلٌ صامت يربك أكثر ممّا يفيد (قرار المالك). */}
        {canMarkUnread && (
          <button
            role="menuitem"
            type="button"
            className="flex min-h-7 w-full items-center gap-1 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-8"
            onClick={markUnreadFromMenu}
          >
            <MailOpen className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="flex-1 whitespace-nowrap">
              {t('tooltips.markUnread', { defaultValue: 'Mark as unread' })}
            </span>
          </button>
        )}
        <button
          role="menuitem"
          type="button"
          aria-pressed={isStarred}
          className="flex min-h-7 w-full items-center gap-1 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-8"
          onClick={toggleStarFromMenu}
        >
          <Bookmark
            className={cn('h-3.5 w-3.5 flex-shrink-0', isStarred && 'fill-current')}
            aria-hidden="true"
          />
          <span className="flex-1 whitespace-nowrap">
            {isStarred
              ? t('tooltips.unfavoriteSession', { defaultValue: 'Unpin' })
              : t('tooltips.favoriteSession', { defaultValue: 'Pin' })}
          </span>
        </button>
        {/* دائرة مكتملة/متقطّعة لا سهم اتجاه: الإغلاق فعل حالة، فلا يُعكس في RTL.
            (كانت أيقونة أرشيف قبل B-332، ثم صار للأرشفة بندها الخاص أدناه فلزم
            الفصل البصري بينهما — والدائرة المكتملة هي نفسها علامة الصفّ المغلق.) */}
        <button
          role="menuitem"
          type="button"
          disabled={conversationClosed.pending}
          aria-pressed={isClosed}
          className="flex min-h-7 w-full items-center gap-1 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-60 [@media(pointer:coarse)]:min-h-8"
          onClick={toggleConversationClosed}
        >
          {isClosed ? (
            <CircleDashed className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <CircleCheck className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          {/* سطر واحد دائماً: الكلمة قصيرة والقائمة تتمدّد للنص، وnowrap يمنع لفّ
              أي ترجمة أطول إلى سطرين. */}
          <span className="flex-1 whitespace-nowrap">
            {isClosed
              ? t('tooltips.reopenConversation', { defaultValue: 'Reopen' })
              : t('tooltips.closeConversation', { defaultValue: 'Close' })}
          </span>
        </button>
        {/* أرشفة مباشرة: تُخفي المحادثة من القائمة النشطة وتبقى قابلة للاستعادة
            من عارض الأرشيف — لا حذف. */}
        <button
          role="menuitem"
          type="button"
          className="flex min-h-7 w-full items-center gap-1 rounded-md px-2 py-1 text-start text-xs transition-colors hover:bg-accent focus:bg-accent focus:outline-none [@media(pointer:coarse)]:min-h-8"
          onClick={archiveSession}
        >
          <Archive className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1 whitespace-nowrap">
            {t('tooltips.archiveSession', { defaultValue: 'Archive' })}
          </span>
        </button>
        <div role="separator" className="mx-1 my-0.5 border-t border-border" />
        {/* الحذف آخر بند وبلونه: فعل لا رجعة فيه، ونافذة التأكيد خلفه. جلسات
            Cursor لا تُحذف من هنا (كما كان في عنقود الصفّ). */}
        {!sessionView.isCursorSession && (
          <button
            role="menuitem"
            type="button"
            className="flex min-h-7 w-full items-center gap-1 rounded-md px-2 py-1 text-start text-xs text-red-600 transition-colors hover:bg-red-50 focus:bg-red-50 focus:outline-none dark:text-red-400 dark:hover:bg-red-900/20 dark:focus:bg-red-900/20 [@media(pointer:coarse)]:min-h-8"
            onClick={deleteSessionFromMenu}
            title={t('tooltips.deleteSessionOptions', 'Archive or permanently delete this session')}
          >
            <Trash2 className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="flex-1 whitespace-nowrap">
              {t('tooltips.deleteSessionShort', { defaultValue: 'Delete' })}
            </span>
          </button>
        )}
      </div>,
      document.body,
    )}
    </>
  );
}
