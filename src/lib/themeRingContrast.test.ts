/**
 * themeRingContrast.test.ts — WCAG 2.2 §1.4.11 for the focus ring, on every
 * preset the product actually ships.
 *
 * Why this file exists: `--ring` was `--brand-accent` verbatim, and a brand
 * fill color had never been checked *as a ring*. Two of six presets were under
 * 3:1 — alkindy light at 2.63 and gemini dark at 2.76 — and neither was caught,
 * for two reasons worth naming:
 *
 *  1. The check that existed was against `--background` alone. Both failures
 *     are on `--muted`/`--secondary`; both PASS on `--background` (2.86, 3.77).
 *     A focused control sits on cards, popovers and muted rows too.
 *  2. Only the alkindy preset was ever measured. The other five were argued
 *     from "they follow the same tokens" — which is a claim about the code, not
 *     a measurement of the output.
 *
 * So the guard is a full cross-product: 6 presets × 2 modes × 5 surfaces. It
 * asserts the shipped value, read back off documentElement exactly as the
 * browser would, rather than re-deriving it.
 *
 * The `default` preset deliberately sets no JS tokens — it clears them so
 * src/index.css takes over — so its values are read from that stylesheet.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CUSTOM_COLORS,
  PRESET_ORDER,
  applyThemePreset,
  type ThemePresetId,
} from './theme-presets';

/* ────────────────────────── contrast math ────────────────────────── */

function channels(h: number, s: number, l: number): [number, number, number] {
  const S = s / 100;
  const L = l / 100;
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = L - c / 2;
  const sextant: [number, number, number][] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r, g, b] = sextant[Math.floor(hue / 60) % 6];
  return [r + m, g + m, b + m];
}

function luminance(token: string): number {
  const m = token.trim().match(/^(-?[\d.]+)\s+(-?[\d.]+)%\s+(-?[\d.]+)%$/);
  if (!m) throw new Error(`not an HSL token: "${token}"`);
  const [r, g, b] = channels(+m[1], +m[2], +m[3]).map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* ───────────────────────── the default preset ────────────────────── */

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css');
const css = readFileSync(cssPath, 'utf8');

/**
 * Pulls a token out of the `:root` or `.dark` theme block inside `@layer base`.
 * It reads the selector's own brace-delimited block (B-644): slicing the sheet
 * at the first `.dark` broke as soon as a `.dark …` rule sat before `:root`,
 * which index.css now has, so "light" read no tokens and "dark" read light ones.
 */
function cssToken(name: string, dark: boolean, sheet: string = css): string {
  const base = sheet.indexOf('@layer base');
  const selector = dark ? '  .dark {' : '  :root {';
  const start = base < 0 ? -1 : sheet.indexOf(selector, base);
  if (start < 0) throw new Error(`${selector.trim()} not found in index.css`);
  const open = sheet.indexOf('{', start);
  let depth = 1;
  let end = open + 1;
  while (end < sheet.length && depth > 0) {
    if (sheet[end] === '{') depth += 1;
    if (sheet[end] === '}') depth -= 1;
    end += 1;
  }
  const scope = sheet.slice(open + 1, end - 1);
  const m = scope.match(new RegExp(`(?:^|[\\s;])${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`${name} not found in index.css (${dark ? '.dark' : ':root'})`);
  return m[1].trim();
}

describe('the index.css token reader (B-644)', () => {
  it('reads each theme block even when a .dark rule comes before :root', () => {
    const sheet = [
      '.dark { --ring: 9 9% 99%; }',
      '.dark .voice-mic-live svg { --ring: 8 8% 88%; }',
      '@layer base {',
      '  :root {',
      '    --ring: 1 1% 11%;',
      '    --nested-ring: 3 3% 33%;',
      '  }',
      '  .dark {',
      '    --ring: 2 2% 22%;',
      '  }',
      '}',
    ].join('\n');
    expect(cssToken('--ring', false, sheet)).toBe('1 1% 11%');
    expect(cssToken('--ring', true, sheet)).toBe('2 2% 22%');
    expect(() => cssToken('--ring', true, sheet.replace('  .dark {', '  .other {'))).toThrow(/not found/);
  });

  it('the shipped sheet has that shape, and its light and dark backgrounds differ', () => {
    expect(css.indexOf('.dark')).toBeLessThan(css.indexOf('@layer base'));
    expect(cssToken('--background', false)).not.toBe(cssToken('--background', true));
  });
});

/* ─────────────────────────────── the guard ───────────────────────── */

/** Every surface a focused control can be rendered on. */
const SURFACES = ['--background', '--card', '--popover', '--muted', '--secondary'] as const;

const MIN = 3;

function tokensFor(preset: ThemePresetId, dark: boolean): Record<string, string> {
  applyThemePreset({ preset, custom: DEFAULT_CUSTOM_COLORS }, dark);
  const style = document.documentElement.style;
  const read = (k: string) => style.getPropertyValue(k).trim() || cssToken(k, dark);
  const out: Record<string, string> = { '--ring': read('--ring') };
  for (const s of SURFACES) out[s] = read(s);
  return out;
}

describe('the focus ring clears WCAG 1.4.11 on every preset, mode and surface', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = '';
  });

  for (const preset of PRESET_ORDER) {
    for (const dark of [false, true]) {
      const label = `${preset} / ${dark ? 'dark' : 'light'}`;

      it(`${label}: --ring is ≥ ${MIN}:1 against all ${SURFACES.length} surfaces`, () => {
        const tokens = tokensFor(preset, dark);
        const measured = SURFACES.map((s) => ({
          surface: s,
          ratio: contrast(tokens['--ring'], tokens[s]),
        }));
        const failures = measured.filter((m) => m.ratio < MIN);

        expect(
          failures,
          `${label} — ring ${tokens['--ring']} fails on: ` +
            failures.map((f) => `${f.surface} ${f.ratio.toFixed(2)}`).join(', '),
        ).toHaveLength(0);
      });
    }
  }

  it('a user-chosen custom accent is corrected too, not just the six presets', () => {
    // Mid-grey on near-white: 1.6:1 as a fill. The solver has to move it.
    applyThemePreset(
      {
        preset: 'custom',
        custom: { accent: '210 8% 72%', background: '0 0% 100%', foreground: '0 0% 10%' },
      },
      false,
    );
    const style = document.documentElement.style;
    const ring = style.getPropertyValue('--ring').trim();
    for (const s of SURFACES) {
      const surface = style.getPropertyValue(s).trim();
      if (!surface) continue;
      expect(contrast(ring, surface), `custom accent vs ${s}`).toBeGreaterThanOrEqual(MIN);
    }
  });

  it('a preset that already passes keeps its brand value untouched', () => {
    // codex dark measures 12.55 on --background — nothing should move.
    applyThemePreset({ preset: 'codex', custom: DEFAULT_CUSTOM_COLORS }, true);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--ring').trim()).toBe(
      style.getPropertyValue('--brand-accent').trim(),
    );
  });

  it('the correction moves lightness only — hue and saturation are the brand', () => {
    applyThemePreset({ preset: 'alkindy', custom: DEFAULT_CUSTOM_COLORS }, false);
    const style = document.documentElement.style;
    const ring = style.getPropertyValue('--ring').trim().split(/\s+/);
    const accent = style.getPropertyValue('--brand-accent').trim().split(/\s+/);
    expect(ring[0], 'hue').toBe(accent[0]);
    expect(ring[1], 'saturation').toBe(accent[1]);
    expect(ring[2], 'lightness should have moved').not.toBe(accent[2]);
  });
});
