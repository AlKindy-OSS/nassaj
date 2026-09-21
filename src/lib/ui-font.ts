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
 *    Arabic woff2 (and vice versa). The default is no longer `system` — see the
 *    note on DEFAULT_UI_FONT — so a first boot does fetch one family's CSS.
 * 4. Real weights only. The UI leans on `font-medium` (500) and `font-semibold`
 *    (600) heavily; a family that lacks them makes the browser synthesise fake
 *    bold. Variable fonts are preferred (100–900 continuous); the two static
 *    families load explicit weight files.
 * 5. No `local()` in any @font-face. `@fontsource` does not emit it, which is
 *    exactly what we want: the user picked a specific face, so the rendering
 *    must be deterministic and must not fall back to a stale locally-installed
 *    copy that may be missing the intermediate weights.
 */

/**
 * Verbatim copy of the historical LTR stack.
 *
 * It is the value of the `system` option and the tail of every other stack — it
 * is NOT the default any more. Read the whole list: `-apple-system`,
 * `BlinkMacSystemFont`, `Segoe UI`, `Roboto`, `Helvetica Neue`, `Arial`. Not one
 * of those carries a designed Arabic face, so every Arabic glyph in the product
 * fell through to whatever the OS happened to install (on Linux typically an
 * unhinted DejaVu/Noto), and `font-semibold` was synthesised rather than drawn.
 * That is why `system` is no longer what a user who never opens Settings gets.
 */
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
  | 'tajawal'
  | 'noto-nastaliq-urdu';

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
  'noto-nastaliq-urdu': {
    id: 'noto-nastaliq-urdu',
    // The one script-specific entry in this list, and the one place the
    // "one font for every language" rule bends. Urdu written in naskh is
    // legible yet reads as a foreign hand; nastaliq is the form the language is
    // actually set in.
    //
    // T-1174 — it IS applied when the UI language becomes Urdu, by owner's
    // decision: for this language the face is not a taste, it is the script.
    // See SCRIPT_ESSENTIAL_FONT / `fontForLanguage` below, which apply it on the
    // language TRANSITION only, so the picker still overrides it afterwards.
    stack: `'Noto Nastaliq Urdu', ${SYSTEM_FONT_STACK}`,
    // 400/500/600 only, deliberately. Each Arabic-subset weight is ~160 KB —
    // nastaliq carries far more contextual glyph forms than a naskh face — so
    // the fourth file would add ~160 KB to buy a 700 that CSS already resolves
    // to the real 600 face (matching upward, no synthesis). The Latin subset is
    // left to the system stack: this family's Latin is an afterthought, and
    // `unicode-range` never requests it anyway.
    loadAssets: () =>
      Promise.all([
        import('@fontsource/noto-nastaliq-urdu/400.css'),
        import('@fontsource/noto-nastaliq-urdu/500.css'),
        import('@fontsource/noto-nastaliq-urdu/600.css'),
      ]),
  },
};

/** Display order in the picker. */
export const UI_FONT_ORDER: UiFontId[] = [
  'system',
  'ibm-plex-sans-arabic',
  'noto-sans-arabic',
  'readex-pro',
  'vazirmatn',
  'tajawal',
  'noto-nastaliq-urdu',
];

/**
 * The family everyone gets until they choose otherwise.
 *
 * It used to be `system`, on the reasoning that the default should cost zero
 * bytes. That reasoning only holds for a Latin interface: the system stack ends
 * at Arial and contains no Arabic face at all, so the product's Arabic — which
 * is most of it — was drawn by an unspecified OS fallback with a synthesised
 * 600 weight. "Free" was buying an undesigned typeface for the majority of the
 * text on screen.
 *
 * IBM Plex Sans Arabic is the replacement because it is already a dependency
 * (`@fontsource/ibm-plex-sans-arabic` in package.json — no new package), ships a
 * genuine 600 so nothing is faked, is the family the Saudi DGA design system
 * standardised on, and pairs with IBM Plex Sans from the same superfamily so
 * mixed Arabic/Latin lines keep one rhythm.
 *
 * Cost: `applyStoredUiFont()` now imports four weight stylesheets at boot for a
 * user with no stored choice, where it previously imported none. They are
 * `unicode-range`-split, self-hosted, and `font-display: swap`.
 *
 * A stored choice still wins: `loadUiFont()` reads localStorage first and this
 * value is only the fallback, so a user who deliberately picked `system` keeps
 * `system`.
 */
export const DEFAULT_UI_FONT: UiFontId = 'ibm-plex-sans-arabic';

const KNOWN_UI_FONTS = new Set<string>(UI_FONT_ORDER);

/* ────────────────── Script-essential font per language ────────────────── */

/**
 * Languages whose script is not merely *preferred* in a particular face but
 * written in it (T-1174).
 *
 * This is the exception to design note 1 above, and it is narrow on purpose.
 * Urdu in naskh is legible the way English in Fraktur is legible: the reader
 * decodes it, and the whole time it reads as someone else's hand. Nastaliq is
 * the form the language is set in — newspapers, books, signage — so shipping
 * Urdu in a naskh face is not a typographic preference, it is the wrong script
 * rendered correctly.
 *
 * Nothing else belongs here. Arabic, Persian and Indonesian are all served by
 * the general list; a language earns an entry only when one face is the norm of
 * the language rather than a taste within it.
 */
export const SCRIPT_ESSENTIAL_FONT: Readonly<Record<string, UiFontId>> = Object.freeze({
  ur: 'noto-nastaliq-urdu',
});

