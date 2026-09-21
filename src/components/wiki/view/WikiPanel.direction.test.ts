/**
 * WikiPanel.direction.test.ts
 *
 * Guards a single reading direction for the whole wiki.
 *
 * THE BUG: the panel root followed the interface language (`dir={i18n.dir()}`)
 * while the index list, the home cards, the breadcrumb and the article each
 * pinned `dir="rtl"` of their own. With an English UI the shell laid out LTR —
 * index column on the left — around content that was individually forced RTL,
 * so half the screen read one way and half the other.
 *
 * THE RULE: every wiki page is an Arabic-only markdown file bundled at build
 * time. There is nothing here for a non-Arabic reader, so the panel is rtl/ar
 * end to end and every child inherits it. Exactly one element declares the
 * direction; the search dialog is the sole exception because it is portalled to
 * document.body and therefore inherits nothing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const viewDir = dirname(fileURLToPath(import.meta.url));
const wikiDir = resolve(viewDir, '..');

/**
 * Source with comments removed. These files explain the direction rule — and
 * the bug that motivated it — in prose that quotes the very patterns being
 * banned, so matching raw text would fail on its own documentation.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every wiki .tsx source, excluding tests. */
function wikiSources(): { name: string; src: string }[] {
  const out: { name: string; src: string }[] = [];
  for (const dir of [wikiDir, viewDir, join(wikiDir, 'markdown')]) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.tsx') || f.includes('.test.')) continue;
      out.push({ name: f, src: code(readFileSync(join(dir, f), 'utf8')) });
    }
  }
  return out;
}

/** Portalled outside the panel, so it must declare its own direction. */
const PORTALLED = 'WikiSearchOverlay.tsx';

describe('wiki reading direction', () => {
  it('the panel root pins rtl/ar literally, not from the interface language', () => {
    const panel = code(readFileSync(resolve(viewDir, 'WikiPanel.tsx'), 'utf8'));
    expect(panel).toContain('dir="rtl"');
    expect(panel).toContain('lang="ar"');
    // Reading the direction from the interface language is what split the
    // layout; it must not come back.
    expect(panel).not.toMatch(/dir=\{[^}]*i18n/);
  });

  /**
   * The invariant is NOT "no dir anywhere". It is that direction is decided by
   * the language of the text, never by the interface preference — the latter is
   * what split the shell from the content.
   *
   * A literal `dir` is allowed. A `dir` computed from the interface language or
   * from the retired label preference is not, anywhere.
   */
  it('no component derives dir from the interface language or the label setting', () => {
    const offenders = wikiSources()
      .flatMap((f) =>
        [...f.src.matchAll(/\bdir=\{([^}]*)\}/g)].map((m) => ({ file: f.name, expr: m[1] })),
      )
      // A literal `dir="ltr"` / `dir="rtl"` never matches this pattern at all —
      // only an interpolated expression does, and only some of those are wrong.
      // `labelDir` is the fixed direction of the Arabic label text itself, so
      // using it is the content-follows-direction rule, not a violation of it.
      .filter(({ expr }) => !/^\s*labelDir\s*$/.test(expr))
      .filter(({ expr }) => /i18n|language|locale|uiLang|wikiLang|isTranslated|langAttr/i.test(expr))
      .map(({ file, expr }) => `${file}: dir={${expr}}`);

    expect(
      offenders,
      `direction must follow the text, not the setting:\n${offenders.join('\n')}`,
    ).toHaveLength(0);
  });

  it('only the panel root and the portalled dialog set a layout-level dir', () => {
    // Everything else that pins a direction must be pinning it for a run of
    // text, not for a container that lays other components out.
    const LAYOUT_OWNERS = new Set(['WikiPanel.tsx', PORTALLED]);
    const TEXT_RUN_EXCEPTIONS = new Set([
      // Arabic sentence runs carrying the fixed `dir={labelDir}`: the landing
      // blurb and the two desk-panel summaries.
      'WikiHome.tsx',
    ]);

    const offenders = wikiSources()
      .filter((f) => !LAYOUT_OWNERS.has(f.name) && !TEXT_RUN_EXCEPTIONS.has(f.name))
      .filter((f) => /\bdir=/.test(f.src))
      .map((f) => f.name);

    expect(
      offenders,
      `these pin a direction without being a layout owner or a known text run: ${offenders.join(', ')}`,
    ).toHaveLength(0);
  });

  it('the portalled search dialog pins rtl for itself', () => {
    const overlay = code(readFileSync(resolve(viewDir, PORTALLED), 'utf8'));
    expect(overlay).toContain('dir="rtl"');
    expect(overlay).not.toMatch(/dir=\{[^}]*i18n/);
  });

  it('the index column is the first child of the panel row, so it sits at the start', () => {
    const panel = code(readFileSync(resolve(viewDir, 'WikiPanel.tsx'), 'utf8'));
    // In an RTL row the start edge is the right — which is where the index
    // belongs. Ordering is what puts it there, so <WikiSidebar> must precede
    // the <main> content area.
    const sidebarAt = panel.indexOf('<WikiSidebar');
    const mainAt = panel.indexOf('<main');
    expect(sidebarAt).toBeGreaterThan(-1);
    expect(mainAt).toBeGreaterThan(-1);
    expect(sidebarAt).toBeLessThan(mainAt);
  });
});
