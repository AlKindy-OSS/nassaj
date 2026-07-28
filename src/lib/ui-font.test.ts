/**
 * Tests for the interface-font setting (src/lib/ui-font.ts) and its picker.
 *
 * Two properties matter more than the rest and are guarded explicitly:
 *  1. `system` is a true zero-cost default — picking it must not request a
 *     single font asset (that is the whole reason it is the default).
 *  2. Changing the selection rewrites `--font-ui` on <html>, which is the one
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
  getRequestedUiFontAssets,
  getUiFontSpec,
  isUiFontId,
  loadUiFont,
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
  it('offers the system font first and treats it as the default', () => {
    expect(UI_FONT_ORDER[0]).toBe('system');
    expect(DEFAULT_UI_FONT).toBe('system');
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

  it('degrades an unknown id to the system font instead of throwing', () => {
    expect(isUiFontId('comic-sans')).toBe(false);
    expect(getUiFontSpec('comic-sans').id).toBe('system');
    expect(getUiFontSpec(undefined).stack).toBe(SYSTEM_FONT_STACK);
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
  it('defaults to the system font when nothing is stored', () => {
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
    expect(loadUiFont()).toBe('system');
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
  it('starts on the system font and offers every catalogued family', async () => {
    const select = await renderPicker();
    expect(select.value).toBe('system');
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

  it('going back to system restores the system stack and adds no new asset', async () => {
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
