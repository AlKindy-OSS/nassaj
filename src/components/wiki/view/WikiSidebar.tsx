/**
 * WikiSidebar.tsx — grouped wiki navigation.
 *
 * Desktop (md+): an in-flow column that the toolbar toggle collapses to zero.
 * Mobile (<md): a fixed drawer sliding in from the start edge, modal, with a
 * backdrop, a focus trap and its own close button.
 *
 * WIDTH, EDGE AND ROW STATE ARE DRIVEN BY CSS, NOT TAILWIND UTILITIES
 * (see wiki-panel.css).
 *  - Width: the previous version composed `md:w-56` / `md:w-0` conditionally
 *    alongside an unconditional `md:w-auto`. All three are single-class
 *    selectors, so the cascade resolved them by stylesheet order, and Tailwind
 *    emits `w-auto` after the numeric scale. `md:w-auto` therefore won in both
 *    states: on desktop the toolbar button toggled nothing but `overflow`, i.e.
 *    it was a dead control.
 *  - Edge: tailwindcss-rtl compiles `end-0` into BOTH physical edges at once,
 *    which stretched the drawer across the viewport and parked it opposite the
 *    button that opens it. Measured live at 390px.
 *  - Row state: the active and inactive row variants set the same properties,
 *    so as conditional utilities they would resolve by emit order too.
 * All three now live in one CSS rule each, keyed off `data-wiki-drawer` /
 * `aria-current`, with no ordering hazard.
 *
 * THERE IS NO AL-KINDY MARK HERE ANY MORE EITHER. It signed the authorship of
 * the wiki's text, which is a statement about the document, not about the tool
 * that displays it — and it sat at the bottom of a 1014px column in an 852px
 * viewport, so it was never actually seen. It now appears exactly once in the
 * whole panel, in the landing page's footer. The Nassaj logo at the head of
 * this column stays: that is the tool's own identity, a different mark saying a
 * different thing.
 *
 * THERE IS NO SEARCH FIELD HERE ANY MORE. The panel used to offer three ways
 * into the same dialog — this one, the one on the landing page beside it, and
 * the toolbar icon — labelled with two contradictory shortcuts (`⌘K` here,
 * `Ctrl K` there). The landing-page field and the toolbar icon remain; they do
 * not sit 300px apart.
 *
 * B-122 invariants (DO NOT remove without updating regression test):
 *  - FocusTrap has fallbackFocus: '#wiki-sidebar'
 *  - <nav id="wiki-sidebar" tabIndex={-1}>
 *  These protect against the "0 tabbable nodes" crash on mobile open.
 */

import FocusTrap from 'focus-trap-react';
import { Home, X } from 'lucide-react';

import { useWikiLabels } from '../useWikiLabels';
import { SECTIONS } from '../wikiContent';
import { WIKI_HOME } from '../WikiContext';
import { wikiIcon } from '../wikiIcons';

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
  sidebarToggleRef,
}: WikiSidebarProps) {
  const { t, langAttr } = useWikiLabels();

  // On mobile every navigation dismisses the drawer; on desktop it stays put.
  const go = (file: string) => {
    onSelectPage(file);
    if (!isDesktop) onClose();
  };

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

      <FocusTrap
        active={!isDesktop && sidebarOpen}
        focusTrapOptions={{
          allowOutsideClick: true,
          returnFocusOnDeactivate: false, // نعيد التركيز يدوياً لزر الفهرس
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
          aria-label={t('sidebar.ariaLabel')}
          aria-modal={!isDesktop && sidebarOpen ? true : undefined}
          className={[
            'flex flex-col overflow-y-auto border-e',
            'bg-background md:bg-muted/20',
            // Desktop: in-flow column. Width comes from wiki-panel.css.
            'md:relative md:z-auto md:flex-shrink-0',
            // Mobile: fixed drawer. The pinned edge comes from wiki-panel.css.
            'fixed inset-y-0 z-40 w-[min(300px,85vw)] md:inset-y-auto',
          ].join(' ')}
          data-wiki-drawer={sidebarOpen ? 'open' : 'closed'}
        >
          {/* ── Logo + close ── */}
          <div className="flex flex-shrink-0 items-center gap-2 px-4 pb-3 pt-4">
            <img
              src="/nassaj-logo-on-light.svg"
              alt={t('sidebar.logoAlt')}
              className="h-7 w-auto dark:hidden md:h-8"
            />
            <img
              src="/nassaj-logo-on-dark.svg"
              alt={t('sidebar.logoAlt')}
              className="hidden h-7 w-auto dark:block md:h-8"
            />
            {/* Mobile only: the drawer is modal, and until now the only ways out
                of it were Escape, the backdrop, or picking a page. A modal
                surface needs a visible dismiss control. */}
            <button
              type="button"
              onClick={onClose}
              aria-label={t('sidebar.close')}
              className="ms-auto flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          {/* ── Home ── */}
          <div className="flex flex-shrink-0 flex-col px-2 pb-2">
            <button
              type="button"
              onClick={() => go(WIKI_HOME)}
              aria-current={activeFile === WIKI_HOME ? 'page' : undefined}
              data-wiki-nav-row
              className="nassaj-control"
            >
              <span className="nassaj-control__surface">
                <Home className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span lang={langAttr}>{t('sidebar.home')}</span>
              </span>
            </button>
          </div>

          {/* ── Sections ── */}
          <div className="flex-1 px-2 pb-4">
            {SECTIONS.map((section) => {
              const Icon = wikiIcon(section.icon);
              return (
                <div key={section.id}>
                  {section.title && (
                    <h3 data-wiki-section-title>
                      <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
                      {section.title}
                    </h3>
                  )}
                  <ul role="list">
                    {section.pages.map((page) => (
                      <li key={page.file}>
                        <button
                          type="button"
                          onClick={() => go(page.file)}
                          aria-current={page.file === activeFile ? 'page' : undefined}
                          data-wiki-nav-row
                          className="nassaj-control"
                        >
                          <span className="nassaj-control__surface">
                            <span>{page.title}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </nav>
      </FocusTrap>
    </>
  );
}
