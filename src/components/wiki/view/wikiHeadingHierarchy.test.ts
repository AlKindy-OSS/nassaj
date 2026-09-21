/**
 * wikiHeadingHierarchy.test.ts — the rule three reviews could not see.
 *
 * Every check we had was ABSOLUTE: is this colour a system token, does this
 * pair reach 4.5:1, is this text at least 13px. The index shipped with its
 * section titles painted the same --muted-foreground as the page rows beneath
 * them, two points SMALLER, and passed all of them — because each element was
 * fine on its own and the defect lived in the relation between two of them.
 * A differential rule needs a differential test.
 *
 * The rule, for each (heading, first thing it heads) pair:
 *   1. the heading is never smaller than what it introduces, and
 *   2. the two differ on at least two independent axes of size / weight /
 *      colour — one axis is a difference the eye reads as noise.
 *
 * Values are read out of wiki-panel.css, not out of the DOM: jsdom parses the
 * cascade but computes no layout and resolves no custom properties, so a
 * getComputedStyle assertion here would pass against an empty string. The
 * stylesheet is the artefact that ships, so the stylesheet is what is asserted.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

// readFileSync, not `?raw`: Vite's CSS pipeline claims .css imports before the
// raw loader sees them, so `wiki-panel.css?raw` resolves to an empty string and
// every assertion below would pass vacuously. Same reason as the width guard
// next door.
const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(here, 'wiki-panel.css'), 'utf8');

// ---------------------------------------------------------------------------
// A deliberately small CSS reader: top-level rules only.
// ---------------------------------------------------------------------------

type Declarations = Record<string, string>;

/** Top-level (selector → declarations) blocks, in source order. */
function parseTopLevelRules(css: string): Array<[string, Declarations]> {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Array<[string, Declarations]> = [];

  let depth = 0;
  let start = 0; // start of the current selector text
  let blockStart = 0;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      if (depth === 0) blockStart = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const selector = source.slice(start, blockStart).trim();
        // Skip at-rules (@media, @keyframes): their bodies are nested rules,
        // and nothing this test asserts is declared inside one.
        if (!selector.startsWith('@')) {
          rules.push([selector, parseDeclarations(source.slice(blockStart + 1, i))]);
        }
        start = i + 1;
      }
    }
  }
  return rules;
}

function parseDeclarations(body: string): Declarations {
  const out: Declarations = {};
  for (const part of body.split(';')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (prop && value) out[prop] = value;
  }
  return out;
}

const RULES = parseTopLevelRules(CSS);

/**
 * Merges every rule whose selector list contains one of `selectors`, in source
 * order — a stand-in for the cascade that is adequate because all the selectors
 * compared here are of equal specificity.
 */
function declarationsFor(selectors: string[]): Declarations {
  const merged: Declarations = {};
  for (const [selectorText, decls] of RULES) {
    const list = selectorText.split(',').map((s) => s.trim());
    if (!selectors.some((wanted) => list.includes(wanted))) continue;
    Object.assign(merged, decls);
  }
  return merged;
}

type Style = { fontSize: number; fontWeight: number; color: string };

function styleOf(name: string, selectors: string[]): Style {
  const d = declarationsFor(selectors);
  expect(Object.keys(d).length, `no rule found for ${name}`).toBeGreaterThan(0);
  expect(d['font-size'], `${name} declares no font-size`).toBeTruthy();
  expect(d['color'], `${name} declares no color`).toBeTruthy();
  return {
    fontSize: parseFloat(d['font-size']),
    // An undeclared weight is 400 — which is exactly the case that produced the
    // defect, so it must be modelled rather than skipped.
    fontWeight: d['font-weight'] ? parseInt(d['font-weight'], 10) : 400,
    color: d['color'],
  };
}

// ---------------------------------------------------------------------------
// The pairs
// ---------------------------------------------------------------------------

type Pair = {
  label: string;
  heading: { name: string; selectors: string[] };
  subordinate: { name: string; selectors: string[] };
};

const PAIRS: Pair[] = [
  {
    label: 'index section title ↔ page row',
    heading: {
      name: '[data-wiki-section-title]',
      selectors: ['[data-wiki-drawer] [data-wiki-section-title]'],
    },
    subordinate: {
      name: '[data-wiki-nav-row]',
      selectors: ['[data-wiki-drawer] [data-wiki-nav-row] > .nassaj-control__surface'],
    },
  },
  {
    label: 'table-of-contents heading ↔ its rows',
    heading: {
      name: '[data-wiki-toc-heading]',
      selectors: ['[data-wiki-toc-rail] [data-wiki-toc-heading]'],
    },
    subordinate: {
      name: '[data-wiki-toc-row][data-level="2"]',
      selectors: [
        '[data-wiki-toc] [data-wiki-toc-row]',
        '[data-wiki-toc] [data-wiki-toc-row][data-level="2"]',
      ],
    },
  },
  {
    label: 'prev/next direction label ↔ section name',
    heading: {
      name: '[data-wiki-prevnext-label]',
      selectors: ['[data-wiki-prevnext-card] [data-wiki-prevnext-label]'],
    },
    subordinate: {
      name: '[data-wiki-prevnext-section]',
      selectors: ['[data-wiki-prevnext-card] [data-wiki-prevnext-section]'],
    },
  },
];

describe('wiki heading hierarchy', () => {
  it.each(PAIRS)('$label — the heading is not smaller', ({ heading, subordinate }) => {
    const h = styleOf(heading.name, heading.selectors);
    const s = styleOf(subordinate.name, subordinate.selectors);
    expect(
      h.fontSize,
      `${heading.name} (${h.fontSize}rem) is smaller than ${subordinate.name} (${s.fontSize}rem)`,
    ).toBeGreaterThanOrEqual(s.fontSize);
  });

  it.each(PAIRS)('$label — they differ on two axes', ({ heading, subordinate }) => {
    const h = styleOf(heading.name, heading.selectors);
    const s = styleOf(subordinate.name, subordinate.selectors);

    const axes = {
      size: h.fontSize !== s.fontSize,
      weight: h.fontWeight !== s.fontWeight,
      colour: h.color !== s.color,
    };
    const differing = Object.entries(axes)
      .filter(([, changed]) => changed)
      .map(([axis]) => axis);

    expect(
      differing.length,
      `${heading.name} and ${subordinate.name} differ only on [${differing.join(', ')}]: ` +
        `${h.fontSize}rem/${h.fontWeight}/${h.color} vs ${s.fontSize}rem/${s.fontWeight}/${s.color}`,
    ).toBeGreaterThanOrEqual(2);
  });

  // Guards the guard: if the parser ever silently stops finding rules, every
  // assertion above would still "pass" on empty objects were it not for the
  // explicit checks in styleOf — this pins the parser itself to a known value.
  it('reads declared values out of the stylesheet', () => {
    const row = styleOf('nav row', [
      '[data-wiki-drawer] [data-wiki-nav-row] > .nassaj-control__surface',
    ]);
    expect(row.fontSize).toBe(0.9375);
    expect(row.fontWeight).toBe(400);
    expect(row.color).toBe('hsl(var(--muted-foreground))');
  });
});
