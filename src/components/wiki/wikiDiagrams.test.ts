/**
 * wikiDiagrams.test.ts — the typographic rules of §2.2/§2.3 reach inside <svg>.
 *
 * The hand-written diagrams on two of the pages were exempt from every rule the
 * brief sets for the panel, because nothing checked them: 58 of their text nodes
 * named a font family the brief explicitly decided against (§2.3 — one reading
 * face, no second Display family), and 36 sat below the 13px floor that §2.2
 * calls absolute for Arabic, some as small as 10px. They are prose in a picture,
 * not decoration.
 *
 * The colour half of the same problem is a separate rule below: --destructive
 * and --primary are surface tokens, and a diagram label painted with one is a
 * label whose contrast follows the theme's background choices rather than any
 * legibility budget. The dark --destructive reached 1.71:1 that way.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const WIKI_DIR = resolve(here, '../../../docs/team-wiki');

const PAGES = readdirSync(WIKI_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((file) => ({ file, source: readFileSync(resolve(WIKI_DIR, file), 'utf8') }));

/** Every `<text …>` opening tag inside an `<svg>` block, with its page and line. */
function diagramTextTags(): Array<{ file: string; line: number; tag: string }> {
  const found: Array<{ file: string; line: number; tag: string }> = [];
  for (const { file, source } of PAGES) {
    for (const svg of source.match(/<svg[\s\S]*?<\/svg>/g) ?? []) {
      const offset = source.indexOf(svg);
      for (const m of svg.matchAll(/<text\b[^>]*>/g)) {
        const line = source.slice(0, offset + (m.index ?? 0)).split('\n').length;
        found.push({ file, line, tag: m[0] });
      }
    }
  }
  return found;
}

const TEXT_TAGS = diagramTextTags();

/** Surface tokens that must never be a text fill. */
const SURFACE_TOKENS = [
  'hsl(var(--destructive))',
  'hsl(var(--primary))',
  'hsl(var(--card))',
  'hsl(var(--muted))',
  'hsl(var(--background))',
];

describe('wiki diagram text', () => {
  it('there are diagram labels to check', () => {
    // Without this the three assertions below pass on an empty list the day the
    // glob, the directory or the <svg> shape changes.
    expect(TEXT_TAGS.length).toBeGreaterThan(40);
  });

  it('names no font family of its own', () => {
    const offenders = TEXT_TAGS.filter((t) => /font-family=/.test(t.tag)).map(
      (t) => `${t.file}:${t.line}`,
    );
    expect(
      offenders,
      'diagram labels inherit --wiki-font-reading; a font-family attribute opts them out',
    ).toEqual([]);
  });

  it('sets no size below the 13px Arabic floor', () => {
    const offenders = TEXT_TAGS.flatMap((t) => {
      const m = t.tag.match(/font-size="([\d.]+)"/);
      if (!m || Number(m[1]) >= 13) return [];
      return [`${t.file}:${t.line} → ${m[1]}px`];
    });
    expect(offenders).toEqual([]);
  });

  it('paints no label with a surface token', () => {
    const offenders = TEXT_TAGS.flatMap((t) => {
      const m = t.tag.match(/fill="([^"]*)"/);
      if (!m) return [];
      const fill = m[1].trim();
      const bad = SURFACE_TOKENS.some((token) => fill.startsWith(token.slice(0, -1)));
      return bad ? [`${t.file}:${t.line} → ${fill}`] : [];
    });
    expect(
      offenders,
      'use --wiki-diagram-ok / -info / -danger, which are measured as text colours',
    ).toEqual([]);
  });
});
