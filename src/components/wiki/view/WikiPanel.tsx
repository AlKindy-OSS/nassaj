/**
 * WikiPanel.tsx — Wiki viewer orchestrator.
 *
 * This file is intentionally thin (~180 lines). It owns:
 *  - Top-level state (active page, sidebar open/closed, search, H1 suppression).
 *  - WikiCtx.Provider value assembly.
 *  - Layout skeleton (sidebar + main content area + toolbar).
 *
 * All sub-concerns live in dedicated modules:
 *  - src/components/wiki/wikiContent.ts       — content loading
 *  - src/components/wiki/useIsDesktop.ts       — responsive breakpoint
 *  - src/components/wiki/WikiContext.tsx        — context type + hook
 *  - src/components/wiki/useWikiSearch.ts       — search logic
 *  - src/components/wiki/useWikiKeyboard.ts     — keyboard shortcuts
 *  - src/components/wiki/domHighlight.ts        — DOM search highlight
 *  - src/components/wiki/markdown/              — ReactMarkdown renderers
 *  - src/components/wiki/view/WikiSidebar.tsx   — drawer (B-122 invariants)
 *  - src/components/wiki/view/TableOfContents.tsx
 *  - src/components/wiki/view/PrevNextNav.tsx
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';
import { PanelLeft } from 'lucide-react';

import { WikiCtx } from '../WikiContext';
import type { WikiInternalContext } from '../WikiContext';
import { PAGES, RAW_BY_FILE, getPageContent } from '../wikiContent';
import { useIsDesktop } from '../useIsDesktop';
import { useWikiSearch } from '../useWikiSearch';
import { useWikiKeyboard } from '../useWikiKeyboard';
import { scrollToMatchedTerm } from '../domHighlight';
import { extractToc } from '../wikiUtils';
import { MARKDOWN_COMPONENTS, REMARK_PLUGINS, REHYPE_PLUGINS } from '../markdown/markdownComponents';
import WikiSidebar from './WikiSidebar';
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function WikiPanel() {
  const { t, i18n } = useTranslation();
  const [activeFile, setActiveFile] = useState<string>(PAGES[0]?.file ?? '');

  // Sidebar open/closed — closed by default on mobile, open on desktop
  const isDesktop = useIsDesktop();
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => getInitialSidebarState());

  // Sync sidebar state when breakpoint changes (device rotation, resize)
  useEffect(() => {
    setSidebarOpen(isDesktop);
  }, [isDesktop]);

  const searchInputRef = useRef<HTMLInputElement>(null) as React.RefObject<HTMLInputElement>;
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement | null>(null);

  // A11y: polite live announcement when the index drawer closes via keyboard.
  const [closeAnnouncement, setCloseAnnouncement] = useState('');

  // B-2: track the matched term from the last search selection
  const pendingMatchTerm = useRef<string | null>(null);

  const { query, setQuery, clearQuery, results, isSearching } = useWikiSearch({
    pages: PAGES,
    rawContents: RAW_BY_FILE,
  });

  // H1 suppression: first H1 per page is hidden (toolbar shows the title already).
  // consumeFirstH1 returns false on the very first call (→ skip), true thereafter.
  const firstH1Done = useRef(false);
  const consumeFirstH1 = useCallback((): boolean => {
    if (!firstH1Done.current) {
      firstH1Done.current = true;
      return false; // tell HeadingWithId: do NOT render this one
    }
    return true;
  }, []);

  // Reset the flag whenever the active page changes
  useEffect(() => {
    firstH1Done.current = false;
  }, [activeFile]);

  // B-2: after page content renders, scroll to and highlight the matched term
  useEffect(() => {
    const term = pendingMatchTerm.current;
    if (!term || !articleRef.current) return;
    pendingMatchTerm.current = null;

    // Give ReactMarkdown a frame to render before walking the DOM
    const id = requestAnimationFrame(() => {
      if (articleRef.current) {
        scrollToMatchedTerm(articleRef.current, term);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [activeFile]);

  const wikiCtxValue = useMemo<WikiInternalContext>(
    () => ({
      setActiveFile,
      scrollContainerRef: scrollContainerRef as React.RefObject<HTMLElement | null>,
      consumeFirstH1,
    }),
    [consumeFirstH1],
  );

  // Keyboard shortcuts — Escape / Ctrl+K / "/"
  useWikiKeyboard({
    query,
    clearQuery,
    sidebarOpen,
    setSidebarOpen,
    setCloseAnnouncement,
    searchInputRef,
    sidebarToggleRef,
  });

  // B-2: when a search result is selected, record the matched term then navigate
  const handleSelectResult = useCallback((file: string, matchedTerm?: string) => {
    if (matchedTerm) {
      pendingMatchTerm.current = matchedTerm;
    }
    setActiveFile(file);
  }, []);

  const content = useMemo(() => getPageContent(activeFile), [activeFile]);
  const activeTitle = PAGES.find((p) => p.file === activeFile)?.title ?? '';

  // TOC derived from raw markdown
  const toc = useMemo(() => (content ? extractToc(content) : []), [content]);

  return (
    <WikiCtx.Provider value={wikiCtxValue}>
      <div
        data-wiki-panel
        className="flex h-full overflow-hidden bg-background"
        // The panel chrome (sidebar, TOC, nav) is translated, so it follows the
        // UI language. Only the wiki *pages* are Arabic-only source files — the
        // `dir`/`lang` pin moved down onto <article> where that is actually true.
        dir={i18n.dir()}
        role="region"
        aria-label={t('wiki.panelAriaLabel', 'ويكي نسّاج')}
      >
        {/* A11y: polite live region for keyboard-driven drawer close. */}
        <div aria-live="polite" className="sr-only">
          {closeAnnouncement}
        </div>

        {/* ── Sidebar (drawer on mobile, column on desktop) ─────────────── */}
        <WikiSidebar
          isDesktop={isDesktop}
          sidebarOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          onDeactivate={() => setSidebarOpen(false)}
          activeFile={activeFile}
          onSelectPage={setActiveFile}
          query={query}
          onQueryChange={setQuery}
          onClearQuery={clearQuery}
          results={results}
          isSearching={isSearching}
          onSelectResult={handleSelectResult}
          searchInputRef={searchInputRef}
          sidebarToggleRef={sidebarToggleRef}
        />

        {/* ── Content area ─────────────────────────────────────────────── */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label={activeTitle}>
          {/* Toolbar */}
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 px-4 py-2">
            <button
              ref={sidebarToggleRef}
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={
                sidebarOpen
                  ? t('wiki.closeSidebar', 'إخفاء الفهرس')
                  : t('wiki.openSidebar', 'إظهار الفهرس')
              }
              aria-expanded={sidebarOpen}
              aria-controls="wiki-sidebar"
              aria-describedby="wiki-sidebar-hint"
              className={[
                'flex items-center gap-1.5 rounded-md text-muted-foreground',
                'hover:bg-accent hover:text-foreground',
                'min-h-[44px] min-w-[44px] justify-center px-2 md:min-h-0 md:min-w-0 md:p-1.5',
              ].join(' ')}
            >
              <PanelLeft className="h-4 w-4 flex-shrink-0 rtl:scale-x-[-1]" aria-hidden="true" />
              <span className="text-sm font-medium md:hidden">
                {t('wiki.sidebarLabel', 'الفهرس')}
              </span>
            </button>
            <span id="wiki-sidebar-hint" className="sr-only">
              {t('wiki.sidebarEscapeHint', 'اضغط Escape لإغلاق الفهرس')}
            </span>
            <h2 className="line-clamp-2 text-base font-bold text-foreground md:text-sm md:font-semibold">
              {activeTitle}
            </h2>
          </div>

          {/* Scrollable body */}
          <div
            className="flex-1 overflow-y-auto px-4 py-6 md:px-6"
            data-wiki-scroll="true"
            ref={(el) => {
              scrollContainerRef.current = el;
            }}
          >
            {content !== null ? (
              <article
                // Wiki pages are Arabic-only markdown bundled from the repo at
                // build time, so the article itself stays rtl/ar whatever the UI
                // language is — otherwise the prose would render against an LTR
                // base for the eight non-Arabic locales.
                dir="rtl"
                lang="ar"
                className="wiki-article prose prose-sm max-w-3xl"
                ref={(el) => {
                  articleRef.current = el;
                }}
              >
                {toc.length > 0 && (
                  <TableOfContents
                    toc={toc}
                    scrollContainerRef={scrollContainerRef as React.RefObject<HTMLElement | null>}
                  />
                )}

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
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('wiki.pageNotFound', 'الصفحة غير موجودة')}
              </p>
            )}
          </div>
        </main>
      </div>
    </WikiCtx.Provider>
  );
}
