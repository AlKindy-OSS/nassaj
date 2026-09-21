/**
 * WikiPanel.logicalDirection.test.ts
 *
 * Guards the AXIS half of B-123. WikiPanel.direction.test.ts already guards the
 * other half — who gets to declare `dir`. This file guards what happens after
 * that: whether the layout trusts the direction it declared.
 *
 * THE DEBT: the panel used to declare `dir="rtl"` and then not believe it. It
 * mixed logical `text-start` with a forcing physical `text-align: right`, pinned
 * drawer edges with `right-0`, and patched icons with `rtl:rotate-180` — roughly
 * forty-five sites arguing with each other across two axes. The root cause was
 * that `<html>` carried no `dir`, so logical utilities resolved LTR and every
 * logical declaration was decoration with no effect; the physical overrides were
 * the only thing actually working. Once the direction became real, the overrides
 * became the bug.
 *
 * The T-1094 rewrite discharged all of it. Nothing guarded it afterwards, which
 * is what this file is for: the debt is cheap to reintroduce one utility at a
 * time, and every individual reintroduction looks locally reasonable.
 *
 * WHY THIS IS NOT "BAN PHYSICAL PROPERTIES". Four physical declarations are
 * correct and are meant to stay. Three of them are inside the `direction: ltr`
 * code island, where the physical edge IS the semantic one; the fourth is the
 * mobile drawer, where `tailwindcss-rtl` compiles a logical inset into `left: 0;
 * right: 0` — both edges at once — and stretches the drawer across the viewport.
 * That one was measured live at 390px, not reasoned about. An absolute ban would
 * have to be suppressed at exactly the places that matter, which is how a guard
 * becomes noise.
 *
 * So the guard is differential, in two layers:
 *
 *   Layer A — a physical directional declaration must carry a `design-ok`
 *             rationale. Catches the thoughtless paste.
 *   Layer B — the SET of selectors allowed to carry one is pinned. Catches the
 *             thoughtful paste: copying the `design-ok` marker along with the
 *             declaration does not buy an exemption, because the allowlist is
 *             what grants it and the allowlist lives here.
 *
 * Layer B is the load-bearing one. Layer A alone is a magic word.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

const viewDir = dirname(fileURLToPath(import.meta.url));
const wikiDir = resolve(viewDir, '..');
const cssPath = resolve(viewDir, 'wiki-panel.css');

/**
 * Source with comments removed.
 *
 * These files document the very patterns they ban — `rtl:rotate-180`,
 * "right-hand column", "left-to-right" — in prose explaining why the pattern is
 * gone. Matching raw text would fail on the documentation of the fix rather than
 * on the fix being undone, which is the classic way a guard earns its removal.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every wiki .ts/.tsx source, excluding tests. */
function wikiSources(): { name: string; src: string }[] {
  const out: { name: string; src: string }[] = [];
  for (const dir of [wikiDir, viewDir, join(wikiDir, 'markdown')]) {
    for (const f of readdirSync(dir)) {
      if (!/\.tsx?$/.test(f) || f.includes('.test.')) continue;
      out.push({ name: f, src: stripComments(readFileSync(join(dir, f), 'utf8')) });
    }
  }
  return out;
}

/* ── Layer B: the pinned allowlist ─────────────────────────────────────────
 *
 * Selectors permitted to carry a physical directional declaration, each with
 * the reason it is not a logical-property miss. Adding an entry here is the
 * deliberate act; the `design-ok` comment at the point of use is the audit
 * trail, not the permission.
 */
const PHYSICAL_ALLOWLIST = new Map<string, string>([
  // The LTR code island itself (`.wiki-article pre, code, kbd, samp`) is NOT
  // listed: its only physical declaration is `text-align: left`, which is
  // governed by the stricter rule further down — physical alignment is legal
  // only in a block that pins `direction: ltr` in the same breath, which that
  // rule does. Listing it here as well would let the weaker permission stand in
  // for the stronger one.
  [
    '.wiki-article [data-wiki-copy]',
    'Floats over the LTR code island from an RTL article. A logical inset resolves ' +
      'against whichever direction it inherits — the RTL wrapper — and lands on the ' +
      "first character of the code. The code's end edge is physically right.",
  ],
  [
    'nav[data-wiki-drawer]',
    'tailwindcss-rtl compiles a logical inset to `left: 0; right: 0`, stretching the ' +
      'drawer across the viewport. Measured live at 390px.',
  ],
  [
    '[dir="rtl"] nav[data-wiki-drawer]',
    'The RTL half of the same measured pair.',
  ],
]);

