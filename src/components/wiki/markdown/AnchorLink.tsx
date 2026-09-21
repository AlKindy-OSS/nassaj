/**
 * AnchorLink.tsx — Anchor renderer for ReactMarkdown.
 *
 * Four cases:
 *  1. Anchor (#section)          — smooth-scroll within the wiki scroll container.
 *  2. Internal .md link          — navigates to another wiki page.
 *  3. Internal .md#section link  — navigates, then scrolls to the heading.
 *  4. External link              — opens in a new tab with noopener.
 *
 * Case 3 used to fall through to case 4 (`endsWith('.md')` is false once a
 * fragment is appended), so a cross-page anchor opened a new browser tab on a
 * relative path and landed on a 404. And an internal link whose target no longer
 * exists used to be swallowed: preventDefault ran, the page lookup failed, and
 * nothing happened — a link that looked live and was dead. Both are handled
 * explicitly below; an unresolvable target now renders as plain text so a broken
 * link is visible to whoever edits the page instead of only to the reader.
 */

import { useContext } from 'react';

import { WikiCtx } from '../WikiContext';
import { findPage } from '../wikiContent';

/**
 * Prose links are underlined at rest, not on hover: colour alone is not a
 * sufficient distinction (WCAG 1.4.1), and the Al-Kindy primary is a dark navy
 * that reads as ordinary body text against --foreground in several themes.
 * The underline weight and offset live in wiki-panel.css.
 */
const LINK_CLASS = 'wiki-link';

export default function AnchorLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  const { navigate, scrollContainerRef } = useContext(WikiCtx);

  // ── Case 1: same-page anchor ──────────────────────────────────────────────
  if (href?.startsWith('#')) {
    const handleClick = (e: React.MouseEvent) => {
      e.preventDefault();
      const container = scrollContainerRef.current;
      const target = document.getElementById(href.slice(1));
      if (target && container) {
        container.scrollTop = target.offsetTop - container.offsetTop - 16;
      } else {
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    return (
      <a href={href} onClick={handleClick} className={LINK_CLASS}>
        {children}
      </a>
    );
  }

  // ── Cases 2 & 3: internal page link, with or without a fragment ───────────
  const internal = href && !/^[a-z]+:/i.test(href) ? /^([^#]*\.md)(?:#(.*))?$/.exec(href) : null;
  if (internal) {
    const file = internal[1].split('/').pop() ?? internal[1];
    const anchorId = internal[2];

    // Unknown target: render the label without a link rather than a control that
    // does nothing when clicked.
    if (!findPage(file)) {
      return <span className="text-muted-foreground">{children}</span>;
    }

    const handleClick = (e: React.MouseEvent) => {
      e.preventDefault();
      navigate(file, anchorId);
    };
    return (
      <a href={href} onClick={handleClick} className={`cursor-pointer ${LINK_CLASS}`}>
        {children}
      </a>
    );
  }

  // ── Case 4: external ──────────────────────────────────────────────────────
  return (
    <a href={href} className={LINK_CLASS} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
