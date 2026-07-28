/**
 * Theme presets — brand-tinted color theme engine.
 *
 * Derived from the `claudecodeui-plugin-enhanced-appearance` plugin v0.6.0
 * (AlKindy OSS, Apache 2.0 — https://github.com/AlKindy-OSS), ported into the
 * app as a native feature. Dark mode and RTL are owned by ThemeContext /
 * RtlContext respectively; this module only derives and applies the brand
 * color tokens on top of the host stylesheet.
 *
 * The "default" preset removes every managed variable so the canonical
 * definitions in `src/index.css` (:root / .dark) take over again.
 */

import { resolveIsDark } from './theme-mode';

export type ThemePresetId = 'default' | 'claude' | 'alkindy' | 'cursor' | 'codex' | 'gemini' | 'custom';

export interface CustomColors {
  /** HSL triplets in shadcn format, e.g. "221 83% 53%". */
  accent: string;
  background: string;
  foreground: string;
}

export interface ThemePresetState {
  preset: ThemePresetId;
  custom: CustomColors;
}

export const THEME_PRESET_STORAGE_KEY = 'nassaj-theme-preset';

export const DEFAULT_CUSTOM_COLORS: CustomColors = {
  accent: '221 83% 53%',
  background: '0 0% 100%',
  foreground: '222 47% 11%',
};

/**
 * Presets offered in the picker, in display order. `custom` is intentionally
 * absent: it is hidden from the UI but remains a valid stored preset
 * (see KNOWN_PRESETS) so existing users keep their custom theme.
 */
export const PRESET_ORDER: ThemePresetId[] = [
  'default',
  'alkindy',
  'claude',
  'cursor',
  'codex',
  'gemini',
];

type Hsl = { h: number; s: number; l: number };
type Mode = 'light' | 'dark';

/* ────────────────────────── HSL utilities ────────────────────────── */

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

