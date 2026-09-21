/**
 * themePrimaryContrast.test.ts — WCAG 2.2 §1.4.3 for `--primary` as text on
 * every surface the product actually ships.
 *
 * Why this file exists: `--primary` is a brand fill colour tuned to look right
 * *as a fill* (buttons, badges, active states). On three light presets — claude
 * (3.37), cursor (3.89), codex (4.10) — and three dark presets — cursor (4.20),
 * gemini (3.70), alkindy (4.26) — it falls under 4.5:1 when used as text on
 * muted/secondary/card surfaces. No check ever measured it *as text*; the
 * existing ring guard only covers the focus indicator.
 *
 * The guard is a full cross-product: 6 presets × 2 modes × 5 surfaces. It
 * asserts the shipped value, read back off documentElement exactly as the
 * browser would, rather than re-deriving it.
 *
 * The `default` preset deliberately sets no JS tokens — it clears them so
 * src/index.css takes over — so its values are read from that stylesheet. The
 * guard does not (and cannot) rewrite CSS; the default dark primary is a
 * pre-existing issue tracked separately.
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
  return luminanceChannels(channels(+m[1], +m[2], +m[3]));
}

function luminanceChannels(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseChannels(token: string): [number, number, number] {
  const m = token.trim().match(/^(-?[\d.]+)\s+(-?[\d.]+)%\s+(-?[\d.]+)%$/);
  if (!m) throw new Error(`not an HSL token: "${token}"`);
  return channels(+m[1], +m[2], +m[3]);
}

function alphaContrast(foreground: string, background: string, alpha: number): number {
  const fg = parseChannels(foreground);
  const bg = parseChannels(background);
  const blended = fg.map((value, index) => value * alpha + bg[index] * (1 - alpha)) as [number, number, number];
  const x = luminanceChannels(blended);
  const y = luminanceChannels(bg);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function parseHslL(token: string): number {
  const m = token.trim().match(/^(-?[\d.]+)\s+(-?[\d.]+)%\s+(-?[\d.]+)%$/);
  if (!m) throw new Error(`not an HSL token: "${token}"`);
  return +m[3];
}

/* ───────────────────────── the default preset ────────────────────── */

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css');
const css = readFileSync(cssPath, 'utf8');

/** Pulls a token out of the `:root` or `.dark` block of index.css. */
function cssToken(name: string, dark: boolean): string {
  const base = css.indexOf('@layer base');
  const selector = dark ? '  .dark {' : '  :root {';
  const start = css.indexOf(selector, base);
  if (start < 0) throw new Error(`${selector.trim()} not found in index.css`);
  const open = css.indexOf('{', start);
  let depth = 1;
  let end = open + 1;
  while (end < css.length && depth > 0) {
    if (css[end] === '{') depth += 1;
    if (css[end] === '}') depth -= 1;
    end += 1;
  }
  const scope = css.slice(open + 1, end - 1);
  const m = scope.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`${name} not found in index.css (${dark ? '.dark' : ':root'})`);
  return m[1].trim();
}

/* ─────────────────────────────── the guard ───────────────────────── */

/** Every surface `--primary` can be rendered on as text. */
const SURFACES = ['--background', '--card', '--popover', '--muted', '--secondary'] as const;

const MIN = 4.5;

function tokensFor(preset: ThemePresetId, dark: boolean): Record<string, string> {
  applyThemePreset({ preset, custom: DEFAULT_CUSTOM_COLORS }, dark);
  const style = document.documentElement.style;
  const read = (k: string) => style.getPropertyValue(k).trim() || cssToken(k, dark);
  const out: Record<string, string> = { '--primary': read('--primary') };
  for (const s of SURFACES) out[s] = read(s);
  return out;
}

/**
 * Presets the guard actually touches. `default` is no longer in PRESET_ORDER
 * (hidden from the picker, still a valid stored preset) and it derives no JS
 * tokens anyway — the two `default` cases below cover it from index.css.
 */
const GUARDED_PRESETS: ThemePresetId[] = [...PRESET_ORDER];

