/**
 * ui-font.migration.test.ts
 *
 * Guards the one-time upgrade off the old `'system'` default.
 *
 * WHY THIS EXISTS: `'system'` — a Latin-only stack with no Arabic family in it —
 * used to be the default, and ThemeContext calls `saveUiFont()` on every boot.
 * So every existing account already has `'system'` persisted (and synced to the
 * server) whether or not anyone opened the picker. Changing DEFAULT_UI_FONT
 * alone therefore fixed nothing for anyone who had ever loaded the app: they
 * kept seeing Arabic rendered in a browser fallback face, which is the whole
 * defect the new default was chosen to remove. A design review caught this after
 * the default had already been changed and shipped.
 *
 * The contract is narrow on purpose: upgrade a stored `'system'` exactly once,
 * and never touch anything a user actually picked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DEFAULT_UI_FONT, UI_FONT_STORAGE_KEY, loadUiFont, markUiFontChosen } from './ui-font';

const MIGRATION_KEY = 'nassaj-ui-font-arabic-default-migrated';

/** Minimal in-memory localStorage; jsdom's own is shared across test files. */
function installStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const mock = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal('localStorage', mock);
  return store;
}

describe('ui-font — legacy system default migration', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('the new default is an Arabic family, not the Latin system stack', () => {
    expect(DEFAULT_UI_FONT).not.toBe('system');
  });

  it('upgrades a stored legacy "system" to the Arabic default', () => {
    const store = installStorage({ [UI_FONT_STORAGE_KEY]: 'system' });
    expect(loadUiFont()).toBe(DEFAULT_UI_FONT);
    // Persisted, so the next boot does not have to migrate again.
    expect(store.get(UI_FONT_STORAGE_KEY)).toBe(DEFAULT_UI_FONT);
    expect(store.get(MIGRATION_KEY)).toBe('1');
  });

  it('migrates once — a later deliberate return to "system" survives', () => {
    const store = installStorage({ [UI_FONT_STORAGE_KEY]: 'system' });
    expect(loadUiFont()).toBe(DEFAULT_UI_FONT);

    // The user opens the picker and chooses the system stack on purpose.
    markUiFontChosen();
    store.set(UI_FONT_STORAGE_KEY, 'system');

    expect(loadUiFont()).toBe('system');
    expect(loadUiFont()).toBe('system'); // and stays, on every subsequent boot
  });

  it('never touches a stored family that is not "system"', () => {
    const store = installStorage({ [UI_FONT_STORAGE_KEY]: 'readex-pro' });
    expect(loadUiFont()).toBe('readex-pro');
    expect(store.has(MIGRATION_KEY)).toBe(false);
  });

  it('a first-time visitor gets the Arabic default with nothing stored', () => {
    installStorage();
    expect(loadUiFont()).toBe(DEFAULT_UI_FONT);
  });

  it('falls back to the Arabic default when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(loadUiFont()).toBe(DEFAULT_UI_FONT);
  });
});
