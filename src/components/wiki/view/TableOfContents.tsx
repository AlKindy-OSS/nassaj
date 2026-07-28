/**
 * TableOfContents.tsx — Collapsible table of contents with scroll-spy.
 *
 * Collapsed by default on mobile (<768px), expanded on desktop.
 * Updates the active heading as the user scrolls.
 */

import { useState, useEffect } from 'react';
import { List, ChevronUp, ChevronDown } from 'lucide-react';
import { useIsDesktop } from '../useIsDesktop';
import type { TocEntry } from '../wikiUtils';

type Props = {
  toc: TocEntry[];
  scrollContainerRef: React.RefObject<HTMLElement | null>;
};

export default function TableOfContents({ toc, scrollContainerRef }: Props) {
  // Collapsed by default on mobile (<768px), open on desktop
  const isDesktop = useIsDesktop();
  const [open, setOpen] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true,
  );

  // Update when breakpoint changes (rotation, window resize)
  useEffect(() => {
    setOpen(isDesktop);
  }, [isDesktop]);

  const [activeId, setActiveId] = useState<string>('');

  // Scroll spy
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || toc.length === 0) return;

    const handleScroll = () => {
      let current = toc[0]?.id ?? '';
      for (const entry of toc) {
        const el = document.getElementById(entry.id);
        if (!el) continue;
        if (container.scrollTop >= el.offsetTop - container.offsetTop - 32) {
          current = entry.id;
        }
      }
      setActiveId(current);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => container.removeEventListener('scroll', handleScroll);
  }, [toc, scrollContainerRef]);

  if (toc.length === 0) return null;

  const scrollToId = (id: string) => {
    const container = scrollContainerRef.current;
    const target = document.getElementById(id);
    if (target && container) {
      container.scrollTop = target.offsetTop - container.offsetTop - 16;
    }
  };

  return (
    /* border/80 for better contrast with the current token */
    <div className="mb-5 rounded-lg border border-border/80 bg-muted/20 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-4 py-2.5 text-start font-semibold text-foreground transition-colors hover:bg-accent/40"
      >
        <List className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1">في هذه الصفحة</span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        )}
      </button>
      {open && (
        <ul className="pb-2 pt-1">
          {toc.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => scrollToId(entry.id)}
                className={[
                  'w-full py-1 text-start transition-colors hover:bg-accent/40',
                  entry.level === 3 ? 'ps-8 text-xs' : 'ps-6 text-sm',
                  activeId === entry.id ? 'font-medium text-primary' : 'text-muted-foreground',
                ].join(' ')}
              >
                {entry.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
