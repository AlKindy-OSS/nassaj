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

export type ThemePresetId =
  | 'default'
  | 'claude'
  | 'alkindy'
  | 'nawras'
  | 'irukhaimi'
  | 'cursor'
  | 'codex'
  | 'gemini'
  | 'custom';

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

/** Canonical host stylesheet backgrounds; guarded against index.css drift. */
export const DEFAULT_THEME_BACKGROUNDS = {
  light: '0 0% 100%',
  dark: '222.2 84% 4.9%',
} as const;

/**
 * Presets offered in the picker, in display order.
 *
 * ‏`HIDDEN_PRESETS` غائبة عن هذه القائمة وحدها لا عن المحرّك: تبقى بريستات
 * صالحة تُحمَّل وتُطبَّق (‏KNOWN_PRESETS)، فلا يفقد ثيمَه من كان عليها، ويظلّ
 * خيارُه ظاهراً له وحده في المنتقي ما دام مختاراً — كما يفعل `custom` تماماً.
 */
export const PRESET_ORDER: Exclude<ThemePresetId, 'custom' | 'default' | 'gemini'>[] = [
  'alkindy',
  'nawras',
  'irukhaimi',
  'claude',
  'cursor',
  'codex',
];

/**
 * بريستات صالحة مخفيّة عن الشبكة.
 *
 * ‏`custom` مخفيّ منذ البداية. و`default` و`gemini` أُخفيا بقرار المالك
 * (‏2026-08-17): الأول لأنه «بلا هوية» — يمسح الرموز فتتولّى `index.css`،
 * والثاني لأنه علامة مورّد لا علاقة لها بعلامات المنتج.
 */
export const HIDDEN_PRESETS: ThemePresetId[] = ['custom', 'default', 'gemini'];

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

/* ─────────────────── Contrast (WCAG 2.2 relative luminance) ─────────── */

