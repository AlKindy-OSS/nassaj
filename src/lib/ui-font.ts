/**
 * UI font — one interface font for every language.
 *
 * The app used to hard-code two different stacks: the system stack for LTR and
 * Tajawal (from a Google Fonts <link>) for RTL. Both are gone. There is now a
 * single CSS custom property, `--font-ui`, whose default value in
 * `src/index.css` is the system stack, and whose value this module overrides on
 * `document.documentElement` when the user picks a font in Settings → Appearance.
 *
 * Design notes
 * ------------
 * 1. One choice for all languages. Every offered family covers BOTH Arabic and
 *    Latin, so the setting never has to be per-language.
 * 2. Self-hosted (`@fontsource*`). No request ever leaves the machine — the app
 *    runs behind a tunnel and must work with no internet access.
 * 3. Lazy. `system` downloads nothing at all; any other choice imports only its
 *    own `@fontsource` CSS, on demand, the first time it is applied. The CSS is
 *    subset-split by `unicode-range`, so a Latin-only screen never pulls the
 *    Arabic woff2 (and vice versa).
 * 4. Real weights only. The UI leans on `font-medium` (500) and `font-semibold`
 *    (600) heavily; a family that lacks them makes the browser synthesise fake
 *    bold. Variable fonts are preferred (100–900 continuous); the two static
 *    families load explicit weight files.
 * 5. No `local()` in any @font-face. `@fontsource` does not emit it, which is
 *    exactly what we want: the user picked a specific face, so the rendering
 *    must be deterministic and must not fall back to a stale locally-installed
 *    copy that may be missing the intermediate weights.
 */

/** Verbatim copy of the historical LTR stack — still the default for everyone. */
export const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const UI_FONT_STORAGE_KEY = 'nassaj-ui-font';
export const UI_FONT_CSS_VAR = '--font-ui';

export type UiFontId =
  | 'system'
  | 'ibm-plex-sans-arabic'
  | 'noto-sans-arabic'
  | 'readex-pro'
  | 'vazirmatn'
  | 'tajawal';

export interface UiFontSpec {
  id: UiFontId;
  /** Value written to `--font-ui`. */
  stack: string;
  /**
   * Downloads the family's @font-face CSS. `null` for `system`, which is the
   * whole point of the default: zero bytes over the wire.
   */
  loadAssets: (() => Promise<unknown>) | null;
}

/**
 * Latin coverage note: each Arabic family below ships a *real* Latin subset in
 * its own @fontsource package (IBM Plex Sans Arabic 20 KB, Noto Sans Arabic
 * 31 KB, Readex Pro 31 KB, Vazirmatn and Tajawal likewise), drawn from the same
 * superfamily as its Latin sibling. Pairing them with a second Latin-only
 * package would download bytes that `unicode-range` never lets the browser use,
 * so the sibling names are kept in the stack purely as a no-cost fallback for
 * the case where the webfont fails to load.
 */
const UI_FONT_SPECS: Record<UiFontId, UiFontSpec> = {
  system: {
    id: 'system',
    stack: SYSTEM_FONT_STACK,
    loadAssets: null,
  },
  'ibm-plex-sans-arabic': {
    id: 'ibm-plex-sans-arabic',
    stack: `'IBM Plex Sans Arabic', 'IBM Plex Sans', ${SYSTEM_FONT_STACK}`,
    // Static family: IBM Plex Sans Arabic has no variable build upstream, but it
    // does ship a genuine 600, so nothing is synthesised. Each `<weight>.css`
    // carries every subset with its `unicode-range`; the per-subset files
    // (`arabic-600.css`) must NOT be used, as they declare the same
    // family+weight with no range and the last import would win outright.
    loadAssets: () =>
      Promise.all([
        import('@fontsource/ibm-plex-sans-arabic/400.css'),
        import('@fontsource/ibm-plex-sans-arabic/500.css'),
        import('@fontsource/ibm-plex-sans-arabic/600.css'),
        import('@fontsource/ibm-plex-sans-arabic/700.css'),
      ]),
  },
  'noto-sans-arabic': {
    id: 'noto-sans-arabic',
    stack: `'Noto Sans Arabic Variable', 'Noto Sans Arabic', 'Noto Sans', ${SYSTEM_FONT_STACK}`,
    // `wght.css` = weight axis only (the wdth build is bigger and unused here).
    loadAssets: () => import('@fontsource-variable/noto-sans-arabic/wght.css'),
  },
  'readex-pro': {
    id: 'readex-pro',
    stack: `'Readex Pro Variable', 'Readex Pro', ${SYSTEM_FONT_STACK}`,
    loadAssets: () => import('@fontsource-variable/readex-pro/wght.css'),
  },
  vazirmatn: {
    id: 'vazirmatn',
    stack: `'Vazirmatn Variable', 'Vazirmatn', ${SYSTEM_FONT_STACK}`,
    loadAssets: () => import('@fontsource-variable/vazirmatn/wght.css'),
  },
  tajawal: {
    id: 'tajawal',
    stack: `'Tajawal', ${SYSTEM_FONT_STACK}`,
    // Tajawal ships 200/300/400/500/700/800/900 — there is no 600 anywhere
    // upstream. CSS weight matching resolves a 600 request upwards to the real
    // 700 face, so `font-semibold` still renders true glyphs (slightly heavier),
    // never a synthesised bold. Loading 800 would not help: 700 is the nearest
    // heavier face and always wins.
    loadAssets: () =>
      Promise.all([
        import('@fontsource/tajawal/400.css'),
        import('@fontsource/tajawal/500.css'),
        import('@fontsource/tajawal/700.css'),
      ]),
  },
};

