import { CircleCheck, CircleSlash } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';

type SidebarClosedFilterToggleProps = {
  hideClosed: boolean;
  onHideClosedChange: (hideClosed: boolean) => void;
  /** Sizing of the square button — matches whichever row hosts it. */
  sizeClass: string;
  /** Icon size; the presence strip is denser than the search row. */
  iconClass?: string;
  t: TFunction;
};

/**
 * Hide/show closed conversations in the project lists.
 *
 * It travels with SidebarArchiveToggle and for the same reason: a filter that
 * empties part of the sidebar must keep its own way back on screen, so it lives
 * wherever that toggle lives (search row when visible, presence strip
 * otherwise) rather than only inside the search row — which the user can hide.
 *
 * The icon is the closed row's own `CircleCheck`, struck out while the filter is
 * hiding: the button says which rows it acts on, and the state is the pressed /
 * unpressed pair, not two unrelated glyphs. Circles, not an arrow or a chevron,
 * so nothing needs mirroring in RTL.
 */
export default function SidebarClosedFilterToggle({
  hideClosed,
  onHideClosedChange,
  sizeClass,
  iconClass = 'h-3.5 w-3.5',
  t,
}: SidebarClosedFilterToggleProps) {
  const label = hideClosed
    ? t('search.showClosedTooltip', 'Show closed conversations')
    : t('search.hideClosedTooltip', 'Hide closed conversations');

  return (
    <Tooltip content={label} position="top">
      <button
        type="button"
        onClick={() => onHideClosedChange(!hideClosed)}
        aria-pressed={hideClosed}
        aria-label={label}
        title={label}
        className={cn(
          'flex flex-shrink-0 items-center justify-center rounded-xl border border-transparent text-xs font-medium transition-all',
          sizeClass,
          hideClosed
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        {hideClosed ? <CircleSlash className={iconClass} /> : <CircleCheck className={iconClass} />}
      </button>
    </Tooltip>
  );
}