/** sRGB channel triple in 0..1, from an HSL token. */
function hslChannels({ h, s, l }: Hsl): [number, number, number] {
  const S = clamp(s, 0, 100) / 100;
  const L = clamp(l, 0, 100) / 100;
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

function relativeLuminance(hsl: Hsl): number {
  const [r, g, b] = hslChannels(hsl).map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: Hsl, b: Hsl): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * WCAG 2.2 §1.4.11 asks for 3:1 between a focus indicator and its background.
 * The target is 3.1 rather than 3.0 so that `fmt()`'s rounding to one decimal
 * can never land a shipped token a hair under the line.
 */
const RING_MIN_CONTRAST = 3.1;

/**
 * WCAG 2.2 §1.4.3 asks for 4.5:1 between normal text and its background.
 * The target is 4.5 exactly — the standard AA threshold for body text.
 */
const PRIMARY_TEXT_MIN_CONTRAST = 4.5;

/**
 * Every surface a focused control can sit on. `--ring` has to clear the bar
 * against all of them, not merely against `--background`: the two presets that
 * failed did so on `--muted`/`--secondary` (alkindy light 2.63, gemini dark
 * 2.76) while still passing on `--background` (2.86 / 3.77). Measuring only the
 * page background is exactly how this stayed invisible.
 */
const RING_BACKDROPS = ['--background', '--card', '--popover', '--muted', '--secondary'] as const;

/**
 * Returns the accent nudged in lightness until its focus ring is legible on
 * every surface — or the accent untouched when it already is.
 *
 * `--ring` used to be `--brand-accent` verbatim. That is a brand-fill color,
 * chosen to look right *as a fill*; nothing ever checked it as a *ring*, and on
 * two of the six presets it fell under 3:1. Hue and saturation are preserved so
 * the ring still reads as the brand — only lightness moves, and only as far as
 * the criterion requires. The search walks outward from the accent's own
 * lightness in 0.5% steps and takes the first passing value in either
 * direction, so a preset that already passes is returned bit-identical.
 *
 * Deliberately NOT applied to `--brand-accent`, `--nav-tab-ring`,
 * `--nav-tab-glow` or `--nav-input-focus-ring`: those are decorative tints at
 * low alpha, not the focus indicator 1.4.11 governs. Changing them would move
 * the brand's look; this moves only what the criterion measures.
 */
function legibleRing(accent: Hsl, backdrops: Hsl[]): Hsl {
  const worst = (l: number) => {
    const candidate = { ...accent, l };
    return backdrops.reduce((min, bd) => Math.min(min, contrastRatio(candidate, bd)), Infinity);
  };
  if (worst(accent.l) >= RING_MIN_CONTRAST) return accent;

  for (let delta = 0.5; delta <= 60; delta += 0.5) {
    for (const l of [accent.l - delta, accent.l + delta]) {
      if (l < 0 || l > 100) continue;
      if (worst(l) >= RING_MIN_CONTRAST) return { ...accent, l };
    }
  }
  // No lightness clears it (a backdrop set that brackets the accent from both
  // sides). Keep the brand value rather than shipping an arbitrary one.
  return accent;
}

/**
 * Rewrites `--ring` in place once every surface token is final.
 *
 * It runs on the finished token map, not inside deriveTokens(), because the
 * `custom` preset overwrites `--background` with the user's own color *after*
 * derivation — solving earlier would measure the ring against a backdrop the
 * user never sees.
 */
function enforceRingContrast(tokens: Record<string, string>): void {
  const ring = tokens['--ring'];
  if (!ring) return;
  const backdrops = RING_BACKDROPS.map((k) => tokens[k]).filter(Boolean).map(parseHsl);
  if (!backdrops.length) return;
  tokens['--ring'] = fmt(legibleRing(parseHsl(ring), backdrops));
}

/**
 * Returns the primary color nudged in lightness until it clears 4.5:1 as text on
 * every surface — or the primary untouched when it already does.
 *
 * `--primary` is a brand fill colour chosen to look right *as a fill* (buttons,
 * badges, active states). On three of the six light presets — claude, cursor,
 * codex — it falls under 4.5:1 when used as text on muted/secondary/card
 * surfaces. Three dark presets also sit below the bar (cursor, gemini, alkindy).
 *
 * Hue and saturation are preserved so the brand identity stays intact; only
 * lightness moves. The search walks outward from the accent's own lightness in
 * 0.5% steps in both directions, so a preset that already passes is returned
 * bit-identical. The floor is 15% (codex needs 27%) and the ceiling is 75%.
 */
function legiblePrimaryText(primary: Hsl, backdrops: Hsl[]): Hsl {
  const worst = (l: number) => {
    const candidate = { ...primary, l };
    return backdrops.reduce((min, bd) => Math.min(min, contrastRatio(candidate, bd)), Infinity);
  };
  if (worst(primary.l) >= PRIMARY_TEXT_MIN_CONTRAST) return primary;

  for (let delta = 0.5; delta <= 60; delta += 0.5) {
    for (const l of [primary.l - delta, primary.l + delta]) {
      if (l < 15 || l > 75) continue;
      if (worst(l) >= PRIMARY_TEXT_MIN_CONTRAST) return { ...primary, l };
    }
  }

  // No lightness clears it while the colour still reads as the brand.
  return primary;
}

/**
 * Rewrites `--primary` and `--primary-foreground` in place once every surface
 * token is final.
 *
 * Runs after `enforceRingContrast` for the same reason: the `custom` preset
 * may overwrite surfaces after derivation, so solving earlier would measure
 * against backdrops the user never sees.
 */
function enforcePrimaryTextContrast(tokens: Record<string, string>): void {
  const primary = tokens['--primary'];
  if (!primary) return;
  const backdrops = RING_BACKDROPS.map((k) => tokens[k]).filter(Boolean).map(parseHsl);
  if (!backdrops.length) return;
  const adjusted = legiblePrimaryText(parseHsl(primary), backdrops);
  tokens['--primary'] = fmt(adjusted);
  tokens['--primary-foreground'] = readableFg(adjusted.l);
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
  background: DEFAULT_THEME_BACKGROUNDS.light, card: '0 0% 100%',
  foreground: '222.2 84% 4.9%', cardForeground: '222.2 84% 4.9%',
  secondary: '210 40% 96.1%', secondaryForeground: '222.2 47.4% 11.2%',
  muted: '210 40% 96.1%', mutedForeground: '215.4 16.3% 46.9%',
  accent: '210 40% 96.1%', accentForeground: '222.2 47.4% 11.2%',
  border: '214.3 31.8% 91.4%', input: '214.3 31.8% 91.4%',
  destructive: '0 84.2% 60.2%', destructiveForeground: '210 40% 98%',
  // B-399: نبرتا الحالة ثابتتان عبر البريستات — الدلالة لا تتلوّن بالعلامة.
  success: '152 42% 28%', warning: '23 83% 31%', danger: '0 72% 42%',
};

const DARK_SURFACES = {
  background: DEFAULT_THEME_BACKGROUNDS.dark, card: '217.2 91.2% 8%',
  foreground: '210 40% 98%', cardForeground: '210 40% 98%',
  secondary: '217.2 32.6% 17.5%', secondaryForeground: '210 40% 98%',
  muted: '217.2 32.6% 17.5%', mutedForeground: '215 20.2% 65.1%',
  accent: '217.2 32.6% 17.5%', accentForeground: '210 40% 98%',
  border: '217.2 32.6% 17.5%', input: '220 13% 46%',
  destructive: '0 62.8% 30.6%', destructiveForeground: '210 40% 98%',
  success: '158 64% 52%', warning: '46 96% 65%', danger: '0 91% 71%',
};

type Surfaces = { [K in keyof typeof LIGHT_SURFACES]: string };

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
        background: '36 18% 97%', card: '0 0% 100%',
        foreground: '24 15% 15%', cardForeground: '24 15% 15%',
        secondary: '34 14% 93%', secondaryForeground: '24 15% 15%',
        muted: '34 12% 94%', mutedForeground: '25 8% 42%',
        accent: '34 18% 90%', accentForeground: '24 15% 15%',
        border: '30 14% 86%', input: '30 14% 86%',
      },
      dark: {
        background: '24 8% 12%', card: '24 9% 15%',
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
        // السلّم مصمَّم لا مُرقَّع (ui-designer، مقيس بلقطة chromium على نصّ
        // عربي كثيف + تحقّق WCAG محسوب على كل زوج نص×سطح).
        //
        // ما أفشل ثلاث محاولات سابقة: **التشبّع**، لا عمق الصفحة ولا ضعف الحدّ.
        // الكريمان ‎#F9F6F0‎/‎#EDE3D1‎ هما gold-50/gold-100 — درجتا تمييزٍ دافئتان
        // بتشبّع 42%، فحين فُرشتا على كل طبقة قرأت العينُ ذهباً لا سطحاً محايداً.
        // وذلك يخالف قاعدة الهوية 60/30/10 صراحةً: «الذهبي عملة نادرة، وكثرته
        // تُرخصه». للمقارنة: طقم `claude` الدافئ الناجح يعيش على تشبّع 12–18%.
        //
        // فالإضاءة وحدها تصنع السلّم (‏97 → 92 → 89 → 85 → 75) والتشبّع يبقى
        // منخفضاً. وينخفض كلما عمُق السطح لا العكس: الكروما أظهرُ على الأعمق،
        // فالبطاقة عند l97 تحتمل s34 (تُقرأ أبيضَ دافئاً ≈ ‎#F9F6F0‎) بينما
        // accent عند l85 يكتفي بـs17 وإلا صار بيجاً صريحاً. المحاولة الأولى
        // رفعت التشبّع مع التعميق ففعلت النقيض تماماً.
        background: '60 15.789% 96.275%', card: '40 34% 97%',
        foreground: '221 45% 14%', cardForeground: '221 45% 14%',
        secondary: '38 19% 89%', secondaryForeground: '221 45% 14%',
        muted: '38 19% 89%', mutedForeground: '28 12% 35%',
        accent: '37 17% 85%', accentForeground: '221 45% 14%',
        // ناعم بقصد: الأسطح صارت أنصع فصار الحدّ يفصل دون خشونة. الراحة
        // البصرية للقراءة الطويلة تسبق حدّة الإطار.
        border: '36 20% 75%', input: '36 20% 75%',
        destructive: '2 49% 43%', destructiveForeground: '40 34% 97%',
        // نبرات الحالة لا تُخصَّص هنا: الدلالة ثابتة عبر كل علامات المنتج.
      },
      // الوضع الداكن مطابق لدليل الهوية حرفياً: الخلفية ≈ navy-900 ‎#10192C‎،
      // الأسطح ≈ navy-800 ‎#16223B‎، النص ≈ ‎#E8EAEF‎. البطاقة ترتفع بوضوح
      // (‏l15 فوق l11)، والنبرات الوظيفية من الدليل مُنصَّعة بما يكفي لعبور
      // `accent` وهو أفتح سطح هنا. أدنى تباين: success 4.59، warning 5.21،
      // danger 4.66، mutedForeground 5.69، foreground 9.49 — كلها تعبر AA.
      dark: {
        background: '221 47% 11%', card: '221 44% 15%',
        foreground: '218 16% 92%', cardForeground: '218 16% 92%',
        secondary: '221 33% 21%', secondaryForeground: '218 16% 92%',
        muted: '221 33% 18%', mutedForeground: '219 15% 73%',
        accent: '221 27% 25%', accentForeground: '218 16% 92%',
        border: '221 26% 27%', input: '221 18% 40%',
        destructive: '2 52% 47%', destructiveForeground: '210 20% 96%',
      },
    },
  },
  /*
   * نورس — مصدره دليل الهوية الرسمي (tokens.css v1.0، 2026-08-15):
   * https://nassaj.example.com/brand/nawras/
   *
   * المرساة `--teal-600` ‎#0A8F8F‎ = `180 87% 30%`، وهي بالضبط ما يعطيه
   * `brandPrimary` للوضع الفاتح (30 - 5 من `greenDarken`، ثم `clamp(…,30,55)`).
   * وتحذير الدليل — «‏teal-600 يعطي 3.93 على أبيض، فللنصّ استخدم teal-700» —
   * يُنفَّذ هنا آلياً لا يدوياً: `enforcePrimaryTextContrast` يغمّق `--primary`
   * حتى يعبر 4.5 فيهبط به إلى جوار ‎#087070‎ (‏teal-700) من تلقائه.
   *
   * الأسطح رمليّة والّلهجة تركوازية: هذا ما يفعله الدليل حرفياً (‏`--bg` من
   * `sand-50` و`--accent` من `teal-600`). و`secondary` هو المرجاني ‎#CA4E21‎
   * (‏`--cta`) — يظهر في التدرّج وحلقة التركيز وتوهّج التبويب، وكلها لمسات
   * نقطية تحترم قاعدة «المرجاني ≤5% من الصفحة».
   *
   * ‏`--destructive` غير مخصَّص عمداً: المرجاني لون نداءٍ لا لون خطأ، وخلطهما
   * يجعل زرّ الحذف وزرّ الإجراء الرئيسي لوناً واحداً.
   *
   * ‏`mutedForeground` أغمق من `sand-500` ‎#917B59‎ الذي يستعمله الدليل: ذاك
   * يعطي 4.05 على أبيض — يمرّ في صفحة تعريفية ويسقط في واجهة عمل نصّها كثيف.
   */
  nawras: {
    base: '180 87% 30%',
    secondary: '16 72% 46%',
    surfaces: {
      light: {
        background: '0 7% 97%', card: '0 0% 100%',
        foreground: '36 18% 11%', cardForeground: '36 18% 11%',
        secondary: '40 10% 94%', secondaryForeground: '36 18% 11%',
        muted: '40 10% 94%', mutedForeground: '36 26% 38%',
        accent: '180 20% 90%', accentForeground: '36 18% 11%',
        border: '36 14% 86%', input: '36 14% 86%',
      },
      // الوضع الليلي من الدليل حرفياً: خلفية ‎#0B1A1A‎ وسطح مرتفع ‎#11292A‎
      // وحدّ ‎#1C3A3A‎ — سطحٌ مائل للتركوازي لا رمادي محايد، كما ينصّ عليه.
      dark: {
        background: '180 41% 7%', card: '182 42% 12%',
        foreground: '180 37% 93%', cardForeground: '180 37% 93%',
        secondary: '180 30% 17%', secondaryForeground: '180 37% 93%',
        muted: '180 32% 15%', mutedForeground: '180 37% 73%',
        accent: '180 27% 21%', accentForeground: '180 37% 93%',
        border: '180 35% 17%', input: '180 20% 40%',
      },
    },
  },
  /*
   * سمة irukhaimi — مصدرها دليل الهوية الرسمي (tokens.css v1.0، 2026-08-15):
   * https://nassaj.example.com/brand/irukhaimi/tokens.css
   *
   * T-1735: المرساة الجديدة «حصري» ‎#664999‎ = `262 35% 44.3%` (تباين 7.05:1 على
   * أبيض بنصّ الدليل). اللهجة «بهجة» ‎#0AADA8‎ = `178 89% 36%` تُبقَى ثانويةً
   * عمداً: الدليل يُصنِّفها «لون تعبئة حصراً» (‏2.78 على أبيض)، فتدخل
   * `--ring`/`--brand-accent` حيث يكفل `enforceRingContrast` عبورها 3:1 حلقةً.
   * إبقاؤها يُنشئ توتراً بنفسجي/تركوازي مقصوداً — علامة مُميِّزة للهوية.
   *
   * `brandPrimary` في الوضع الداكن: `violetLift` ≈ 2.5 درجة (h=262، distFromViolet=22)
   * ترفع المرساة من l=44% إلى l≈58.5%، ثم `enforcePrimaryTextContrast` يُكمل
   * الرفع حتى تعبر 4.5:1 — مساراً يُقارب ‎#9C89BD‎ (h=262، l≈64%) من الدليل.
   *
   * T-1611: الكنفاس المحايد (#F7F8F9) والحدود (#C2CBD3) مُستبقَيان من T-1611 —
   * يظلّان مقروءَين مع تلوين violet خفيف على secondary/muted.
   */
  irukhaimi: {
    base: hexToHslString('#664999'),
    secondary: '178 89% 36%',
    surfaces: {
      light: {
        background: hexToHslString('#F7F8F9'), card: '0 0% 100%',
        foreground: '0 0% 13%', cardForeground: '0 0% 13%',
        secondary: '262 18% 93%', secondaryForeground: '0 0% 13%',
        muted: '262 18% 93%', mutedForeground: '262 10% 38%',
        accent: '262 14% 89%', accentForeground: '0 0% 13%',
        border: hexToHslString('#C2CBD3'), input: '262 10% 80%',
      },
      dark: {
        background: '262 35% 10%', card: '262 30% 14%',
        foreground: '262 20% 93%', cardForeground: '262 20% 93%',
        secondary: '262 22% 19%', secondaryForeground: '262 20% 93%',
        muted: '262 22% 17%', mutedForeground: '262 22% 75%',
        accent: '262 22% 23%', accentForeground: '262 20% 93%',
        border: '262 28% 22%', input: '262 20% 40%',
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
      background: `${h} ${s(4)}% 99%`, card: `${h} ${s(3)}% 100%`,
      secondary: `${h} ${s(12)}% 95%`, muted: `${h} ${s(12)}% 95%`,
      accent: `${h} ${s(18)}% 92%`, border: `${h} ${s(15)}% 88%`, input: `${h} ${s(15)}% 88%`,
      foreground: canonical.foreground, cardForeground: canonical.cardForeground,
      secondaryForeground: canonical.secondaryForeground, mutedForeground: canonical.mutedForeground,
      accentForeground: canonical.accentForeground,
      destructive: canonical.destructive, destructiveForeground: canonical.destructiveForeground,
      success: canonical.success, warning: canonical.warning, danger: canonical.danger,
    };
  }
  return {
    background: `${h} ${s(15)}% 6%`, card: `${h} ${s(18)}% 10%`,
    secondary: `${h} ${s(20)}% 18%`, muted: `${h} ${s(20)}% 18%`,
    accent: `${h} ${s(22)}% 22%`, border: `${h} ${s(18)}% 20%`, input: `${h} ${s(15)}% 46%`,
    foreground: canonical.foreground, cardForeground: canonical.cardForeground,
    secondaryForeground: canonical.secondaryForeground, mutedForeground: canonical.mutedForeground,
    accentForeground: canonical.accentForeground,
    destructive: canonical.destructive, destructiveForeground: canonical.destructiveForeground,
    success: canonical.success, warning: canonical.warning, danger: canonical.danger,
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
    // Popovers, menus and dialogs share the page background (owner request 2026-09-10).
    '--popover': surf.background, '--popover-foreground': surf.foreground,
    '--secondary': surf.secondary, '--secondary-foreground': surf.secondaryForeground,
    '--muted': surf.muted, '--muted-foreground': surf.mutedForeground,
    '--accent': surf.accent, '--accent-foreground': surf.accentForeground,
    '--border': surf.border, '--input': surf.input,
    '--destructive': surf.destructive, '--destructive-foreground': surf.destructiveForeground,
    '--success': surf.success, '--warning': surf.warning, '--danger': surf.danger,
    '--primary': fmt(primary), '--primary-foreground': primaryFg,
    '--ring': fmt(accent), '--brand-accent': fmt(accent),
    '--nav-glass-bg': `${surf.background} / ${navGlassAlpha}`,
    '--nav-tab-glow': `${fmt(accent)} / ${glowAlpha}`,
    '--nav-tab-ring': `${fmt(accent)} / ${ringAlpha}`,
    '--nav-float-shadow': floatShadow,
    '--nav-float-ring': `${surf.border} / ${floatRingAlpha}`,
    '--nav-input-bg': `${surf.secondary} / 0.5`,
    '--nav-input-focus-ring': `${fmt(accent)} / ${focusRingAlpha}`,
    '--gradient-surface': `linear-gradient(135deg, hsl(${surf.background}) 0%, hsl(${surf.card}) 100%)`,
    '--gradient-primary': `linear-gradient(135deg, hsl(${fmt(primary)}) 0%, hsl(${fmt(gradientEnd)}) 100%)`,
    '--gradient-sidebar': `linear-gradient(180deg, hsl(${surf.secondary}) 0%, hsl(${surf.background}) 100%)`,
    '--gradient-header': `linear-gradient(180deg, hsl(${surf.card}) 0%, hsl(${surf.background}) 100%)`,
    // Project-navigation surface tokens — universal for every preset (T-1705).
    // Alkindy immediately overwrites these with its hand-tuned values.
    ...deriveProjectNavTokens(surf, mode, primary),
  };
}

