/**
 * Tests for the interface-font setting (src/lib/ui-font.ts) and its picker.
 *
 * Three properties matter more than the rest and are guarded explicitly:
 *  1. The default family covers Arabic. It used to be `system`, chosen because
 *     it downloads nothing; but that stack ends at Arial and contains no Arabic
 *     face, so the majority of this product's text was drawn by an unspecified
 *     OS fallback with a synthesised semibold. Zero bytes was buying an
 *     undesigned typeface.
 *  2. `system` remains available and remains free — picking it must still not
 *     request a single font asset.
 *  3. Changing the selection rewrites `--font-ui` on <html>, which is the one
 *     hook every surface in the app reads (body, wiki article, auth screen).
 */

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  DEFAULT_UI_FONT,
  SYSTEM_FONT_STACK,
  UI_FONT_CSS_VAR,
  UI_FONT_ORDER,
  UI_FONT_STORAGE_KEY,
  __resetUiFontAssetsForTests,
  applyStoredUiFont,
  applyUiFont,
  fontForLanguage,
  getRequestedUiFontAssets,
  getUiFontSpec,
  isUiFontId,
  loadUiFont,
  markUiFontChosen,
  saveUiFont,
} from './ui-font';

const readVar = () => document.documentElement.style.getPropertyValue(UI_FONT_CSS_VAR);

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty(UI_FONT_CSS_VAR);
  __resetUiFontAssetsForTests();
});

afterEach(() => {
  cleanup();
});

describe('font catalogue', () => {
  it('defaults to a family that actually covers Arabic', () => {
    // The picker still lists `system` first, but it is no longer what a user
    // who never opens Settings is given.
    expect(UI_FONT_ORDER[0]).toBe('system');
    expect(DEFAULT_UI_FONT).toBe('ibm-plex-sans-arabic');
    expect(UI_FONT_ORDER).toContain(DEFAULT_UI_FONT);
  });

  it('the default is a real face with real weights, not the system fallback', () => {
    const spec = getUiFontSpec(DEFAULT_UI_FONT);
    expect(spec.stack.startsWith("'IBM Plex Sans Arabic'")).toBe(true);
    // Non-null loader: the whole point is that the files are actually fetched.
    expect(spec.loadAssets).toBeTypeOf('function');
  });

  it('never downloads anything for the system font', () => {
    expect(getUiFontSpec('system').loadAssets).toBeNull();
  });

  it('gives every other font a loader and a system fallback tail', () => {
    for (const id of UI_FONT_ORDER.filter((f) => f !== 'system')) {
      const spec = getUiFontSpec(id);
      expect(spec.loadAssets, `${id} must load its own assets`).toBeTypeOf('function');
      // A webfont that fails to arrive must degrade to the system stack, not to
      // an unstyled serif default.
      expect(spec.stack.endsWith(SYSTEM_FONT_STACK), `${id} stack tail`).toBe(true);
    }
  });

  it('degrades an unknown id to the default instead of throwing', () => {
    expect(isUiFontId('comic-sans')).toBe(false);
    expect(getUiFontSpec('comic-sans').id).toBe(DEFAULT_UI_FONT);
    expect(getUiFontSpec(undefined).stack).toBe(getUiFontSpec(DEFAULT_UI_FONT).stack);
  });
});

describe('applyUiFont', () => {
  it('writes the system stack and requests NO font asset for "system"', () => {
    applyUiFont('system');
    expect(readVar()).toBe(SYSTEM_FONT_STACK);
    expect(getRequestedUiFontAssets()).toEqual([]);
  });

  it('writes the chosen stack and requests that family only', () => {
    applyUiFont('vazirmatn');
    expect(readVar()).toContain('Vazirmatn Variable');
    expect(getRequestedUiFontAssets()).toEqual(['vazirmatn']);
  });

  it('requests a family once, however often it is re-applied', () => {
    applyUiFont('readex-pro');
    applyUiFont('readex-pro');
    applyUiFont('readex-pro');
    expect(getRequestedUiFontAssets()).toEqual(['readex-pro']);
  });

  it('switching back to system leaves the variable at the system stack', () => {
    applyUiFont('tajawal');
    expect(readVar()).toContain('Tajawal');
    applyUiFont('system');
    expect(readVar()).toBe(SYSTEM_FONT_STACK);
  });
});

