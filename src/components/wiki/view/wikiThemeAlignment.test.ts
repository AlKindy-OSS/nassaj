/**
 * wikiThemeAlignment.test.ts
 *
 * "Someone moving between the chat and the wiki should not feel they changed
 * application." These are the parts of that sentence a machine can hold.
 *
 * It reads wiki-panel.css as TEXT, deliberately. jsdom computes no layout and
 * resolves no custom property, so any getComputedStyle assertion here would
 * pass on an empty string and guard nothing (the same reason
 * wikiHeadingHierarchy.test.ts reads the file). Measured contrast belongs to
 * the live browser pass; what belongs here is the shape of the declarations.
 *
 * Three regressions are pinned:
 *  1. The reintroduction of a wiki-only border token (B-121's scope, which
 *     WCAG 1.4.11 never asked for).
 *  2. A shadow derived from --foreground — which is near-white in every dark
 *     theme, so it renders as a white halo rather than a shadow.
 *  3. A focus ring that is not the app's own --ring.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const viewDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(viewDir, 'wiki-panel.css'), 'utf8');
const tocSource = readFileSync(join(viewDir, 'TableOfContents.tsx'), 'utf8');

/** Stylesheet with comments removed — they quote the very patterns banned. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('wiki borders speak the app palette', () => {
  it('the retired tokens are gone, name and value', () => {
    // §9 item 30: grep equals zero, definition and use alike.
    expect(rules).not.toContain('--wiki-border-ui');
    expect(rules).not.toContain('--wiki-border-strong');
  });

  it('the single border token is the app token, not a wiki-only recipe', () => {
    expect(rules).toMatch(/--wiki-border:\s*hsl\(var\(--border\)\)/);
    // A tinted --foreground border is exactly the thing that "screamed".
    expect(rules).not.toMatch(/--wiki-border:\s*hsl\(var\(--foreground\)/);
  });

  it('no static border in the island is a --foreground tint', () => {
    const offenders = rules
      .split('\n')
      .filter((line) => /border[a-z-]*(-color)?\s*:/.test(line))
      .filter((line) => /hsl\(var\(--foreground\)/.test(line));

    expect(
      offenders,
      `these paint a border from --foreground instead of --border: ${offenders.join(' | ')}`,
    ).toHaveLength(0);
  });

  it('the three state indicators keep their 2px edge — 1.4.11 does apply to them', () => {
    // Active index row, active TOC row, selected search result. These are
    // states, which is precisely what the criterion covers.
    const bars = rules.match(/border-inline-start:\s*2px solid/g) ?? [];
    expect(bars.length).toBeGreaterThanOrEqual(3);
    expect(rules).toMatch(
      /\[data-wiki-drawer\] \[data-wiki-nav-row\]\[aria-current="page"\] > \.nassaj-control__surface[\s\S]{0,260}border-inline-start-color:\s*var\(--wiki-active-fg\)/,
    );
  });

  it('the compensation for quieter rules is actually declared', () => {
    // §3.5.4 — structure by surface, since the lines no longer carry it.
    expect(rules).toMatch(/thead\s*{\s*background-color/);
    expect(rules).toMatch(/tbody tr:hover\s*{\s*background-color/);
    expect(rules).toMatch(/backdrop-filter:\s*blur/);
  });
});

describe('wiki shadows are shadows, not halos', () => {
  const shadowTokens = rules.match(/--wiki-shadow-[a-z]+:\s*[^;]+;/g) ?? [];

  it('all six elevation tokens are declared', () => {
    // Three in light, three overridden in dark.
    expect(shadowTokens).toHaveLength(6);
  });

  it('every one of them is black, never a --foreground tint', () => {
    for (const token of shadowTokens) {
      expect(token, `not black: ${token}`).toMatch(/hsl\(0 0% 0% \/ 0\.\d+\)/);
      expect(token, `derived from --foreground: ${token}`).not.toContain('--foreground');
    }
  });

  it('dark mode raises the opacity rather than inverting the colour', () => {
    const dark = rules.slice(rules.indexOf('.dark [data-wiki-panel]'));
    const restDark = /--wiki-shadow-rest:\s*0 1px 2px hsl\(0 0% 0% \/ (0\.\d+)\)/.exec(dark);
    expect(restDark).not.toBeNull();
    expect(Number(restDark![1])).toBeGreaterThan(0.06);
  });
});

describe('the focus ring is the app ring', () => {
  it('--wiki-focus reads --ring', () => {
    expect(rules).toMatch(/--wiki-focus:\s*hsl\(var\(--ring\)\)/);
    expect(rules).not.toMatch(/--wiki-focus:\s*hsl\(var\(--foreground\)\)/);
  });

  it('the island paints exactly one ring rule, on :focus-visible only', () => {
    expect(rules).toMatch(/:focus-visible[\s\S]{0,180}outline:\s*2px solid var\(--wiki-focus\)/);
  });
});

describe('wiki TOC density', () => {
  it('keeps rows at 40px without additive padding and expands touch rows to 44px', () => {
    expect(rules).toMatch(
      /\[data-wiki-toc\] \[data-wiki-toc-row\] \{[\s\S]{0,320}padding-block:\s*0;/,
    );
    expect(rules).toMatch(
      /\[data-wiki-toc\] \[data-wiki-toc-row\] \{[\s\S]{0,180}min-block-size:\s*2\.5rem;[\s\S]{0,80}block-size:\s*2\.5rem;/,
    );
    expect(rules).toMatch(
      /@media \(any-pointer:\s*coarse\)[\s\S]{0,240}block-size:\s*2\.75rem;/,
    );
  });

  it('keeps the inline disclosure root and surface exactly 44px high', () => {
    expect(rules).toMatch(
      /\[data-wiki-toc-inline\] > button \{[\s\S]{0,260}min-block-size:\s*2\.75rem;[\s\S]{0,80}block-size:\s*2\.75rem;/,
    );
    expect(rules).toMatch(
      /\[data-wiki-toc-inline\] > button > \.nassaj-control__surface \{[\s\S]{0,160}block-size:\s*2\.75rem;/,
    );
  });

  it('clips a long real-world heading inside a shrinkable text node', () => {
    const longHeading = 'عنوان طويل '.repeat(10).trim();
    expect(longHeading.length).toBeGreaterThan(94);
    expect(tocSource).toContain('<span data-wiki-toc-text title={entry.text}>{entry.text}</span>');
    expect(rules).toMatch(
      /\[data-wiki-toc-text\] \{[\s\S]{0,80}flex:\s*1;[\s\S]{0,80}min-inline-size:\s*0;[\s\S]{0,100}overflow:\s*hidden;[\s\S]{0,100}text-overflow:\s*ellipsis;[\s\S]{0,100}white-space:\s*nowrap;/,
    );
    expect(rules).toMatch(
      /\[data-wiki-toc\] \[data-wiki-toc-row\] > \.nassaj-control__surface \{[\s\S]{0,180}min-inline-size:\s*0;[\s\S]{0,100}overflow:\s*hidden;/,
    );
  });
});
