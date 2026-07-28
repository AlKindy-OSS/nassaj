/**
 * WikiSidebar.tsx — Wiki navigation drawer.
 *
 * Responsibilities:
 *  - Render the sidebar nav (desktop column + mobile fixed drawer).
 *  - FocusTrap on mobile when the drawer is open (modal behaviour).
 *  - Backdrop on mobile.
 *  - Logo, search field, page list, al-Kindy footer.
 *
 * B-122 invariants (DO NOT remove without updating regression test):
 *  - FocusTrap has fallbackFocus: '#wiki-sidebar'
 *  - <nav id="wiki-sidebar" tabIndex={-1}>
 *  These protect against the "0 tabbable nodes" crash on mobile open.
 */

import { useTranslation } from 'react-i18next';
import FocusTrap from 'focus-trap-react';
import { ChevronRight } from 'lucide-react';
import WikiSearchField from '../WikiSearchField';
import { PAGES } from '../wikiContent';
import type { SearchMatch } from '../useWikiSearch';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type WikiSidebarProps = {
  isDesktop: boolean;
  sidebarOpen: boolean;
  onClose: () => void;
  onDeactivate: () => void;
  activeFile: string;
  onSelectPage: (file: string) => void;
  /** Search state (passed from WikiPanel) */
  query: string;
  onQueryChange: (q: string) => void;
  onClearQuery: () => void;
  results: SearchMatch[];
  isSearching: boolean;
  onSelectResult: (file: string, matchedTerm?: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
  sidebarToggleRef: React.RefObject<HTMLButtonElement | null>;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WikiSidebar({
  isDesktop,
  sidebarOpen,
  onClose,
  onDeactivate,
  activeFile,
  onSelectPage,
  query,
  onQueryChange,
  onClearQuery,
  results,
  isSearching,
  onSelectResult,
  searchInputRef,
  sidebarToggleRef,
}: WikiSidebarProps) {
  const { t } = useTranslation();

  return (
    <>
      {/* ── Mobile backdrop ─────────────────────────────────────────────── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          aria-hidden="true"
          onClick={onClose}
        />
      )}

      {/* ── Sidebar nav ─────────────────────────────────────────────────────
          Desktop (md+): regular flex column — pushes main content.
          Mobile (<md):  fixed drawer from inline-end (right in RTL), overlaid.
          FocusTrap active only on mobile when drawer is open (modal behaviour).
      */}
      <FocusTrap
        active={!isDesktop && sidebarOpen}
        focusTrapOptions={{
          allowOutsideClick: true,
          returnFocusOnDeactivate: false, // نعيد التركيز يدوياً لزر ☰
          fallbackFocus: '#wiki-sidebar', // B-122: يحمي من 0 tabbable nodes قبل reflow
          onDeactivate: () => {
            onDeactivate();
            requestAnimationFrame(() => sidebarToggleRef.current?.focus());
          },
        }}
      >
        <nav
          id="wiki-sidebar"
          tabIndex={-1} /* B-122: هدف fallbackFocus يجب أن يكون قابلاً للتركيز */
          aria-label={t('wiki.sidebarAriaLabel', 'فهرس الويكي')}
          aria-modal={!isDesktop && sidebarOpen ? true : undefined}
          className={[
            'overflow-y-auto border-e border-border/60 transition-all duration-200',
            'bg-background md:bg-muted/20',
            // Desktop: normal flex-shrink-0 column, width controlled by sidebarOpen
            'md:relative md:z-auto md:flex-shrink-0',
            sidebarOpen ? 'md:w-56 lg:w-64' : 'md:w-0 md:overflow-hidden',
            // Mobile: fixed drawer from inline-end (= right in RTL).
            // The wiki root has dir="rtl" so logical end-0 resolves correctly here.
            'fixed inset-y-0 end-0 z-40 w-[min(280px,85vw)]',
            'md:inset-y-auto md:end-auto md:w-auto md:transform-none',
          ].join(' ')}
          data-wiki-drawer={sidebarOpen ? 'open' : 'closed'}
        >
          {/* ── Logo ── */}
          <div className="flex items-center px-4 pb-2 pt-3">
            <img
              src="/nassaj-logo-on-light.svg"
              alt="نسّاج"
              className="h-7 w-auto dark:hidden md:h-8"
            />
            <img
              src="/nassaj-logo-on-dark.svg"
              alt="نسّاج"
              className="hidden h-7 w-auto dark:block md:h-8"
            />
          </div>

          {/* ── Search ── */}
          <WikiSearchField
            query={query}
            onQueryChange={onQueryChange}
            onClear={onClearQuery}
            results={results}
            isSearching={isSearching}
            onSelectResult={onSelectResult}
            inputRef={searchInputRef}
          />

          {/* ── Page list ── */}
          {!isSearching && (
            <div className="px-2 pb-4">
              <ul role="list" className="space-y-0.5">
                {PAGES.map((page) => {
                  const isActive = page.file === activeFile;
                  return (
                    <li key={page.file}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelectPage(page.file);
                          // On mobile, close the drawer after selecting a page
                          if (!isDesktop) onClose();
                        }}
                        aria-current={isActive ? 'page' : undefined}
                        className={`flex min-h-[44px] w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm transition-colors md:min-h-0 ${
                          isActive
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                        }`}
                      >
                        {isActive && (
                          <ChevronRight
                            className="h-3 w-3 flex-shrink-0 rotate-180"
                            aria-hidden="true"
                          />
                        )}
                        <span className={isActive ? '' : 'ps-5'}>{page.title}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {/* ── Al-Kindy footer ── */}
              <div data-wiki-footer className="mt-4 flex flex-col items-center gap-1 border-t border-border/30 pt-4">
                <span className="text-[10px] text-muted-foreground">علامة من دار الكندي</span>
                <img
                  src="/alkindy-symbol.svg"
                  alt="دار الكندي"
                  className="h-5 w-auto opacity-70"
                />
              </div>
            </div>
          )}
        </nav>
      </FocusTrap>
    </>
  );
}
