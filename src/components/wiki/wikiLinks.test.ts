/**
 * wikiLinks.test.ts — link integrity across the shipped wiki pages.
 *
 * Every internal link is a promise that a page exists. AnchorLink renders an
 * unresolvable target as plain text, which is honest to the reader but silent to
 * the author — nobody finds out a link died until someone tries to follow it.
 * Renaming or splitting a page is exactly when that happens, and the wiki was
 * reorganised wholesale at least once.
 *
 * These assertions run against the real content, so on a node with no team-wiki
 * content they simply have nothing to check and pass trivially.
 */

import { describe, it, expect } from 'vitest';

import { PAGES, SECTIONS, RAW_BY_FILE } from './wikiContent';
import { extractHeadings, extractToc } from './wikiUtils';

/** Markdown links to a local .md file, with an optional #fragment. */
const INTERNAL_LINK = /\]\((?:\.\/)?([0-9A-Za-z._-]+\.md)(?:#([^)]*))?\)/g;

type Link = { from: string; file: string; fragment?: string };

const links: Link[] = [];
for (const [from, raw] of Object.entries(RAW_BY_FILE)) {
  for (const m of raw.matchAll(INTERNAL_LINK)) {
    links.push({ from, file: m[1], fragment: m[2] });
  }
}

const known = new Set(PAGES.map((p) => p.file));

describe('wiki index integrity', () => {
  it('every page named in the index has content bundled for it', () => {
    const missing = PAGES.filter((p) => !RAW_BY_FILE[p.file]).map((p) => p.file);
    expect(missing, `index names pages with no markdown file: ${missing.join(', ')}`)
      .toHaveLength(0);
  });

  it('every generated TOC contains real H2 headings only, never fenced templates', () => {
    for (const [file, raw] of Object.entries(RAW_BY_FILE)) {
      const toc = extractToc(raw);
      expect(toc.every((entry) => entry.level === 2), file).toBe(true);
    }
    const updates = extractToc(RAW_BY_FILE['00-updates.md'] ?? '');
    expect(updates.map((entry) => entry.text)).not.toContain('الإصدار X.x.x.x — اليوم الشهر السنة');
  });

  it('assigns unique ids to repeated headings and ignores fenced lookalikes', () => {
    const markdown = '# صفحة\n## مكرر\n```md\n## مكرر\n```\n## مكرر\n';
    expect(extractHeadings(markdown).map(({ id }) => id)).toEqual(['صفحه', 'مكرر', 'مكرر-2']);
    expect(extractToc(markdown).map(({ id }) => id)).toEqual(['مكرر', 'مكرر-2']);
  });

  it('no page is listed twice', () => {
    const files = PAGES.map((p) => p.file);
    expect(files).toHaveLength(new Set(files).size);
  });

  it('every section has a title and at least one page', () => {
    for (const section of SECTIONS) {
      expect(section.pages.length, `section ${section.id} is empty`).toBeGreaterThan(0);
      // The legacy flat index folds into one deliberately untitled section; a v2
      // section without a title would render a nameless group in the nav.
      if (SECTIONS.length > 1) {
        expect(section.title, `section ${section.id} has no title`).toBeTruthy();
      }
    }
  });
});

describe('wiki internal links', () => {
  it('every internal link points at a page in the index', () => {
    const broken = links
      .filter((l) => !known.has(l.file))
      .map((l) => `${l.from} → ${l.file}`);
    expect(broken, `broken wiki links:\n${broken.join('\n')}`).toHaveLength(0);
  });

  it('every cross-page fragment matches a heading on the target page', () => {
    const broken: string[] = [];
    for (const l of links) {
      if (!l.fragment || !known.has(l.file)) continue;
      const target = RAW_BY_FILE[l.file];
      if (!target) continue;
      const ids = new Set(extractToc(target).map((e) => e.id));
      if (!ids.has(l.fragment)) {
        broken.push(`${l.from} → ${l.file}#${l.fragment}`);
      }
    }
    expect(broken, `links to headings that do not exist:\n${broken.join('\n')}`).toHaveLength(0);
  });
});
