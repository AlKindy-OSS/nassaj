/**
 * WikiToolbar.tsx — sticky header above the article.
 *
 * Holds the index toggle, a breadcrumb that says where the reader is (section ›
 * page), and the search trigger. The breadcrumb replaces the bare page title:
 * with the index grouped into sections, the section name is what tells someone
 * whether they are in "دليل الواجهة" or in "حلّ المشاكل".
 *
 * ICONS ARE CHOSEN, NOT FLIPPED. The panel's direction is fixed rtl, so a
 * `rtl:-scale-x-100` on a permanently-RTL surface is a mirror that is always
 * on — it just picks the wrong glyph and then reverses it, and it would silently
 * mirror any internal asymmetry a future version of the icon gains. `PanelRight`
 * is drawn the way this toolbar needs it: the index lives at the start of the
 * reading direction, which in RTL is the right.
 *
 * The breadcrumb separator is the one chevron that must NOT be mirrored: the
 * trail flows right-to-left, so it points left already. Adding `rtl:rotate-180`
 * here would break it.
 */

import { PanelRight, Search, ChevronLeft, ArrowRight } from 'lucide-react';

import { useWikiLabels } from '../useWikiLabels';

type Props = {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Mutable, not RefObject: this component is the one that *attaches* the ref. */
  sidebarToggleRef: React.MutableRefObject<HTMLButtonElement | null>;
  onOpenSearch: () => void;
  onGoHome: () => void;
  /** Section title — omitted on the landing page. */
  sectionTitle?: string;
  /** Page title — omitted on the landing page. */
  pageTitle?: string;
  /**
   * True on the standalone `/wiki` route, false when the panel is a tab inside
   * the app.
   *
   * It controls the only way back. As a tab, the app's own chrome surrounds the
   * panel and the reader can just switch tabs. On `/wiki` there is no chrome at
   * all — the panel fills the viewport — so without this link the reader is
   * stranded on a page whose only exit is the browser's own back button. The
   * sidebar opens the wiki with `window.open(..., '_blank', 'noopener')`, and
   * `noopener` severs the reference that `window.close()` would need, so
   * closing the tab from script is not an option: the exit has to be a real
   * navigation to `/`.
   */
  standalone?: boolean;
};

const CONTROL_CLASS = [
  'flex flex-shrink-0 items-center justify-center rounded-md text-muted-foreground',
  'transition-colors hover:bg-accent hover:text-foreground',
  // 44px touch target on mobile, a compact 32px square on the desktop toolbar.
  'h-11 w-11 md:h-8 md:w-8',
].join(' ');

export default function WikiToolbar({
  sidebarOpen,
  onToggleSidebar,
  sidebarToggleRef,
  onOpenSearch,
  onGoHome,
  sectionTitle,
  pageTitle,
  standalone = false,
}: Props) {
  const { t, langAttr } = useWikiLabels();

  return (
    <div data-wiki-toolbar className="flex flex-shrink-0 items-center gap-2 border-b">
      <button
        ref={sidebarToggleRef}
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? t('toolbar.hideIndex') : t('toolbar.showIndex')}
        aria-expanded={sidebarOpen}
        aria-controls="wiki-sidebar"
        aria-describedby="wiki-sidebar-hint"
        className={CONTROL_CLASS}
      >
        <PanelRight className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      </button>
      <span id="wiki-sidebar-hint" className="sr-only" lang={langAttr}>
        {t('toolbar.escapeHint')}
      </span>

      {/* ── Breadcrumb ── (dir/lang inherited from the panel root) */}
      <nav aria-label={t('toolbar.breadcrumbAria')} className="flex min-w-0 flex-1 items-center gap-1">
        {pageTitle ? (
          <button
            type="button"
            onClick={onGoHome}
            data-wiki-crumb
            lang={langAttr}
            className="flex-shrink-0 rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('toolbar.home')}
          </button>
        ) : (
          <span data-wiki-crumb aria-current="page" lang={langAttr} className="text-foreground">
            {t('toolbar.home')}
          </span>
        )}

        {sectionTitle && (
          <>
            <ChevronLeft
              className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60"
              aria-hidden="true"
            />
            {/* Section is a label, not a destination: sections have no page of
                their own, so making it clickable would promise navigation that
                does not exist. Hidden on narrow screens to keep the page title
                readable. */}
            <span data-wiki-crumb className="hidden flex-shrink-0 text-muted-foreground sm:inline">
              {sectionTitle}
            </span>
            <ChevronLeft
              className="hidden h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60 sm:inline"
              aria-hidden="true"
            />
          </>
        )}

        {pageTitle && (
          // 500, not 600: the article carries the real <h1> again, so this is a
          // position indicator rather than the page's title.
          <span
            data-wiki-crumb
            aria-current="page"
            className="min-w-0 truncate font-medium text-foreground"
          >
            {pageTitle}
          </span>
        )}
      </nav>

      <button
        type="button"
        onClick={onOpenSearch}
        aria-label={t('toolbar.search')}
        className={CONTROL_CLASS}
      >
        <Search className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      </button>
      {standalone && (
        <>
          <span
            data-wiki-toolbar-divider
            aria-hidden="true"
            className="h-5 w-px flex-shrink-0 bg-[hsl(var(--wiki-border))]"
          />
          {/* An anchor, not a router link: on `/wiki` this is the way out of a
              tab that may have been opened with `noopener`, and a plain `href`
              works even if the router state is not what we expect. */}
          <a
            href="/"
            aria-label={t('toolbar.backToApp')}
            className={`${CONTROL_CLASS} gap-1.5 md:w-auto md:px-2.5`}
            lang={langAttr}
          >
            <ArrowRight className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span className="hidden text-[13px] font-medium md:inline">{t('toolbar.backToApp')}</span>
          </a>
        </>
      )}
    </div>
  );
}
