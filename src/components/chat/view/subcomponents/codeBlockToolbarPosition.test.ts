/**
 * codeBlockToolbarPosition.test.ts — B-274: the code-block toolbar sits at the
 * end of the block, and a logical inset cannot put it there.
 *
 * What the owner saw: the Execute and Copy buttons pinned to the BOTTOM-LEFT of
 * a code block instead of the bottom-right.
 *
 * Why the obvious reading was wrong. The toolbar used `end-2`, the wrapper
 * already hard-set `dir="ltr"`, and a comment written on 2026-07-27 explained
 * that this combination pins the bar to the right. It does not, and the reason
 * is not a specificity contest:
 *
 *   tailwindcss-rtl emits TWO descendant rules per logical utility —
 *     [dir=rtl] .end-2 { left:  .5rem }
 *     [dir=ltr] .end-2 { right: .5rem }
 *   An Arabic message carries dir="rtl" ABOVE the code block, and an ancestor
 *   matches a descendant selector no matter how distant, so BOTH rules apply.
 *   They are not competing declarations that the cascade resolves — they set
 *   DIFFERENT PROPERTIES, so both stick: left:8px AND right:8px. An absolutely
 *   positioned element with both insets and width:auto stretches the full width,
 *   and its flex content then lands at the inline start — the left.
 *
 * Measured in a browser against the real built CSS, with the real nesting
 * (html[dir=ltr] > div[dir=rtl] > div[dir=ltr] > toolbar):
 *   before — left 8px, right 8px, box stretched to 1280px, content at x=8
 *   after  — right 8px only, intrinsic width 101px, 8px from the right edge
 *
 * So inside this deliberately-LTR island the PHYSICAL inset is the correct and
 * honest expression of «the end of the block», and it is immune because the
 * plugin generates no direction variants for physical utilities. Everything in
 * this file that follows the page direction stays logical.
 *
 * These are source guards: the defect lives in which CSS class is emitted, which
 * a jsdom render cannot observe (jsdom applies no stylesheets).
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../../../..');

const source = readFileSync(resolve(__dirname, 'Markdown.tsx'), 'utf8');

/** The absolutely-positioned children of the code-block wrapper. */
const toolbar = /className="absolute[^"]*bottom-2[^"]*"/.exec(source)?.[0] ?? '';
const langLabel = /className="absolute[^"]*top-2 z-10 text-xs font-medium[^"]*"/.exec(source)?.[0] ?? '';

describe('B-274 — the toolbar is anchored with a physical inset', () => {
  it('the guarded elements are actually found in the source', () => {
    // Otherwise every assertion below would pass against an empty string.
    expect(toolbar).toContain('absolute');
    expect(langLabel).toContain('absolute');
  });

  it('pins the toolbar to the right, not to a logical end', () => {
    expect(toolbar).toMatch(/\bright-2\b/);
    // `end-2` is what produced left:8px AND right:8px together.
    expect(toolbar).not.toMatch(/\bend-2\b/);
  });

  it('pins the language label to the left, not to a logical start', () => {
    expect(langLabel).toMatch(/\bleft-3\b/);
    expect(langLabel).not.toMatch(/\bstart-3\b/);
  });

  it('keeps the wrapper explicitly LTR — the physical insets assume it', () => {
    // If this ever becomes direction-following, the physical insets become wrong
    // and this file's whole justification collapses.
    expect(source).toMatch(/className="group relative my-2" dir="ltr"/);
  });

  it('records the deliberate exception for the design gate', () => {
    // The repo hook blocks physical positioning in RTL files by default; this
    // marker is the documented conscious override, and it must stay attached to
    // the reasoning rather than be silently dropped.
    expect(source).toContain('design-ok:');
  });
});

describe('B-274 — the exception stays confined to the LTR island', () => {
  it('does not spread physical insets through the rest of the file', () => {
    // Only the two elements above may be physical. Anything else that follows
    // the page direction must stay logical, or Arabic layout regresses.
    const physical = [...source.matchAll(/className="[^"]*\b(left|right)-\d[^"]*"/g)].map((m) => m[0]);
    expect(physical).toHaveLength(2);
  });

  it('still uses logical spacing utilities elsewhere', () => {
    // e.g. the dismiss button's `-me-0.5` — direction-following margins are
    // unaffected by this fix and must not be "corrected" to physical ones.
    expect(source).toMatch(/\bme-\d|\bms-\d|-me-|-ms-/);
  });
});

describe('B-274 — the plugin that caused it is still installed', () => {
  const tailwindConfig = readFileSync(resolve(REPO, 'tailwind.config.js'), 'utf8');

  it('tailwindcss-rtl is present, so the two-rule behaviour still applies', () => {
    // The day this plugin is dropped, logical utilities become plain
    // inset-inline-* and the physical exception above can be reconsidered.
    expect(tailwindConfig).toContain('tailwindcss-rtl');
  });
});