/**
 * The font in use before a script-essential one took over, so leaving that
 * language gives it back rather than stranding an Arabic or Latin interface in
 * nastaliq — a face with no Latin worth the name and enormous descenders.
 */
const PRE_SCRIPT_FONT_KEY = 'nassaj-ui-font-before-script';

/** `ur-PK` → `ur`. i18next may hand back either shape. */
function baseLanguage(language: unknown): string {
  return typeof language === 'string' ? language.split('-')[0].toLowerCase() : '';
}

function rememberPreScriptFont(id: UiFontId | null): void {
  try {
    if (id) localStorage.setItem(PRE_SCRIPT_FONT_KEY, id);
    else localStorage.removeItem(PRE_SCRIPT_FONT_KEY);
  } catch {
    /* typography must never fail a language switch */
  }
}

function readPreScriptFont(): UiFontId | null {
  try {
    const raw = localStorage.getItem(PRE_SCRIPT_FONT_KEY);
    return isUiFontId(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * What the interface font should become when the UI language becomes `language`
 * — `null` when nothing should change, which is the answer for every language
 * that has no essential script and for a font already correct for this one.
 *
 * ONLY THE TRANSITION IS OWNED, never the steady state. Switching *into* Urdu
 * applies nastaliq and switching *out of* it hands back what was displaced; in
 * between, the font picker is free, and a reader who deliberately chooses naskh
 * while reading Urdu keeps it — the next language change sees a current font
 * that is no longer the essential one and leaves it alone. Forcing the face on
 * every render would silently defeat the picker instead, which is the failure
 * this shape exists to avoid.
 *
 * @param current the font in effect right now
 */
export function fontForLanguage(language: unknown, current: UiFontId): UiFontId | null {
  const essential = SCRIPT_ESSENTIAL_FONT[baseLanguage(language)];

  if (essential) {
    if (current === essential) return null;
    rememberPreScriptFont(current);
    return essential;
  }

  // Left a script-essential language. Only a font we ourselves imposed is taken
  // back; anything else is the reader's own pick and is not ours to undo.
  const isScriptFont = Object.values(SCRIPT_ESSENTIAL_FONT).includes(current);
  if (!isScriptFont) {
    rememberPreScriptFont(null);
    return null;
  }
  const restored = readPreScriptFont() ?? DEFAULT_UI_FONT;
  rememberPreScriptFont(null);
  return restored === current ? null : restored;
}

export function isUiFontId(value: unknown): value is UiFontId {
  return typeof value === 'string' && KNOWN_UI_FONTS.has(value);
}

/** Spec for an id; anything unknown degrades to the system default. */
export function getUiFontSpec(id: unknown): UiFontSpec {
  return isUiFontId(id) ? UI_FONT_SPECS[id] : UI_FONT_SPECS[DEFAULT_UI_FONT];
}

/* ──────────────────────── State persistence ────────────────────── */

/**
 * One-time migration off the old `'system'` default.
 *
 * `'system'` used to be the default, and ThemeContext calls `saveUiFont()` on
 * every boot — so every existing account has `'system'` written to localStorage
 * and synced to the server, whether or not anyone ever opened the font picker.
 * The stored value is therefore NOT evidence of a choice, and simply changing
 * DEFAULT_UI_FONT would have left every current user (the owner included)
 * looking at Arabic rendered in a Latin fallback stack — the exact defect the
 * new default exists to fix.
 *
 * So: the first time this build runs, a stored `'system'` is treated as the old
 * default and upgraded. Anything else is a real preference and is left alone.
 * Marking the key means a user who deliberately re-picks `'system'` afterwards
 * keeps it — the upgrade never repeats.
 */
const MIGRATION_KEY = 'nassaj-ui-font-arabic-default-migrated';

function migrateLegacySystemDefault(raw: string | null): UiFontId | null {
  if (raw !== 'system') return null;
  try {
    if (localStorage.getItem(MIGRATION_KEY) === '1') return null; // chosen on purpose
    localStorage.setItem(MIGRATION_KEY, '1');
    localStorage.setItem(UI_FONT_STORAGE_KEY, DEFAULT_UI_FONT);
    return DEFAULT_UI_FONT;
  } catch {
    // Storage unavailable: still upgrade for this session.
    return DEFAULT_UI_FONT;
  }
}

export function loadUiFont(): UiFontId {
  try {
    const raw = localStorage.getItem(UI_FONT_STORAGE_KEY);
    const migrated = migrateLegacySystemDefault(raw);
    if (migrated) return migrated;
    return isUiFontId(raw) ? raw : DEFAULT_UI_FONT;
  } catch {
    return DEFAULT_UI_FONT;
  }
}

/**
 * Records that the current value is a deliberate choice, so the migration above
 * never overrides it. Called by the font picker, not by boot-time sync.
 */
export function markUiFontChosen(): void {
  try {
    localStorage.setItem(MIGRATION_KEY, '1');
  } catch {
    /* preference tracking is not worth failing a click over */
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
  // The chosen family is also exposed as an attribute, because a stylesheet
  // cannot branch on a custom property's VALUE. Nastaliq needs it: its glyphs
  // sweep far below the baseline, so the leading Tailwind bakes into `text-sm`
  // clips descenders outright — a metric correction that belongs in CSS and
  // cannot be expressed through `--font-ui` alone. See index.css.
  document.documentElement.setAttribute('data-ui-font', spec.id);
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
