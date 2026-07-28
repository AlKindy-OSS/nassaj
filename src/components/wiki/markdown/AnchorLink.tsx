/**
 * AnchorLink.tsx — Anchor renderer for ReactMarkdown.
 *
 * Three cases:
 *  1. Anchor (#section) — smooth-scroll within the wiki scroll container.
 *  2. Internal .md link — navigates to another wiki page.
 *  3. External link — opens in a new tab with noopener.
 */

import { useContext } from 'react';
import { WikiCtx } from '../WikiContext';
import { PAGES } from '../wikiContent';

export default function AnchorLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  const { setActiveFile, scrollContainerRef } = useContext(WikiCtx);

  // Case 1: anchor (#section)
  if (href?.startsWith('#')) {
    const handleClick = (e: React.MouseEvent) => {
      e.preventDefault();
      const id = href.slice(1);
      const container = scrollContainerRef.current;
      const target = document.getElementById(id);
      if (target && container) {
        container.scrollTop = target.offsetTop - container.offsetTop - 16;
      } else {
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    return (
      <a href={href} onClick={handleClick} className="text-primary underline-offset-2 hover:underline">
        {children}
      </a>
    );
  }

  // Case 2: internal .md link
  if (href && href.endsWith('.md') && !href.startsWith('http')) {
    const handleClick = (e: React.MouseEvent) => {
      e.preventDefault();
      const filename = href.split('/').pop() ?? href;
      if (PAGES.some((p) => p.file === filename)) {
        setActiveFile(filename);
      }
    };
    return (
      <a
        href={href}
        onClick={handleClick}
        className="cursor-pointer text-primary underline-offset-2 hover:underline"
      >
        {children}
      </a>
    );
  }

  // Case 3: external link
  return (
    <a
      href={href}
      className="text-primary underline-offset-2 hover:underline"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}
