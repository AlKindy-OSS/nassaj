/**
 * wikiNumerals.test.ts — one numeral system per screen, enforced.
 *
 * Why this exists: the wiki is Arabic prose wrapped around a technical product,
 * so every page inevitably carries Latin-script material it cannot rewrite —
 * `502`, `Ctrl+Shift+R`, `2026-07-27`, ports, versions, task ids. When a numbered
 * heading is typed as `### ١.` next to that material, the same paragraph shows two
 * numeral systems at once. That is the one near-absolute rule in the house Arabic
 * policy (arabic-rtl-excellence): Western digits `0123` are the default for Nassaj
 * products, and mixing `0123` with `٠١٢٣` on a single screen is never acceptable.
 *
 * All nineteen pages were mixed until they were converted wholesale. Nothing in the
 * build or the renderer notices a relapse — Arabic-Indic digits render perfectly
 * well, they just look wrong beside the Latin ones — so a single new `### ١.` typed
 * out of habit would quietly reintroduce the defect. This test is the only thing
 * standing between that habit and the shipped wiki.
 *
 * Fenced and inline code is exempt on purpose: a code span may be a verbatim command,
 * a path, or captured output, and rewriting characters inside it would change meaning
 * rather than presentation.
 *
 * Like wikiLinks.test.ts, this runs against the real bundled content, so on a node
 * with no team-wiki content it has nothing to check and passes trivially.
 */

import { describe, it, expect } from 'vitest';

import { RAW_BY_FILE } from './wikiContent';

/**
 * Arabic-Indic digits ٠-٩ (U+0660–U+0669) plus the Arabic decimal separator,
 * thousands separator and percent sign, which belong to the same typographic set
 * and look equally out of place next to Western digits.
 */
const EASTERN_NUMERALS = /[٠-٩٫٬٪]/;

/** Fence openers/closers: ``` or ~~~ (any length ≥ 3), optionally indented. */
const FENCE = /^\s*(`{3,}|~{3,})/;

/** Inline code spans — a run of backticks, content, matching-ish closing run. */
const INLINE_CODE = /`+[^`]*?`+/g;

type Offence = { file: string; line: number; text: string };

/** Lines outside fenced blocks, with inline code spans blanked out. */
function proseLines(markdown: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fence: string | null = null;

  markdown.split('\n').forEach((raw, i) => {
    const opener = FENCE.exec(raw);
    if (opener) {
      const marker = opener[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return; // the fence line itself is code punctuation, never prose
    }
    if (fence !== null) return;
    out.push({ line: i + 1, text: raw.replace(INLINE_CODE, '') });
  });

  return out;
}

const offences: Offence[] = [];
for (const [file, raw] of Object.entries(RAW_BY_FILE)) {
  for (const { line, text } of proseLines(raw)) {
    if (EASTERN_NUMERALS.test(text)) offences.push({ file, line, text: text.trim() });
  }
}

describe('wiki numerals', () => {
  it('uses Western digits 0123 everywhere outside code', () => {
    const report = offences.map((o) => `${o.file}:${o.line}  ${o.text}`).join('\n');
    expect(
      offences,
      `Arabic-Indic numerals found in wiki prose — convert them to 0123 ` +
        `(code spans are exempt):\n${report}`,
    ).toHaveLength(0);
  });
});
