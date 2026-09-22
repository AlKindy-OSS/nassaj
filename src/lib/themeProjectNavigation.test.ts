import { afterEach, describe, expect, it } from 'vitest';

import {
  applyThemePreset, DEFAULT_CUSTOM_COLORS, HIDDEN_PRESETS,
  hexToHslString, hslStringToHex, PRESET_ORDER,
} from './theme-presets';

const read = (name: string) => document.documentElement.style.getPropertyValue(name).trim();
const bubbleKeys = () => Array.from(document.documentElement.style).filter((key) => key.startsWith('--user-bubble-'));
const projectKeys = () => Array.from(document.documentElement.style).filter((key) => key.startsWith('--project-'));
// Alkindy-specific surfaces include the T-1711 action-strip token (10 project keys total).
const surfaces = ['--project-surface', '--project-header-open', '--project-hover', '--project-session-selected', '--project-action-strip'];

function luminance(value: string): number {
  const hex = value.startsWith('#') ? value : hslStringToHex(value);
  const channels = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

afterEach(() => { document.documentElement.style.cssText = ''; });

describe('Alkindy project navigation after the theme guards run', () => {
  const preset = 'alkindy';
  it.each([false, true])('keeps project text and keyboard focus readable (dark=%s)', (dark) => {
    applyThemePreset({ preset, custom: DEFAULT_CUSTOM_COLORS }, dark);
    // T-1711: --project-action-strip is the 10th project token (alkindy only).
    expect(projectKeys()).toHaveLength(10);
    expect(bubbleKeys()).toHaveLength(3);
    for (const foreground of ['--user-bubble-foreground', '--user-bubble-muted-foreground']) {
      expect(contrast(read(foreground), read('--user-bubble-background'))).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of surfaces) {
      for (const foreground of ['--project-foreground', '--project-muted-foreground', '--project-accent']) {
        expect(contrast(read(foreground), read(surface)), `${foreground} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(read('--project-accent'), read(surface))).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(read('--project-accent'), read('--background'))).toBeGreaterThanOrEqual(3);
    const [body, header, selected] = ['--project-surface', '--project-header-open', '--project-session-selected'].map((key) => luminance(read(key)));
    expect(dark ? header > selected && selected > body : header < selected && selected < body).toBe(true);
    // Project navigation colors must not replace the brand's global accents.
    expect(Number(read('--primary').split(' ')[0])).toBe(221);
    expect(Number(read('--brand-accent').split(' ')[0])).toBe(39);
  });

  it.each([...PRESET_ORDER, ...HIDDEN_PRESETS].filter((preset) => preset !== 'alkindy'))('clears alkindy overrides when switching to %s, preserving unrelated variables', (nextPreset) => {
    for (const dark of [false, true]) {
      applyThemePreset({ preset: nextPreset, custom: DEFAULT_CUSTOM_COLORS }, dark);
      const baseline = document.documentElement.style.cssText;
      applyThemePreset({ preset, custom: DEFAULT_CUSTOM_COLORS }, false);
      const lightSurface = read('--project-surface');
      applyThemePreset({ preset, custom: DEFAULT_CUSTOM_COLORS }, true);
      expect(read('--project-surface')).not.toBe(lightSurface);
      document.documentElement.style.setProperty('--unrelated-feature', 'preserved');
      applyThemePreset({ preset: nextPreset, custom: DEFAULT_CUSTOM_COLORS }, dark);
      // T-1705: all presets now carry project tokens; only alkindy bubble tokens are gone.
      if (nextPreset === 'default') {
        expect(projectKeys()).toEqual([]);
      } else {
        expect(projectKeys()).toHaveLength(9);
      }
      expect(bubbleKeys()).toEqual([]);
      expect(read('--unrelated-feature')).toBe('preserved');
      document.documentElement.style.removeProperty('--unrelated-feature');
      expect(document.documentElement.style.cssText).toBe(baseline);
    }
  });
});

// irukhaimi has its own derived project tokens but must not use Alkindy's navy/gold.
describe('irukhaimi brand isolation', () => {
  it.each([false, true])('keeps its own brand accents without Alkindy colour overrides (dark=%s)', (dark) => {
    applyThemePreset({ preset: 'irukhaimi', custom: DEFAULT_CUSTOM_COLORS }, dark);
    // T-1705: irukhaimi now carries derived project tokens (9 keys).
    expect(projectKeys()).toHaveLength(9);
    // Global brand colours must remain hasri-violet / bahja-teal, not Alkindy navy/gold.
    // T-1735: primary hue moved from hikma 201 to hasri 262.
    expect(Number(read('--primary').split(' ')[0])).toBe(262);
    expect(Number(read('--brand-accent').split(' ')[0])).toBe(178);
    // Project accent must not be Alkindy's hand-tuned navy.
    expect(read('--project-accent').toLowerCase()).not.toBe('#293f70');
  });
});


// T-1705: every non-default preset must produce project surfaces ordered by depth.
// Light: surface (lightest) > hover > selected > header-open (darkest)
// Dark:  surface (darkest)  < hover < selected < header-open (most prominent)
describe('All presets — project surface depth ordering', () => {
  const allPresets = [...PRESET_ORDER, ...HIDDEN_PRESETS].filter((p) => p !== 'default');

  it.each(allPresets)('%s satisfies depth ordering in both light and dark modes', (preset) => {
    for (const dark of [false, true]) {
      applyThemePreset({ preset, custom: DEFAULT_CUSTOM_COLORS }, dark);
      const surfaceVal = read('--project-surface');
      const selectedVal = read('--project-session-selected');
      const headerOpenVal = read('--project-header-open');
      // Skip if tokens are absent (only 'default' preset clears them, already excluded).
      if (!surfaceVal || !selectedVal || !headerOpenVal) continue;
      const surfL = luminance(surfaceVal);
      const selL = luminance(selectedVal);
      const headL = luminance(headerOpenVal);
      if (dark) {
        expect(headL, `${preset} dark: header-open must be more prominent than selected`).toBeGreaterThan(selL);
        expect(selL, `${preset} dark: selected must be more prominent than surface`).toBeGreaterThan(surfL);
      } else {
        expect(headL, `${preset} light: header-open must be darker than selected`).toBeLessThan(selL);
        expect(selL, `${preset} light: selected must be darker than surface`).toBeLessThan(surfL);
      }
    }
  });
});

// T-1705 follow-up: for themes with a clearly coloured primary (s ≥ 40 %),
// the derived project surfaces must carry the brand hue — not a neutral grey.
// Only hover/selected/header-open are checked; surface at l=100% is pure white.
describe('All presets — brand hue carried into project surfaces', () => {
  // Presets that have a saturated primary (all named presets except 'default').
  const coloredPresets = [...PRESET_ORDER, ...HIDDEN_PRESETS].filter(
    (p) => p !== 'default',
  );

  function hueDiff(a: number, b: number): number {
    return Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  }

  it.each(coloredPresets)('%s: tinted tokens share the brand hue (both modes)', (preset) => {
    for (const dark of [false, true]) {
      applyThemePreset({ preset, custom: DEFAULT_CUSTOM_COLORS }, dark);
      const primaryTriplet = read('--primary'); // "h s% l%"
      const primaryH = Number(primaryTriplet.split(' ')[0]);
      const primaryS = parseFloat(primaryTriplet.split(' ')[1]);

      // Skip near-achromatic primaries — hue is meaningless below ~40 % sat.
      if (primaryS < 40) continue;

      // hover (l ≈ 97 %) has only 1-unit RGB spread, making the round-trip
      // hue unreliable; check selected (l ≈ 93 %) and header-open (l ≈ 87 %)
      // where saturation is high enough to survive hex quantisation.
      for (const key of [
        '--project-session-selected',
        '--project-header-open',
      ]) {
        const hex = read(key);
        if (!hex) continue;
        const triplet = hexToHslString(hex); // "h s% l%"
        const surfS = parseFloat(triplet.split(' ')[1]);

        // Only assert when the surface itself has measurable saturation.
        if (surfS < 3) continue;

        const surfH = Number(triplet.split(' ')[0]);
        expect(
          hueDiff(surfH, primaryH),
          `${preset} ${dark ? 'dark' : 'light'} ${key}: hue diff`,
        ).toBeLessThanOrEqual(20);
      }
    }
  });
});

describe('Alkindy original unified surfaces', () => {
  it('clears retired surface overrides on every theme and mode', () => {
    const retired = ['--chat-reading-surface', '--app-chrome-surface', '--app-header-surface'];
    for (const preset of [...PRESET_ORDER, ...HIDDEN_PRESETS]) {
      for (const dark of [false, true]) {
        for (const key of retired) document.documentElement.style.setProperty(key, '#ffffff');
        applyThemePreset({ preset, custom: DEFAULT_CUSTOM_COLORS }, dark);
        for (const key of retired) expect(read(key)).toBe('');
      }
    }
  });

  it('restores light bubbles to the actual guarded primary while retaining the dark bubble', () => {
    applyThemePreset({ preset: 'alkindy', custom: DEFAULT_CUSTOM_COLORS }, false);
    expect(hslStringToHex(read('--background')).toLowerCase()).toBe('#f7f7f4');
    for (const key of ['--chat-reading-surface', '--app-chrome-surface', '--app-header-surface']) expect(read(key)).toBe('');
    expect(read('--user-bubble-background')).toBe(hslStringToHex(read('--primary')));
    expect(read('--user-bubble-background').toLowerCase()).toBe('#293f70');
    expect(read('--user-bubble-foreground')).toBe(read('--primary-foreground'));
    expect(read('--user-bubble-muted-foreground')).toBe(read('--primary-foreground'));
    applyThemePreset({ preset: 'alkindy', custom: DEFAULT_CUSTOM_COLORS }, true);
    expect(read('--user-bubble-background')).toBe('#202D45');
  });
});
