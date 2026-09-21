import { Archive, CheckSquare, Lock, MoreHorizontal, RotateCcw, Square, Trash2, Unlock, X } from 'lucide-react';
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
  const closeButtonRef = useRef<HTMLButtonElement>(null);
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
      disabled={disabled}
      title={!isAvailable ? unavailableReason : undefined}
      onClick={() => onAction(action)}
      className={cn(
        'bulk-more-action flex min-h-11 items-center justify-start gap-1 rounded-md px-1.5 text-[11px] font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8 md:px-1',
        inMoreDialog && 'bulk-more-dialog-button',
        destructive ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-accent',
      )}
    >{icon}{label}</button>
  );

  const utilityButton = (label: string, onClick: () => void, icon: ReactNode, disabledValue = false) => (
    <button type="button" disabled={disabledValue} onClick={onClick} className="bulk-more-dialog-button bulk-more-action flex min-h-11 items-center justify-start gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8 md:px-1">{icon}{label}</button>
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
    closeButtonRef.current?.focus();
    const keepFocusInDialog = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMoreOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keepFocusInDialog);
    return () => document.removeEventListener('keydown', keepFocusInDialog);
  }, [moreOpen]);

  return (
    <div className="sticky top-0 z-20 min-h-11 bg-background px-2 md:h-9 md:min-h-9" aria-label={t('bulk.actions', 'Bulk actions')}>
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
          onClick={() => setMoreOpen(true)}
          className="bulk-more-trigger flex min-h-11 min-w-11 items-center justify-center rounded-md text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:size-8 md:min-h-8 md:min-w-8"
          aria-label={t('bulk.moreActions', 'More actions')}
          aria-expanded={moreOpen}
        ><MoreHorizontal className="h-4 w-4" /></button>
      </div>
      {moreOpen && (
        <div ref={dialogRef} className="bulk-more-dialog fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background p-1 shadow-2xl md:absolute md:inset-x-auto md:end-0 md:top-full md:mt-1 md:w-fit md:max-w-[200px] md:rounded-lg md:border" role="dialog" aria-modal="true" aria-label={t('bulk.moreActions', 'More actions')}>
          <div className="bulk-more-dialog-header flex h-9 items-center justify-between px-1 md:h-8 md:px-0.5">
            <h2 className="text-xs font-medium">{t('bulk.moreActions', 'More actions')}</h2>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={() => setMoreOpen(false)}
              className="bulk-more-close flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:size-8"
              aria-label={t('bulk.closeMenu', 'Close menu')}
            ><X className="h-4 w-4" /></button>
          </div>
          <div className="bulk-more-dialog-grid grid grid-cols-2 gap-0.5 md:w-[154px]">
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