/** Display order in the picker. `system` first — it is the default. */
export const UI_FONT_ORDER: UiFontId[] = [
  'system',
  'ibm-plex-sans-arabic',
  'noto-sans-arabic',
  'readex-pro',
  'vazirmatn',
  'tajawal',
];

export const DEFAULT_UI_FONT: UiFontId = 'system';

const KNOWN_UI_FONTS = new Set<string>(UI_FONT_ORDER);

export function isUiFontId(value: unknown): value is UiFontId {
  return typeof value === 'string' && KNOWN_UI_FONTS.has(value);
}

/** Spec for an id; anything unknown degrades to the system default. */
export function getUiFontSpec(id: unknown): UiFontSpec {
  return isUiFontId(id) ? UI_FONT_SPECS[id] : UI_FONT_SPECS[DEFAULT_UI_FONT];
}

/* ──────────────────────── State persistence ────────────────────── */

export function loadUiFont(): UiFontId {
  try {
    const raw = localStorage.getItem(UI_FONT_STORAGE_KEY);
    return isUiFontId(raw) ? raw : DEFAULT_UI_FONT;
  } catch {
    return DEFAULT_UI_FONT;
  }
}

let quotaWarned = false;
export function saveUiFont(id: UiFontId): void {
  try {
    localStorage.setItem(UI_FONT_STORAGE_KEY, id);
  } catch (err) {
    if (!quotaWarned) {
      quotaWarned = true;
      console.warn('[ui-font] localStorage write failed:', err);
    }
  }
}

/* ────────────────────── Asset loading ───────────────────── */

/**
 * Ids whose @fontsource CSS has already been requested this session. Recorded
 * synchronously (before the dynamic import settles) so a rapid back-and-forth
 * in the picker cannot queue the same download twice.
 */
const requestedAssets = new Set<UiFontId>();

/** Test/diagnostic view of which families actually triggered a download. */
export function getRequestedUiFontAssets(): UiFontId[] {
  return [...requestedAssets];
}

/** Test-only: forget what has been requested. */
export function __resetUiFontAssetsForTests(): void {
  requestedAssets.clear();
}

/**
 * Downloads a family's @font-face CSS once. Returns a promise that resolves
 * when the CSS is in the document (or immediately for `system` / a repeat call).
 * Failures are swallowed: a missing font must never break the UI, the stack
 * simply falls through to the system fallback already present in `--font-ui`.
 */
export function loadUiFontAssets(id: UiFontId): Promise<void> {
  const spec = getUiFontSpec(id);
  if (!spec.loadAssets || requestedAssets.has(spec.id)) {
    return Promise.resolve();
  }
  requestedAssets.add(spec.id);
  return spec.loadAssets().then(
    () => undefined,
    (err) => {
      // Allow a retry on the next selection — the failure may be transient.
      requestedAssets.delete(spec.id);
      console.warn(`[ui-font] failed to load "${spec.id}":`, err);
    },
  );
}

/* ────────────────────── DOM application ───────────────────── */

/**
 * Writes `--font-ui` on the root element and starts the (lazy) download.
 * The custom property is set synchronously so text is laid out in the right
 * fallback immediately; `font-display: swap` handles the rest.
 */
export function applyUiFont(id: UiFontId): void {
  const spec = getUiFontSpec(id);
  document.documentElement.style.setProperty(UI_FONT_CSS_VAR, spec.stack);
  void loadUiFontAssets(spec.id);
}

/**
 * Applies the stored font as early as possible at boot (before React renders)
 * so the interface never flashes the system stack and re-flows into the chosen
 * family. Mirrors `applyStoredThemePreset()` in theme-presets.ts.
 */
export function applyStoredUiFont(): UiFontId {
  try {
    const id = loadUiFont();
    applyUiFont(id);
    return id;
  } catch {
    // Never block boot on typography.
    return DEFAULT_UI_FONT;
  }
}
