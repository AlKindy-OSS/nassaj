/**
 * WikiContext.tsx — internal React context shared between WikiPanel and its
 * markdown sub-components (HeadingWithId, AnchorLink).
 *
 * Kept as a separate file so markdown components can import it without
 * pulling in the entire WikiPanel tree.
 */

import { createContext, useContext } from 'react';

// ---------------------------------------------------------------------------
// Route sentinel
// ---------------------------------------------------------------------------

/**
 * `activeFile` value that renders the wiki landing page instead of a markdown
 * article. A sentinel rather than `null` so every consumer handles one type and
 * an in-page link can target it (`[الرئيسية](#home)`).
 */
export const WIKI_HOME = '__home__';

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export type WikiInternalContext = {
  /**
   * Opens a wiki page, optionally scrolling to a heading id once it has
   * rendered. Anchor scrolling has to be owned here rather than by the caller:
   * the target element does not exist until the new page commits.
   */
  navigate: (file: string, anchorId?: string) => void;
  /** Ref to the scrollable container (data-wiki-scroll) */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  /**
   * Returns false on the very first call per page (so the first H1 is hidden),
   * and true on every subsequent call. Reset by WikiPanel on activeFile change.
   */
  consumeFirstH1: () => boolean;
  /** Stable per-page id shared by the rendered heading and its TOC entry. */
  headingId: (text: string, sourceOffset?: number) => string;
};

// ---------------------------------------------------------------------------
// Context and default value
// ---------------------------------------------------------------------------

export const WikiCtx = createContext<WikiInternalContext>({
  navigate: () => undefined,
  scrollContainerRef: { current: null },
  consumeFirstH1: () => true,
  headingId: (text) => text,
});

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Convenience hook — throws if used outside WikiCtx.Provider. */
export function useWikiCtx(): WikiInternalContext {
  return useContext(WikiCtx);
}
