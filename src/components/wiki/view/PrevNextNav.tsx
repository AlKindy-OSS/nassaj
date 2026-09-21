/**
 * PrevNextNav.tsx — Previous / Next page navigation at the foot of an article.
 *
 * Each card names the direction it goes in, the section it leads into, and the
 * page. The direction label is new and is not decoration: the only thing that
 * distinguished "previous" from "next" before was a silent chevron, which tells
 * a screen-reader user nothing and tells a sighted reader nothing either once
 * they have stopped noticing which way it points.
 *
 * The two cards sit in a two-column grid rather than `justify-between`. On the
 * first and last pages of the wiki there is only one card, and under
 * `justify-between` it stretched to an arbitrary width and hugged one edge; the
 * grid gives each card a fixed half and leaves the empty slot empty.
 *
 * Icons are chosen, not rotated: `ChevronRight` for "previous" points towards
 * the start of the RTL reading flow (the right), `ChevronLeft` for "next"
 * towards its end. The old version picked the opposite glyphs and flipped both
 * with `rtl:rotate-180` to land in the same place — the same pixels, via a
 * transform that would double-apply if this ever rendered inside a second RTL
 * wrapper.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';

import { useWikiLabels } from '../useWikiLabels';
import { PAGES, SECTIONS, findPage } from '../wikiContent';

type Props = {
  activeFile: string;
  onNavigate: (file: string) => void;
};

/** Section title that owns a page, for the small label above the page name. */
function sectionOf(file: string): string {
  return findPage(file)?.section.title ?? '';
}

export default function PrevNextNav({ activeFile, onNavigate }: Props) {
  const { t, langAttr } = useWikiLabels();
  const idx = PAGES.findIndex((p) => p.file === activeFile);
  const prevPage = idx > 0 ? PAGES[idx - 1] : null;
  const nextPage = idx >= 0 && idx < PAGES.length - 1 ? PAGES[idx + 1] : null;

  if (!prevPage && !nextPage) return null;

  // A section label is only informative when there is more than one section.
  const showSection = SECTIONS.length > 1;

  const card = (page: { file: string; title: string }, direction: 'prev' | 'next') => {
    const Chevron = direction === 'prev' ? ChevronRight : ChevronLeft;
    return (
      <button
        type="button"
        onClick={() => onNavigate(page.file)}
        data-wiki-prevnext-card
        data-direction={direction}
      >
        {direction === 'prev' && (
          <Chevron className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">
          <span data-wiki-prevnext-label lang={langAttr}>
            {t(direction === 'prev' ? 'prevNext.prev' : 'prevNext.next')}
          </span>
          {showSection && (
            <span data-wiki-prevnext-section className="truncate">
              {sectionOf(page.file)}
            </span>
          )}
          <span data-wiki-prevnext-title className="truncate">
            {page.title}
          </span>
        </span>
        {direction === 'next' && (
          <Chevron className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
      </button>
    );
  };

  return (
    <nav aria-label={t('prevNext.navAria')} data-wiki-prevnext>
      {/* The empty <span> holds the grid slot so a lone card keeps its half. */}
      {prevPage ? card(prevPage, 'prev') : <span />}
      {nextPage ? card(nextPage, 'next') : <span />}
    </nav>
  );
}
