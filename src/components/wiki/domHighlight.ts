/**
 * domHighlight.ts — DOM-based search-term highlighting for the wiki viewer.
 *
 * Scrolls to the first element inside `container` whose text contains `term`
 * (Arabic-normalized), and applies a brief highlight animation.
 */

import { normalizeArabic } from './useWikiSearch';

/** CSS class injected for the temporary highlight animation (defined in wiki-panel.css). */
export const HIGHLIGHT_CLASS = 'wiki-search-highlight';

/**
 * After a search result is selected, scroll to the first text node inside
 * `container` that contains `term` (Arabic-normalized), and apply a brief
 * highlight that fades out.
 *
 * Strategy: walk the DOM tree looking for Element nodes whose textContent
 * (normalized) contains the normalized term. Prefer the deepest match so we
 * land on the paragraph/heading rather than the article root.
 */
export function scrollToMatchedTerm(
  container: HTMLElement,
  term: string,
): void {
  const normalizedTerm = normalizeArabic(term.trim());
  if (!normalizedTerm) return;

  // BFS/DFS: collect candidate elements whose textContent contains the term.
  // We want the deepest element (smallest subtree) to avoid highlighting the
  // whole article.
  let bestMatch: HTMLElement | null = null;

  const walk = (node: HTMLElement) => {
    const nodeText = normalizeArabic(node.textContent ?? '');
    if (!nodeText.includes(normalizedTerm)) return; // prune subtree

    // This node contains the term. Record it (last one visited = deepest).
    bestMatch = node;

    // Recurse into children for a deeper match
    for (const child of Array.from(node.children)) {
      walk(child as HTMLElement);
    }
  };

  walk(container);

  if (!bestMatch) return;

  const el = bestMatch as HTMLElement;

  // Scroll the matched element into view inside the scroll container
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Apply highlight: add class, remove after 2s
  el.classList.add(HIGHLIGHT_CLASS);
  setTimeout(() => el.classList.remove(HIGHLIGHT_CLASS), 2000);
}
