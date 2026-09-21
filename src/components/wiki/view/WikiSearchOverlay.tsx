/**
 * WikiSearchOverlay.tsx — full-screen search dialog (⌘K / Ctrl+K / "/").
 *
 * Replaces the old dropdown that lived inside the sidebar. Search is the main
 * way anyone finds anything here, and burying it in a drawer that is closed by
 * default on mobile made it the least reachable control in the panel.
 *
 * Portalled to document.body: the wiki panel is rendered inside a tab container
 * with `overflow: hidden`, and any ancestor carrying a transform would turn a
 * `fixed` overlay into a clipped, panel-relative box. Because it is portalled it
 * inherits nothing — not the direction, not the island's tokens — so it pins
 * `dir="rtl" lang="ar"` itself and carries `data-wiki-overlay`, which is what
 * wiki-panel.css keys the token block off. Both are covered by
 * WikiPanel.direction.test.ts.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import FocusTrap from 'focus-trap-react';
import { Search, X, CornerDownLeft, ArrowUp, ArrowDown } from 'lucide-react';

import { useWikiLabels } from '../useWikiLabels';
import type { SearchMatch } from '../useWikiSearch';

// ---------------------------------------------------------------------------
// Snippet highlighting
// ---------------------------------------------------------------------------

function Highlighted({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="font-medium">{text.slice(idx, idx + term.length)}</mark>
      {text.slice(idx + term.length)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  open: boolean;
  onClose: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  results: SearchMatch[];
  isSearching: boolean;
  onSelect: (file: string, matchedTerm?: string) => void;
  /** Shown as one-tap shortcuts before the reader types anything. */
  suggestions: { file: string; title: string }[];
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WikiSearchOverlay({
  open,
  onClose,
  query,
  onQueryChange,
  results,
  isSearching,
  onSelect,
  suggestions,
}: Props) {
  const { t, langAttr } = useWikiLabels();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Rows are either search results or, before typing, the suggestion shortcuts.
  const rows = useMemo(
    () =>
      isSearching
        ? results.map((r) => ({ file: r.file, term: r.matchedTerm }))
        : suggestions.map((s) => ({ file: s.file, term: undefined })),
    [isSearching, results, suggestions],
  );

  // Reset the cursor whenever the candidate set changes, so Enter never fires a
  // stale row left selected by a previous query.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, isSearching]);

  useEffect(() => {
    if (!open) return;
    // Autofocus after the dialog paints; focus-trap needs the node mounted.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Keep the highlighted row inside the scroll viewport during arrow paging.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  const choose = (index: number) => {
    const row = rows[index];
    if (!row) return;
    onSelect(row.file, row.term);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return createPortal(
    <FocusTrap focusTrapOptions={{ allowOutsideClick: true, onDeactivate: onClose }}>
      {/* Portalled to document.body, so unlike the rest of the panel this
          cannot inherit dir/lang — it pins its own. */}
      <div
        dir="rtl"
        lang="ar"
        data-wiki-overlay
        className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[10vh]"
        role="dialog"
        aria-modal="true"
        aria-label={t('search.dialogAria')}
      >
        {/* Backdrop */}
        <button
          type="button"
          aria-label={t('search.close')}
          data-wiki-overlay-backdrop
          className="absolute inset-0 cursor-default bg-black/50"
          onClick={onClose}
        />

        <div
          data-wiki-overlay-box
          /* No `w-full`: the dialog width is `min(40rem, 100%)` set on
             [data-wiki-overlay-box] in wiki-panel.css. `w-full` is width:100%
             at the same specificity, and it won by emit order — the dialog
             rendered 1408px wide on a 1440px viewport, i.e. the documented
             Tailwind collision trap, in brand-new code. */
          className="relative flex flex-col overflow-hidden"
          onKeyDown={handleKeyDown}
        >
          {/* ── Input row ── */}
          <div className="flex flex-shrink-0 items-center gap-3 border-b px-4 [border-color:var(--wiki-border)]">
            <Search className="h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder={t('search.placeholder')}
              className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
              aria-label={t('search.inputAria')}
              aria-controls="wiki-search-results"
            />
            <button
              type="button"
              onClick={onClose}
              aria-label={t('search.close')}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!isSearching && (
              <>
                <p
                  className="px-4 pb-1 pt-3 text-[0.8125rem] font-medium text-muted-foreground"
                  lang={langAttr}
                >
                  {t('search.popular')}
                </p>
                <ul id="wiki-search-results" ref={listRef} role="listbox" className="pb-2">
                  {suggestions.map((s, i) => (
                    <li key={s.file}>
                      <button
                        type="button"
                        data-row={i}
                        data-wiki-result
                        role="option"
                        aria-selected={i === activeIndex}
                        onMouseEnter={() => setActiveIndex(i)}
                        onClick={() => choose(i)}
                        className="flex items-center gap-2"
                      >
                        <Search
                          className="h-3.5 w-3.5 flex-shrink-0 opacity-60"
                          aria-hidden="true"
                        />
                        <span data-wiki-result-title>{s.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {isSearching && results.length === 0 && (
              <p className="px-4 py-10 text-center text-muted-foreground" lang={langAttr}>
                {t('search.noResults')}
              </p>
            )}

            {isSearching && results.length > 0 && (
              <ul id="wiki-search-results" ref={listRef} role="listbox" className="py-2">
                {results.map((r, i) => (
                  <li key={r.file}>
                    <button
                      type="button"
                      data-row={i}
                      data-wiki-result
                      role="option"
                      aria-selected={i === activeIndex}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => choose(i)}
                    >
                      <span className="flex items-baseline gap-2">
                        <span data-wiki-result-title>{r.title}</span>
                        {r.section && <span data-wiki-result-section>{r.section}</span>}
                      </span>
                      {r.snippet && (
                        <span data-wiki-result-snippet className="mt-0.5 line-clamp-2 block">
                          <Highlighted text={r.snippet} term={r.matchedTerm} />
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── Keyboard legend (desktop only — no keyboard to hint at on touch) ── */}
          <div
            data-wiki-key-legend
            className="hidden flex-shrink-0 items-center gap-4 border-t px-4 py-2 text-muted-foreground [border-color:var(--wiki-border)] md:flex"
          >
            <span className="flex items-center gap-1">
              <ArrowUp className="h-3 w-3" aria-hidden="true" />
              <ArrowDown className="h-3 w-3" aria-hidden="true" />
              <span lang={langAttr}>{t('search.navigate')}</span>
            </span>
            <span className="flex items-center gap-1">
              {/* Not mirrored: this is a picture of the physical Enter key, whose
                  shape is the same on an Arabic keyboard. */}
              <CornerDownLeft className="h-3 w-3" aria-hidden="true" />
              <span lang={langAttr}>{t('search.open')}</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd>Esc</kbd>
              <span lang={langAttr}>{t('search.dismiss')}</span>
            </span>
          </div>
        </div>
      </div>
    </FocusTrap>,
    document.body,
  );
}