/** Physical directional properties. Block-axis (`top`/`bottom`) is not directional. */
const PHYSICAL_PROPS =
  /^(left|right|margin-left|margin-right|padding-left|padding-right|border-left(-[a-z]+)?|border-right(-[a-z]+)?|float|clear|border-top-left-radius|border-top-right-radius|border-bottom-left-radius|border-bottom-right-radius)$/;

type Decl = { prop: string; value: string };
type Rule = { selector: string; body: string; decls: Decl[]; designOk: boolean; line: number };

/**
 * Parse the stylesheet into rules, each tagged with whether a `design-ok`
 * rationale governs it.
 *
 * A rule is governed if the marker appears in its own body, or in the nearest
 * preceding comment with no OTHER comment in between. The second form is what
 * lets one rationale cover the drawer's `ltr`/`rtl` pair, which is written as
 * two adjacent rules under a single explanation.
 *
 * `[^{}]*` cannot span a brace, so an `@media` prelude never swallows the rules
 * inside it: the outer match fails and the scan resumes at the inner rules.
 */
function parseRules(css: string): Rule[] {
  const comments = [...css.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => ({
    end: m.index! + m[0].length,
    designOk: m[0].includes('design-ok'),
  }));

  const rules: Rule[] = [];
  for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    // A match starts right after the previous `}`, so its prelude carries any
    // comment written above the rule. Strip those out of the selector — they are
    // read separately, below, as the rule's rationale.
    const selector = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Skip at-rule preludes that carry no declarations of their own.
    if (!selector || selector.startsWith('@')) continue;
    const body = m[2];

    // Comments up to the opening brace, so a rationale written in the prelude
    // counts as governing the rule it sits above.
    const braceAt = m.index! + m[1].length;
    const preceding = comments.filter((c) => c.end <= braceAt).pop();
    const designOk = body.includes('design-ok') || Boolean(preceding?.designOk);

    const decls: Decl[] = [];
    for (const d of body.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
      const at = d.indexOf(':');
      if (at === -1) continue;
      decls.push({ prop: d.slice(0, at).trim().toLowerCase(), value: d.slice(at + 1).trim() });
    }

    rules.push({
      selector,
      body,
      decls,
      designOk,
      line: css.slice(0, m.index!).split('\n').length,
    });
  }
  return rules;
}