/**
 * Derives the four project-navigation surface tokens (+ border/fg helpers) for
 * any brand preset.  The result satisfies a strict depth ordering so the sidebar
 * communicates hierarchy without explicit borders:
 *
 *   Light: surface (lightest) > hover > selected > header-open (darkest)
 *   Dark:  surface (darkest)  < hover < selected < header-open (most prominent)
 *
 * Hue comes from `primary` (the brand accent), not from the neutral background,
 * so each theme's project block carries its own brand colour as a gentle tint —
 * the same principle as Alkindy's navy-tinted #D8DDE8.  Saturation is scaled
 * proportionally to the primary's saturation and capped so vivid brands (e.g.
 * cursor 90 %) still read as surfaces, not swatches.
 *
 * L steps of 3 / 7 / 13 guarantee the luminance ordering for any in-range L.
 * All values are converted to hex so they can be used as direct CSS colour values,
 * matching the format of ALKINDY_PROJECT_TOKENS.
 *
 * Alkindy overrides these with ALKINDY_PROJECT_TOKENS immediately after
 * deriveTokens returns.
 */
function deriveProjectNavTokens(surf: Surfaces, mode: Mode, primary: Hsl): Record<string, string> {
  const bg = parseHsl(surf.background);
  const card = parseHsl(surf.card);
  const isDark = mode === 'dark';

  // Hue anchor: the brand primary.  This is what makes nawras teal, irukhaimi
  // blue, claude warm, etc.  Background hue is near-neutral on most presets and
  // would produce a grey-pink tint for nawras (whose bg is off-white h≈0).
  const h = primary.h;

  // Saturation: scale proportionally to the primary so vivid brands produce a
  // clear but gentle tint.  Caps prevent surfaces from reading as swatches.
  const maxS = isDark ? 20 : 15;
  const sBase = Math.min(primary.s * 0.15, maxS);
  const s0 = clamp(sBase * 0.3, 0, maxS);  // surface — barely perceptible
  const s1 = clamp(sBase * 0.5, 0, maxS);  // hover
  const s2 = clamp(sBase * 0.7, 0, maxS);  // selected
  const s3 = clamp(sBase,       0, maxS);  // header-open — most distinct

  // Light: start from card lightness (≈ 100 %); darken towards header-open.
  // Dark: start from background lightness (darkest); lighten towards header-open.
  const baseL = isDark ? bg.l : card.l;
  const dir = isDark ? 1 : -1;

  const surface    = { h, s: s0, l: clamp(baseL,           0, 100) };
  const hover      = { h, s: s1, l: clamp(baseL + dir * 3, 0, 100) };
  const selected   = { h, s: s2, l: clamp(baseL + dir * 7, 0, 100) };
  const headerOpen = { h, s: s3, l: clamp(baseL + dir * 13, 0, 100) };

  return {
    '--project-surface':          hslToHex(surface),
    '--project-hover':            hslToHex(hover),
    '--project-session-selected': hslToHex(selected),
    '--project-header-open':      hslToHex(headerOpen),
    '--project-border':           hslStringToHex(surf.border),
    '--project-border-open':      hslStringToHex(surf.input),
    '--project-foreground':       hslStringToHex(surf.foreground),
    '--project-muted-foreground': hslStringToHex(surf.mutedForeground),
    '--project-accent':           hslToHex(primary),
  };
}

