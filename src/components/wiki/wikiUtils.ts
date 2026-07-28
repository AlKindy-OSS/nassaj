/**
 * wikiUtils.ts — shared utilities for the wiki viewer.
 *
 * Deliberately kept dependency-free (no rehype-slug, no external libs)
 * so as not to touch package.json.
 */

import { normalizeArabic } from './useWikiSearch';

// ---------------------------------------------------------------------------
// Slug generation — Arabic-aware
// Matches the normalization used in useWikiSearch so anchor links resolve.
// ---------------------------------------------------------------------------

/**
 * Converts a heading text into a URL-safe id/slug.
 *
 * Steps:
 *  1. Normalise Arabic diacritics/variants (same rules as search).
 *  2. Lower-case.
 *  3. Replace whitespace with hyphens.
 *  4. Remove characters that are not alphanumeric, Arabic letters, or hyphens.
 */
export function slugify(text: string): string {
  return normalizeArabic(text)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// TOC extraction from raw Markdown
// ---------------------------------------------------------------------------

export type TocEntry = {
  level: 2 | 3;
  text: string;
  id: string;
};

const SKIP_TITLES = new Set(['في هذه الصفحة', 'in this page', 'table of contents', 'toc']);

/**
 * Scans raw Markdown for level-2 and level-3 headings and returns a TOC list.
 * Skips manual "في هذه الصفحة" sections (will be removed from content anyway).
 * Skips H1 (handled separately — first H1 is suppressed to avoid toolbar duplication).
 */
export function extractToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const lines = markdown.split('\n');

  for (const line of lines) {
    const m2 = /^## (.+)$/.exec(line.trim());
    const m3 = /^### (.+)$/.exec(line.trim());
    const match = m2 ?? m3;
    if (!match) continue;

    const level = m2 ? 2 : 3;
    const rawText = match[1].trim();

    // Strip inline markdown from heading text (bold, inline code, links …)
    const text = rawText
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();

    if (SKIP_TITLES.has(text.toLowerCase()) || SKIP_TITLES.has(text)) continue;

    entries.push({ level: level as 2 | 3, text, id: slugify(text) });
  }

  return entries;
}
