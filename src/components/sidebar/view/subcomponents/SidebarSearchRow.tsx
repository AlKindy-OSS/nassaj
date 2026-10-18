import type { ReactNode } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Input } from '../../../../shared/view/ui';
import type { SidebarSearchMode, SidebarSearchScope } from '../../types/types';

import SidebarArchiveToggle from './SidebarArchiveToggle';
import SidebarSearchScopeMenu from './SidebarSearchScopeMenu';

const MOD_KEY =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

type Direction = 'rtl' | 'ltr';

const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR_CHAR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

/** Direction of the first strong character, like `dir="auto"`; null for none. */
function firstStrongDirection(text: string): Direction | null {
  for (const char of text) {
    if (RTL_CHAR.test(char)) return 'rtl';
    if (LTR_CHAR.test(char)) return 'ltr';
  }
  return null;
}

/*
 * Inline paddings of the field, per side of the WRAPPER (which always follows
 * the UI direction): the search icon sits at its start, the clear button (or,
 * when empty, the Ctrl K hint on hover devices) at its end. When typed text
 * flips the field's own direction, its logical start/end swap sides, so the
 * classes swap with them — the reserved space stays under the icon and the
 * controls. Spelled out in full so Tailwind keeps them.
 */
const FIELD_PADDING = {
  empty: { same: 'ps-9 pe-9 [@media(hover:hover)]:pe-14', flipped: 'pe-9 ps-9 [@media(hover:hover)]:ps-14' },
  filled: { same: 'ps-9 pe-12', flipped: 'pe-9 ps-12' },
} as const;

type SidebarSearchRowProps = {
  createProjectControl?: ReactNode;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  searchScope: SidebarSearchScope;
  onSearchScopeChange: (scope: SidebarSearchScope) => void;
  isMessageSearching: boolean;
  t: TFunction;
};

/** Project search controls, kept outside the fixed 90px top rail. */
export default function SidebarSearchRow({
  createProjectControl,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  searchScope,
  onSearchScopeChange,
  isMessageSearching,
  t,
}: SidebarSearchRowProps) {
  const searchPlaceholder = searchMode === 'archived'
    ? t('search.archivedPlaceholder', 'Search archived sessions...')
    : searchScope === 'messages'
      ? t('search.messagesPlaceholder', 'Search inside conversations...')
      : searchScope === 'all'
        ? t('search.allPlaceholder', 'Search titles and conversations...')
        : t('projects.searchPlaceholder');

  // B-1668: an empty field follows the UI direction (RtlProvider stamps it on
  // <html dir>). The shared Input's
  // `dir="auto"` resolved an empty value to LTR inside the RTL sidebar, which
  // clipped the Arabic placeholder from its start and put the padding reserved
  // for the Ctrl K hint on the wrong side, under the hint.
  const uiDirection: Direction = document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';
  const fieldDirection = (searchFilter && firstStrongDirection(searchFilter)) || uiDirection;
  const fieldPadding = FIELD_PADDING[searchFilter ? 'filled' : 'empty'][fieldDirection === uiDirection ? 'same' : 'flipped'];

  return (
    <div className="flex h-11 flex-shrink-0 items-center gap-1.5 px-3" data-sidebar-search-row>
      <div className="relative min-w-0 flex-1" dir={uiDirection}>
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/50 [@media(hover:hover)]:h-3.5 [@media(hover:hover)]:w-3.5" />
        <Input
          type="text"
          dir={fieldDirection}
          placeholder={searchPlaceholder}
          value={searchFilter}
          onChange={(event) => onSearchFilterChange(event.target.value)}
          className={`nav-search-input h-8 text-ellipsis rounded-lg border-0 text-sm transition-all duration-200 placeholder:text-muted-foreground/40 focus-visible:ring-0 focus-visible:ring-offset-0 ${fieldPadding}`}
        />
        {searchFilter ? (
          <span className="absolute end-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {isMessageSearching && (
              <Loader2
                className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                aria-label={t('search.searchingConversations', 'Searching conversations…')}
              />
            )}
            <button
              type="button"
              onClick={onClearSearchFilter}
              aria-label={t('tooltips.clearSearch')}
              className="rounded-md p-1 hover:bg-accent [@media(hover:hover)]:p-0.5"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground [@media(hover:hover)]:h-3 [@media(hover:hover)]:w-3" />
            </button>
          </span>
        ) : (
          <span
            aria-hidden
            title={t('tooltips.openCommandPalette')}
            className="pointer-events-none absolute end-2.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground [@media(hover:hover)]:inline-flex"
          >
            <span dir="ltr" className="inline-flex items-center gap-0.5">
              {MOD_KEY}
              <span>K</span>
            </span>
          </span>
        )}
      </div>
      {searchMode !== 'archived' && (
        <SidebarSearchScopeMenu
          scope={searchScope}
          onScopeChange={onSearchScopeChange}
          sizeClass="h-8 w-8"
          t={t}
        />
      )}
      {createProjectControl}
      <SidebarArchiveToggle
        searchMode={searchMode}
        onSearchModeChange={onSearchModeChange}
        sizeClass="h-8 w-8"
        t={t}
      />
    </div>
  );
}