// Alkindy-only opaque navigation surfaces; preserve provider/status icons and global primary.
// Full CSS colors let components preserve the existing alpha colors as fallbacks.
const ALKINDY_PROJECT_TOKENS = {
  light: {
    // T-1692: بند 1 — خلفية منطقة المحتوى بيضاء نقية.
    // T-1711: ثلاث درجات متمايزة بوضوح (كحلي→كريم):
    //   header-open (#CED4DE)  → action-strip (#E0E4EB)  → selected (#EDEFF3)
    // --project-action-strip يُعيَّن على :root فيُرثَّب إلى .sidebar-project-sessions
    // حيث يُستهلَك بـvar(--project-action-strip, ...) في قاعدة CSS العالمية.
    // muted-foreground #4A5870: تباين ≥4.5 على header-open (#CED4DE, lum≈0.65) — WCAG AA.
    // خُفِّفت التلوينة الكحلية (التشبّع من ≈34% إلى ≈20%) مع الإبقاء على الهوية والتباين.
    '--project-surface': '#FFFFFF',
    '--project-header-open': '#CED4DE',
    '--project-hover': '#F4F6F9',
    '--project-session-selected': '#EDEFF3',
    '--project-action-strip': '#E0E4EB',
    '--project-border': '#D8DDE6',
    '--project-border-open': '#B8C3D5',
    '--project-foreground': '#1A2434',
    '--project-muted-foreground': '#4A5870',
    '--project-accent': '#293F70',
  },
  dark: {
    // T-1711: dark midpoint action-strip between header (#29364D) and selected (#232E40).
    '--project-surface': '#202329',
    '--project-header-open': '#29364D',
    '--project-hover': '#252C37',
    '--project-session-selected': '#232E40',
    '--project-action-strip': '#263246',
    '--project-border': '#41454B',
    '--project-border-open': '#52627D',
    '--project-foreground': '#E8EAEF',
    '--project-muted-foreground': '#BCC0C8',
    '--project-accent': '#9FAFCE',
  },
} satisfies Record<Mode, Record<string, string>>;

