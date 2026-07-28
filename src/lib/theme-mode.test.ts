/**
 * Tests for theme-mode.ts — the shared resolveIsDark() helper — and for the
 * parity between resolveIsDark() and applyStoredThemePreset() in theme-presets.ts.
 *
 * Regression guard: if applyStoredThemePreset() ever diverges from
 * resolveIsDark() (e.g. someone replaces line 413 with `savedTheme === 'dark'`),
 * the parity tests in the second describe block will turn red.
 * Concretely: stored='system', OS=dark → resolveIsDark returns true, but
 * `savedTheme === 'dark'` returns false → expect(false).toBe(true) fails.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveIsDark } from './theme-mode';
import { applyStoredThemePreset } from './theme-presets';

/* ─── matchMedia mock helper ─── */

function mockMatchMedia(prefersDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? prefersDark : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

/* ─── resolveIsDark unit tests ─── */

describe('resolveIsDark', () => {
  describe('when system prefers dark', () => {
    beforeEach(() => mockMatchMedia(true));

    it("'dark'   → true",   () => expect(resolveIsDark('dark')).toBe(true));
    it("'light'  → false",  () => expect(resolveIsDark('light')).toBe(false));
    it("'system' → true (follows OS)", () => expect(resolveIsDark('system')).toBe(true));
    it('null     → true (follows OS)', () => expect(resolveIsDark(null)).toBe(true));
    it('unknown  → true (follows OS)', () => expect(resolveIsDark('bogus')).toBe(true));
  });

  describe('when system prefers light', () => {
    beforeEach(() => mockMatchMedia(false));

    it("'dark'   → true",    () => expect(resolveIsDark('dark')).toBe(true));
    it("'light'  → false",   () => expect(resolveIsDark('light')).toBe(false));
    it("'system' → false (follows OS)", () => expect(resolveIsDark('system')).toBe(false));
    it('null     → false (follows OS)', () => expect(resolveIsDark(null)).toBe(false));
    it('unknown  → false (follows OS)', () => expect(resolveIsDark('bogus')).toBe(false));
  });
});

/* ─── applyStoredThemePreset parity tests ─── */
//
// applyStoredThemePreset() now returns the isDark boolean it computed, so we
// can assert it directly against resolveIsDark(storedValue).
//
// Detection proof: if line 413 of theme-presets.ts were reverted to
//   `savedTheme === 'dark'`
// then for stored='system', OS=dark: boot returns false, but
// resolveIsDark('system') returns true → expect(false).toBe(true) → RED.

const CASES: Array<[string | null, boolean]> = [
  [null,     false],
  [null,     true],
  ['light',  false],
  ['light',  true],
  ['dark',   false],
  ['dark',   true],
  ['system', false],
  ['system', true],
  ['bogus',  false],
  ['bogus',  true],
];

describe('applyStoredThemePreset parity with resolveIsDark', () => {
  for (const [stored, prefersDark] of CASES) {
    it(`stored=${JSON.stringify(stored)} os=${prefersDark ? 'dark' : 'light'}`, () => {
      mockMatchMedia(prefersDark);

      if (stored === null) {
        localStorage.removeItem('theme');
      } else {
        localStorage.setItem('theme', stored);
      }

      const bootResult = applyStoredThemePreset();
      const expected   = resolveIsDark(stored);

      expect(bootResult).toBe(expected);
    });
  }
});