describe('persistence and boot', () => {
  it('boots on the Arabic-capable default when nothing is stored', () => {
    expect(loadUiFont()).toBe(DEFAULT_UI_FONT);
    expect(applyStoredUiFont()).toBe(DEFAULT_UI_FONT);
    expect(readVar()).toContain('IBM Plex Sans Arabic');
    // This is the cost of the change, asserted rather than assumed: the default
    // path now does fetch its family, where before it fetched nothing.
    expect(getRequestedUiFontAssets()).toEqual([DEFAULT_UI_FONT]);
  });

  /**
   * This case previously asserted that a stored `'system'` is honoured as an
   * explicit choice. A design review showed the premise was false: `'system'`
   * was the old default AND ThemeContext re-saves the current value on every
   * boot, so every pre-existing account has `'system'` written whether or not
   * anyone opened the picker. Honouring it left every current user — the owner
   * first — reading Arabic in a Latin fallback stack, which is precisely the
   * defect the new default removes.
   *
   * The contract is now: a stored `'system'` is the old default until the picker
   * says otherwise. Migration mechanics are covered in ui-font.migration.test.ts.
   */
  it('a stored "system" is treated as the old default and upgraded once', () => {
    saveUiFont('system');
    expect(loadUiFont()).toBe(DEFAULT_UI_FONT);
    expect(applyStoredUiFont()).toBe(DEFAULT_UI_FONT);
    expect(readVar()).toContain('IBM Plex Sans Arabic');
  });

  it('honours "system" once the picker has marked it as deliberate', () => {
    markUiFontChosen();
    saveUiFont('system');
    expect(loadUiFont()).toBe('system');
    expect(applyStoredUiFont()).toBe('system');
    expect(readVar()).toBe(SYSTEM_FONT_STACK);
    expect(getRequestedUiFontAssets()).toEqual([]);
  });

  it('round-trips a saved choice and applies it before React renders', () => {
    saveUiFont('noto-sans-arabic');
    expect(localStorage.getItem(UI_FONT_STORAGE_KEY)).toBe('noto-sans-arabic');
    expect(applyStoredUiFont()).toBe('noto-sans-arabic');
    expect(readVar()).toContain('Noto Sans Arabic Variable');
  });

  it('ignores a corrupted stored value', () => {
    localStorage.setItem(UI_FONT_STORAGE_KEY, '{"not":"an id"}');
    expect(loadUiFont()).toBe(DEFAULT_UI_FONT);
  });
});

/* ─── The picker, end to end through ThemeProvider ─── */

async function renderPicker() {
  const { ThemeProvider } = await import('../contexts/ThemeContext');
  const { default: UiFontPicker } = await import(
    '../components/settings/view/tabs/UiFontPicker'
  );
  const React = await import('react');
  render(
    React.createElement(ThemeProvider, null, React.createElement(UiFontPicker, null)),
  );
  return screen.getByRole('combobox') as HTMLSelectElement;
}

describe('UiFontPicker', () => {
  it('starts on the default family and offers every catalogued family', async () => {
    const select = await renderPicker();
    expect(select.value).toBe(DEFAULT_UI_FONT);
    expect([...select.options].map((o) => o.value)).toEqual(UI_FONT_ORDER);
  });

  it('updates --font-ui and persists the choice when the value changes', async () => {
    const select = await renderPicker();

    fireEvent.change(select, { target: { value: 'ibm-plex-sans-arabic' } });

    expect(select.value).toBe('ibm-plex-sans-arabic');
    expect(readVar()).toContain('IBM Plex Sans Arabic');
    expect(localStorage.getItem(UI_FONT_STORAGE_KEY)).toBe('ibm-plex-sans-arabic');
    expect(getRequestedUiFontAssets()).toContain('ibm-plex-sans-arabic');
  });

  it('choosing system restores the system stack and adds no new asset', async () => {
    const select = await renderPicker();
    fireEvent.change(select, { target: { value: 'readex-pro' } });
    const afterFirst = getRequestedUiFontAssets();

    fireEvent.change(select, { target: { value: 'system' } });

    expect(readVar()).toBe(SYSTEM_FONT_STACK);
    expect(localStorage.getItem(UI_FONT_STORAGE_KEY)).toBe('system');
    // No extra download was triggered by returning to the default.
    expect(getRequestedUiFontAssets()).toEqual(afterFirst);
  });
});

/* ─────────── T-1174: a language whose script is essential ─────────── */

describe('fontForLanguage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('switches Urdu into nastaliq, whatever was in effect', () => {
    expect(fontForLanguage('ur', 'ibm-plex-sans-arabic')).toBe('noto-nastaliq-urdu');
    expect(fontForLanguage('ur-PK', 'tajawal')).toBe('noto-nastaliq-urdu');
  });

  it('leaves every other language alone', () => {
    expect(fontForLanguage('ar', 'tajawal')).toBeNull();
    expect(fontForLanguage('en', 'system')).toBeNull();
    expect(fontForLanguage('fa', 'vazirmatn')).toBeNull();
  });

  it('hands back the displaced font on the way out, not the default', () => {
    expect(fontForLanguage('ur', 'vazirmatn')).toBe('noto-nastaliq-urdu');
    expect(fontForLanguage('ar', 'noto-nastaliq-urdu')).toBe('vazirmatn');
  });

  it('keeps a font the reader picked WHILE reading Urdu', () => {
    // Nastaliq is applied on the transition only. A reader who then chooses
    // naskh has overruled us, and leaving Urdu must not undo that choice.
    fontForLanguage('ur', 'tajawal');
    expect(fontForLanguage('en', 'noto-sans-arabic')).toBeNull();
  });

  it('is idempotent: re-entering Urdu in nastaliq changes nothing', () => {
    expect(fontForLanguage('ur', 'noto-nastaliq-urdu')).toBeNull();
  });

  it('falls back to the default when nothing was remembered', () => {
    expect(fontForLanguage('en', 'noto-nastaliq-urdu')).toBe(DEFAULT_UI_FONT);
  });
});