// Keep the reviewed dark bubble independent; light uses the original primary.
const ALKINDY_DARK_USER_BUBBLE_TOKENS = {
  '--user-bubble-background': '#202D45',
  '--user-bubble-foreground': '222.857 17.949% 92.353%',
  '--user-bubble-muted-foreground': '217.241 25.217% 77.451%',
};

// Keys we own on documentElement.style. Listed explicitly so clearing only
// touches what we set — never anything else defined by the stylesheet.
const MANAGED_KEYS = [
  // Retired surface experiment: clear values left by an already-open client.
  '--chat-reading-surface', '--app-chrome-surface', '--app-header-surface',
  ...Object.keys(ALKINDY_PROJECT_TOKENS.light),
  ...Object.keys(ALKINDY_DARK_USER_BUBBLE_TOKENS),
  '--background', '--foreground', '--card', '--card-foreground',
  '--popover', '--popover-foreground', '--primary', '--primary-foreground',
  '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
  '--accent', '--accent-foreground', '--destructive', '--destructive-foreground',
  '--success', '--warning', '--danger',
  '--border', '--input', '--ring', '--brand-accent',
  '--nav-glass-bg', '--nav-tab-glow', '--nav-tab-ring',
  '--nav-float-shadow', '--nav-float-ring',
  '--nav-input-bg', '--nav-input-focus-ring',
  '--gradient-surface', '--gradient-primary', '--gradient-sidebar', '--gradient-header',
];

