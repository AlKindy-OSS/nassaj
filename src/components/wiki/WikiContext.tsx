/**
 * WikiContext.tsx — internal React context shared between WikiPanel and its
 * markdown sub-components (HeadingWithId, AnchorLink).
 *
 * Kept as a separate file so markdown components can import it without
 * pulling in the entire WikiPanel tree.
 */

import { createContext, useContext } from 'react';

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export type WikiInternalContext = {
  setActiveFile: (file: string) => void;
  /** Ref to the scrollable container (data-wiki-scroll) */
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  /**
   * Returns false on the very first call per page (so the first H1 is hidden),
   * and true on every subsequent call. Reset by WikiPanel on activeFile change.
   */
  consumeFirstH1: () => boolean;
};

// ---------------------------------------------------------------------------
// Context and default value
// ---------------------------------------------------------------------------

export const WikiCtx = createContext<WikiInternalContext>({
  setActiveFile: () => undefined,
  scrollContainerRef: { current: null },
  consumeFirstH1: () => true,
});

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Convenience hook — throws if used outside WikiCtx.Provider. */
export function useWikiCtx(): WikiInternalContext {
  return useContext(WikiCtx);
}
