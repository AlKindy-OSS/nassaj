import { Archive } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { SidebarSearchMode } from '../../types/types';

type SidebarArchiveToggleProps = {
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  /** Sizing of the square button — matches whichever row hosts it. */
  sizeClass: string;
  /** Icon size; the presence strip is denser than the search row. */
  iconClass?: string;
  t: TFunction;
};

/**
 * Archive-only toggle (B-332). Extracted from SidebarHeader because it now has
 * two possible homes and must render in EXACTLY ONE of them: beside the search
 * input when the search row is visible, otherwise inside the presence strip —
 * so hiding the search bar never hides the way into the archive.
 */
export default function SidebarArchiveToggle({
  searchMode,
  onSearchModeChange,
  sizeClass,
  iconClass = 'h-3.5 w-3.5',
  t,
}: SidebarArchiveToggleProps) {
  const isArchived = searchMode === 'archived';
  const label = t('search.archiveOnlyTooltip', 'Archive only');

  return (
    <Tooltip content={label} position="top">
      <button
        type="button"
        onClick={() => onSearchModeChange(isArchived ? 'projects' : 'archived')}
        aria-pressed={isArchived}
        aria-label={label}
        title={label}
        className={cn(
          'flex flex-shrink-0 items-center justify-center rounded-xl border border-transparent text-xs font-medium transition-all',
          sizeClass,
          isArchived
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        <Archive className={iconClass} />
      </button>
    </Tooltip>
  );
}
