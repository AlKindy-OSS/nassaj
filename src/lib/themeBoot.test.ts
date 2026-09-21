import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CUSTOM_COLORS,
  HIDDEN_PRESETS,
  PRESET_ORDER,
  THEME_PRESET_STORAGE_KEY,
  applyStoredThemePreset,
  applyThemePreset,
  loadThemePresetState,
  type ThemePresetId,
} from './theme-presets';

function state(preset: ThemePresetId) {
  return { preset, custom: { ...DEFAULT_CUSTOM_COLORS } };
}

function themeColor(): string | null {
  return document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? null;
}

describe('theme preset browser chrome', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#ffffff">';
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });
  });

  const expected: Record<Exclude<ThemePresetId, 'custom'>, [string, string]> = {
    default: ['#ffffff', '#020817'],
    alkindy: ['#f7f7f4', '#0f1729'],
    nawras: ['#f8f7f7', '#0b1919'],
    // T-1735: dark bg retinted to hasri violet h=262 — #171122 = HSL(262 35% 10%).
    irukhaimi: ['#f7f8f9', '#171122'],
    claude: ['#f9f8f6', '#211e1c'],
    cursor: ['#fcfcfd', '#0c0f13'],
    codex: ['#fcfdfc', '#0d1210'],
    gemini: ['#fcfcfd', '#0d0f12'],
  };

  for (const preset of [...PRESET_ORDER, ...HIDDEN_PRESETS.filter((p) => p !== 'custom')]) {
    it(`tracks the fixed ${preset} background in both modes`, () => {
      applyThemePreset(state(preset), false);
      expect(themeColor()).toBe(expected[preset][0]);

      applyThemePreset(state(preset), true);
      expect(themeColor()).toBe(expected[preset][1]);
    });
  }

  it('tracks a custom background rather than its accent', () => {
    const custom = state('custom');
    custom.custom.background = '200 50% 40%';
    custom.custom.accent = '10 90% 50%';

    applyThemePreset(custom, false);
    expect(themeColor()).toBe('#337799');
  });

  it('does not fail when the document has no theme-color meta', () => {
    document.head.innerHTML = '';
    expect(() => applyThemePreset(state('alkindy'), true)).not.toThrow();
  });

  it('applies default dark mode before React mounts', () => {
    localStorage.setItem('theme', 'dark');
    localStorage.setItem(THEME_PRESET_STORAGE_KEY, JSON.stringify(state('default')));

    expect(applyStoredThemePreset()).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(themeColor()).toBe('#020817');
  });

  it('removes a stale dark class when the stored mode is light', () => {
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'light');

    expect(applyStoredThemePreset()).toBe(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  // إخفاءُ بريستٍ عن الشبكة ليس حذفَه: من كان عليه محفوظاً يبقى عليه. لو سقط
  // من `KNOWN_PRESETS` مع سقوطه من `PRESET_ORDER` لانقلب ثيمُ مستخدمٍ إلى
  // «الكندي» في أول إقلاع بعد النشر، بلا أن يطلب ذلك.
  for (const preset of HIDDEN_PRESETS) {
    it(`keeps the hidden ${preset} preset loadable after it left the picker`, () => {
      localStorage.setItem(THEME_PRESET_STORAGE_KEY, JSON.stringify(state(preset)));
      expect(loadThemePresetState().preset).toBe(preset);
    });
  }

  it('drops default and gemini from the picker without dropping them from the engine', () => {
    expect(PRESET_ORDER).not.toContain('default');
    expect(PRESET_ORDER).not.toContain('gemini');
    expect(PRESET_ORDER).toContain('nawras');
    expect(PRESET_ORDER).toContain('irukhaimi');
  });

  it('falls back safely when preset storage is corrupt', () => {
    localStorage.setItem('theme', 'dark');
    localStorage.setItem(THEME_PRESET_STORAGE_KEY, '{broken json');

    expect(applyStoredThemePreset()).toBe(true);
    expect(themeColor()).toBe('#0f1729');
  });
});
