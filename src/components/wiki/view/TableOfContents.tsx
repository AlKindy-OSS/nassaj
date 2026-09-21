/**
 * TableOfContents.tsx — in-page heading navigation with scroll-spy.
 *
 * Two presentations, one behaviour:
 *  - variant="rail"   — sticky column beside the article on xl+ screens.
 *  - variant="inline" — collapsible box above the article on narrower screens,
 *                       collapsed by default on mobile.
 *
 * Both are rendered by WikiPanel and hidden at opposite breakpoints, so the
 * reader always has exactly one, and the scroll-spy logic exists once.
 *
 * Presentation lives in wiki-panel.css, keyed off `data-level` and
 * `data-active`. The longest page here has 42 entries across two levels that
 * were previously distinguished by 8px of indent and nothing else — no size
 * step, no weight step — and the inline box had no height cap, so it clipped
 * without saying so. Both are fixed in CSS; putting the active state there too
 * keeps it out of the conditional-utility collision described in that file.
 */

import { useState, useEffect } from 'react';
import { List, ChevronDown } from 'lucide-react';

import { useIsDesktop } from '../useIsDesktop';
import { useWikiLabels } from '../useWikiLabels';
import type { TocEntry } from '../wikiUtils';

type Props = {
  toc: TocEntry[];
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  variant?: 'rail' | 'inline';
  className?: string;
};

/** Offset from the top of the scroll viewport at which a heading counts as current. */
const SPY_OFFSET = 32;

function useActiveHeading(
  toc: TocEntry[],
  scrollContainerRef: React.RefObject<HTMLElement | null>,
): string {
  const [activeId, setActiveId] = useState<string>('');

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || toc.length === 0) return;

    const handleScroll = () => {
      let current = toc[0]?.id ?? '';
      for (const entry of toc) {
        const el = document.getElementById(entry.id);
        if (!el) continue;
        if (container.scrollTop >= el.offsetTop - container.offsetTop - SPY_OFFSET) {
          current = entry.id;
        }
      }
      setActiveId(current);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => container.removeEventListener('scroll', handleScroll);
  }, [toc, scrollContainerRef]);

  return activeId;
}

function scrollToId(id: string, container: HTMLElement | null) {
  const target = document.getElementById(id);
  if (target && container) {
    container.scrollTop = target.offsetTop - container.offsetTop - 16;
  }
}

export default function TableOfContents({
  toc,
  scrollContainerRef,
  variant = 'inline',
  className = '',
}: Props) {
  const { t, langAttr } = useWikiLabels();
  const isDesktop = useIsDesktop();
  const activeId = useActiveHeading(toc, scrollContainerRef);

  // Inline variant only: collapsed by default on mobile, open on desktop.
  const [open, setOpen] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true,
  );
  useEffect(() => {
    setOpen(isDesktop);
  }, [isDesktop]);

  if (toc.length === 0) return null;

  const entries = (
    <ul data-wiki-toc-list>
      {toc.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            onClick={() => scrollToId(entry.id, scrollContainerRef.current)}
            data-wiki-toc-row
            data-level={entry.level}
            data-active={activeId === entry.id ? 'true' : 'false'}
            className="nassaj-control"
          >
            <span className="nassaj-control__surface">
              <span data-wiki-toc-text title={entry.text}>{entry.text}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  // ── Rail ────────────────────────────────────────────────────────────────
  if (variant === 'rail') {
    return (
      <nav aria-label={t('toc.title')} data-wiki-toc data-wiki-toc-rail className={className}>
        <p data-wiki-toc-heading lang={langAttr}>
          {t('toc.title')}
        </p>
        {entries}
      </nav>
    );
  }

  // ── Inline ──────────────────────────────────────────────────────────────
  return (
    <div data-wiki-toc data-wiki-toc-inline className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="nassaj-control"
      >
        <span className="nassaj-control__surface">
          <List className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="flex-1" lang={langAttr}>
            {t('toc.title')}
          </span>
          {/* One glyph that rotates, rather than two that swap: the rotation is on
              the vertical axis, so it needs no direction awareness. */}
          <ChevronDown
            className="h-4 w-4 flex-shrink-0 text-muted-foreground"
            aria-hidden="true"
            data-wiki-toc-chevron
          />
        </span>
      </button>
      {open && entries}
    </div>
  );
}