describe('primary text clears WCAG 1.4.3 on every guarded preset, mode and surface', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = '';
  });

  // 5 guarded presets × 2 modes × 5 surfaces = 50 measurements
  for (const preset of GUARDED_PRESETS) {
    for (const dark of [false, true]) {
      const label = `${preset} / ${dark ? 'dark' : 'light'}`;

      it(`${label}: --primary is ≥ ${MIN}:1 against all ${SURFACES.length} surfaces`, () => {
        const tokens = tokensFor(preset, dark);
        const measured = SURFACES.map((s) => ({
          surface: s,
          ratio: contrast(tokens['--primary'], tokens[s]),
        }));
        const failures = measured.filter((m) => m.ratio < MIN);

        expect(
          failures,
          `${label} — primary ${tokens['--primary']} fails on: ` +
            failures.map((f) => `${f.surface} ${f.ratio.toFixed(2)}`).join(', '),
        ).toHaveLength(0);
      });
    }
  }

  it('default light reads from CSS and passes (4.76 on all surfaces)', () => {
    const tokens = tokensFor('default', false);
    for (const s of SURFACES) {
      expect(contrast(tokens['--primary'], tokens[s]), `default light vs ${s}`).toBeGreaterThanOrEqual(MIN);
    }
  });

  it('default dark reads from CSS — pre-existing issue, guard does not apply', () => {
    const tokens = tokensFor('default', true);
    // Document the current CSS value; do not assert ≥ 4.5 because the guard
    // intentionally does not rewrite CSS tokens.
    expect(tokens['--primary']).toBe('217.2 91.2% 59.8%');
    const measured = SURFACES.map((s) => ({
      surface: s,
      ratio: contrast(tokens['--primary'], tokens[s]),
    }));
    // Worst case is muted/secondary at ~3.97 — a pre-existing CSS issue.
    const worst = Math.min(...measured.map((m) => m.ratio));
    expect(worst).toBeGreaterThanOrEqual(3.9);
    expect(worst).toBeLessThan(4.5);
  });

  it('a user-chosen custom accent is corrected too, not just the shipped presets', () => {
    // Mid-grey on near-white: far below 4.5:1. The solver has to move it darker.
    applyThemePreset(
      {
        preset: 'custom',
        custom: { accent: '210 8% 72%', background: '0 0% 100%', foreground: '0 0% 10%' },
      },
      false,
    );
    const style = document.documentElement.style;
    const primary = style.getPropertyValue('--primary').trim();
    for (const s of SURFACES) {
      const surface = style.getPropertyValue(s).trim();
      if (!surface) continue;
      expect(contrast(primary, surface), `custom accent vs ${s}`).toBeGreaterThanOrEqual(MIN);
    }
  });

  it('claude light was 3.37 — the guard darkens it to ~43%', () => {
    applyThemePreset({ preset: 'claude', custom: DEFAULT_CUSTOM_COLORS }, false);
    const style = document.documentElement.style;
    const primary = style.getPropertyValue('--primary').trim();
    const l = parseHslL(primary);
    // brandPrimary for claude light clamps to 55%; the guard must push it down.
    expect(l).toBeLessThan(55);
    expect(l).toBeGreaterThanOrEqual(42);
    expect(l).toBeLessThanOrEqual(44);
    for (const s of SURFACES) {
      const surface = style.getPropertyValue(s).trim() || cssToken(s, false);
      expect(contrast(primary, surface), `claude light vs ${s}`).toBeGreaterThanOrEqual(MIN);
    }
  });

  it('cursor light was 3.89 — the guard darkens it to ~45%', () => {
    applyThemePreset({ preset: 'cursor', custom: DEFAULT_CUSTOM_COLORS }, false);
    const style = document.documentElement.style;
    const primary = style.getPropertyValue('--primary').trim();
    const l = parseHslL(primary);
    // brandPrimary for cursor light produces 52%; the guard must push it down.
    expect(l).toBeLessThan(52);
    expect(l).toBeGreaterThanOrEqual(44);
    expect(l).toBeLessThanOrEqual(46);
    for (const s of SURFACES) {
      const surface = style.getPropertyValue(s).trim() || cssToken(s, false);
      expect(contrast(primary, surface), `cursor light vs ${s}`).toBeGreaterThanOrEqual(MIN);
    }
  });

  it('codex light was 4.10 — the guard darkens it to ~27%', () => {
    applyThemePreset({ preset: 'codex', custom: DEFAULT_CUSTOM_COLORS }, false);
    const style = document.documentElement.style;
    const primary = style.getPropertyValue('--primary').trim();
    const l = parseHslL(primary);
    // brandPrimary for codex light clamps to 30% (greenDarken pulls it down);
    // the guard must push it below the brandPrimary floor to pass.
    expect(l).toBeLessThan(30);
    expect(l).toBeGreaterThanOrEqual(26);
    expect(l).toBeLessThanOrEqual(28);
    for (const s of SURFACES) {
      const surface = style.getPropertyValue(s).trim() || cssToken(s, false);
      expect(contrast(primary, surface), `codex light vs ${s}`).toBeGreaterThanOrEqual(MIN);
    }
  });

  it('cursor dark was 4.20 — the guard lightens it to ~61%', () => {
    applyThemePreset({ preset: 'cursor', custom: DEFAULT_CUSTOM_COLORS }, true);
    const style = document.documentElement.style;
    const primary = style.getPropertyValue('--primary').trim();
    const l = parseHslL(primary);
    // brandPrimary for cursor dark produces ~58.1%; the guard must push it up.
    expect(l).toBeGreaterThan(58.1);
    expect(l).toBeGreaterThanOrEqual(60);
    expect(l).toBeLessThanOrEqual(62);
    for (const s of SURFACES) {
      const surface = style.getPropertyValue(s).trim() || cssToken(s, true);
      expect(contrast(primary, surface), `cursor dark vs ${s}`).toBeGreaterThanOrEqual(MIN);
    }
  });

  it('gemini dark was 3.70 — the guard lightens it to ~64.5%', () => {
    applyThemePreset({ preset: 'gemini', custom: DEFAULT_CUSTOM_COLORS }, true);
    const style = document.documentElement.style;
    const primary = style.getPropertyValue('--primary').trim();
    const l = parseHslL(primary);
    // brandPrimary for gemini dark produces ~58.5%; the guard must push it up.
    expect(l).toBeGreaterThan(58.5);
    expect(l).toBeGreaterThanOrEqual(63);
    expect(l).toBeLessThanOrEqual(66);
    for (const s of SURFACES) {
      const surface = style.getPropertyValue(s).trim() || cssToken(s, true);
      expect(contrast(primary, surface), `gemini dark vs ${s}`).toBeGreaterThanOrEqual(MIN);
    }
  });

  it('alkindy dark was 4.26 — the guard lightens it to ~67%', () => {
    applyThemePreset({ preset: 'alkindy', custom: DEFAULT_CUSTOM_COLORS }, true);
    const style = document.documentElement.style;
    const primary = style.getPropertyValue('--primary').trim();
    const l = parseHslL(primary);
    // brandPrimary for alkindy dark produces ~58.1%; the guard must push it up.
    expect(l).toBeGreaterThan(58.1);
    expect(l).toBeGreaterThanOrEqual(65);
    expect(l).toBeLessThanOrEqual(68);
    for (const s of SURFACES) {
      const surface = style.getPropertyValue(s).trim() || cssToken(s, true);
      expect(contrast(primary, surface), `alkindy dark vs ${s}`).toBeGreaterThanOrEqual(MIN);
    }
  });

  it('light-mode passing presets (alkindy/default/gemini) move ≤ 0.5% in l', () => {
    for (const preset of ['alkindy', 'default', 'gemini'] as ThemePresetId[]) {
      applyThemePreset({ preset, custom: DEFAULT_CUSTOM_COLORS }, false);
      const style = document.documentElement.style;
      const primary = style.getPropertyValue('--primary').trim() || cssToken('--primary', false);
      const l = parseHslL(primary);
      // These presets already pass in light mode; the guard should not move them.
      // default reads from CSS (58.3%), alkindy ~30%, gemini ~50%
      if (preset === 'alkindy') {
        // alkindy light primary from brandPrimary: clamp(20, 30, 55) = 30
        expect(Math.abs(l - 30), `${preset} light l delta`).toBeLessThanOrEqual(0.5);
      } else if (preset === 'gemini') {
        // gemini light base: 217 89% 50%, greenDarken=0, l=50
        expect(Math.abs(l - 50), `${preset} light l delta`).toBeLessThanOrEqual(0.5);
      } else {
        // default light from CSS: 221.2 83.2% 53.3%
        expect(Math.abs(l - 53.3), `${preset} light l delta`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('the correction moves lightness only — hue and saturation are the brand', () => {
    applyThemePreset({ preset: 'claude', custom: DEFAULT_CUSTOM_COLORS }, false);
    const style = document.documentElement.style;
    const primary = style.getPropertyValue('--primary').trim().split(/\s+/);
    // claude base hue=15, saturation=62 (rounded by fmt)
    expect(primary[0], 'hue').toBe('15');
    expect(primary[1], 'saturation').toBe('62%');
    expect(+primary[2].replace('%', ''), 'lightness should have moved down from 55').toBeLessThan(55);
  });

  it('primary-foreground is updated when primary changes', () => {
    applyThemePreset({ preset: 'claude', custom: DEFAULT_CUSTOM_COLORS }, false);
    const style = document.documentElement.style;
    const primaryL = parseHslL(style.getPropertyValue('--primary').trim());
    const fg = style.getPropertyValue('--primary-foreground').trim();
    // readableFg returns white when bgL < 55
    if (primaryL < 55) {
      expect(fg).toBe('0 0% 100%');
    } else {
      expect(fg).toBe('222 47% 11%');
    }
  });

  it('full primary foreground stays legible as 11px user-bubble metadata in product themes', () => {
    const measured: Array<{ label: string; ratio: number }> = [];
    for (const preset of ['alkindy', 'nawras', 'irukhaimi'] as ThemePresetId[]) {
      for (const dark of [false, true]) {
        applyThemePreset({ preset, custom: DEFAULT_CUSTOM_COLORS }, dark);
        const style = document.documentElement.style;
        const primary = style.getPropertyValue('--primary').trim();
        const foreground = style.getPropertyValue('--primary-foreground').trim();
        const ratio = alphaContrast(foreground, primary, 1);
        measured.push({ label: `${preset} / ${dark ? 'dark' : 'light'}`, ratio });
      }
    }
    const failures = measured.filter(({ ratio }) => ratio < MIN);
    expect(
      failures,
      failures.map(({ label, ratio }) => `${label}: ${ratio.toFixed(3)}:1`).join(', '),
    ).toHaveLength(0);
  });
});
