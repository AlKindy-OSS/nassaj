/**
 * useWikiSearch — pure client-side search over wiki pages.
 *
 * Exported separately so WikiPanel stays focused on presentation.
 * No external search libraries are used; we rely on string normalization
 * and includes() — sufficient for 7 pages of Arabic markdown.
 */

import { useState, useEffect, useMemo, useRef } from 'react';

// ---------------------------------------------------------------------------
// Arabic text normalization
// Strips diacritics (tashkeel), normalizes Alef variants, Taa marbuta, Waw.
// Keeps the function lightweight — no dependency on ICU or full Unicode tables.
// ---------------------------------------------------------------------------
export function normalizeArabic(text: string): string {
  return (
    text
      // Remove tashkeel (harakat) — Unicode range 0x0610–0x061A, 0x064B–0x065F
      .replace(/[ؐ-ًؚ-ٟ]/g, '')
      // Normalize Alef variants → plain Alef (ا)
      .replace(/[أإآٱ]/g, 'ا')
      // Normalize Taa marbuta (ة) → Haa (ه) so "مهمة" matches "مهمه"
      .replace(/ة/g, 'ه')
      // Normalize Waw variants
      .replace(/ؤ/g, 'و')
      // Normalize Yaa variants → plain Yaa
      .replace(/[يى]/g, 'ي')
      // Normalize Hamza on chair
      .replace(/ئ/g, 'ي')
      .toLowerCase()
  );
}

/** Strip basic Markdown syntax so snippets don't include `##`, `**`, `[]()` etc. */
export function stripMarkdown(text: string): string {
  return text
    // Fenced code blocks
    .replace(/```[\s\S]*?```/g, ' ')
    // Inline code
    .replace(/`[^`]*`/g, ' ')
    // Headings (#, ##, …)
    .replace(/^#{1,6}\s+/gm, '')
    // Bold / italic (**, *, __, _)
    .replace(/(\*{1,2}|_{1,2})(.*?)\1/g, '$2')
    // Links [text](url)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Images ![alt](url)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Blockquote markers
    .replace(/^>\s*/gm, '')
    // Horizontal rules
    .replace(/^-{3,}$/gm, '')
    // Table pipes
    .replace(/\|/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WikiPage = {
  file: string;
  title: string;
};

export type SearchMatch = {
  /** Page identifier (file name) */
  file: string;
  title: string;
  /**
   * Short excerpt around the first hit inside the page body.
   * undefined when the match was on the title only.
   */
  snippet?: string;
  /**
   * The matched query term (already normalized) — used by the UI to
   * highlight inside snippets.
   */
  matchedTerm: string;
};

// ---------------------------------------------------------------------------
// Core search logic (exported for unit tests)
// ---------------------------------------------------------------------------

const SNIPPET_CONTEXT = 80; // characters before/after the hit

export function buildSnippet(
  plainText: string,
  normalizedText: string,
  normalizedQuery: string,
): string | undefined {
  const idx = normalizedText.indexOf(normalizedQuery);
  if (idx === -1) return undefined;

  const start = Math.max(0, idx - SNIPPET_CONTEXT);
  const end = Math.min(plainText.length, idx + normalizedQuery.length + SNIPPET_CONTEXT);

  let snippet = plainText.slice(start, end).trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < plainText.length) snippet = snippet + '…';
  return snippet;
}

export function searchWikiPages(
  query: string,
  pages: WikiPage[],
  rawContents: Record<string, string>,
): SearchMatch[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const normalizedQuery = normalizeArabic(trimmed);
  const results: SearchMatch[] = [];

  for (const page of pages) {
    const rawMd = rawContents[page.file] ?? '';
    const plain = stripMarkdown(rawMd);
    const normalizedTitle = normalizeArabic(page.title);
    const normalizedPlain = normalizeArabic(plain);

    const titleMatch = normalizedTitle.includes(normalizedQuery);
    const bodyMatch = normalizedPlain.includes(normalizedQuery);

    if (titleMatch || bodyMatch) {
      const snippet = bodyMatch
        ? buildSnippet(plain, normalizedPlain, normalizedQuery)
        : undefined;

      results.push({
        file: page.file,
        title: page.title,
        snippet,
        matchedTerm: trimmed,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

type UseWikiSearchOptions = {
  pages: WikiPage[];
  /** Raw markdown strings keyed by page.file */
  rawContents: Record<string, string>;
  debounceMs?: number;
};

type UseWikiSearchReturn = {
  query: string;
  setQuery: (q: string) => void;
  clearQuery: () => void;
  results: SearchMatch[];
  isSearching: boolean;
};

export function useWikiSearch({
  pages,
  rawContents,
  debounceMs = 150,
}: UseWikiSearchOptions): UseWikiSearchReturn {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setDebouncedQuery(query);
    }, debounceMs);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [query, debounceMs]);

  const results = useMemo(
    () => searchWikiPages(debouncedQuery, pages, rawContents),
    [debouncedQuery, pages, rawContents],
  );

  const isSearching = query.trim().length > 0;

  const clearQuery = () => {
    setQuery('');
    setDebouncedQuery('');
  };

  return { query, setQuery, clearQuery, results, isSearching };
}
