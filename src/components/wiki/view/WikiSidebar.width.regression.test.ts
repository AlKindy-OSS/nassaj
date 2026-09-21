/**
 * WikiSidebar.width.regression.test.ts
 *
 * Guards the fix for the dead index toggle.
 *
 * THE BUG: WikiSidebar composed its desktop width from Tailwind utilities —
 * `md:w-56` / `md:w-0` chosen by the open state, sitting in the same class list
 * as an unconditional `md:w-auto`. All three are single-class selectors, so the
 * cascade resolved them by stylesheet order, and Tailwind emits `w-auto` after
 * the numeric scale. `md:w-auto` therefore won in both states: on desktop the
 * toolbar button toggled nothing but `overflow`, i.e. it did nothing at all.
 *
 * WHY A SOURCE GUARD: the existing B-122 suite already asserts that clicking the
 * toggle flips `data-wiki-drawer` between "open" and "closed" — and it passed
 * throughout, because the attribute was never the broken part. jsdom computes no
 * layout, so no render-based assertion in this suite can see a width that never
 * changes. The only durable check is that the width is not expressed as
 * conflicting utilities in the first place.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

// readFileSync, not `?raw`: Vite's CSS pipeline claims .css imports before the
// raw loader sees them, so `wiki-panel.css?raw` resolves to an empty string and
// every assertion below would pass vacuously. The B-122 suite in this directory
// reads source the same way.
const here = dirname(fileURLToPath(import.meta.url));
const sidebarSrc = readFileSync(resolve(here, 'WikiSidebar.tsx'), 'utf8');
const panelCss = readFileSync(resolve(here, 'wiki-panel.css'), 'utf8');

/** The className array on the <nav>, i.e. everything the cascade has to resolve. */
function navClassList(src: string): string {
  const start = src.indexOf('data-wiki-drawer=');
  expect(start, 'WikiSidebar must still render data-wiki-drawer').toBeGreaterThan(-1);
  // Walk back to the className array that precedes the attribute.
  const classNameAt = src.lastIndexOf('className={[', start);
  expect(classNameAt, 'the <nav> must still build className from an array').toBeGreaterThan(-1);
  return src.slice(classNameAt, start);
}

describe('WikiSidebar — desktop width is CSS-driven (dead-toggle regression)', () => {
  it('the <nav> declares no responsive width utility', () => {
    const classes = navClassList(sidebarSrc);
    // Any md:/lg:/xl: width utility here re-opens the ordering hazard, whether or
    // not it currently happens to win.
    const offenders = classes.match(/\b(?:md|lg|xl|2xl):w-[^\s'"`]+/g) ?? [];
    expect(offenders, `responsive width utilities on the drawer: ${offenders.join(', ')}`)
      .toHaveLength(0);
  });

  it('the <nav> declares no transform utility that would fight the mobile slide', () => {
    const classes = navClassList(sidebarSrc);
    const offenders = classes.match(/\b(?:md|lg|xl|2xl):transform-none\b/g) ?? [];
    expect(offenders).toHaveLength(0);
  });

  it('wiki-panel.css sets the open and collapsed widths on nav[data-wiki-drawer]', () => {
    // Element-qualified (0,1,1) so it outranks any single utility class (0,1,0)
    // rather than depending on emit order.
    expect(panelCss).toMatch(/nav\[data-wiki-drawer\]\s*\{[^}]*width:/);
    expect(panelCss).toMatch(/nav\[data-wiki-drawer="closed"\]\s*\{[^}]*width:\s*0/);
  });

  it('the collapsed column is hidden from assistive tech and the tab order', () => {
    // width:0 + overflow:hidden still leaves children focusable by keyboard.
    expect(panelCss).toMatch(
      /nav\[data-wiki-drawer="closed"\]\s*\{[^}]*visibility:\s*hidden/,
    );
  });

  it('the desktop rule cancels the mobile translate', () => {
    expect(panelCss).toMatch(/nav\[data-wiki-drawer\]\s*\{[^}]*transform:\s*none/);
  });

  it('uses the root as a full-width hitbox and the surface as the single visual row', () => {
    expect(panelCss).toMatch(
      /\[data-wiki-drawer\] \[data-wiki-nav-row\]\s*\{[^}]*inline-size:\s*100%[^}]*padding:\s*0[^}]*border:\s*0/,
    );
    expect(panelCss).toMatch(
      /\[data-wiki-drawer\] \[data-wiki-nav-row\] > \.nassaj-control__surface\s*\{[^}]*inline-size:\s*100%[^}]*justify-content:\s*flex-start[^}]*white-space:\s*normal/,
    );
    expect(panelCss).toMatch(
      /\[data-wiki-nav-row\] > \.nassaj-control__surface > span\s*\{[^}]*min-inline-size:\s*0[^}]*text-align:\s*start/,
    );
  });
});