describe('wiki logical direction (B-123)', () => {
  const css = readFileSync(cssPath, 'utf8');
  const rules = parseRules(css);

  it('parses the stylesheet it is meant to be guarding', () => {
    // A parser that silently matches nothing turns every assertion below into a
    // green light over an unread file — the exact shape of a guard that passes
    // because it never ran.
    expect(rules.length).toBeGreaterThan(50);
    expect(rules.some((r) => r.decls.some((d) => d.prop === 'text-align'))).toBe(true);
    expect(rules.some((r) => r.designOk)).toBe(true);
  });

  /* ── Layer A ─────────────────────────────────────────────────────────── */

  it('every physical directional declaration carries a design-ok rationale', () => {
    const offenders = rules
      .filter((r) => r.decls.some((d) => PHYSICAL_PROPS.test(d.prop)) && !r.designOk)
      .map(
        (r) =>
          `wiki-panel.css:${r.line} ${r.selector} — ` +
          r.decls
            .filter((d) => PHYSICAL_PROPS.test(d.prop))
            .map((d) => `${d.prop}: ${d.value}`)
            .join('; '),
      );

    expect(
      offenders,
      'use the logical form, or explain the exception with a `design-ok:` comment ' +
        `and add the selector to PHYSICAL_ALLOWLIST:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  /* ── Layer B ─────────────────────────────────────────────────────────── */

  it('only the pinned selectors carry a physical directional declaration', () => {
    const actual = [
      ...new Set(
        rules
          .filter((r) => r.decls.some((d) => PHYSICAL_PROPS.test(d.prop)))
          .map((r) => r.selector),
      ),
    ].sort();

    expect(
      actual,
      'a `design-ok` comment is an audit trail, not a permission. Pinning a new ' +
        'physical edge is a deliberate act: measure it in a browser, then add the ' +
        'selector to PHYSICAL_ALLOWLIST with the measurement as its reason.',
    ).toEqual([...PHYSICAL_ALLOWLIST.keys()].sort());
  });

  /* ── The literal B-123 defect ────────────────────────────────────────── */

  it('no rule forces text-align to a physical side against the inherited direction', () => {
    // `text-align: right` was the signature of the debt: the panel declaring rtl
    // and then re-stating it physically in case the declaration did not take.
    // There is no legitimate use — in RTL, `start` already IS right, and in an
    // LTR island `right` would be actively wrong.
    const forcedRight = rules
      .filter((r) => r.decls.some((d) => d.prop === 'text-align' && d.value === 'right'))
      .map((r) => `wiki-panel.css:${r.line} ${r.selector}`);

    expect(
      forcedRight,
      `use \`text-align: start\` and trust the direction:\n${forcedRight.join('\n')}`,
    ).toEqual([]);

    // `text-align: left` is legitimate in exactly one situation: a rule that
    // pins `direction: ltr` itself, where left IS the start. Anywhere else it is
    // the same defect facing the other way.
    const strandedLeft = rules
      .filter(
        (r) =>
          r.decls.some((d) => d.prop === 'text-align' && d.value === 'left') &&
          !r.decls.some((d) => d.prop === 'direction' && d.value === 'ltr'),
      )
      .map((r) => `wiki-panel.css:${r.line} ${r.selector}`);

    expect(
      strandedLeft,
      'physical `left` alignment is only correct in a rule that pins `direction: ltr` ' +
        `in the same block:\n${strandedLeft.join('\n')}`,
    ).toEqual([]);
  });

  it('horizontal motion takes its sign from --dir', () => {
    // translateX has no logical twin, so an unsigned one is a slide that goes
    // the right way in exactly one direction. `--dir` is defined on the island
    // rather than :root because <html> follows the interface language and may be
    // LTR while the panel is RTL.
    const offenders = [...css.matchAll(/translateX\(([^)]*(?:\([^)]*\))?[^)]*)\)/g)]
      .map((m) => m[1].trim())
      .filter((arg) => !/var\(\s*--dir/.test(arg) && !/^0[a-z%]*$/.test(arg));

    expect(
      offenders,
      `multiply by var(--dir) so the slide follows the reading direction: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  /* ── The component half ──────────────────────────────────────────────── */

  it('no component uses a physical directional utility', () => {
    // The utilities that made up the bulk of the ~45 sites. Matched only at a
    // class-string boundary, so `border-r` does not fire on `border-red-500` and
    // prose is excluded by stripComments above.
    const PHYSICAL_UTILITY =
      /(?:^|[\s"'`{])-?(?:ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|left|right|inset-l|inset-r)-(?:\[[^\]]+\]|[0-9]+(?:\.[0-9]+)?|px|full|auto|reverse)\b|(?:^|[\s"'`{])text-(?:left|right)\b|(?:^|[\s"'`{])float-(?:left|right)\b/g;

    const offenders = wikiSources().flatMap((f) =>
      [...f.src.matchAll(PHYSICAL_UTILITY)].map((m) => `${f.name}: ${m[0].trim()}`),
    );

    expect(
      offenders,
      'the panel is rtl end to end — use the logical utility (ms-/me-/ps-/pe-/' +
        `start-/end-/text-start/text-end):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('no component patches direction with an rtl:/ltr: variant', () => {
    // A direction variant on a permanently-RTL surface is a branch with one live
    // arm. `rtl:rotate-180` was the icon half of the debt: pick the glyph that
    // already points the right way instead of picking the wrong one and
    // reversing it — a transform that double-applies if the component ever
    // renders inside a second RTL wrapper.
    const offenders = wikiSources().flatMap((f) =>
      [...f.src.matchAll(/(?:^|[\s"'`{])-?(?:rtl|ltr):[a-z0-9:[\]./-]+/g)].map(
        (m) => `${f.name}: ${m[0].trim()}`,
      ),
    );

    expect(
      offenders,
      'the wiki panel is always rtl: choose the correct glyph or write the rule in ' +
        `wiki-panel.css, do not mirror at the call site:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
