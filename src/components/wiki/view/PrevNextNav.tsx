/**
 * PrevNextNav.tsx — Previous / Next page navigation bar.
 *
 * Rendered at the bottom of each wiki article.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { PAGES } from '../wikiContent';

type Props = {
  activeFile: string;
  onNavigate: (file: string) => void;
};

export default function PrevNextNav({ activeFile, onNavigate }: Props) {
  const idx = PAGES.findIndex((p) => p.file === activeFile);
  const prevPage = idx > 0 ? PAGES[idx - 1] : null;
  const nextPage = idx < PAGES.length - 1 ? PAGES[idx + 1] : null;

  if (!prevPage && !nextPage) return null;

  return (
    <div className="mt-8 flex items-center justify-between border-t border-border/40 pt-4">
      {/* Previous — base glyph points back (←); rtl:rotate-180 flips it to (→),
          the "back" direction in RTL. Mirrors the rtl flip used elsewhere. */}
      {prevPage ? (
        <button
          type="button"
          onClick={() => onNavigate(prevPage.file)}
          className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4 flex-shrink-0 rtl:rotate-180" aria-hidden="true" />
          <span className="max-w-[140px] truncate">{prevPage.title}</span>
        </button>
      ) : (
        <div />
      )}

      {/* Next — base glyph points forward (→); rtl:rotate-180 flips it to (←),
          the "forward" direction in RTL. */}
      {nextPage ? (
        <button
          type="button"
          onClick={() => onNavigate(nextPage.file)}
          className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <span className="max-w-[140px] truncate">{nextPage.title}</span>
          <ChevronRight className="h-4 w-4 flex-shrink-0 rtl:rotate-180" aria-hidden="true" />
        </button>
      ) : (
        <div />
      )}
    </div>
  );
}
