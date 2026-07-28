import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { MessagesSquare } from 'lucide-react';

import { cn } from '../../lib/utils';
import type { Project } from '../../types/app';
import type { ActiveConversations } from './usePresence';

/**
 * Shared interactive "active conversations" indicator
 * (extracted from PresenceCountCollapsed so the collapsed rail and the expanded
 * PresencePanel render the *same* clickable popover instead of two divergent
 * widgets — one interactive, one a read-only Tooltip).
 *
 * It renders a trigger (icon + total count) plus a popover listing the visible
 * projects, each a button that selects the project (and, in the collapsed rail,
 * expands the sidebar). Keyboard users tab to the trigger, open with
 * Enter/Space/hover/focus, and Escape closes and restores focus.
 *
 * Firefox/Zen safety (cf. upstream bug 1392476): the popover is rendered through
 * createPortal into document.body with `position: fixed` coordinates computed
 * from getBoundingClientRect() — never a `position:absolute` child of the
 * trigger <button>.
 *
 * `placement` controls where the popover opens relative to the trigger rect:
 *   - 'inline-end': opens to the inline-end side, vertically centred — used by
 *     the narrow collapsed rail (the rail sits at the inline-start edge so there
 *     is always room on this side). RTL-correct because it is relative to the
 *     trigger rect.
 *   - 'bottom': opens directly below the trigger, aligned to its inline-start
 *     edge — used by the wider expanded PresencePanel row.
 *
 * RTL: logical spacing only; positions are computed from the trigger rect so
 * they mirror correctly under RTL.
 */

export type ActiveConversationsMenuPlacement = 'inline-end' | 'bottom';

type ActiveConversationsMenuProps = {
  /** Server-authoritative active-conversations breakdown (null = no snapshot yet → renders nothing). */
  activeConversations: ActiveConversations | null;
  /** Sidebar project list — maps running-conversation project paths to names. */
  projects?: Project[];
  /** Select a project (and surface it in the main view). */
  onProjectSelect?: (project: Project) => void;
  /** Optional: expand the collapsed sidebar so the selected project is visible. */
  onExpand?: () => void;
  /** Where the popover opens relative to the trigger. */
  placement: ActiveConversationsMenuPlacement;
};

