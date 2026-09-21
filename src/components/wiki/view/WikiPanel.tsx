/**
 * WikiPanel.tsx — Wiki viewer orchestrator.
 *
 * Owns top-level state (active page, drawer, search dialog) and the layout
 * skeleton; every sub-concern lives in a dedicated module:
 *  - src/components/wiki/wikiContent.ts        — content + grouped index
 *  - src/components/wiki/useIsDesktop.ts        — responsive breakpoint
 *  - src/components/wiki/WikiContext.tsx        — context + WIKI_HOME sentinel
 *  - src/components/wiki/useWikiSearch.ts       — search logic
 *  - src/components/wiki/useWikiKeyboard.ts     — keyboard shortcuts
 *  - src/components/wiki/domHighlight.ts        — DOM search highlight
 *  - src/components/wiki/markdown/              — ReactMarkdown renderers
 *  - src/components/wiki/view/WikiSidebar.tsx   — drawer (B-122 invariants)
 *  - src/components/wiki/view/WikiToolbar.tsx   — breadcrumb + controls
 *  - src/components/wiki/view/WikiHome.tsx      — landing page
 *  - src/components/wiki/view/WikiSearchOverlay.tsx
 *  - src/components/wiki/view/TableOfContents.tsx
 *  - src/components/wiki/view/PrevNextNav.tsx
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';

import { WikiCtx, WIKI_HOME } from '../WikiContext';
import type { WikiInternalContext } from '../WikiContext';
import { PAGES, SECTIONS, RAW_BY_FILE, getPageContent, findPage } from '../wikiContent';
import { useIsDesktop } from '../useIsDesktop';
import { useWikiSearch } from '../useWikiSearch';
import { useWikiKeyboard } from '../useWikiKeyboard';
import { useWikiLabels } from '../useWikiLabels';
import { scrollToMatchedTerm } from '../domHighlight';
import { extractHeadings, extractToc, slugify } from '../wikiUtils';
import { MARKDOWN_COMPONENTS, REMARK_PLUGINS, REHYPE_PLUGINS } from '../markdown/markdownComponents';

import WikiSidebar from './WikiSidebar';
import WikiToolbar from './WikiToolbar';
import WikiHome from './WikiHome';
import WikiSearchOverlay from './WikiSearchOverlay';
import TableOfContents from './TableOfContents';
import PrevNextNav from './PrevNextNav';
import './wiki-panel.css';

// ---------------------------------------------------------------------------
// Sidebar initial state helper
// ---------------------------------------------------------------------------

/**
 * Computes the initial sidebar open state from the matchMedia API.
 *
 * Exported for isolated unit testing (B-120): accepts an optional matchMediaFn
 * so tests can inject a deterministic mock without touching window.matchMedia.
 * Production callers omit matchMediaFn; the real window.matchMedia is used.
 * Returns true (sidebar open) when window is unavailable (SSR / headless env).
 */
export function getInitialSidebarState(
  matchMediaFn?: (q: string) => { matches: boolean },
): boolean {
  if (typeof window === 'undefined') {
    return true;
  }
  return (matchMediaFn ?? window.matchMedia.bind(window))('(min-width: 768px)').matches;
}

/*
 * THE INDEX NO LONGER CLOSES ITSELF ON THE LANDING PAGE.
 *
 * A helper taking (isHome, isDesktop) used to force it shut there,
 * because the landing page listed the same nineteen titles the index lists and
 * two copies in one viewport read as a duplicate. That treated the symptom: the
 * reader reopens the index — it is a navigation column, that is what it is for —
 * and the duplication returns, now beside a layout missing the width it was
 * designed with. The landing page no longer lists page titles at all
 * (WikiHome.tsx), so there is nothing left to hide, and the index's initial
 * state is decided by width alone, on the landing page and in an article alike.
 */

