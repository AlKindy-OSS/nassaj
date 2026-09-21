/**
 * useWikiSearch — pure client-side search over wiki pages.
 *
 * Exported separately so WikiPanel stays focused on presentation.
 * No external search libraries are used; we rely on string normalization
 * and includes() — sufficient for 7 pages of Arabic markdown.
 */

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';

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

/**
 * Strip basic Markdown syntax so snippets don't include `##`, `**`, `[]()` etc.
 *
 * Raw HTML blocks go first, and `<svg>` goes before everything: two pages carry
 * hand-written diagrams of several hundred lines, and the indexer read their
 * markup as prose. A search for a word that happened to sit in a diagram put
 * `font-size="11" fill=…` in front of the reader as the excerpt that was
 * supposed to explain the page. The label text inside a diagram is not lost
 * prose worth keeping — every one of those strings is repeated in the article
 * body — so the whole element is dropped rather than unwrapped.
 */
export function stripMarkdown(text: string): string {
  return text
    // Fenced code blocks
    .replace(/```[\s\S]*?```/g, ' ')
    // Inline code
    .replace(/`[^`]*`/g, ' ')
    // Inline SVG diagrams — markup, never prose. After the fences, so that a
    // `<svg>` shown as a code sample cannot swallow the prose that follows it.
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    // Any remaining raw HTML tags (the diagram wrapper, <br>, <details>…).
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
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
  /** One-line description from the index — searched, and shown as a fallback snippet. */
  summary?: string;
  /**
   * Synonyms the reader is likely to type but that never appear in the prose:
   * the English name of a button, a colloquial spelling, an error string.
   * Matched like the title but never rendered.
   */
  keywords?: string[];
  /** Section title, carried through so results can show where a page lives. */
  section?: string;
};

export type SearchMatch = {
  /** Page identifier (file name) */
  file: string;
  title: string;
  /** Section title of the owning page, for grouping//labelling results. */
  section?: string;
  /**
   * Short excerpt around the first hit inside the page body.
   * Falls back to the page summary when the match was on title/keywords only.
   */
  snippet?: string;
  /**
   * The matched query term (already normalized) — used by the UI to
   * highlight inside snippets.
   */
  matchedTerm: string;
  /**
   * Higher is more relevant. Each term scores by where it lands — 3 in the
   * title, 2 in the summary/keywords, 1 in the body — and the whole phrase
   * appearing verbatim adds a bonus.
   */
  score: number;
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

  // Match every whitespace-separated term rather than the query as one literal
  // substring. People search the way they speak — "الجلسة معلقة" — and the page
  // that answers it says "الجلسة" in one sentence and "معلّقة" in another.
  // Phrase-only matching returned nothing for exactly that kind of query.
  const rawTerms = trimmed.split(/\s+/).filter(Boolean);
  const terms = rawTerms.map(normalizeArabic).filter(Boolean);
  if (terms.length === 0) return [];

  const normalizedPhrase = normalizeArabic(trimmed);
  const results: SearchMatch[] = [];

  for (const page of pages) {
    const rawMd = rawContents[page.file] ?? '';
    const plain = stripMarkdown(rawMd);
    const normalizedTitle = normalizeArabic(page.title);
    const normalizedMeta = normalizeArabic(
      [page.summary ?? '', ...(page.keywords ?? [])].join(' '),
    );
    const normalizedPlain = normalizeArabic(plain);

    const everywhere = `${normalizedTitle} ${normalizedMeta} ${normalizedPlain}`;
    if (!terms.every((t) => everywhere.includes(t))) continue;

    // Score each term where it lands rather than demanding that *all* of them
    // reach the title or the keywords. All-or-nothing scoring flattened the
    // common case — one term in the keywords, one only in the prose — down to
    // the same rank as a page that merely mentions both in passing, and the
    // wrong page came first.
    const hasPhrase = normalizedPlain.includes(normalizedPhrase);
    let score = terms.reduce((sum, t) => {
      if (normalizedTitle.includes(t)) return sum + 3;
      if (normalizedMeta.includes(t)) return sum + 2;
      return sum + 1;
    }, 0);
    if (normalizedTitle.includes(normalizedPhrase)) score += 2;
    else if (hasPhrase) score += 1;

    // Excerpt around the most specific term that actually occurs in the body:
    // the full phrase if present, else the longest single term that hit.
    const bodyTermIndex = terms
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => normalizedPlain.includes(t))
      .sort((a, b) => b.t.length - a.t.length)[0];

    let snippet: string | undefined;
    let matchedTerm = trimmed;
    if (hasPhrase) {
      snippet = buildSnippet(plain, normalizedPlain, normalizedPhrase);
    } else if (bodyTermIndex) {
      snippet = buildSnippet(plain, normalizedPlain, bodyTermIndex.t);
      // Highlighting runs against the raw text, so hand back the term as typed.
      matchedTerm = rawTerms[bodyTermIndex.i];
    }
    // No body hit at all (title/keywords only): the summary still tells the
    // reader what the page is before they open it.
    if (!snippet) snippet = page.summary;

    results.push({
      file: page.file,
      title: page.title,
      section: page.section,
      snippet,
      matchedTerm,
      score,
    });
  }

  // Most relevant first; ties keep the index (reading) order, which is already
  // ordered from introductory to advanced.
  return results.sort((a, b) => b.score - a.score);
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

  // Stable identity: callers put clearQuery in effect/callback dependency lists,
  // and a fresh function each render would re-subscribe the global key handler
  // on every keystroke.
  const clearQuery = useCallback(() => {
    setQuery('');
    setDebouncedQuery('');
  }, []);

  return { query, setQuery, clearQuery, results, isSearching };
}
