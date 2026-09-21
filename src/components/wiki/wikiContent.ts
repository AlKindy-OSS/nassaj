/**
 * wikiContent.ts — Build-time wiki content loading and pre-processing.
 *
 * Responsibilities:
 *  - Load all markdown pages via Vite import.meta.glob (eager, at build time).
 *  - Normalise the index into SECTIONS (grouped nav) and PAGES (flat order).
 *  - Expose RAW_BY_FILE, getPageContent, findPage, and collapseHtmlBlocks.
 *
 * INDEX SCHEMA (v2 — grouped):
 *   { "version": 2, "sections": [ { id, title, icon?, summary?, pages: [...] } ] }
 * The legacy flat shape ({ "pages": [...] }) is still accepted and folded into a
 * single untitled section, so a node carrying older content — or the empty seed
 * written by scripts/ensure-wiki-index.mjs — keeps rendering instead of crashing.
 *
 * INVARIANT — collapseHtmlBlocks:
 *   Assumes SVG elements in wiki markdown are:
 *   (1) Balanced — every <svg> has a matching </svg>.
 *   (2) Non-nested — no <svg> inside another <svg>.
 *   (3) Outside code fences — raw HTML blocks, not inside ```…```.
 *   Any SVG that violates these will be collapsed incorrectly.
 *   Unit-tested in wikiContent.test.ts against a real SVG from the shipped pages.
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
// Types
// ---------------------------------------------------------------------------

/** Icon key resolved to a lucide component by the nav layer (wikiIcons.ts). */
export type WikiIconName =
  | 'rocket'
  | 'layout'
  | 'brain'
  | 'lifebuoy'
  | 'book'
  | 'page';

export type WikiPage = {
  file: string;
  title: string;
  /** One-line description, shown on the home cards and in search results. */
  summary?: string;
  /** Free-form keywords that should match in search but need not appear in prose. */
  keywords?: string[];
};

export type WikiSection = {
  id: string;
  title: string;
  icon?: WikiIconName;
  summary?: string;
  pages: WikiPage[];
};

type IndexShape = {
  version?: number;
  sections?: WikiSection[];
  /** Legacy v1 flat list. */
  pages?: WikiPage[];
};

// ---------------------------------------------------------------------------
// Index normalisation
// ---------------------------------------------------------------------------

function normaliseIndex(raw: IndexShape): WikiSection[] {
  if (Array.isArray(raw.sections) && raw.sections.length > 0) {
    return raw.sections
      .map((section) => ({
        ...section,
        pages: Array.isArray(section.pages) ? section.pages : [],
      }))
      .filter((section) => section.pages.length > 0);
  }

  // Legacy flat index (or the empty seed): one anonymous section keeps every
  // consumer — nav, search, prev/next — working unchanged.
  const flat = Array.isArray(raw.pages) ? raw.pages : [];
  if (flat.length === 0) return [];
  return [{ id: 'all', title: '', pages: flat }];
}

export const SECTIONS: WikiSection[] = normaliseIndex(indexJson as IndexShape);

/**
 * Flat, ordered page list — the reading order used by prev/next navigation and
 * by search. Derived from SECTIONS so section order is the single source of
 * truth for "what comes next".
 */
export const PAGES: WikiPage[] = SECTIONS.flatMap((section) => section.pages);

// ---------------------------------------------------------------------------
// Indexed raw content (keyed by filename)
// ---------------------------------------------------------------------------

export const RAW_BY_FILE: Record<string, string> = {};
for (const page of PAGES) {
  const raw = RAW_PAGES[`/docs/team-wiki/${page.file}`];
  if (typeof raw === 'string') RAW_BY_FILE[page.file] = raw;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export type WikiLocation = {
  page: WikiPage;
  section: WikiSection;
  /** Index into PAGES — used for prev/next. */
  index: number;
};

const LOCATION_BY_FILE = new Map<string, WikiLocation>();
{
  let index = 0;
  for (const section of SECTIONS) {
    for (const page of section.pages) {
      LOCATION_BY_FILE.set(page.file, { page, section, index });
      index += 1;
    }
  }
}

/** Returns the page plus its owning section, or null for an unknown file. */
export function findPage(file: string): WikiLocation | null {
  return LOCATION_BY_FILE.get(file) ?? null;
}

/** The first page in reading order — the "start here" target. */
export const FIRST_PAGE: string = PAGES[0]?.file ?? '';

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
