/**
 * T-2046 (Q7): every shipped locale carries the three `common:mermaidZoom` labels.
 *
 * Run: NODE_ENV=test npx vitest run src/shared/view/mermaidZoomLocales.test.ts
 */
import { describe, it, expect } from 'vitest';

const locales = import.meta.glob('../../i18n/locales/*/common.json', { eager: true, import: 'default' }) as Record<
  string,
  { mermaidZoom?: Record<string, string> }
>;

describe('mermaidZoom locale keys', () => {
  it('covers all 12 locales', () => {
    expect(Object.keys(locales)).toHaveLength(12);
  });

  it.each(Object.entries(locales))('%s has non-empty zoom/zoomedAria/close', (_path, bundle) => {
    for (const key of ['zoom', 'zoomedAria', 'close']) {
      expect(bundle.mermaidZoom?.[key]?.trim()).toBeTruthy();
    }
  });

  it('Arabic labels match the wiki wording', () => {
    const ar = Object.entries(locales).find(([p]) => p.includes('/ar/'))?.[1];
    expect(ar?.mermaidZoom).toEqual({ zoom: 'تكبير المخطط', zoomedAria: 'مخطط Mermaid مكبَّر', close: 'إغلاق' });
  });
});