/** Last path segment of a project path, for a compact fallback label. */
function lastSegment(projectPath: string): string {
  const trimmed = projectPath.replace(/[/\\]+$/, '');
  const segments = trimmed.split(/[/\\]+/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

export function ActiveConversationsMenu({
  activeConversations,
  projects = [],
  onProjectSelect,
  onExpand,
  placement,
}: ActiveConversationsMenuProps) {
  const { t } = useTranslation('presence');

  const [isOpen, setIsOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const popoverId = useId();

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const open = useCallback(() => {
    clearCloseTimer();
    setIsOpen(true);
  }, [clearCloseTimer]);

  const close = useCallback(() => {
    clearCloseTimer();
    setIsOpen(false);
  }, [clearCloseTimer]);

  // Hover-out grace so the cursor can travel from trigger to popover.
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => setIsOpen(false), 120);
  }, [clearCloseTimer]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spacing = 8;
    if (placement === 'bottom') {
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Measure the popover's rendered dimensions.  The portal renders first
      // with the fallback off-screen style (opacity:0, top/left -9999px), so by
      // the time this RAF callback fires the element has real offsetWidth/Height.
      const popover = popoverRef.current;
      const popoverW = popover?.offsetWidth ?? 288;  // 18rem fallback
      const popoverH = popover?.offsetHeight ?? 200; // conservative fallback

      // Vertical: open below by default; flip above when there is not enough
      // space below AND there is room above.
      let top: number;
      if (rect.bottom + spacing + popoverH > vh - spacing) {
        const topIfAbove = rect.top - spacing - popoverH;
        top = topIfAbove >= spacing
          ? topIfAbove
          : Math.max(spacing, vh - popoverH - spacing); // best-effort if neither fits
      } else {
        top = rect.bottom + spacing;
      }

      // Horizontal clamping: getBoundingClientRect() is always in physical
      // viewport coords, so we clamp using the physical viewport width.  The
      // logical insetInlineStart is set to the clamped physical-left value,
      // which keeps the popover anchored below the trigger in LTR; in RTL the
      // sidebar is on the same side so rect.left stays in the visible area.
      const left = Math.max(spacing, Math.min(rect.left, vw - popoverW - spacing));

      setPopoverStyle({
        position: 'fixed',
        top,
        insetInlineStart: left,
        zIndex: 9999,
        maxWidth: `min(18rem, calc(100vw - ${spacing * 2}px))`,
      });
      return;
    }
    // 'inline-end': open toward the inline-end of the rail, vertically centred.
    setPopoverStyle({
      position: 'fixed',
      top: rect.top + rect.height / 2,
      insetInlineStart: rect.right + spacing,
      transform: 'translateY(-50%)',
      zIndex: 9999,
      maxWidth: 'min(18rem, calc(100vw - 4rem))',
    });
  }, [placement]);

  // Recompute position while open and track viewport changes.
  useEffect(() => {
    if (!isOpen) {
      setPopoverStyle(null);
      return;
    }
    const rafId = window.requestAnimationFrame(updatePosition);
    const onViewportChange = () => updatePosition();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [isOpen, updatePosition]);

  // Close on outside pointer and on Escape.
  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node) {
        if (triggerRef.current?.contains(target)) return;
        if (popoverRef.current?.contains(target)) return;
      }
      setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  // Hide until the first presence snapshot arrives (null = not yet received).
  if (activeConversations === null) return null;

  const count = activeConversations.total;

  const collapsed = placement === 'inline-end';

  const tooltipLabel = t('collapsedRailTooltip', {
    count,
    defaultValue: '{{count}} open conversations',
  });
  const headingLabel = t('activeConversations', {
    defaultValue: 'Active conversations',
  });
  // Compact "{{count}} active" label used by the wider (bottom) trigger.
  const countLabel = t('activeConversationsCount', {
    count,
    defaultValue: '{{count}} active',
  });

  /** Resolve a projectPath to { name, project } using the sidebar list. */
  const resolveProject = (projectPath: string): { name: string; project: Project | null } => {
    const project =
      projects.find(
        (p) =>
          p.fullPath === projectPath ||
          (p as unknown as Record<string, unknown>).path === projectPath,
      ) ?? null;
    return {
      name: project ? project.displayName : lastSegment(projectPath),
      project,
    };
  };

  const handleSelect = (project: Project | null) => {
    if (project && onProjectSelect) {
      onProjectSelect(project);
      onExpand?.();
    }
    close();
  };

  const hasProjects = activeConversations.byProject.length > 0;
  const interactive = hasProjects || activeConversations.hiddenCount > 0;

  // ARIA label for the wider (bottom) trigger mirrors the old read-only span:
  // names each visible project, then a «N elsewhere» line when hiddenCount > 0.
  const bottomAriaLabel = hasProjects
    ? t('activeConversationsAriaLabel', {
        count: activeConversations.total,
        projects: [
          ...activeConversations.byProject.map(
            ({ projectPath, count: projectCount }) =>
              `${resolveProject(projectPath).name} ${projectCount}`,
          ),
          ...(activeConversations.hiddenCount > 0
            ? [
                t('activeConversationsElsewhere', {
                  count: activeConversations.hiddenCount,
                  defaultValue: '{{count}} elsewhere',
                }),
              ]
            : []),
        ].join(', '),
        defaultValue: 'Active conversations: {{count}} across {{projects}}',
      })
    : `${headingLabel}: ${activeConversations.total}`;

  const sharedHandlers = {
    onClick: () => {
      if (!interactive) return;
      setIsOpen((prev) => !prev);
    },
    onMouseEnter: interactive ? open : undefined,
    onMouseLeave: interactive ? scheduleClose : undefined,
    onFocus: interactive ? open : undefined,
    onBlur: interactive ? scheduleClose : undefined,
    'aria-haspopup': interactive ? ('dialog' as const) : undefined,
    'aria-expanded': interactive ? isOpen : undefined,
    'aria-controls': interactive && isOpen ? popoverId : undefined,
  };

  return (
    <>
      {collapsed ? (
        <button
          ref={triggerRef}
          type="button"
          className={cn(
            'flex flex-col items-center gap-0.5 rounded-lg py-1 text-muted-foreground transition-colors',
            'hover:bg-accent/80 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
          title={tooltipLabel}
          aria-label={tooltipLabel}
          {...sharedHandlers}
        >
          <MessagesSquare aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="text-[9px] tabular-nums leading-none">{count}</span>
        </button>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className={cn(
            'inline-flex flex-shrink-0 items-center gap-0.5 rounded text-[10px] tabular-nums text-muted-foreground/70 transition-colors',
            'hover:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            interactive ? 'cursor-pointer' : 'cursor-default',
          )}
          aria-label={bottomAriaLabel}
          {...sharedHandlers}
        >
          <MessagesSquare className="h-2.5 w-2.5 flex-shrink-0 opacity-60" aria-hidden="true" />
          <span>{countLabel}</span>
        </button>
      )}

      {interactive && isOpen && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            role="group"
            aria-label={headingLabel}
            dir="auto"
            style={
              popoverStyle ?? {
                position: 'fixed',
                top: '-9999px',
                insetInlineStart: '-9999px',
                opacity: 0,
              }
            }
            className={cn(
              'min-w-[12rem] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg',
              'animate-in fade-in-0 zoom-in-95 duration-150',
            )}
            onMouseEnter={open}
            onMouseLeave={scheduleClose}
          >
            <div className="border-b border-border/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {headingLabel}
            </div>
            <ul className="max-h-[60vh] overflow-y-auto py-1">
              {activeConversations.byProject.map(({ projectPath, count: projectCount }) => {
                const { name, project } = resolveProject(projectPath);
                const selectable = project !== null && Boolean(onProjectSelect);
                return (
                  <li key={projectPath}>
                    <button
                      type="button"
                      disabled={!selectable}
                      onClick={() => handleSelect(project)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-start text-xs',
                        'focus-visible:outline-none focus-visible:bg-accent',
                        selectable
                          ? 'cursor-pointer hover:bg-accent hover:text-accent-foreground'
                          : 'cursor-default text-muted-foreground',
                      )}
                    >
                      <span className="truncate">{name}</span>
                      <span className="flex-shrink-0 tabular-nums opacity-60">
                        {t('activeConversationsProjectCount', {
                          count: projectCount,
                          defaultValue: '— {{count}}',
                        })}
                      </span>
                    </button>
                  </li>
                );
              })}
              {activeConversations.hiddenCount > 0 && (
                <li
                  role="presentation"
                  className="px-3 py-1.5 text-xs italic text-muted-foreground/70"
                >
                  {t('activeConversationsElsewhere', {
                    count: activeConversations.hiddenCount,
                    defaultValue: '{{count}} elsewhere',
                  })}
                </li>
              )}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
