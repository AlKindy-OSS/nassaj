/**
 * wikiContent.test.ts — Unit tests for collapseHtmlBlocks.
 *
 * Uses a REAL SVG extracted from docs/team-wiki/00-overview.md (lines 22–212)
 * to avoid the false confidence of synthetic fixtures.
 * See: feedback_synthetic_fixtures_false_confidence.md (memory)
 *
 * INVARIANT verified:
 *   collapseHtmlBlocks collapses blank lines inside <svg>…</svg> so remark
 *   treats the whole tag as one HTML block, and wraps it in a scroll container.
 *   Assumes SVG is balanced, non-nested, and outside code fences.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collapseHtmlBlocks } from './wikiContent';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Load real SVG from 00-overview.md
// ---------------------------------------------------------------------------

const overviewMd = readFileSync(
  resolve(__dirname, '../../../docs/team-wiki/00-overview.md'),
  'utf8',
);

// Extract the first SVG block (lines 22–212 in the actual file)
function extractFirstSvg(markdown: string): string | null {
  const match = /(<svg[\s\S]*?<\/svg>)/.exec(markdown);
  return match ? match[1] : null;
}

const realSvg = extractFirstSvg(overviewMd);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collapseHtmlBlocks — real SVG from 00-overview.md', () => {
  it('extracts a real SVG from 00-overview.md (fixture is not synthetic)', () => {
    expect(realSvg).not.toBeNull();
    expect(realSvg).toContain('<svg');
    expect(realSvg).toContain('</svg>');
    // Must be a real wiki diagram (class="wiki-diagram")
    expect(realSvg).toContain('wiki-diagram');
  });

  it('real SVG contains blank lines (proves the collapse is actually needed)', () => {
    // Without blank lines the fix would be a no-op on real content
    const blankLineCount = (realSvg?.match(/\n{2,}/g) ?? []).length;
    expect(blankLineCount).toBeGreaterThan(0);
  });

  it('wraps SVG in .wiki-diagram-scroll container', () => {
    const markdown = `بعض النص\n\n${realSvg}\n\nبعد السيفي جي`;
    const result = collapseHtmlBlocks(markdown);
    expect(result).toContain('<div class="wiki-diagram-scroll">');
    expect(result).toContain('</div>');
  });

  it('collapses blank lines inside SVG — no \n\n remains inside the svg tag', () => {
    const markdown = `${realSvg}`;
    const result = collapseHtmlBlocks(markdown);

    // Extract the SVG portion from the result (inside the wrapper div)
    const svgMatch = /(<svg[\s\S]*?<\/svg>)/.exec(result);
    expect(svgMatch).not.toBeNull();
    const collapsedSvg = svgMatch![1];

    // No double blank lines should remain inside the SVG
    expect(collapsedSvg).not.toMatch(/\n{2,}/);
  });

  it('does NOT collapse blank lines outside SVG — surrounding markdown preserved', () => {
    const before = 'فقرة قبل\n\nفقرة ثانية';
    const after = '\n\nفقرة بعد\n\nفقرة أخيرة';
    const markdown = `${before}\n\n${realSvg}${after}`;
    const result = collapseHtmlBlocks(markdown);

    // Surrounding content must keep its blank lines
    expect(result).toContain('فقرة قبل\n\nفقرة ثانية');
    expect(result).toContain('فقرة بعد\n\nفقرة أخيرة');
  });

  it('SVG structure is preserved — opening and closing tags intact after collapse', () => {
    const markdown = `${realSvg}`;
    const result = collapseHtmlBlocks(markdown);

    // Extract SVG from result
    const svgMatch = /(<svg[\s\S]*?<\/svg>)/.exec(result);
    const collapsedSvg = svgMatch![1];

    // Opening tag attributes must be intact
    expect(collapsedSvg).toContain('class="wiki-diagram"');
    expect(collapsedSvg).toContain('viewBox=');
    expect(collapsedSvg).toContain('role="img"');
    // Closing tag
    expect(collapsedSvg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('handles markdown with no SVG — returns content unchanged', () => {
    const plain = '# عنوان\n\nفقرة عادية\n\n- عنصر قائمة\n';
    const result = collapseHtmlBlocks(plain);
    expect(result).toBe(plain);
  });
});