function parseHsl(input: string): Hsl {
  const m = String(input)
    .trim()
    .match(/^(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%$/);
  if (!m) return { h: 0, s: 0, l: 0 };
  return { h: +m[1], s: +m[2], l: +m[3] };
}

function fmt(hsl: Hsl): string {
  const h = Math.round(((hsl.h % 360) + 360) % 360);
  const s = Math.round(clamp(hsl.s, 0, 100));
  const l = Math.round(clamp(hsl.l, 0, 100) * 10) / 10;
  return `${h} ${s}% ${l}%`;
}

function hslToHex(hsl: Hsl): string {
  const h = (((hsl.h % 360) + 360) % 360) / 360;
  const s = clamp(hsl.s, 0, 100) / 100;
  const l = clamp(hsl.l, 0, 100) / 100;
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (x: number) =>
    Math.round(clamp(x * 255, 0, 255)).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToHsl(hex: string): Hsl {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return { h: 0, s: 0, l: 0 };
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hexToHslString(hex: string): string {
  return fmt(hexToHsl(hex));
}

export function hslStringToHex(hslStr: string): string {
  return hslToHex(parseHsl(hslStr));
}

/* ──────────────────────── Brand token engine ─────────────────────── */

const LIGHT_SURFACES = {
  background: '0 0% 100%', card: '0 0% 100%', popover: '0 0% 100%',
  foreground: '222.2 84% 4.9%', cardForeground: '222.2 84% 4.9%',
  secondary: '210 40% 96.1%', secondaryForeground: '222.2 47.4% 11.2%',
  muted: '210 40% 96.1%', mutedForeground: '215.4 16.3% 46.9%',
  accent: '210 40% 96.1%', accentForeground: '222.2 47.4% 11.2%',
  border: '214.3 31.8% 91.4%', input: '214.3 31.8% 91.4%',
  destructive: '0 84.2% 60.2%', destructiveForeground: '210 40% 98%',
};

const DARK_SURFACES = {
  background: '222.2 84% 4.9%', card: '217.2 91.2% 8%', popover: '217.2 91.2% 8%',
  foreground: '210 40% 98%', cardForeground: '210 40% 98%',
  secondary: '217.2 32.6% 17.5%', secondaryForeground: '210 40% 98%',
  muted: '217.2 32.6% 17.5%', mutedForeground: '215 20.2% 65.1%',
  accent: '217.2 32.6% 17.5%', accentForeground: '210 40% 98%',
  border: '217.2 32.6% 17.5%', input: '220 13% 46%',
  destructive: '0 62.8% 30.6%', destructiveForeground: '210 40% 98%',
};

type Surfaces = typeof LIGHT_SURFACES;

interface BrandSpec {
  base: string;
  secondary?: string;
  surfaceSatBoost?: number;
  surfaces?: Partial<Record<Mode, Partial<Surfaces>>>;
}

const BRAND_SPECS: Record<string, BrandSpec> = {
  claude: {
    base: '15 62% 58%',
    surfaces: {
      light: {
        background: '36 18% 97%', card: '0 0% 100%', popover: '0 0% 100%',
        foreground: '24 15% 15%', cardForeground: '24 15% 15%',
        secondary: '34 14% 93%', secondaryForeground: '24 15% 15%',
        muted: '34 12% 94%', mutedForeground: '25 8% 42%',
        accent: '34 18% 90%', accentForeground: '24 15% 15%',
        border: '30 14% 86%', input: '30 14% 86%',
      },
      dark: {
        background: '24 8% 12%', card: '24 9% 15%', popover: '24 9% 15%',
        foreground: '36 20% 94%', cardForeground: '36 20% 94%',
        secondary: '22 7% 20%', secondaryForeground: '36 20% 94%',
        muted: '22 7% 18%', mutedForeground: '32 10% 72%',
        accent: '22 8% 22%', accentForeground: '36 20% 94%',
        border: '24 8% 24%', input: '24 8% 28%',
      },
    },
  },
  alkindy: {
    base: '221 47% 20%',
    secondary: '39 38% 50%',
    surfaces: {
      light: {
        background: '40 43% 96%', card: '0 0% 100%', popover: '0 0% 100%',
        foreground: '221 47% 12%', cardForeground: '221 47% 12%',
        secondary: '40 30% 92%', secondaryForeground: '221 47% 12%',
        muted: '40 30% 92%', mutedForeground: '30 8% 38%',
        accent: '40 32% 89%', accentForeground: '221 47% 12%',
        border: '39 25% 84%', input: '39 25% 84%',
        destructive: '2 49% 43%',
      },
      dark: {
        background: '221 47% 12%', card: '221 46% 16%', popover: '221 46% 16%',
        foreground: '216 12% 92%', cardForeground: '216 12% 92%',
        secondary: '221 35% 22%', secondaryForeground: '216 12% 92%',
        muted: '221 35% 19%', mutedForeground: '220 16% 71%',
        accent: '221 30% 26%', accentForeground: '216 12% 92%',
        border: '221 30% 24%', input: '221 20% 40%',
      },
    },
  },
  cursor: { base: '212 90% 52%', surfaceSatBoost: 1.5 },
  codex: { base: '162 84% 35%' },
  gemini: { base: '217 89% 50%', secondary: '268 75% 55%' },
};

function readableFg(bgL: number): string {
  return bgL < 55 ? '0 0% 100%' : '222 47% 11%';
}

function tintedSurfaces(brandHue: number, mode: Mode, satBoost = 1): Surfaces {
  const canonical = mode === 'dark' ? DARK_SURFACES : LIGHT_SURFACES;
  const h = ((brandHue % 360) + 360) % 360;
  const s = (n: number) => Math.round(clamp(n * satBoost, 0, 100));
  if (mode === 'light') {
    return {
      background: `${h} ${s(4)}% 99%`, card: `${h} ${s(3)}% 100%`, popover: `${h} ${s(3)}% 100%`,
      secondary: `${h} ${s(12)}% 95%`, muted: `${h} ${s(12)}% 95%`,
      accent: `${h} ${s(18)}% 92%`, border: `${h} ${s(15)}% 88%`, input: `${h} ${s(15)}% 88%`,
      foreground: canonical.foreground, cardForeground: canonical.cardForeground,
      secondaryForeground: canonical.secondaryForeground, mutedForeground: canonical.mutedForeground,
      accentForeground: canonical.accentForeground,
      destructive: canonical.destructive, destructiveForeground: canonical.destructiveForeground,
    };
  }
  return {
    background: `${h} ${s(15)}% 6%`, card: `${h} ${s(18)}% 10%`, popover: `${h} ${s(18)}% 10%`,
    secondary: `${h} ${s(20)}% 18%`, muted: `${h} ${s(20)}% 18%`,
    accent: `${h} ${s(22)}% 22%`, border: `${h} ${s(18)}% 20%`, input: `${h} ${s(15)}% 46%`,
    foreground: canonical.foreground, cardForeground: canonical.cardForeground,
    secondaryForeground: canonical.secondaryForeground, mutedForeground: canonical.mutedForeground,
    accentForeground: canonical.accentForeground,
    destructive: canonical.destructive, destructiveForeground: canonical.destructiveForeground,
  };
}

function brandPrimary(anchor: Hsl, mode: Mode): Hsl {
  const h = ((anchor.h % 360) + 360) % 360;
  const distFromGreen = Math.min(Math.abs(h - 150), 360 - Math.abs(h - 150));
  const greenDarken = distFromGreen < 60 ? -10 * (1 - distFromGreen / 60) : 0;
  if (mode === 'light') {
    return { h: anchor.h, s: anchor.s, l: clamp(anchor.l + greenDarken, 30, 55) };
  }
  const distFromViolet = Math.abs(h - 240);
  const violetLift = distFromViolet < 60 ? 4 * (1 - distFromViolet / 60) : 0;
  return { h: anchor.h, s: anchor.s, l: clamp(Math.max(anchor.l, 56) + violetLift, 56, 66) };
}

interface DeriveOptions {
  base: string;
  secondary?: string;
  mode: Mode;
  surfaceSatBoost?: number;
  surfaces?: BrandSpec['surfaces'];
}

function deriveTokens({ base, secondary, mode, surfaceSatBoost, surfaces }: DeriveOptions): Record<string, string> {
  const baseAnchor = parseHsl(base);
  const accentAnchor = parseHsl(secondary || base);
  const isDark = mode === 'dark';
  const baseSurfaces = tintedSurfaces(baseAnchor.h, mode, surfaceSatBoost || 1);
  const overrides = (surfaces && surfaces[mode]) || {};
  const surf: Surfaces = { ...baseSurfaces, ...overrides };
  const primary = brandPrimary(baseAnchor, mode);
  const accent = brandPrimary(accentAnchor, mode);
  const primaryStop = { h: primary.h + 5, s: primary.s, l: clamp(primary.l + 5, 0, 100) };
  const gradientEnd = secondary ? accent : primaryStop;
  const primaryFg = readableFg(primary.l);
  const glowAlpha = isDark ? 0.25 : 0.18;
  const ringAlpha = isDark ? 0.15 : 0.1;
  const focusRingAlpha = isDark ? 0.25 : 0.22;
  const navGlassAlpha = isDark ? 0.55 : 0.7;
  const floatRingAlpha = isDark ? 0.3 : 0.5;
  const floatShadow = isDark ? '0 0% 0% / 0.35' : '0 0% 0% / 0.06';

  return {
    '--background': surf.background, '--foreground': surf.foreground,
    '--card': surf.card, '--card-foreground': surf.cardForeground,
    '--popover': surf.popover, '--popover-foreground': surf.cardForeground,
    '--secondary': surf.secondary, '--secondary-foreground': surf.secondaryForeground,
    '--muted': surf.muted, '--muted-foreground': surf.mutedForeground,
    '--accent': surf.accent, '--accent-foreground': surf.accentForeground,
    '--border': surf.border, '--input': surf.input,
    '--destructive': surf.destructive, '--destructive-foreground': surf.destructiveForeground,
    '--primary': fmt(primary), '--primary-foreground': primaryFg,
    '--ring': fmt(accent), '--brand-accent': fmt(accent),
    '--nav-glass-bg': `${surf.background} / ${navGlassAlpha}`,
    '--nav-tab-glow': `${fmt(accent)} / ${glowAlpha}`,
    '--nav-tab-ring': `${fmt(accent)} / ${ringAlpha}`,
    '--nav-float-shadow': floatShadow,
    '--nav-float-ring': `${surf.border} / ${floatRingAlpha}`,
    '--nav-divider-color': `${surf.border} / 0.5`,
    '--nav-input-bg': `${surf.secondary} / 0.5`,
    '--nav-input-focus-ring': `${fmt(accent)} / ${focusRingAlpha}`,
    '--gradient-surface': `linear-gradient(135deg, hsl(${surf.background}) 0%, hsl(${surf.card}) 100%)`,
    '--gradient-primary': `linear-gradient(135deg, hsl(${fmt(primary)}) 0%, hsl(${fmt(gradientEnd)}) 100%)`,
    '--gradient-sidebar': `linear-gradient(180deg, hsl(${surf.secondary}) 0%, hsl(${surf.background}) 100%)`,
    '--gradient-header': `linear-gradient(180deg, hsl(${surf.card}) 0%, hsl(${surf.background}) 100%)`,
  };
}

// Keys we own on documentElement.style. Listed explicitly so clearing only
// touches what we set — never anything else defined by the stylesheet.
const MANAGED_KEYS = [
  '--background', '--foreground', '--card', '--card-foreground',
  '--popover', '--popover-foreground', '--primary', '--primary-foreground',
  '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
  '--accent', '--accent-foreground', '--destructive', '--destructive-foreground',
  '--border', '--input', '--ring', '--brand-accent',
  '--nav-glass-bg', '--nav-tab-glow', '--nav-tab-ring',
  '--nav-float-shadow', '--nav-float-ring', '--nav-divider-color',
  '--nav-input-bg', '--nav-input-focus-ring',
  '--gradient-surface', '--gradient-primary', '--gradient-sidebar', '--gradient-header',
];

/* ──────────────────────── State persistence ────────────────────── */

const DEFAULT_STATE: ThemePresetState = {
  preset: 'alkindy',
  custom: { ...DEFAULT_CUSTOM_COLORS },
};

// Accepts everything in the picker plus the hidden-but-still-valid `custom`,
// so a previously saved custom theme keeps loading and applying.
const KNOWN_PRESETS = new Set<string>([...PRESET_ORDER, 'custom']);

export function loadThemePresetState(): ThemePresetState {
  try {
    const raw = localStorage.getItem(THEME_PRESET_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE, custom: { ...DEFAULT_STATE.custom } };
    const parsed = JSON.parse(raw) as Partial<ThemePresetState>;
    const preset = parsed.preset && KNOWN_PRESETS.has(parsed.preset) ? parsed.preset : 'alkindy';
    return {
      preset,
      custom: { ...DEFAULT_CUSTOM_COLORS, ...(parsed.custom || {}) },
    };
  } catch {
    return { ...DEFAULT_STATE, custom: { ...DEFAULT_STATE.custom } };
  }
}

let quotaWarned = false;
export function saveThemePresetState(state: ThemePresetState): void {
  try {
    localStorage.setItem(THEME_PRESET_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    if (!quotaWarned) {
      quotaWarned = true;
      console.warn('[theme-presets] localStorage write failed:', err);
    }
  }
}

/* ────────────────────── DOM application ───────────────────── */

function clearTokens(): void {
  const root = document.documentElement;
  for (const k of MANAGED_KEYS) root.style.removeProperty(k);
}

/**
 * Applies the given preset on top of the current light/dark mode.
 * "default" clears every managed variable so `src/index.css` rules apply.
 */
export function applyThemePreset(state: ThemePresetState, isDark: boolean): void {
  const root = document.documentElement;
  const mode: Mode = isDark ? 'dark' : 'light';

  clearTokens();

  const preset = KNOWN_PRESETS.has(state.preset) ? state.preset : 'default';

  if (preset === 'default') {
    return; // host stylesheet takes over
  }

  let tokens: Record<string, string>;
  if (preset === 'custom') {
    tokens = deriveTokens({ base: state.custom.accent, mode });
    tokens['--background'] = state.custom.background;
    tokens['--foreground'] = state.custom.foreground;
    tokens['--card-foreground'] = state.custom.foreground;
    tokens['--popover-foreground'] = state.custom.foreground;
    tokens['--secondary-foreground'] = state.custom.foreground;
  } else {
    const spec = BRAND_SPECS[preset];
    tokens = deriveTokens({
      base: spec.base, secondary: spec.secondary, mode,
      surfaceSatBoost: spec.surfaceSatBoost, surfaces: spec.surfaces,
    });
  }
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
}

/**
 * Applies the stored preset as early as possible at boot (before React
 * renders) so the default theme never flashes.
 *
 * Uses resolveIsDark() from theme-mode.ts — the same function used by
 * ThemeContext at runtime — so 'system', 'light', 'dark', and null all
 * resolve identically at boot and at runtime (no flash on any stored value).
 */
export function applyStoredThemePreset(): boolean {
  try {
    const savedTheme = localStorage.getItem('theme');
    const isDark = resolveIsDark(savedTheme);
    applyThemePreset(loadThemePresetState(), isDark);
    return isDark;
  } catch {
    // Never block boot on theming.
    return false;
  }
}

/* ──────────────────────── Preview ramps ────────────────────────── */

function brandRamp(id: string, mode: Mode): string[] {
  const spec = BRAND_SPECS[id];
  if (!spec) return [];
  const baseAnchor = parseHsl(spec.base);
  const baseSurfaces = tintedSurfaces(baseAnchor.h, mode, spec.surfaceSatBoost || 1);
  const overrides = (spec.surfaces && spec.surfaces[mode]) || {};
  const surf: Surfaces = { ...baseSurfaces, ...overrides };
  const primary = brandPrimary(baseAnchor, mode);
  const accent = spec.secondary ? brandPrimary(parseHsl(spec.secondary), mode) : null;
  return [
    parseHsl(surf.background), parseHsl(surf.card), parseHsl(surf.muted),
    parseHsl(surf.border), primary,
    accent || parseHsl(surf.mutedForeground), parseHsl(surf.foreground),
  ].map(hslToHex);
}

function defaultRamp(mode: Mode): string[] {
  if (mode === 'light')
    return ['#ffffff', '#ffffff', '#f1f5f9', '#e2e8f0', '#2563eb', '#64748b', '#020617'];
  return ['#020617', '#0a1428', '#1e293b', '#1e293b', '#3b82f6', '#94a3b8', '#f8fafc'];
}

function customRamp(custom: CustomColors, mode: Mode): string[] {
  const surf = mode === 'dark' ? DARK_SURFACES : LIGHT_SURFACES;
  const accent = brandPrimary(parseHsl(custom.accent), mode);
  return [
    hslStringToHex(custom.background), hslStringToHex(custom.background),
    hslToHex(parseHsl(surf.muted)), hslToHex(parseHsl(surf.border)),
    hslToHex(accent), hslToHex(parseHsl(surf.mutedForeground)),
    hslStringToHex(custom.foreground),
  ];
}

/** Seven preview swatches (hex) for a preset card. */
export function presetSwatches(id: ThemePresetId, custom: CustomColors, isDark: boolean): string[] {
  const mode: Mode = isDark ? 'dark' : 'light';
  if (id === 'default') return defaultRamp(mode);
  if (id === 'custom') return customRamp(custom, mode);
  return brandRamp(id, mode);
}