/* ──────────────────────── State persistence ────────────────────── */

const DEFAULT_STATE: ThemePresetState = {
  preset: 'alkindy',
  custom: { ...DEFAULT_CUSTOM_COLORS },
};

// Accepts everything in the picker plus the hidden-but-still-valid presets,
// so a previously saved theme keeps loading and applying.
const KNOWN_PRESETS = new Set<string>([...PRESET_ORDER, ...HIDDEN_PRESETS]);

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
  // T-1692: أزِل سمة الثيم حتى لا تبقى قواعد CSS المقيَّدة بها فاعلةً بعد
  // التبديل لثيم آخر.
  root.removeAttribute('data-theme');
}

/** Keep browser chrome aligned with the page surface owned by this preset. */
function syncThemeColor(background: string): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = hslStringToHex(background);
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
    syncThemeColor((isDark ? DARK_SURFACES : LIGHT_SURFACES).background);
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
  // Last, after the custom branch has had its say on --background.
  enforceRingContrast(tokens);
  enforcePrimaryTextContrast(tokens);
  if (preset === 'alkindy') {
    // Override the generic derived project tokens with Alkindy's hand-tuned values
    // (T-1692/T-1705). Layout rules are now universal in index.css so data-theme
    // is no longer needed for CSS scoping.
    Object.assign(tokens, ALKINDY_PROJECT_TOKENS[mode], mode === 'dark'
      ? ALKINDY_DARK_USER_BUBBLE_TOKENS
      : {
          '--user-bubble-background': hslStringToHex(tokens['--primary']),
          '--user-bubble-foreground': tokens['--primary-foreground'],
          '--user-bubble-muted-foreground': tokens['--primary-foreground'],
        });
  }
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
  syncThemeColor(tokens['--background']);
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
    // The default preset has no inline tokens of its own, so its dark surface
    // depends on this class existing before React (and the first paint).
    document.documentElement.classList.toggle('dark', isDark);
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
