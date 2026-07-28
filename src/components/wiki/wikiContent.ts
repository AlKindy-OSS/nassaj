/**
 * wikiContent.ts — Build-time wiki content loading and pre-processing.
 *
 * Responsibilities:
 *  - Load all markdown pages via Vite import.meta.glob (eager, at build time).
 *  - Expose PAGES (ordered index), RAW_BY_FILE (raw markdown by filename),
 *    getPageContent (processed content), and the collapseHtmlBlocks utility.
 *
 * INVARIANT — collapseHtmlBlocks:
 *   Assumes SVG elements in wiki markdown are:
 *   (1) Balanced — every <svg> has a matching </svg>.
 *   (2) Non-nested — no <svg> inside another <svg>.
 *   (3) Outside code fences — raw HTML blocks, not inside ```…```.
 *   Any SVG that violates these will be collapsed incorrectly.
 *   Unit-tested in wikiContent.test.ts against a real SVG from 00-overview.md.
 */

import indexJson from '../../../docs/team-wiki/index.json';

// ---------------------------------------------------------------------------
// Raw pages loaded at build time via Vite import.meta.glob (?raw).
// ---------------------------------------------------------------------------

const RAW_PAGES = import.meta.glob('/docs/team-wiki/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// ---------------------------------------------------------------------------
// Page index and types
// ---------------------------------------------------------------------------

export type WikiPage = {
  file: string;
  title: string;
};

export const PAGES: WikiPage[] = (indexJson as { pages: WikiPage[] }).pages;

// ---------------------------------------------------------------------------
// Indexed raw content (keyed by filename)
// ---------------------------------------------------------------------------

export const RAW_BY_FILE: Record<string, string> = {};
for (const page of PAGES) {
  const raw = RAW_PAGES[`/docs/team-wiki/${page.file}`];
  if (typeof raw === 'string') RAW_BY_FILE[page.file] = raw;
}

// ---------------------------------------------------------------------------
// collapseHtmlBlocks — fix blank-line splitting of SVG blocks
// ---------------------------------------------------------------------------

/**
 * remark treats a blank line inside a raw HTML block as the end of that block,
 * which causes large multi-line SVGs (that contain blank separator lines) to be
 * split: only the first chunk is treated as HTML, the rest becomes paragraphs
 * or code blocks.
 *
 * This function collapses blank lines that appear *inside* an SVG element so
 * remark sees the whole tag as a single contiguous HTML block, and wraps each
 * SVG in a horizontally-scrollable container so dense diagrams stay legible on
 * narrow (mobile) viewports instead of shrinking to an unreadable size
 * (app-wide viewport disables pinch-zoom). It does NOT touch other content.
 *
 * INVARIANT: SVG must be balanced, non-nested, and outside code fences.
 */
export function collapseHtmlBlocks(markdown: string): string {
  // Collapse blank lines inside <svg>…</svg>, then wrap in a scroll container.
  return markdown.replace(
    /(<svg[\s\S]*?<\/svg>)/g,
    (match) =>
      `<div class="wiki-diagram-scroll">${match.replace(/\n{2,}/g, '\n')}</div>`,
  );
}

// ---------------------------------------------------------------------------
// getPageContent — returns processed content for a given page file
// ---------------------------------------------------------------------------

export function getPageContent(file: string): string | null {
  const raw = RAW_BY_FILE[file];
  return typeof raw === 'string' ? collapseHtmlBlocks(raw) : null;
}