/** How many quick links the empty search dialog offers. */
const SUGGESTION_COUNT = 6;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type WikiPanelProps = {
  /**
   * True only on the standalone `/wiki` route.
   *
   * As a tab inside MainContent the app's chrome surrounds this panel, so the
   * way back is the tab bar. On `/wiki` the panel fills the viewport and there
   * is no chrome at all — so the toolbar has to supply the exit itself, or the
   * reader is stranded (reported by the owner, 2026-07-31).
   */
  standalone?: boolean;
};

export default function WikiPanel({ standalone = false }: WikiPanelProps = {}) {

  // The wiki opens on its landing page. It used to open on the first article,
  // which meant a first-time reader met the longest page in the wiki with no
  // signpost telling them what else existed.
  const [activeFile, setActiveFile] = useState<string>(WIKI_HOME);

  const isHome = activeFile === WIKI_HOME;

  const isDesktop = useIsDesktop();
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(getInitialSidebarState);
  const [searchOpen, setSearchOpen] = useState(false);

  /**
   * Re-derive the index state on ONE transition only: crossing the
   * mobile/desktop breakpoint (rotation, resize). Everything else — including
   * the reader's own use of the toolbar toggle, and moving between the landing
   * page and an article — is left alone, which is why the previous value is
   * compared rather than just assigned. The ref starts null so the first effect
   * run, which happens right after the initial state above, cannot immediately
   * overwrite it.
   */
  const prevIsDesktop = useRef<boolean | null>(null);
  useEffect(() => {
    const crossedBreakpoint =
      prevIsDesktop.current !== null && prevIsDesktop.current !== isDesktop;
    prevIsDesktop.current = isDesktop;
    if (crossedBreakpoint) setSidebarOpen(isDesktop);
  }, [isDesktop]);

  const { t, langAttr } = useWikiLabels();

  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null);

  // A11y: polite live announcement when the index drawer closes via keyboard.
  const [closeAnnouncement, setCloseAnnouncement] = useState('');

  // B-2: track the matched term from the last search selection
  const pendingMatchTerm = useRef<string | null>(null);
  // Heading id requested by a cross-page anchor link (page.md#section).
  const pendingAnchor = useRef<string | null>(null);

  // Search indexes the flat page list, enriched with the owning section title so
  // a result can say which part of the wiki it lives in.
  const searchPages = useMemo(
    () =>
      SECTIONS.flatMap((section) =>
        section.pages.map((page) => ({ ...page, section: section.title })),
      ),
    [],
  );

  const { query, setQuery, clearQuery, results, isSearching } = useWikiSearch({
    pages: searchPages,
    rawContents: RAW_BY_FILE,
  });

  const suggestions = useMemo(
    () => PAGES.slice(0, SUGGESTION_COUNT).map((p) => ({ file: p.file, title: p.title })),
    [],
  );

  // H1 suppression is keyed synchronously to the page. Resetting this from an
  // effect is too late: the new Markdown tree renders before effects run and
  // can consume the previous page's `true` value.
  const firstH1Page = useRef<string | null>(null);
  const consumeFirstH1 = useCallback((): boolean => {
    if (firstH1Page.current !== activeFile) {
      firstH1Page.current = activeFile;
      return false; // tell HeadingWithId: do NOT render this one
    }
    return true;
  }, [activeFile]);

  // On navigation, land the reader in the right place: the term they searched
  // for, the heading an anchor link named, or the top of the page. Without the
  // top-reset, opening a page from halfway down a long article used to drop the
  // reader halfway down the next one.
  useEffect(() => {
    const term = pendingMatchTerm.current;
    const anchor = pendingAnchor.current;
    pendingMatchTerm.current = null;
    pendingAnchor.current = null;

    // Wait one frame for ReactMarkdown to commit before touching the DOM.
    const id = requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (term && articleRef.current) {
        scrollToMatchedTerm(articleRef.current, term);
        return;
      }
      const target = anchor ? document.getElementById(anchor) : null;
      if (target && container) {
        container.scrollTop = target.offsetTop - container.offsetTop - 16;
      } else if (container) {
        container.scrollTop = 0;
      }
    });
    return () => cancelAnimationFrame(id);
  }, [activeFile]);

  /**
   * Page navigation used by nav, home cards and in-page links.
   * Re-navigating to the page you are already on still has to run the scroll
   * effect (an anchor link to a heading on the current page must move), so the
   * anchor is applied directly when the file does not change.
   */
  const navigate = useCallback(
    (file: string, anchorId?: string) => {
      if (file === activeFile) {
        // Same page: activeFile does not change, so the effect above will not
        // run. Scroll here instead — the target is already in the DOM.
        const target = anchorId ? document.getElementById(anchorId) : null;
        const container = scrollContainerRef.current;
        if (target && container) {
          container.scrollTop = target.offsetTop - container.offsetTop - 16;
        }
        return;
      }
      pendingAnchor.current = anchorId ?? null;
      setActiveFile(file);
    },
    [activeFile],
  );

  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    clearQuery();
  }, [clearQuery]);

  const location = isHome ? null : findPage(activeFile);
  const content = useMemo(() => (isHome ? null : getPageContent(activeFile)), [activeFile, isHome]);
  const headingsByOffset = useMemo(
    () => new Map((content ? extractHeadings(content) : []).map(({ offset, id }) => [offset, id])),
    [content],
  );
  const headingId = useCallback(
    (text: string, sourceOffset?: number) =>
      (sourceOffset === undefined ? undefined : headingsByOffset.get(sourceOffset)) ?? slugify(text),
    [headingsByOffset],
  );

  const wikiCtxValue = useMemo<WikiInternalContext>(
    () => ({
      navigate,
      scrollContainerRef: scrollContainerRef as React.RefObject<HTMLElement | null>,
      consumeFirstH1,
      headingId,
    }),
    [navigate, consumeFirstH1, headingId],
  );

  useWikiKeyboard({
    searchOpen,
    openSearch,
    setSidebarOpen,
    setCloseAnnouncement,
    sidebarToggleRef,
    // The announcement is a label, so it follows the shell language like the
    // rest of them; the hook itself stays free of translation machinery.
    closedMessage: t('a11y.indexClosed'),
  });

  // B-2: when a search result is selected, record the matched term then navigate
  const handleSelectResult = useCallback((file: string, matchedTerm?: string) => {
    if (matchedTerm) {
      pendingMatchTerm.current = matchedTerm;
    }
    setActiveFile(file);
  }, []);

  // TOC derived from raw markdown
  const toc = useMemo(() => (content ? extractToc(content) : []), [content]);

  return (
    <WikiCtx.Provider value={wikiCtxValue}>
      <div
        data-wiki-panel
        className="flex h-full overflow-hidden bg-background"
        /*
         * The whole panel is RTL Arabic, not just the articles.
         *
         * This used to follow the interface language (`dir={i18n.dir()}`) on the
         * theory that the chrome is translated while only the pages are Arabic.
         * In practice that splits the panel down the middle: with an English UI
         * the shell laid out LTR — index column on the left — while the index
         * list, the home cards and the article inside it were each pinned RTL.
         * Half the screen read one way and half the other.
         *
         * There is no version of this wiki a non-Arabic reader can use: every
         * page is an Arabic-only markdown file bundled at build time, with no
         * translations. English chrome around unreadable Arabic prose buys
         * nothing and costs a coherent layout. So the panel is Arabic end to
         * end, and the index sits at the start of the reading direction — the
         * right — as it should.
         */
        dir="rtl"
        lang="ar"
        role="region"
        aria-label={t('panel.ariaLabel')}
      >
        {/* A11y: polite live region for keyboard-driven drawer close. */}
        <div aria-live="polite" className="sr-only">
          {closeAnnouncement}
        </div>

        <WikiSidebar
          isDesktop={isDesktop}
          sidebarOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onDeactivate={() => setSidebarOpen(false)}
          activeFile={activeFile}
          onSelectPage={setActiveFile}
          sidebarToggleRef={sidebarToggleRef}
        />

        {/* ── Content area ─────────────────────────────────────────────── */}
        <main
          className="flex min-w-0 flex-1 flex-col overflow-hidden"
          aria-label={location?.page.title ?? t('panel.home')}
        >
          <WikiToolbar
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            sidebarToggleRef={sidebarToggleRef}
            onOpenSearch={openSearch}
            onGoHome={() => setActiveFile(WIKI_HOME)}
            sectionTitle={location?.section.title || undefined}
            pageTitle={location?.page.title}
            standalone={standalone}
          />

          {/* Scrollable body */}
          <div
            className="flex-1 overflow-y-auto px-5 py-6 md:px-6 xl:px-8"
            data-wiki-scroll="true"
            ref={(el) => {
              scrollContainerRef.current = el;
            }}
          >
            {isHome ? (
              // navigate, not setActiveFile: the landing page's rows target
              // headings inside pages, and only navigate carries the anchor.
              <WikiHome onNavigate={navigate} onOpenSearch={openSearch} />
            ) : content !== null ? (
              <div className="mx-auto flex w-full max-w-5xl gap-8">
                <article
                  // dir/lang are inherited from the panel root, which is pinned
                  // rtl/ar for the whole wiki — no second pin needed here.
                  // No `prose-sm`: it pins a 15px body, and the reading scale
                  // for this island is set in wiki-panel.css. The measure
                  // (max 68ch) is set there too, so no max-w-* here either.
                  className="wiki-article prose min-w-0 flex-1"
                  ref={(el) => {
                    articleRef.current = el;
                  }}
                >
                  {/*
                    The page title, drawn from the index rather than from the
                    markdown.

                    It used to exist only in the toolbar. But a 3rem sticky strip
                    at weight 500 is a location indicator, not a page title:
                    copying or printing the article produced a document with no
                    heading at all, and the heading outline started at h2, which
                    is a broken structure for anyone navigating by headings. The
                    markdown's own first h1 is still suppressed (consumeFirstH1),
                    so there is exactly one.
                  */}
                  {location?.page.title && <h1>{location.page.title}</h1>}

                  {location?.page.summary && (
                    <p className="wiki-lede">{location.page.summary}</p>
                  )}

                  {/* Narrow screens get the collapsible TOC above the prose; the
                      sticky rail below takes over from xl up. */}
                  <TableOfContents
                    key={`inline-${activeFile}`}
                    toc={toc}
                    scrollContainerRef={scrollContainerRef as React.RefObject<HTMLElement | null>}
                    variant="inline"
                    className="xl:hidden"
                  />

                  {/*
                    key={activeFile} resets the ReactMarkdown subtree on page change,
                    which is essential for the H1-suppression ref to work correctly.
                  */}
                  <ReactMarkdown
                    key={activeFile}
                    remarkPlugins={REMARK_PLUGINS}
                    rehypePlugins={REHYPE_PLUGINS}
                    components={MARKDOWN_COMPONENTS}
                  >
                    {content}
                  </ReactMarkdown>

                  <PrevNextNav activeFile={activeFile} onNavigate={setActiveFile} />
                </article>

                <TableOfContents
                  key={`rail-${activeFile}`}
                  toc={toc}
                  scrollContainerRef={scrollContainerRef as React.RefObject<HTMLElement | null>}
                  variant="rail"
                  className="hidden xl:block"
                />
              </div>
            ) : (
              <p className="text-muted-foreground" lang={langAttr}>
                {t('panel.notFound')}
              </p>
            )}
          </div>
        </main>

        <WikiSearchOverlay
          open={searchOpen}
          onClose={closeSearch}
          query={query}
          onQueryChange={setQuery}
          results={results}
          isSearching={isSearching}
          onSelect={handleSelectResult}
          suggestions={suggestions}
        />
      </div>
    </WikiCtx.Provider>
  );
}
