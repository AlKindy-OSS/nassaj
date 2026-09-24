import { Archive, CheckSquare, Lock, MoreHorizontal, RotateCcw, Square, Trash2, Unlock } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import type { BulkSelectionKind, BulkProjectAction, BulkSessionAction } from '../../hooks/useSidebarController';

type Props = {
  kind: BulkSelectionKind;
  selectedCount: number;
  visibleCount: number;
  isArchived: boolean;
  isBusy: boolean;
  isAvailable: boolean;
  onSelectVisible: () => void;
  onClear: () => void;
  onAction: (action: BulkProjectAction | BulkSessionAction) => void;
};

/** Compact, sticky toolbar so selection remains actionable while a long list scrolls. */
export default function SidebarBulkToolbar({
  kind, selectedCount, visibleCount, isArchived, isBusy, isAvailable, onSelectVisible, onClear, onAction,
}: Props) {
  const { t } = useTranslation('sidebar');
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const wasMoreOpenRef = useRef(false);
  const disabled = selectedCount === 0 || isBusy || !isAvailable;
  const unavailableReason = t('bulk.unavailable', 'Bulk changes are unavailable until the server update completes.');
  const actionButton = (
    label: string,
    action: BulkProjectAction | BulkSessionAction,
    icon: ReactNode,
    destructive = false,
    inMoreDialog = false,
  ) => (
    <button
      type="button"
      role={inMoreDialog ? 'menuitem' : undefined}
      disabled={disabled}
      title={!isAvailable ? unavailableReason : undefined}
      onClick={() => { onAction(action); if (inMoreDialog) setMoreOpen(false); }}
      className={cn(
        inMoreDialog
          ? 'bulk-more-dialog-button bulk-more-action flex min-h-11 w-full items-center justify-start gap-2 rounded-md px-2 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 md:min-h-9'
          : 'bulk-more-action flex min-h-11 items-center justify-start gap-1 rounded-md px-1.5 text-[11px] font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8 md:px-1',
        destructive ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-accent',
      )}
    >{icon}{label}</button>
  );

  const utilityButton = (label: string, onClick: () => void, icon: ReactNode, disabledValue = false) => (
    <button type="button" role="menuitem" disabled={disabledValue} onClick={() => { onClick(); setMoreOpen(false); }} className="bulk-more-dialog-button bulk-more-action flex min-h-11 w-full items-center justify-start gap-2 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 md:min-h-9">{icon}{label}</button>
  );

  useEffect(() => {
    if (!moreOpen) {
      if (wasMoreOpenRef.current) {
        moreButtonRef.current?.focus();
      }
      wasMoreOpenRef.current = false;
      return undefined;
    }

    wasMoreOpenRef.current = true;
    dialogRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    const keepFocusInDialog = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMoreOpen(false);
        return;
      }

      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        focusable[(activeIndex + step + focusable.length) % focusable.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        (event.key === 'Home' ? first : last).focus();
      } else if (event.key === 'Tab' && event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (event.key === 'Tab' && !event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node
        && !dialogRef.current?.contains(target)
        && !moreButtonRef.current?.contains(target)) setMoreOpen(false);
    };
    document.addEventListener('keydown', keepFocusInDialog);
    document.addEventListener('pointerdown', closeOutside, true);
    return () => {
      document.removeEventListener('keydown', keepFocusInDialog);
      document.removeEventListener('pointerdown', closeOutside, true);
    };
  }, [moreOpen]);

  return (
    <div className="sticky top-0 z-20 min-h-11 bg-background px-2 md:relative md:h-9 md:min-h-9" aria-label={t('bulk.actions', 'Bulk actions')}>
      {/* The presence strip owns the selection count and exit control. This row
          deliberately owns actions only, avoiding duplicate state summaries. */}
      <div className="flex h-full min-h-11 min-w-0 items-center gap-1 md:min-h-9">
        <div className="min-w-0 flex-1">{isArchived
          ? actionButton(t('bulk.restore', 'Restore'), 'restore', <RotateCcw className="h-4 w-4" />)
          : actionButton(t('bulk.archive', 'Archive'), 'archive', <Archive className="h-4 w-4" />)}</div>
        {actionButton(t('bulk.deletePermanently', 'Delete permanently'), 'delete_permanently', <Trash2 className="h-4 w-4" />, true)}
        <button
          ref={moreButtonRef}
          type="button"
          onClick={() => setMoreOpen((open) => !open)}
          className="bulk-more-trigger flex min-h-11 min-w-11 items-center justify-center rounded-md text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:size-8 md:min-h-8 md:min-w-8"
          aria-label={t('bulk.moreActions', 'More actions')}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
        ><MoreHorizontal className="h-4 w-4" /></button>
      </div>
      {moreOpen && (
        <div ref={dialogRef} className="bulk-more-dialog absolute end-0 top-full z-50 mt-1 w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-border/40" role="menu" aria-label={t('bulk.moreActions', 'More actions')}>
          <div className="bulk-more-dialog-grid flex flex-col gap-0.5">
            {utilityButton(t('bulk.selectVisible', 'Select visible'), onSelectVisible, <CheckSquare className="h-4 w-4" />, isBusy || visibleCount === 0)}
            {utilityButton(t('bulk.clear', 'Clear'), onClear, <Square className="h-4 w-4" />, isBusy || selectedCount === 0)}
            {!isArchived && kind === 'sessions' && actionButton(t('bulk.close', 'Close'), 'close', <Lock className="h-4 w-4" />, false, true)}
            {!isArchived && kind === 'sessions' && actionButton(t('bulk.reopen', 'Reopen'), 'reopen', <Unlock className="h-4 w-4" />, false, true)}
          </div>
          {!isAvailable && <p className="mt-1 px-1 text-xs text-muted-foreground">{unavailableReason}</p>}
        </div>
      )}
    </div>
  );
}
