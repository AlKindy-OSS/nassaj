/**
 * HeadingWithId.tsx — Heading renderer with anchor ID and scroll behaviour.
 *
 * Suppresses the very first H1 per page (the toolbar already displays the
 * page title — consumeFirstH1 from WikiCtx controls this).
 */

import { useContext } from 'react';
import { WikiCtx } from '../WikiContext';
import { slugify } from '../wikiUtils';

// ---------------------------------------------------------------------------
// extractTextFromChildren
// ---------------------------------------------------------------------------

/** Recursively extract plain text from React children. */
export function extractTextFromChildren(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractTextFromChildren).join('');
  if (children !== null && typeof children === 'object' && 'props' in (children as object)) {
    const el = children as React.ReactElement<{ children?: React.ReactNode }>;
    return extractTextFromChildren(el.props?.children);
  }
  return '';
}

// ---------------------------------------------------------------------------
// HeadingWithId
// ---------------------------------------------------------------------------

export default function HeadingWithId({
  level,
  children,
  className,
}: {
  level: 1 | 2 | 3;
  children: React.ReactNode;
  className: string;
}) {
  const { scrollContainerRef, consumeFirstH1 } = useContext(WikiCtx);

  const text = extractTextFromChildren(children);
  const id = slugify(text);

  // Suppress the very first H1 — toolbar already displays the page title
  if (level === 1 && !consumeFirstH1()) {
    return null;
  }

  const Tag = `h${level}` as 'h1' | 'h2' | 'h3';

  const handleAnchorClick = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = scrollContainerRef.current;
    const target = document.getElementById(id);
    if (target && container) {
      container.scrollTop = target.offsetTop - container.offsetTop - 16;
    }
  };

  return (
    <Tag id={id} className={className}>
      <a
        href={`#${id}`}
        onClick={handleAnchorClick}
        className="no-underline hover:underline decoration-primary/40"
        aria-label={`رابط للقسم: ${text}`}
      >
        {children}
      </a>
    </Tag>
  );
}
