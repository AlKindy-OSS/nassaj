import { describe, expect, it } from 'vitest';

import {
  createCommandViewModel,
  isArabicCodexSideAlias,
  normalizeArabicSlashCommand,
} from './commandLocalization';

describe('Arabic command localization', () => {
  it('keeps the canonical command separate from Arabic display data', () => {
    const view = createCommandViewModel('/compact', 'Compact context', 'codex', 'ar');
    expect(view.canonicalName).toBe('/compact');
    expect(view.title).toBe('ضغط');
    expect(view.description).toBe('اضغط سياق Codex الحالي.');
    expect(view.aliases).toEqual(['/ضغط']);
  });

  it('does not invent Arabic text for dynamic provider skills', () => {
    const view = createCommandViewModel('/deploy-preview', 'Deploy a preview', 'codex', 'ar');
    expect(view.title).toBeUndefined();
    expect(view.description).toBe('Deploy a preview');
    expect(view.aliases).toEqual([]);
  });

  it('does not localize dynamic names that collide with built-ins', () => {
    for (const [name, kind] of [['/compact', 'skill'], ['/help', 'custom']] as const) {
      const view = createCommandViewModel(name, `Provider ${kind}`, 'codex', 'ar', kind);
      expect(view.title).toBeUndefined();
      expect(view.description).toBe(`Provider ${kind}`);
      expect(view.aliases).toEqual([]);
    }
  });

  it('normalizes an exact Arabic first token only in Arabic UI', () => {
    expect(normalizeArabicSlashCommand('/ضغط الآن', 'codex', 'ar-SA')).toBe('/compact الآن');
    expect(normalizeArabicSlashCommand('/ضغط', 'claude', 'ar')).toBe('/ضغط');
    expect(normalizeArabicSlashCommand('/ضغط_اختبار', 'codex', 'ar')).toBe('/ضغط_اختبار');
    expect(normalizeArabicSlashCommand('/ضغط الآن', 'codex', 'en')).toBe('/ضغط الآن');
  });

  it('maps side aliases only for Codex and preserves the question', () => {
    expect(normalizeArabicSlashCommand('/جانبي ما الذي تغيّر؟', 'codex', 'ar')).toBe('/side ما الذي تغيّر؟');
    expect(normalizeArabicSlashCommand('/بالمناسبة ما الذي تغيّر؟', 'codex', 'ar')).toBe('/side ما الذي تغيّر؟');
    expect(normalizeArabicSlashCommand('/جانبي ما الذي تغيّر؟', 'claude', 'ar')).toBe('/جانبي ما الذي تغيّر؟');
    expect(isArabicCodexSideAlias('/جانبي سؤال', 'codex', 'ar')).toBe(true);
    expect(isArabicCodexSideAlias('/جانبية سؤال', 'codex', 'ar')).toBe(false);
    expect(isArabicCodexSideAlias('/جانبي سؤال', 'claude', 'ar')).toBe(false);
  });
});
