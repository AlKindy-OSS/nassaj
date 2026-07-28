/**
 * codeHighlightScope.test.ts — عقد المستويات كبيانات خالصة.
 *
 * هذا الملف عمداً **لا يستورد** `prismRegistry` ولا React: الوحدة المُختبَرة هنا
 * هي نفسها التي تستوردها طبقة التفضيلات، وأي تلوّث لها بـPrism يُعيد المُلوِّن
 * إلى حزمة البدء من طريق غير مقصود. الاختبار يحرس الحدّ كما يحرس السلوك.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { describe, expect, it } from 'vitest';

import {
  CODE_HIGHLIGHT_SCOPES,
  CODE_HIGHLIGHT_SCOPE_RANK,
  CORE_LANGUAGE_IDS,
  DEFAULT_CODE_HIGHLIGHT_SCOPE,
  EXTENDED_LANGUAGE_IDS,
  parseCodeHighlightScope,
} from './codeHighlightScope';

describe('parseCodeHighlightScope', () => {
  it('accepts the three published scopes', () => {
    for (const scope of CODE_HIGHLIGHT_SCOPES) {
      expect(parseCodeHighlightScope(scope)).toBe(scope);
    }
  });

  it('falls back to the lightest scope for junk values', () => {
    // كل واحدة من هذه وردت فعلاً في تخزين محلي أو حمولة خادم في مرحلة ما:
    // مفتاح قديم، قيمة منطقية، كائن، غياب كامل.
    for (const junk of [undefined, null, '', 'CORE', 'all', 300, true, {}, []]) {
      expect(parseCodeHighlightScope(junk)).toBe(DEFAULT_CODE_HIGHLIGHT_SCOPE);
    }
  });

  it('honours an explicit fallback (used by the preferences reducer)', () => {
    expect(parseCodeHighlightScope('nope', 'full')).toBe('full');
  });

  it('defaults to the scope that ships statically', () => {
    expect(DEFAULT_CODE_HIGHLIGHT_SCOPE).toBe('core');
  });
});

describe('scope catalogue', () => {
  it('advertises 10 core and 10 extended languages', () => {
    expect(CORE_LANGUAGE_IDS).toHaveLength(10);
    expect(EXTENDED_LANGUAGE_IDS).toHaveLength(10);
  });

  it('never repeats a language between the two tiers', () => {
    const overlap = EXTENDED_LANGUAGE_IDS.filter((id) => CORE_LANGUAGE_IDS.includes(id));
    expect(overlap).toEqual([]);
  });

  it('ranks scopes so a higher tier is never re-fetched by a lower one', () => {
    expect(CODE_HIGHLIGHT_SCOPE_RANK.core).toBeLessThan(CODE_HIGHLIGHT_SCOPE_RANK.extended);
    expect(CODE_HIGHLIGHT_SCOPE_RANK.extended).toBeLessThan(CODE_HIGHLIGHT_SCOPE_RANK.full);
  });
});
