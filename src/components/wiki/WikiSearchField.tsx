/**
 * WikiSearchField — search input + results dropdown for the wiki sidebar.
 *
 * Responsibilities:
 *  - Render the search input with Search/X icons
 *  - Render a results list (role="listbox") beneath the input
 *  - Highlight the matched term inside snippets
 *  - Keyboard navigation: Arrow Up/Down, Enter, Escape
 *  - Delegate all business logic to the parent via props / callbacks
 *
 * Intentionally keeps its own internal activeIndex state only — all other
 * state lives in the parent (WikiPanel).
 */

import { useState, useRef, useCallback, useEffect, useId } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SearchMatch } from './useWikiSearch';

// ---------------------------------------------------------------------------
// Highlight helper
// ---------------------------------------------------------------------------

function HighlightedText({
  text,
  term,
}: {
  text: string;
  term: string;
}) {
  if (!term) return <>{text}</>;

  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const idx = lowerText.indexOf(lowerTerm);
  if (idx === -1) return <>{text}</>;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + term.length);
  const after = text.slice(idx + term.length);

  return (
    <>
      {before}
      <mark className="rounded bg-primary/20 px-0.5 text-primary">{match}</mark>
      {after}
    </>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type WikiSearchFieldProps = {
  query: string;
  onQueryChange: (q: string) => void;
  onClear: () => void;
  results: SearchMatch[];
  isSearching: boolean;
  /** Called with the selected file and the matched search term (for in-page highlight). */
  onSelectResult: (file: string, matchedTerm?: string) => void;
  /** Ref to forward focus back to the input after selecting a result */
  inputRef?: React.RefObject<HTMLInputElement>;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WikiSearchField({
  query,
  onQueryChange,
  onClear,
  results,
  isSearching,
  onSelectResult,
  inputRef: externalInputRef,
}: WikiSearchFieldProps) {
  const { t } = useTranslation();
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalRef;
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // P1-D: keyboard nav state
  const [activeIndex, setActiveIndex] = useState<number>(-1);

  // Reset active index whenever results change
  useEffect(() => {
    setActiveIndex(-1);
    itemRefs.current = [];
  }, [results]);

  const uid = useId();
  const listboxId = `wiki-search-listbox-${uid}`;
  const inputId = `wiki-search-input-${uid}`;
  const getOptionId = (i: number) => `wiki-search-option-${uid}-${i}`;

  const handleSelect = useCallback(
    (file: string, matchedTerm?: string) => {
      onSelectResult(file, matchedTerm);
      onClear();
      inputRef.current?.focus();
    },
    [onSelectResult, onClear, inputRef],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!isSearching) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((prev) => {
            const next = prev < results.length - 1 ? prev + 1 : 0;
            itemRefs.current[next]?.scrollIntoView({ block: 'nearest' });
            return next;
          });
          break;

        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((prev) => {
            const next = prev > 0 ? prev - 1 : results.length - 1;
            itemRefs.current[next]?.scrollIntoView({ block: 'nearest' });
            return next;
          });
          break;

        case 'Enter':
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < results.length) {
            const r = results[activeIndex];
            handleSelect(r.file, r.matchedTerm);
          }
          break;

        case 'Escape':
          // Escape is handled in WikiPanel; stop propagation here so it
          // doesn't also fire the WikiPanel handler.
          e.stopPropagation();
          onClear();
          setActiveIndex(-1);
          break;

        default:
          break;
      }
    },
    [isSearching, results, activeIndex, handleSelect, onClear],
  );

  const hasResults = results.length > 0;
  const activeDescendant =
    activeIndex >= 0 && hasResults ? getOptionId(activeIndex) : undefined;

  return (
    <div className="relative px-2 pb-2 pt-2">
      {/* ── Search input ── */}
      <div className="relative flex items-center">
        <Search
          className="pointer-events-none absolute start-2.5 h-3.5 w-3.5 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          // The only search box in the app not built on the shared Input; it
          // takes Arabic page titles and Latin terms alike, so match that default.
          dir="auto"
          role="combobox"
          aria-expanded={isSearching && hasResults}
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          aria-label={t('wiki.searchAriaLabel', 'بحث في صفحات الويكي')}
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('wiki.searchPlaceholder', 'ابحث في الويكي… (/ أو Ctrl+K)')}
          className={[
            'w-full rounded-md py-1.5',
            // البند 6: border/80 بدل border/60 لرفع تباين الحد (أفضل ما يتيحه الـtoken)
            'border border-border/80',
            'bg-background',
            'ps-8 pe-7 text-sm text-foreground',
            // البند 6: placeholder بدون عتامة (muted-foreground الكامل = ~4.77:1 على أبيض)
            'placeholder:text-muted-foreground',
            'outline-none ring-offset-background',
            'focus:border-primary/50 focus:ring-1 focus:ring-primary/30',
            'transition-colors',
          ].join(' ')}
        />
        {query && (
          <button
            type="button"
            onClick={onClear}
            aria-label={t('wiki.searchClear', 'مسح البحث')}
            className={[
              'absolute end-1.5 rounded text-muted-foreground hover:text-foreground',
              // البند 6: هدف لمس ≥24px (مُفضَّل ≥44px كما طُلب)
              'flex h-[44px] w-[44px] items-center justify-center md:h-6 md:w-6',
            ].join(' ')}
          >
            <X className="h-4 w-4 md:h-3.5 md:w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* ── Results dropdown ── */}
      {isSearching && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={t('wiki.searchResultsAriaLabel', 'نتائج البحث')}
          className={[
            'absolute start-2 end-2 z-20 mt-1 overflow-y-auto rounded-lg',
            // البند 6: border/80 بدل border/60
            'border border-border/80',
            'bg-popover shadow-lg',
            // البند 6: max-h ديناميكية تحترم شاشات الجوال القصيرة
            hasResults ? 'max-h-[min(18rem,60dvh)]' : '',
          ].join(' ')}
        >
          {!hasResults ? (
            <li
              role="option"
              aria-selected={false}
              className="px-3 py-3 text-center text-sm text-muted-foreground"
            >
              {t('wiki.searchNoResults', 'لا نتائج')}
            </li>
          ) : (
            results.map((match, i) => {
              const isActive = i === activeIndex;
              return (
                <li
                  key={match.file}
                  id={getOptionId(i)}
                  role="option"
                  aria-selected={isActive}
                >
                  <button
                    ref={(el) => {
                      itemRefs.current[i] = el;
                    }}
                    type="button"
                    onClick={() => handleSelect(match.file, match.matchedTerm)}
                    className={[
                      'flex w-full flex-col gap-0.5 px-3 py-2 text-start',
                      'focus:outline-none transition-colors',
                      'border-b border-border/30 last:border-b-0',
                      isActive
                        ? 'bg-accent/70'
                        : 'hover:bg-accent/60 focus:bg-accent/60',
                    ].join(' ')}
                  >
                    <span className="text-sm font-medium text-foreground">
                      <HighlightedText text={match.title} term={match.matchedTerm} />
                    </span>
                    {match.snippet && (
                      <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        <HighlightedText text={match.snippet} term={match.matchedTerm} />
                      </span>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}

      {/* Screen-reader count announcement */}
      {isSearching && hasResults && (
        <p role="status" aria-live="polite" className="sr-only">
          {t('wiki.searchResultsCount', '{{count}} نتيجة', { count: results.length })}
        </p>
      )}
    </div>
  );
}
