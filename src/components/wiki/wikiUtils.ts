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

export type MarkdownHeading = {
  level: 1 | 2 | 3;
  text: string;
  id: string;
  offset: number;
};

const SKIP_TITLES = new Set(['في هذه الصفحة', 'in this page', 'table of contents', 'toc']);

/**
 * Scans raw Markdown for level-2 headings and returns a compact TOC list.
 * Skips manual "في هذه الصفحة" sections (will be removed from content anyway).
 * Skips H1 (handled separately — first H1 is suppressed to avoid toolbar duplication).
 */
export function extractHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = markdown.split('\n');
  let fence: string | null = null;
  let offset = 0;
  const seen = new Map<string, number>();

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceMatch = /^(?:`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      if (fence === null) {
        fence = fenceMatch[0][0];
      } else if (fence === fenceMatch[0][0]) {
        fence = null;
      }
      offset += line.length + 1;
      continue;
    }
    if (fence !== null) {
      offset += line.length + 1;
      continue;
    }

    const match = /^(#{1,3}) (.+)$/.exec(trimmed);
    if (!match) {
      offset += line.length + 1;
      continue;
    }

    const rawText = match[2].trim();

    // Strip inline markdown from heading text (bold, inline code, links …)
    const text = rawText
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();

    const base = slugify(text);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    headings.push({
      level: match[1].length as 1 | 2 | 3,
      text,
      id: occurrence === 1 ? base : `${base}-${occurrence}`,
      offset: offset + line.indexOf('#'),
    });
    offset += line.length + 1;
  }

  return headings;
}

export function extractToc(markdown: string): TocEntry[] {
  return extractHeadings(markdown)
    .filter((heading) => heading.level === 2)
    .filter((heading) =>
      !SKIP_TITLES.has(heading.text.toLowerCase()) && !SKIP_TITLES.has(heading.text))
    .map(({ text, id }) => ({ level: 2, text, id }));
}
